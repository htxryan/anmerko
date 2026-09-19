import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveRelease } from '../../scripts/release/release-automation.mjs';
import { continuePromotion } from '../../scripts/release/release-deliver.mjs';
import { digest } from '../../scripts/release/approved-release.mjs';
import { activeRepository } from '../../scripts/release/release-repository.mjs';

const source = 'a'.repeat(40);
const activeRepositoryName = activeRepository();
const mainAfterPromotion = 'b'.repeat(40);
const success = name => ({ name, status: 'completed', conclusion: 'success' });
const fullCheckJobs = ['Changed paths', 'Lint and types', 'Chrome', 'Firefox / Android',
  'Desktop browsers (ubuntu-latest) / Browser scenarios',
  'Desktop browsers (macos-latest) / Browser scenarios'].map(success);
const check = (id, head, headBranch = 'main') => ({ id, run_attempt: 1, path: '.github/workflows/check.yml', event: 'workflow_dispatch',
  head_sha: head, head_branch: headBranch, repository: { full_name: activeRepositoryName }, head_repository: { full_name: activeRepositoryName }, status: 'completed', conclusion: 'success' });

function outputs(bytes) {
  return Object.fromEntries(bytes.trim().split('\n').filter(Boolean).map(line => {
    const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)];
  }));
}

