import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveRelease } from '../scripts/release-automation.mjs';
import { createHash } from 'node:crypto';

const oldSource = 'a'.repeat(40), newSource = 'b'.repeat(40);
const oldTag = `automation-0-5-3-${oldSource}`, newTag = `automation-0-5-4-${newSource}`;
const content = value => ({ content: Buffer.from(JSON.stringify(value)).toString('base64') });
const plan = (source, version, supersedes) => ({ schema: 1, source, version, adopt: false, releaseRun: 10, releaseAttempt: 1, ...(supersedes && { supersedes }) });
const oldState = {
  schema: 2, revision: 8, source: oldSource, version: '0.5.3', payloadFingerprint: 'c'.repeat(64), checkRun: 4,
  website: { chrome: 'ready', edge: 'ready', firefox: 'ready', deployment: 'published' },
  stores: { chrome: 'published', firefox: 'pending-review' }, promotion: null, complete: false,
};
const release = (tag_name, body, assets = []) => ({ tag_name, body: JSON.stringify(body), target_commitish: body.source,
  draft: false, prerelease: true, created_at: '2026-09-14T00:00:00Z', assets });
const stateBytes = state => Buffer.from(JSON.stringify(state));
const stateAsset = state => ({ id: state.revision, name: `state-${String(state.revision).padStart(3, '0')}.json`,
  digest: `sha256:${createHash('sha256').update(stateBytes(state)).digest('hex')}` });

function environment(directory, event, resumeOnly = false) {
  process.env.GITHUB_EVENT_NAME = event; process.env.GITHUB_RUN_ID = '20'; process.env.GITHUB_RUN_ATTEMPT = '1';
  process.env.GITHUB_OUTPUT = join(directory, 'output'); process.env.GITHUB_STEP_SUMMARY = join(directory, 'summary');
  process.env.RELEASE_RESUME_ONLY = resumeOnly ? 'true' : '';
  delete process.env.RELEASE_VERSION_OVERRIDE;
}

function baseApi(releases, changed = [{ filename: 'src/comment-card.ts' }]) {
  return path => {
    if (path === 'git/ref/heads/main') return { object: { sha: newSource } };
    if (path.startsWith('contents/releases/approved.json')) return content({ validation: { kind: 'automation' }, browsers: {
      chrome: { source: oldSource, version: '0.5.3' }, firefox: { source: oldSource, version: '0.5.3.1' } } });
    if (path.startsWith('contents/package.json')) return content({ name: 'anmerko', version: '0.5.3' });
    if (path === 'releases?per_page=100') return releases;
    if (path === `compare/${oldSource}...${newSource}`) return { files: changed, merge_base_commit: { sha: oldSource }, status: 'ahead' };
    if (path === `compare/${newSource}...${newSource}`) return { merge_base_commit: { sha: newSource }, status: 'identical' };
    if (path.startsWith('actions/workflows/check.yml/runs?')) return { workflow_runs: [] };
    if (path === `git/ref/heads/codex/release-source-${newSource}`) throw new Error('not found');
    assert.fail(`Unexpected API call: ${path}`);
  };
}

