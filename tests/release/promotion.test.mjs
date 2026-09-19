import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { assertArchiveRetirement, verifyApproved } from '../../scripts/release/verify-approved-release.mjs';
import { digest, validateManifest } from '../../scripts/release/approved-release.mjs';

const pinned = JSON.parse(await readFile(new URL('../../releases/approved.json', import.meta.url)));
const historical = JSON.parse(await readFile(new URL('../fixtures/release/approved-sequence-8.json', import.meta.url)));
const historicalDigest = digest(JSON.stringify(historical));

test('the one-time migration preserves every approved browser and removes only demo metadata', async () => {
  assert.equal(historicalDigest, '18cedc5f1f240877054d28fbc4aa5dd584ae2ca172fcaecc9a8dc1f8c147cd8a');
  assert.doesNotThrow(() => assertArchiveRetirement(historical, pinned));
  await assert.doesNotReject(verifyApproved({ current: historical, next: pinned }));
  assert.equal(pinned.demo, undefined);
  assert.equal(validateManifest(pinned), pinned);
});

test('archive retirement rejects every change beyond the exact metadata removal', () => {
  const migrated = structuredClone(pinned);
  const mutations = [
    value => { value.schema = 3; }, value => { value.sequence = 10; }, value => { value.previous = 'f'.repeat(64); },
    value => { value.validation.kind = 'release'; }, value => { value.browsers.chrome.artifact.sha256 = 'f'.repeat(64); },
    value => { value.browsers.chrome.artifact.location += '-changed'; }, value => { delete value.browsers.firefox; },
    value => { value.demo = {}; }, value => { value.unknown = true; },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(migrated); mutate(changed);
    assert.throws(() => assertArchiveRetirement(historical, changed));
  }
  const wrongSource = structuredClone(historical); wrongSource.browsers.chrome.source = 'f'.repeat(40);
  assert.throws(() => assertArchiveRetirement(wrongSource, pinned), /exact sequence-8/);
});

test('future manifests reject retired schema and fields', () => {
  for (const mutate of [value => { value.schema = 1; }, value => { value.demo = {}; }, value => { value.unknown = true; }]) {
    const changed = structuredClone(pinned); mutate(changed); assert.throws(() => validateManifest(changed));
  }
});

test('automation promotion remains bound to its run, full Check, repository and durable package evidence', async () => {
  const source = 'a'.repeat(40), controller = 'b'.repeat(40), version = '0.6.0', phase = 'firefox';
  const packages = {
    chrome: { version, filename: `anmerko-${version}.zip`, sha256: digest('chrome') },
    edge: { version, filename: `anmerko-${version}-edge.zip`, sha256: digest('chrome') },
    firefox: { version: `${version}.1`, filename: `anmerko-${version}.1-firefox.xpi`, sha256: digest('signed firefox') },
  };
  const evidence = { schema: 1, source, controller, version, phase, checkRun: 456, payloadFingerprint: 'f'.repeat(64),
    files: Object.fromEntries(Object.values(packages).map(item => [item.filename, item.sha256])), browsers: packages };
  const evidenceBytes = Buffer.from(JSON.stringify(evidence));
  const tag = `automation-${version.replaceAll('.', '-')}-${source}`, base = `https://github.com/htxryan/anmerko/releases/download/${tag}`;
  const next = { ...structuredClone(pinned), sequence: 10, previous: digest(JSON.stringify(pinned)), validation: {
    kind: 'automation', runId: 123, runAttempt: 2, source, controller, checkRun: 456, version, phase,
    payloadFingerprint: evidence.payloadFingerprint,
    record: { location: `${base}/promotion-${phase}-${controller}.json`, sha256: digest(evidenceBytes) },
  }, browsers: Object.fromEntries(Object.entries(packages).map(([browser, item]) => [browser, { version: item.version, source,
    artifact: { filename: item.filename, location: `${base}/${item.filename}`, sha256: item.sha256 } }])) };
  const success = name => ({ name, status: 'completed', conclusion: 'success' });
  const releaseRun = { path: '.github/workflows/release.yml', event: 'schedule', head_branch: 'main', head_sha: controller,
    repository: { full_name: 'htxryan/anmerko' }, head_repository: { full_name: 'htxryan/anmerko' }, status: 'completed', conclusion: 'success', run_attempt: 2 };
  const checkRun = { path: '.github/workflows/check.yml', head_branch: `codex/release-source-${source}`, head_sha: source,
    repository: { full_name: 'htxryan/anmerko' }, head_repository: { full_name: 'htxryan/anmerko' }, status: 'completed', conclusion: 'success' };
  const checkJobs = ['Changed paths', 'Lint and types', 'Chrome', 'Firefox / Android',
    'Desktop browsers (ubuntu-latest) / Browser scenarios', 'Desktop browsers (macos-latest) / Browser scenarios'].map(success);
  const release = { tag_name: tag, target_commitish: source, assets: [
    { name: `promotion-${phase}-${controller}.json`, digest: `sha256:${digest(evidenceBytes)}` },
    ...Object.values(packages).map(item => ({ name: item.filename, digest: `sha256:${item.sha256}` })),
  ] };
  const get = path => {
    if (path === 'actions/runs/123') return releaseRun;
    if (path.includes('actions/runs/123/attempts/2/jobs')) return { jobs: [success('One-button release')] };
    if (path === 'actions/runs/123/artifacts?per_page=100') return { artifacts: [{ name: 'release-evidence-2', expired: false }] };
    if (path === 'actions/runs/456') return checkRun;
    if (path.includes('actions/runs/456/attempts/')) return { jobs: checkJobs };
    if (path === 'git/ref/heads/main') return { object: { sha: controller } };
    if (path.startsWith('compare/')) return { merge_base_commit: { sha: source }, status: 'ahead' };
    if (path === 'releases?per_page=100&page=1') return [release];
    assert.fail(`Unexpected API request: ${path}`);
  };
  const read = async artifact => artifact.location.endsWith('.json') ? evidenceBytes
    : Buffer.from(artifact.filename.includes('firefox') ? 'signed firefox' : 'chrome');
  const options = { next, current: pinned, get, read, original: async () => evidenceBytes };
  await verifyApproved(options);
  const mutate = async change => { const value = structuredClone(next); change(value); await assert.rejects(verifyApproved({ ...options, next: value })); };
  await mutate(value => { value.validation.runId++; });
  await mutate(value => { value.validation.source = 'c'.repeat(40); });
  await mutate(value => { value.validation.payloadFingerprint = 'bad'; });
  await mutate(value => { value.browsers.chrome.artifact.sha256 = 'd'.repeat(64); });
  const wrongRepository = path => path === 'actions/runs/456'
    ? { ...checkRun, repository: { full_name: 'someone/fork' } } : get(path);
  await assert.rejects(verifyApproved({ ...options, get: wrongRepository }));
  checkJobs.find(job => job.name.includes('macos-latest')).conclusion = 'failure';
  await assert.rejects(verifyApproved(options), /macOS|Check job/);
  checkJobs.find(job => job.name.includes('macos-latest')).conclusion = 'success';
  await assert.rejects(verifyApproved({ ...options, original: async () => Buffer.from('forged') }));
  release.assets.shift();
  await assert.rejects(verifyApproved(options));
});

