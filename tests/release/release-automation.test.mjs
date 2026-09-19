import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activeTrustedCheck, candidateFingerprint, changesExtensionPayload, checkArtifactPrefix, requiredCheckJobs } from '../../scripts/release-automation.mjs';
import { activeRepository } from '../../scripts/release-repository.mjs';
const active = activeRepository();
const inactive = active === 'htxryan/briefmark' ? 'htxryan/anmerko' : 'htxryan/briefmark';

test('Check report prefix follows only the exact source package family', () => {
  assert.equal(checkArtifactPrefix({ name: 'briefmark' }, '0.5.2'), 'briefmark');
  assert.equal(checkArtifactPrefix({ name: 'anmerko' }, '0.5.5'), 'anmerko');
  assert.throws(() => checkArtifactPrefix({ name: 'other' }, '0.5.5'), /Unknown release artifact family/);
  assert.throws(() => checkArtifactPrefix({}, '0.5.5'), /package name is missing/);
});

test('candidate fingerprint is stable across file enumeration order and changes with bytes', () => {
  assert.equal(candidateFingerprint({ b: '2', a: '1' }), candidateFingerprint({ a: '1', b: '2' }));
  assert.notEqual(candidateFingerprint({ a: '1' }), candidateFingerprint({ a: '2' }));
});

test('website and release machinery changes reuse the extension family but payload changes do not', () => {
  assert.equal(changesExtensionPayload([{ filename: 'docs/release-process.md' }, { filename: 'scripts/release-state.mjs' }]), false);
  assert.equal(changesExtensionPayload([{ filename: 'src/core.ts' }]), true);
  assert.equal(changesExtensionPayload([{ filename: 'public/manifest.json' }]), true);
  assert.equal(changesExtensionPayload([{ filename: 'scripts/build-version.mjs' }]), true);
  assert.equal(changesExtensionPayload([{ filename: 'tsconfig.json' }]), true);
});

test('release CI requires successful Linux and local macOS evidence', () => {
  const success = name => ({ name, status: 'completed', conclusion: 'success' });
  const jobs = ['Changed paths', 'Lint and types', 'Chrome', 'Firefox / Android',
    'Desktop browsers (ubuntu-latest) / Browser scenarios', 'Desktop browsers (macos-latest) / Browser scenarios'].map(success);
  assert.doesNotThrow(() => requiredCheckJobs(jobs));
  for (let index = 0; index < jobs.length; index += 1) assert.throws(() => requiredCheckJobs(jobs.toSpliced(index, 1)));
  assert.throws(() => requiredCheckJobs(jobs.map(job => job.name === 'Chrome' ? { ...job, conclusion: 'failure' } : job)));
});

test('an active exact-source Check suppresses duplicate dispatch', () => {
  const source = 'a'.repeat(40), branch = `codex/release-source-${source}`;
  const run = { path: '.github/workflows/check.yml', event: 'workflow_dispatch', head_sha: source, head_branch: branch,
    repository: { full_name: active }, head_repository: { full_name: active }, status: 'in_progress' };
  assert.equal(activeTrustedCheck([run], source, ['main', branch]), true);
  for (const patch of [{ event: 'pull_request' }, { head_sha: 'b'.repeat(40) }, { head_branch: 'other' },
    { status: 'completed' }, { repository: { full_name: 'someone/fork' } },
    { head_repository: { full_name: 'someone/fork' } }, { repository: { full_name: inactive } },
    { head_repository: { full_name: inactive } }]) {
    assert.equal(activeTrustedCheck([{ ...run, ...patch }], source, ['main', branch]), false);
  }
  assert.equal(activeTrustedCheck([{ ...run, repository: { full_name: inactive }, head_repository: { full_name: inactive } }], source, ['main', branch], inactive), true);
  assert.equal(activeTrustedCheck([run], source, ['main', branch], inactive), false);
});