test('explicit release appends planned and superseded truth before starting a deterministic newer release', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'anmerko-supersession-')); environment(directory, 'workflow_dispatch');
  await writeFile(process.env.GITHUB_OUTPUT, ''); await writeFile(process.env.GITHUB_STEP_SUMMARY, '');
  const old = release(oldTag, plan(oldSource, '0.5.3'), [stateAsset(oldState), { name: 'release-candidate.tgz' }]);
  const calls = [], gh = args => {
    calls.push(args);
    if (args[0] === 'api' && args.at(-1).endsWith('/8')) return stateBytes(oldState);
    return '';
  };
  await resolveRelease({ api: baseApi([old]), gh });
  const output = await readFile(process.env.GITHUB_OUTPUT, 'utf8');
  assert.match(output, new RegExp(`source=${newSource}`)); assert.match(output, /version=0\.5\.4/); assert.match(output, /resume=false/);
  const uploads = calls.filter(args => args[0] === 'release' && args[1] === 'upload');
  assert.equal(uploads.length, 2, 'Supersession plan and completion are separate append-only revisions');
  const states = await Promise.all(uploads.map(args => readFile(args[3], 'utf8').then(JSON.parse)));
  assert.deepEqual(states.map(state => state.supersession.status), ['planned', 'superseded']);
  assert.ok(states.every(state => state.complete === false && state.stores.firefox === 'pending-review'));
  const create = calls.find(args => args[0] === 'release' && args[1] === 'create');
  assert.equal(create[2], newTag); assert.equal(JSON.parse(create[create.indexOf('--notes') + 1]).supersedes, oldTag);
});

test('callbacks only resume the old release and cannot initiate supersession', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'anmerko-supersession-')); environment(directory, 'schedule');
  await writeFile(process.env.GITHUB_OUTPUT, ''); await writeFile(process.env.GITHUB_STEP_SUMMARY, '');
  const old = release(oldTag, plan(oldSource, '0.5.3'), [stateAsset(oldState), { name: 'release-candidate.tgz' }]);
  const calls = [], gh = args => { calls.push(args); return args[0] === 'api' ? stateBytes(oldState) : ''; };
  await resolveRelease({ api: baseApi([old]), gh });
  const output = await readFile(process.env.GITHUB_OUTPUT, 'utf8');
  assert.match(output, new RegExp(`source=${oldSource}`)); assert.match(output, /version=0\.5\.3/); assert.match(output, /resume=true/);
  assert.ok(!calls.some(args => args[0] === 'release' && ['create', 'upload'].includes(args[1])));
});

test('a crash after creating the new release reconciles the planned old state without another create', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'anmerko-supersession-')); environment(directory, 'schedule');
  await writeFile(process.env.GITHUB_OUTPUT, ''); await writeFile(process.env.GITHUB_STEP_SUMMARY, '');
  const planned = { ...oldState, revision: 9, supersession: { status: 'planned', fromTag: oldTag, newTag, newSource,
    newVersion: '0.5.4', releaseRun: 10, releaseAttempt: 1 } };
  const old = release(oldTag, plan(oldSource, '0.5.3'), [stateAsset(planned)]);
  const next = release(newTag, plan(newSource, '0.5.4', oldTag)); next.draft = true; next.prerelease = false;
  const calls = [], gh = args => { calls.push(args); return args[0] === 'api' ? stateBytes(planned) : ''; };
  await resolveRelease({ api: baseApi([next, old]), gh });
  assert.ok(!calls.some(args => args[0] === 'release' && args[1] === 'create'));
  assert.equal(calls.filter(args => args[0] === 'release' && args[1] === 'upload').length, 1);
  assert.match(await readFile(process.env.GITHUB_OUTPUT, 'utf8'), /version=0\.5\.4/);
});

test('supersession honors an explicit newer version override', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'anmerko-supersession-')); environment(directory, 'workflow_dispatch');
  process.env.RELEASE_VERSION_OVERRIDE = '0.5.6';
  await writeFile(process.env.GITHUB_OUTPUT, ''); await writeFile(process.env.GITHUB_STEP_SUMMARY, '');
  const old = release(oldTag, plan(oldSource, '0.5.3'), [stateAsset(oldState), { name: 'release-candidate.tgz' }]);
  const calls = [], gh = args => { calls.push(args); return args[0] === 'api' ? stateBytes(oldState) : ''; };
  await resolveRelease({ api: baseApi([old]), gh });
  assert.match(await readFile(process.env.GITHUB_OUTPUT, 'utf8'), /version=0\.5\.6/);
  assert.ok(calls.some(args => args[0] === 'release' && args[1] === 'create'
    && args[2] === `automation-0-5-6-${newSource}`));
});

