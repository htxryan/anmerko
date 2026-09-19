import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { findReusableCheck, reuseOrRun } from '../../scripts/ci/reuse-ci.mjs';

test('release proof can read associated PR evidence across the reusable-workflow boundary', () => {
  const caller = readFileSync('.github/workflows/check.yml', 'utf8')
    .split('  release-proof:\n')[1].split('\n  continue-release:')[0];
  const reusable = readFileSync('.github/workflows/release-validation.yml', 'utf8')
    .split('\npermissions:\n')[1].split('\njobs:')[0];
  for (const boundary of [caller, reusable]) {
    for (const permission of ['contents', 'actions', 'pull-requests']) {
      assert.match(boundary, new RegExp(`\\b${permission}: read`));
    }
    assert.doesNotMatch(boundary, /:\s*write\b/);
  }
});

const hash = digit => digit.repeat(40);
function fixture() {
  const repository = 'owner/anmerko', commit = hash('1'), head = hash('2'), base = hash('3'), merge = hash('4'), tree = hash('5');
  const main = { tree: { sha: tree }, parents: [{ sha: base }] };
  const tested = { tree: { sha: tree }, parents: [{ sha: base }, { sha: head }] };
  const pr = { number: 12, merged: true, merge_commit_sha: commit,
    base: { ref: 'main', repo: { full_name: repository } }, head: { sha: head, repo: { full_name: repository } } };
  const run = { id: 42, run_attempt: 1, event: 'pull_request', status: 'completed', conclusion: 'success',
    path: '.github/workflows/check.yml', head_sha: head, repository: { full_name: repository },
    head_repository: { full_name: repository }, run_started_at: '2026-09-13T00:00:00Z' };
  const jobs = ['Changed paths', 'Lint and types', 'Chrome', 'Firefox / Android',
    ...['ubuntu-latest', 'windows-latest', 'macos-latest'].map(os => `Desktop browsers (${os}) / Browser scenarios`)]
    .map(name => ({ name, status: 'completed', conclusion: 'success' }));
  const artifact = { id: 99, name: 'ci-source-1', expired: false, size_in_bytes: 512 };
  const source = { schema: 2, scope: 'full', workflowVersion: 'policy-v2', repository, runId: 42, runAttempt: 1, pr: 12, head, base, sha: merge, tree };
  const root = `repos/${repository}`;
  const responses = new Map([
    [`${root}/git/commits/${commit}`, main], [`${root}/commits/${commit}/pulls?per_page=100`, [{ number: 12 }]],
    [`${root}/pulls/12`, pr],
    [`${root}/actions/workflows/check.yml/runs?event=pull_request&head_sha=${head}&status=success&per_page=10`, { workflow_runs: [run] }],
    [`${root}/actions/runs/42/attempts/1/jobs?per_page=100`, { jobs }],
    [`${root}/actions/runs/42/artifacts?per_page=100`, { artifacts: [artifact] }],
    [`${root}/git/commits/${merge}`, tested],
  ]);
  const options = { repository, commit, scope: 'full', version: 'policy-v2', event: 'push', ref: 'refs/heads/main', now: Date.parse('2026-09-13T01:00:00Z'),
    get(path) { assert.ok(responses.has(path), `Unexpected API request: ${path}`); return responses.get(path); },
    read: () => source };
  return { options, main, tested, pr, run, jobs, artifact, source, responses };
}

test('a passing PR with the identical Git tree and base can satisfy a squash or ordinary merge', () => {
  const f = fixture();
  const expected = { runId: 42, pr: 12, source: hash('4'), tree: hash('5'), url: 'https://github.com/owner/anmerko/actions/runs/42' };
  assert.deepEqual(findReusableCheck(f.options), expected);
  f.main.parents.push({ sha: hash('2') });
  assert.deepEqual(findReusableCheck(f.options), expected);
});

