import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { activeRepository } from './release-repository.mjs';
import { CURRENT_PRODUCT } from './release-names.mjs';

export const RELEASE_SCHEMA = 2;
export const releaseDigest = value => createHash('sha256').update(value).digest('hex');

export function parseVersion(value, parts = 3) {
  assert.match(value, new RegExp(`^\\d+(?:\\.\\d+){${parts - 1}}$`), `Expected a ${parts}-part version`);
  return value.split('.').map(Number);
}

export function compareVersions(a, b) {
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

export function nextReleaseVersion({ packageVersion, approvedVersions = [], storeVersions = [], override, adopt = false }) {
  const requested = override || packageVersion;
  parseVersion(requested);
  const known = [...approvedVersions, ...storeVersions].filter(Boolean).map(version => {
    assert.match(version, /^\d+\.\d+\.\d+(?:\.\d+)?$/, 'Expected a store version');
    return version.split('.').slice(0, 3).join('.');
  });
  if (override) {
    assert.ok(known.every(version => compareVersions(parseVersion(override), parseVersion(version)) > 0
      || (adopt && compareVersions(parseVersion(override), parseVersion(version)) === 0)),
    'Version override must exceed every approved and store version unless adopting verified existing bytes');
    return override;
  }
  const floor = known.reduce((highest, version) => compareVersions(parseVersion(version), parseVersion(highest)) > 0 ? version : highest, requested);
  if (known.every(version => compareVersions(parseVersion(requested), parseVersion(version)) > 0)) return requested;
  const [major, minor, patch] = parseVersion(floor);
  return `${major}.${minor}.${patch + 1}`;
}

export const firefoxWebsiteVersion = version => `${version}.1`;

export function releaseKey({ source, version }) {
  assert.match(source, /^[a-f0-9]{40}$/, 'Release source must be a full commit');
  parseVersion(version);
  return `${CURRENT_PRODUCT}-${version}-${source}`;
}

export function initialReleaseState({ source, version, payloadFingerprint, checkRun, releaseRun, releaseAttempt }) {
  assert.match(payloadFingerprint, /^[a-f0-9]{64}$/, 'Payload fingerprint must be a SHA-256');
  assert.ok(Number.isSafeInteger(checkRun) && checkRun > 0, 'A trusted Check run is required');
  return {
    schema: RELEASE_SCHEMA, revision: 1, source, version, releaseRun, releaseAttempt,
    firefoxWebsiteVersion: firefoxWebsiteVersion(version), payloadFingerprint, checkRun,
    website: { chrome: 'pending', edge: 'pending', firefox: 'pending', deployment: 'pending' },
    stores: { chrome: 'pending', firefox: 'pending' },
    promotion: 'pending', complete: false,
  };
}

export function advanceReleaseState(previous, patch) {
  assert.equal(previous.schema, RELEASE_SCHEMA);
  assert.equal(patch.source ?? previous.source, previous.source, 'Cannot change release source');
  assert.equal(patch.version ?? previous.version, previous.version, 'Cannot change release version');
  assert.equal(patch.payloadFingerprint ?? previous.payloadFingerprint, previous.payloadFingerprint, 'Cannot change release bytes');
  if (previous.supersession) {
    assert.ok(patch.supersession, 'Cannot remove a release supersession');
    const allowed = previous.supersession.status === 'planned' && patch.supersession.status === 'superseded';
    const same = JSON.stringify(patch.supersession) === JSON.stringify(previous.supersession);
    assert.ok(same || allowed, 'Cannot change a planned release supersession');
    if (allowed) assert.deepEqual({ ...patch.supersession, status: 'planned' }, previous.supersession,
      'Cannot change the target of a release supersession');
  }
  const next = { ...previous, ...patch, website: { ...previous.website, ...patch.website }, stores: { ...previous.stores, ...patch.stores } };
  next.complete = !next.supersession && ['chrome', 'edge', 'firefox'].every(browser => next.website[browser] === 'ready')
    && next.website.deployment === 'published'
    && next.promotion === null
    && next.stores.chrome === 'published'
    && next.stores.firefox === 'published';
  if (JSON.stringify(next) === JSON.stringify(previous)) return previous;
  next.revision = previous.revision + 1;
  return next;
}

export function shouldResume({ event, states }) {
  if (event === 'workflow_dispatch') return true;
  assert.ok(['schedule', 'workflow_run'].includes(event), 'Unsupported release event');
  return states.some(state => state.schema === RELEASE_SCHEMA && state.complete !== true);
}

export function assertTrustedCheck(run, { source, workflowPath = '.github/workflows/check.yml', branches = ['main'], repository = activeRepository() }) {
  assert.equal(run.path, workflowPath);
  assert.equal(run.head_sha, source);
  assert.ok(branches.includes(run.head_branch), 'Check ran on an untrusted branch');
  assert.ok(['push', 'workflow_dispatch'].includes(run.event));
  assert.equal(run.status, 'completed');
  assert.equal(run.conclusion, 'success');
  assert.equal(run.repository?.full_name, repository);
  assert.equal(run.head_repository?.full_name, repository);
}

export function chooseRelease({ event, source, existingStates }) {
  const pending = existingStates.filter(state => state.schema === RELEASE_SCHEMA && state.complete !== true)
    .sort((a, b) => b.revision - a.revision);
  if (pending.length) {
    const release = pending[0];
    assert.ok(pending.every(candidate => candidate.source === release.source && candidate.version === release.version),
      'More than one release is pending');
    return release;
  }
  if (event !== 'workflow_dispatch') return null;
  return { source };
}