test('manual promotion requires current policy, successful full run and exact durable evidence', async () => {
  const source = 'd'.repeat(40), policy = 'e'.repeat(64), version = '0.6.0';
  const filename = `anmerko-${version}.zip`, installer = Buffer.from('tested package'), sha256 = digest(installer);
  const scenarios = Object.fromEntries(['P1','P2','P3','P4','P5','P6','P7','P8'].map(id => [id, 'passed']));
  const candidate = { schema: 1, source, version, scope: 'full', workflowVersion: policy, eligible: true,
    previous: digest(JSON.stringify(pinned)), browsers: { chrome: { filename, sha256 } },
    automated: { result: 'passed', source, scope: 'full', workflowVersion: policy, packages: { chrome: sha256 } },
    manual: { source, browsers: { chrome: Object.fromEntries(['darwin','linux'].map(os => [os, {
      result: 'passed', version, sha256, evidence: `docs/evidence/${os}.json`, scenarios,
    }])) } } };
  const bytes = Buffer.from(JSON.stringify(candidate)), tag = `approved-${source}-123-1`;
  const base = `https://github.com/htxryan/anmerko/releases/download/${tag}`;
  const next = { ...structuredClone(pinned), sequence: 10, previous: candidate.previous,
    validation: { kind: 'release', runId: 123, runAttempt: 1, source, workflowVersion: policy,
      record: { location: `${base}/validation.json`, sha256: digest(bytes) } },
    browsers: { ...pinned.browsers, chrome: { version, source, artifact: { filename, sha256, location: `${base}/${filename}` } } } };
  const success = name => ({ name, status: 'completed', conclusion: 'success' });
  const jobs = ['Resolve release source','Prepare and test exact packages','Release gate',
    'Release desktop (ubuntu-latest) / Browser scenarios', 'Release desktop (macos-latest) / Browser scenarios'].map(success);
  const run = { path: '.github/workflows/release.yml', event: 'workflow_dispatch', head_branch: 'main', run_attempt: 1,
    repository: { full_name: 'htxryan/anmerko' }, head_repository: { full_name: 'htxryan/anmerko' }, status: 'completed', conclusion: 'success' };
  const release = { tag_name: tag, target_commitish: source, assets: [
    { name: 'validation.json', digest: `sha256:${digest(bytes)}` }, { name: filename, digest: `sha256:${sha256}` },
  ] };
  const get = path => path.startsWith('releases?') ? [release] : path.includes('/jobs?') ? { jobs } : run;
  const options = { next, current: pinned, get, read: async artifact => artifact.location.endsWith('.json') ? bytes : installer,
    original: async () => bytes, policy: () => policy };
  await verifyApproved(options);
  await assert.rejects(verifyApproved({ ...options, policy: () => 'f'.repeat(64) }), /policy changed/);
  await assert.rejects(verifyApproved({ ...options, original: async () => Buffer.from('forged') }), /Forged/);
  jobs.find(job => job.name === 'Release gate').conclusion = 'failure';
  await assert.rejects(verifyApproved(options));
  jobs.find(job => job.name === 'Release gate').conclusion = 'success';
  release.assets[1].digest = `sha256:${digest('changed')}`;
  await assert.rejects(verifyApproved(options));
});