test('PRs, manual runs, other branches and malformed commits never query for reusable checks', () => {
  for (const override of [{ event: 'pull_request' }, { event: 'workflow_dispatch' }, { ref: 'refs/heads/feature' }, { commit: 'bad' }]) {
    const f = fixture();
    assert.equal(findReusableCheck({ ...f.options, ...override, get: () => assert.fail('Must run normally') }), null);
  }
});

test('reuse rejects incomplete, stale, unrelated or mismatched evidence', async t => {
  const cases = {
    'Linux-only evidence': f => { f.source.scope = 'fast'; },
    'unknown scope': f => { delete f.source.scope; },
    'old workflow version': f => { f.source.workflowVersion = 'old'; },
    'old schema': f => { f.source.schema = 1; },
    'not a merged PR': f => { f.pr.merged = false; },
    'different merge commit': f => { f.pr.merge_commit_sha = hash('6'); },
    'different target branch': f => { f.pr.base.ref = 'release'; },
    'fork PR': f => { f.pr.head.repo.full_name = 'other/anmerko'; },
    'different workflow': f => { f.run.path = '.github/workflows/other.yml'; },
    'different event': f => { f.run.event = 'workflow_dispatch'; },
    'different run head': f => { f.run.head_sha = hash('6'); },
    'foreign run repository': f => { f.run.repository.full_name = 'other/anmerko'; },
    'failed run': f => { f.run.conclusion = 'failure'; },
    'unfinished run': f => { f.run.status = 'in_progress'; },
    'older than one day': f => { f.options.now += 24 * 60 * 60 * 1000; },
    'missing timestamp': f => { delete f.run.run_started_at; },
    'missing required job': f => { f.jobs.pop(); },
    'skipped required job': f => { f.jobs[2].conclusion = 'skipped'; },
    'failed required job': f => { f.jobs[3].conclusion = 'failure'; },
    'duplicate required job': f => { f.jobs.push(f.jobs[2]); },
    'expired artifact': f => { f.artifact.expired = true; },
    'oversized artifact': f => { f.artifact.size_in_bytes = 65537; },
    'artifact from another attempt': f => { f.artifact.name = 'ci-source-2'; },
    'source from another attempt': f => { f.source.runAttempt = 2; },
    'source from another run': f => { f.source.runId = 43; },
    'source from another PR': f => { f.source.pr = 13; },
    'source from another repository': f => { f.source.repository = 'other/anmerko'; },
    'different merged tree': f => { f.main.tree.sha = hash('6'); },
    'different merge base': f => { f.main.parents[0].sha = hash('6'); },
    'falsified artifact tree': f => { f.tested.tree.sha = hash('6'); },
    'falsified tested head': f => { f.tested.parents[1].sha = hash('6'); },
    'falsified tested base': f => { f.tested.parents[0].sha = hash('6'); },
    'not a synthetic merge': f => { f.tested.parents.pop(); },
  };
  for (const [name, mutate] of Object.entries(cases)) await t.test(name, () => {
    const f = fixture(); mutate(f);
    assert.equal(findReusableCheck(f.options), null);
  });
});

test('API, archive and JSON errors fall back to the full suite', () => {
  for (const method of ['get', 'read']) {
    const f = fixture();
    f.options[method] = () => { throw new Error('Unavailable or malformed response'); };
    assert.equal(reuseOrRun(f.options).reuse, null);
  }
});

test('fast reuse accepts current Linux evidence but cannot promote it to full validation', () => {
  const f = fixture();
  f.options.scope = 'fast'; f.source.scope = 'fast'; f.jobs.splice(-2);
  assert.ok(findReusableCheck(f.options));
  assert.equal(findReusableCheck({ ...f.options, scope: 'full' }), null);
});

test('full CI reuse does not require Windows jobs during the hold', () => {
  const f = fixture();
  f.jobs.splice(f.jobs.findIndex(job => job.name.includes('windows-latest')), 1);
  assert.ok(findReusableCheck(f.options));
});