test('real release drivers resume a lost first button, publish through Deploy, and no-op the same payload', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'anmerko-release-integration-'));
  const previous = { validation: { kind: 'release' }, browsers: { chrome: { source: 'c'.repeat(40), version: '0.5.3' },
    firefox: { source: 'd'.repeat(40), version: '0.5.3.1' } } };
  const plan = { schema: 1, source, version: '0.5.4', adopt: false, releaseRun: 700, releaseAttempt: 1 };
  const pending = { tag_name: `automation-0-5-4-${source}`, draft: true, created_at: '2026-09-14T00:00:00Z',
    body: JSON.stringify(plan), assets: [] };
  const ghCalls = [];
  const gh = args => { ghCalls.push(args); return ''; };
  const originalEnvironment = Object.fromEntries(['GITHUB_EVENT_NAME', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT',
    'GITHUB_OUTPUT', 'GITHUB_STEP_SUMMARY', 'RELEASE_VERSION_OVERRIDE', 'ADOPT_EXISTING', 'RELEASE_RESUME_ONLY'].map(key => [key, process.env[key]]));
  try {
    process.env.GITHUB_EVENT_NAME = 'workflow_dispatch'; process.env.GITHUB_RUN_ID = '700'; process.env.GITHUB_RUN_ATTEMPT = '1';
    process.env.GITHUB_OUTPUT = join(directory, 'output'); process.env.GITHUB_STEP_SUMMARY = join(directory, 'summary');
    await writeFile(process.env.GITHUB_OUTPUT, ''); await writeFile(process.env.GITHUB_STEP_SUMMARY, '');
    const content = value => ({ content: Buffer.from(JSON.stringify(value)).toString('base64') });
    const firstApi = path => {
      if (path === 'git/ref/heads/main') return { object: { sha: source } };
      if (path.startsWith('contents/releases/approved.json')) return content(previous);
      if (path.startsWith('contents/package.json')) return content({ name: 'anmerko', version: '0.5.4' });
      if (path === 'releases?per_page=100') return [];
      if (path === `compare/${previous.browsers.chrome.source}...${source}`) return { files: [{ filename: 'src/core.ts' }] };
      if (path === `compare/${source}...${source}`) return { merge_base_commit: { sha: source }, status: 'identical' };
      if (path.startsWith('actions/workflows/check.yml/runs?')) return { workflow_runs: [] };
      assert.fail(`Unexpected first-button API call: ${path}`);
    };
    process.env.RELEASE_RESUME_ONLY = 'true';
    await resolveRelease({ api: firstApi, gh });
    assert.equal(outputs(await readFile(process.env.GITHUB_OUTPUT, 'utf8')).run, 'false');
    assert.equal(ghCalls.length, 0, 'Resume-only dispatch cannot create a release plan');
    delete process.env.RELEASE_RESUME_ONLY; await writeFile(process.env.GITHUB_OUTPUT, '');
    await resolveRelease({ api: firstApi, gh });
    let actual = outputs(await readFile(process.env.GITHUB_OUTPUT, 'utf8'));
    assert.equal(actual.run, 'true'); assert.equal(actual.resume, 'false'); assert.equal(actual.ready, 'false');
    assert.equal(actual['artifact-prefix'], 'anmerko');
    assert.ok(ghCalls.some(args => args[0] === 'release' && args[1] === 'create'), 'First button persists a draft release plan');
    assert.ok(ghCalls.some(args => args.includes(`ref=refs/heads/codex/release-source-${source}`)), 'First button pins the selected main commit');
    assert.ok(ghCalls.some(args => args.join(' ') === `workflow run check.yml --repo ${activeRepositoryName} --ref codex/release-source-${source}`));

    await writeFile(process.env.GITHUB_OUTPUT, ''); process.env.GITHUB_EVENT_NAME = 'schedule';
    const snapshot = `codex/release-source-${source}`, sourceCheck = check(800, source, snapshot);
    const resumeApi = path => {
      if (path === 'git/ref/heads/main') return { object: { sha: source } };
      if (path.startsWith('contents/releases/approved.json')) return content(previous);
      if (path.startsWith('contents/package.json')) return content({ name: 'anmerko', version: '0.5.4' });
      if (path === 'releases?per_page=100') return [{ ...pending, draft: false, prerelease: true }];
      if (path.startsWith('actions/workflows/check.yml/runs?')) return { workflow_runs: [sourceCheck] };
      if (path.startsWith('actions/runs/800/attempts/1/jobs')) return { jobs: fullCheckJobs };
      if (path === `compare/${source}...${source}`) return { merge_base_commit: { sha: source }, status: 'identical' };
      assert.fail(`Unexpected resume API call: ${path}`);
    };
    await resolveRelease({ api: resumeApi, gh });
    actual = outputs(await readFile(process.env.GITHUB_OUTPUT, 'utf8'));
    assert.equal(actual.run, 'true'); assert.equal(actual.resume, 'false'); assert.equal(actual.ready, 'true');
    assert.equal(actual.source, source); assert.equal(actual['check-run'], '800'); assert.equal(actual['artifact-prefix'], 'anmerko');

    const saved = [], promotionGh = [], mutations = [];
    const save = async state => { saved.push(structuredClone(state)); };
    const promotion = { phase: 'chromium', branch: 'codex/automated-release-0-5-4-chromium', pr: 62,
      runId: 700, status: 'waiting-for-release' };
    let state = { schema: 2, revision: 1, source, version: '0.5.4', releaseRun: 700, releaseAttempt: 1,
      firefoxWebsiteVersion: '0.5.4.1', payloadFingerprint: 'e'.repeat(64), checkRun: 800,
      website: { chrome: 'ready', edge: 'ready', firefox: 'ready', deployment: 'pending' },
      stores: { chrome: 'pending-review', firefox: 'pending-review' }, promotion, complete: false };
    let stage = 'merge', prRunState = 'success';
    const promotionApi = path => {
      if (path === 'pulls/62') return stage === 'merge' ? { state: 'open', user: { login: 'briefmark-release-automation[bot]' },
        head: { ref: promotion.branch, repo: { full_name: activeRepositoryName } }, base: { ref: 'main' } }
        : { state: 'closed', merged_at: '2026-09-14T01:00:00Z' };
      if (path === 'actions/runs/700') return { status: 'completed', conclusion: 'success' };
      if (path === `git/ref/heads/${promotion.branch}`) return { object: { sha: 'f'.repeat(40) } };
      if (path.includes('actions/workflows/check.yml/runs?head_sha=' + 'f'.repeat(40))) return { workflow_runs: [
        check(801, 'f'.repeat(40)),
        { ...check(800, 'f'.repeat(40), promotion.branch), event: 'pull_request', conclusion: 'action_required' },
        { ...check(803, 'f'.repeat(40), promotion.branch), event: 'pull_request',
          status: prRunState === 'active' ? 'in_progress' : 'completed', conclusion: prRunState === 'active' ? null : 'success' },
      ] };
      if (path.startsWith('actions/runs/803/attempts/1/jobs')) return { jobs: fullCheckJobs };
      if (path === `git/commits/${'f'.repeat(40)}`) return { parents: [{ sha: mainAfterPromotion }] };
      if (path === `compare/${mainAfterPromotion}...${'f'.repeat(40)}`) return { total_commits: 1, files: [{ filename: 'releases/approved.json' }] };
      if (path === 'git/ref/heads/main') return { object: { sha: mainAfterPromotion } };
      if (path.includes('actions/workflows/check.yml/runs?head_sha=' + mainAfterPromotion)) return { workflow_runs: [check(802, mainAfterPromotion)] };
      if (path.includes('actions/workflows/deploy.yml/runs?head_sha=' + mainAfterPromotion)) return { workflow_runs: stage === 'deployed'
        ? [{ id: 900, path: '.github/workflows/deploy.yml', event: 'workflow_dispatch', head_sha: mainAfterPromotion,
          repository: { full_name: activeRepositoryName }, head_repository: { full_name: activeRepositoryName }, status: 'completed', conclusion: 'success' }]
        : [] };
      assert.fail(`Unexpected promotion API call: ${path}`);
    };
    const mutation = (method, path, body) => { mutations.push({ method, path, body }); return { merged: true }; };
    const driver = { api: promotionApi, gh: args => promotionGh.push(args), mutate: mutation, save };
    const active = await continuePromotion(structuredClone(state), pending.tag_name, {
      ...driver, api: path => path === 'actions/runs/700' ? { status: 'in_progress', conclusion: null } : promotionApi(path),
    });
    assert.equal(active.handled, true); assert.deepEqual(active.state.promotion, promotion);
    for (const conclusion of ['failure', 'cancelled']) {
      const failedStates = [];
      const failed = await continuePromotion(structuredClone(state), pending.tag_name, {
        ...driver, api: path => path === 'actions/runs/700' ? { status: 'completed', conclusion } : promotionApi(path),
        save: async value => failedStates.push(structuredClone(value)),
      });
      assert.equal(failed.handled, false); assert.equal(failed.state.promotion, null);
      assert.equal(failedStates.at(-1).promotion, null, 'Terminal failed authorizer reset must be durable');
    }
    let interruptedClosed = false, failFirstReopen = true;
    const interruptedStates = [], interruptedMutations = [];
    const interruptedApi = path => {
      if (path === 'pulls/62') return { state: interruptedClosed ? 'closed' : 'open', merged_at: null,
        user: { login: 'github-actions[bot]' }, head: { ref: promotion.branch, repo: { full_name: activeRepositoryName } }, base: { ref: 'main' } };
      if (path === 'actions/runs/700') return { status: 'completed', conclusion: 'success' };
      if (path === `git/ref/heads/${promotion.branch}`) return { object: { sha: '9'.repeat(40) } };
      if (path === `git/commits/${'9'.repeat(40)}`) return { parents: [{ sha: mainAfterPromotion }] };
      if (path === `compare/${mainAfterPromotion}...${'9'.repeat(40)}`) return { total_commits: 1, files: [{ filename: 'releases/approved.json' }] };
      if (path.includes('actions/workflows/check.yml/runs?')) return { workflow_runs: [
        { ...check(805, '9'.repeat(40), promotion.branch), event: 'pull_request', conclusion: 'action_required' },
      ] };
      if (path === 'git/ref/heads/main') return { object: { sha: mainAfterPromotion } };
      assert.fail(`Unexpected interrupted-reopen API call: ${path}`);
    };
    const interruptedDriver = { api: interruptedApi, gh: () => {}, save: async value => interruptedStates.push(structuredClone(value)),
      mutate: (method, path, body) => { interruptedMutations.push({ method, path, body }); return {}; },
      mutatePull: (method, path, body) => {
        if (body.state === 'closed') interruptedClosed = true;
        else if (failFirstReopen) { failFirstReopen = false; throw new Error('simulated reopen failure'); }
        else interruptedClosed = false;
        return {};
      } };
    await assert.rejects(continuePromotion(structuredClone(state), pending.tag_name, interruptedDriver), /simulated reopen failure/);
    const reopening = interruptedStates.at(-1);
    assert.equal(reopening.promotion.status, 'reopening'); assert.equal(interruptedClosed, true);
    const resumedReopen = await continuePromotion(reopening, pending.tag_name, interruptedDriver);
    assert.equal(resumedReopen.state.promotion.status, 'waiting-for-release'); assert.equal(interruptedClosed, false);
    assert.equal(interruptedMutations.length, 0, 'Reopening must not rebuild the branch or packages');
    const parent = 'e'.repeat(40), oldHead = 'f'.repeat(40);
    const currentApproved = { sequence: 3 }, promotedApproved = { sequence: 4, previous: digest(JSON.stringify(currentApproved)) };
    const encoded = value => ({ content: Buffer.from(JSON.stringify(value)).toString('base64') });
    const recoveryMutations = [], pullMutations = [];
    const recoveryApi = path => {
      if (path === 'pulls/62') return { state: 'open', user: { login: 'github-actions[bot]' },
        head: { ref: promotion.branch, repo: { full_name: activeRepositoryName } }, base: { ref: 'main' } };
      if (path === 'actions/runs/700') return { status: 'completed', conclusion: 'success' };
      if (path === `git/ref/heads/${promotion.branch}`) return { object: { sha: oldHead } };
      if (path.includes(`actions/workflows/check.yml/runs?head_sha=${oldHead}`)) return { workflow_runs: [
        { ...check(804, oldHead, promotion.branch), event: 'pull_request', conclusion: 'action_required' },
      ] };
      if (path === `git/commits/${oldHead}`) return { parents: [{ sha: parent }] };
      if (path === `compare/${parent}...${oldHead}`) return { total_commits: 1, files: [{ filename: 'releases/approved.json' }] };
      if (path === 'git/ref/heads/main') return { object: { sha: mainAfterPromotion } };
      if (path === `compare/${parent}...${mainAfterPromotion}`) return { merge_base_commit: { sha: parent } };
      if (path === `contents/releases/approved.json?ref=${mainAfterPromotion}`) return encoded(currentApproved);
      if (path === `contents/releases/approved.json?ref=${oldHead}`) return encoded(promotedApproved);
      if (path === `git/commits/${mainAfterPromotion}`) return { tree: { sha: '1'.repeat(40) } };
      assert.fail(`Unexpected recovery API call: ${path}`);
    };
    const recovered = await continuePromotion(structuredClone(state), pending.tag_name, { api: recoveryApi,
      gh: args => promotionGh.push(args), save, mutate: (method, path, body) => {
        recoveryMutations.push({ method, path, body });
        return path === 'git/trees' ? { sha: '2'.repeat(40) } : path === 'git/commits' ? { sha: '3'.repeat(40) } : {};
      }, mutatePull: (method, path, body) => { pullMutations.push({ method, path, body }); return {}; } });
    assert.equal(recovered.handled, true);
    assert.ok(recoveryMutations.some(entry => entry.path === `git/refs/heads/${promotion.branch}` && entry.body.force));
    assert.deepEqual(pullMutations.map(entry => entry.body.state), ['closed', 'open']);
    prRunState = 'active';
    const mutationsBeforeActive = mutations.length;
    const superseded = await continuePromotion(structuredClone(state), pending.tag_name, driver);
    assert.equal(superseded.handled, true); assert.equal(mutations.length, mutationsBeforeActive);
    prRunState = 'success';
    ({ state } = await continuePromotion(state, pending.tag_name, driver));
    assert.equal(state.revision, 2); assert.equal(state.promotion.status, 'merged'); assert.equal(state.website.deployment, 'waiting-for-main-check');
    assert.equal(saved.at(-1).revision, 2); assert.equal(mutations[0].path, 'pulls/62/merge');

    stage = 'dispatch'; ({ state } = await continuePromotion(state, pending.tag_name, driver));
    assert.equal(state.revision, 3); assert.equal(state.website.deployment, 'dispatched'); assert.equal(saved.at(-1).revision, 3);
    assert.equal(state.complete, false, 'Store review must remain resumable until both stores publish');
    assert.ok(promotionGh.some(args => args.join(' ') === `workflow run deploy.yml --repo ${activeRepositoryName} --ref main -f check-run=802`));

    state = { ...state, stores: { chrome: 'published', firefox: 'published' } };
    stage = 'deployed'; ({ state } = await continuePromotion(state, pending.tag_name, driver));
    assert.equal(state.revision, 4); assert.equal(state.website.deployment, 'published'); assert.equal(state.promotion, null);
    assert.equal(saved.at(-1).revision, 4); assert.equal(state.complete, true);

    await writeFile(process.env.GITHUB_OUTPUT, ''); process.env.GITHUB_EVENT_NAME = 'workflow_dispatch';
    const approvedSamePayload = { validation: { kind: 'automation' }, browsers: { chrome: { source, version: '0.5.4' }, firefox: { source, version: '0.5.4.1' } } };
    const noOpApi = path => {
      if (path === 'git/ref/heads/main') return { object: { sha: source } };
      if (path.startsWith('contents/releases/approved.json')) return content(approvedSamePayload);
      if (path.startsWith('contents/package.json')) return content({ name: 'anmerko', version: '0.5.4' });
      if (path === 'releases?per_page=100') return [{ ...pending, draft: false, prerelease: false,
        name: 'Briefmark 0.5.4 automated release', assets: [{ name: 'state-004.json' }] }];
      if (path.startsWith('compare/')) return { files: [] };
      assert.fail(`Unexpected no-op API call: ${path}`);
    };
    const callsBeforeNoOp = ghCalls.length; await resolveRelease({ api: noOpApi, gh });
    actual = outputs(await readFile(process.env.GITHUB_OUTPUT, 'utf8'));
    assert.equal(actual.run, 'false'); assert.equal(ghCalls.length, callsBeforeNoOp, 'Second button does not publish or dispatch duplicate work');
  } finally {
    for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
