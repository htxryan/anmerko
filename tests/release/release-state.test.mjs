import assert from 'node:assert/strict';
import { test } from 'node:test';
import { advanceReleaseState, assertTrustedCheck, chooseRelease, firefoxWebsiteVersion, initialReleaseState, nextReleaseVersion, shouldResume } from '../../scripts/release/release-state.mjs';
import { activeRepository } from '../../scripts/release/release-repository.mjs';
const active = activeRepository();
const inactive = active === 'htxryan/briefmark' ? 'htxryan/anmerko' : 'htxryan/briefmark';

test('selects a new patch above package, approved, and store families', () => {
  assert.equal(nextReleaseVersion({ packageVersion: '0.5.3', approvedVersions: ['0.5.2'], storeVersions: [] }), '0.5.3');
  assert.equal(nextReleaseVersion({ packageVersion: '0.5.3', approvedVersions: ['0.5.3'], storeVersions: ['0.5.4'] }), '0.5.5');
  assert.equal(nextReleaseVersion({ packageVersion: '1.0.0', approvedVersions: ['0.9.9'], storeVersions: ['2.1.8'] }), '2.1.9');
  assert.equal(nextReleaseVersion({ packageVersion: '0.5.3', approvedVersions: ['0.5.3.1'] }), '0.5.4');
  assert.throws(() => nextReleaseVersion({ packageVersion: '0.5.3', approvedVersions: ['0.5.4'], override: '0.5.4' }), /exceed/);
  assert.equal(nextReleaseVersion({ packageVersion: '0.5.3', approvedVersions: ['0.5.3'], override: '0.5.3', adopt: true }), '0.5.3');
  assert.throws(() => nextReleaseVersion({ packageVersion: '0.5', approvedVersions: [] }), /3-part/);
});

test('uses a unique four-part Mozilla website channel version', () => {
  assert.equal(firefoxWebsiteVersion('0.5.4'), '0.5.4.1');
});

test('durable state cannot silently change source, version, or bytes', () => {
  const state = initialReleaseState({ source: 'a'.repeat(40), version: '0.5.4', payloadFingerprint: 'b'.repeat(64), checkRun: 42 });
  const pending = advanceReleaseState(state, { website: { chrome: 'ready', edge: 'ready' }, stores: { firefox: 'pending-review' } });
  assert.equal(pending.revision, 2); assert.equal(pending.complete, false);
  assert.equal(advanceReleaseState(pending, { stores: { firefox: 'pending-review' } }), pending, 'Unchanged polling must not consume a revision');
  const chromiumOnly = advanceReleaseState(pending, { website: { deployment: 'published', firefox: 'waiting-for-signature' }, stores: { chrome: 'published', firefox: 'published' }, promotion: null });
  assert.equal(chromiumOnly.complete, false, 'Firefox website signing must finish before release completion');
  const stillReviewing = advanceReleaseState(pending, { website: { firefox: 'ready', deployment: 'published' }, stores: { chrome: 'published' } });
  assert.equal(stillReviewing.complete, false);
  const pendingPromotion = advanceReleaseState(stillReviewing, { stores: { firefox: 'published' } });
  assert.equal(pendingPromotion.complete, false, 'An active promotion must prevent release completion');
  const complete = advanceReleaseState(pendingPromotion, { promotion: null });
  assert.equal(complete.complete, true);
  for (const patch of [{ source: 'c'.repeat(40) }, { version: '0.5.5' }, { payloadFingerprint: 'd'.repeat(64) }]) {
    assert.throws(() => advanceReleaseState(state, patch), /Cannot change/);
  }
  const planned = advanceReleaseState(pending, { supersession: { status: 'planned', fromTag: 'old', newTag: 'new',
    newSource: 'c'.repeat(40), newVersion: '0.5.5', releaseRun: 9, releaseAttempt: 1 } });
  assert.equal(planned.complete, false);
  assert.throws(() => advanceReleaseState(planned, { supersession: null }), /Cannot remove/);
  assert.throws(() => advanceReleaseState(planned, { supersession: { ...planned.supersession, newVersion: '0.5.6' } }), /Cannot change/);
  const superseded = advanceReleaseState(planned, { supersession: { ...planned.supersession, status: 'superseded' } });
  assert.equal(superseded.complete, false); assert.equal(superseded.supersession.status, 'superseded');
});

test('scheduled continuation resumes pending work and never creates a release', () => {
  const pending = { schema: 2, source: 'a'.repeat(40), version: '0.5.4', revision: 2, complete: false };
  assert.equal(shouldResume({ event: 'schedule', states: [] }), false);
  assert.equal(shouldResume({ event: 'schedule', states: [pending] }), true);
  assert.equal(chooseRelease({ event: 'schedule', source: 'b'.repeat(40), existingStates: [] }), null);
  assert.deepEqual(chooseRelease({ event: 'schedule', source: 'b'.repeat(40), existingStates: [pending] }), pending);
  assert.throws(() => chooseRelease({ event: 'workflow_dispatch', source: 'b'.repeat(40), existingStates: [pending, { ...pending, source: 'c'.repeat(40) }] }), /More than one/);
});

test('only a completed successful main Check for the exact source is trusted', () => {
  const run = { path: '.github/workflows/check.yml', head_sha: 'a'.repeat(40), head_branch: 'main', event: 'workflow_dispatch', status: 'completed', conclusion: 'success', repository: { full_name: active }, head_repository: { full_name: active } };
  assert.doesNotThrow(() => assertTrustedCheck(run, { source: 'a'.repeat(40) }));
  for (const patch of [{ head_sha: 'b'.repeat(40) }, { head_branch: 'feature' }, { event: 'pull_request' }, { conclusion: 'failure' }]) {
    assert.throws(() => assertTrustedCheck({ ...run, ...patch }, { source: 'a'.repeat(40) }));
  }
  assert.throws(() => assertTrustedCheck({ ...run, repository: { full_name: inactive } }, { source: 'a'.repeat(40) }));
  assert.throws(() => assertTrustedCheck({ ...run, head_repository: { full_name: inactive } }, { source: 'a'.repeat(40) }));
  const renamed = { ...run, repository: { full_name: inactive }, head_repository: { full_name: inactive } };
  assert.doesNotThrow(() => assertTrustedCheck(renamed, { source: 'a'.repeat(40), repository: inactive }));
  assert.throws(() => assertTrustedCheck(run, { source: 'a'.repeat(40), repository: inactive }));
});