test('planned recovery rejects a non-deterministic target before mutation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'anmerko-supersession-')); environment(directory, 'schedule');
  await writeFile(process.env.GITHUB_OUTPUT, ''); await writeFile(process.env.GITHUB_STEP_SUMMARY, '');
  const planned = { ...oldState, revision: 9, supersession: { status: 'planned', fromTag: oldTag,
    newTag: `automation-0-5-4-${'d'.repeat(40)}`, newSource, newVersion: '0.5.4', releaseRun: 10, releaseAttempt: 1 } };
  const old = release(oldTag, plan(oldSource, '0.5.3'), [stateAsset(planned)]);
  const calls = [], gh = args => { calls.push(args); return args[0] === 'api' ? stateBytes(planned) : ''; };
  await assert.rejects(resolveRelease({ api: baseApi([old]), gh }), /not deterministic/);
  assert.ok(!calls.some(args => args[0] === 'release'));
});

test('explicit release resumes without mutation until supersession readiness and payload guards pass', async () => {
  const variants = [
    [{ ...oldState, website: { ...oldState.website, deployment: 'pending' } }, /Publish the previous website/],
    [{ ...oldState, stores: { ...oldState.stores, chrome: 'pending-review' } }, /Publish the previous Chrome/],
  ];
  for (const [state] of variants) {
    const directory = await mkdtemp(join(tmpdir(), 'anmerko-supersession-')); environment(directory, 'workflow_dispatch');
    await writeFile(process.env.GITHUB_OUTPUT, ''); await writeFile(process.env.GITHUB_STEP_SUMMARY, '');
    const old = release(oldTag, plan(oldSource, '0.5.3'), [stateAsset(state), { name: 'release-candidate.tgz' }]);
    const calls = [];
    await resolveRelease({ api: baseApi([old]), gh: args => { calls.push(args); return args[0] === 'api' ? stateBytes(state) : ''; } });
    assert.match(await readFile(process.env.GITHUB_OUTPUT, 'utf8'), /version=0\.5\.3/);
    assert.ok(!calls.some(args => args[0] === 'release' && ['create', 'upload'].includes(args[1])));
  }
  const directory = await mkdtemp(join(tmpdir(), 'anmerko-supersession-')); environment(directory, 'workflow_dispatch');
  await writeFile(process.env.GITHUB_OUTPUT, ''); await writeFile(process.env.GITHUB_STEP_SUMMARY, '');
  const old = release(oldTag, plan(oldSource, '0.5.3'), [stateAsset(oldState), { name: 'release-candidate.tgz' }]);
  const calls = [];
  await resolveRelease({ api: baseApi([old], [{ filename: 'docs/release-process.md' }]),
    gh: args => { calls.push(args); return args[0] === 'api' ? stateBytes(oldState) : ''; } });
  assert.match(await readFile(process.env.GITHUB_OUTPUT, 'utf8'), /version=0\.5\.3/);
  assert.ok(!calls.some(args => args[0] === 'release' && ['create', 'upload'].includes(args[1])));
});

test('release state digest and identity are trusted before candidate retirement', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'anmerko-supersession-')); environment(directory, 'workflow_dispatch');
  await writeFile(process.env.GITHUB_OUTPUT, ''); await writeFile(process.env.GITHUB_STEP_SUMMARY, '');
  const wrong = { ...oldState, version: '0.5.2' };
  const old = release(oldTag, plan(oldSource, '0.5.3'), [stateAsset(wrong), { name: 'release-candidate.tgz' }]);
  await assert.rejects(resolveRelease({ api: baseApi([old]), gh: args => args[0] === 'api' ? stateBytes(wrong) : '' }), /state version/);
  old.assets[0].digest = `sha256:${'0'.repeat(64)}`;
  await assert.rejects(resolveRelease({ api: baseApi([old]), gh: args => args[0] === 'api' ? stateBytes(wrong) : '' }), /digest/);
});
