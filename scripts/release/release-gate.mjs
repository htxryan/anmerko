import assert from 'node:assert/strict';
import { digest, isSource } from './approved-release.mjs';
import { desktopScenarios } from '../../tests/shared/desktop-scenarios.mjs';
import { requiredOperatingSystems } from '../ci/ci-policy.mjs';
import { activeRepository, HISTORICAL_REPOSITORIES } from './release-repository.mjs';

export function assertFastEvidence(run, source, repository = activeRepository()) {
  assert.ok(isSource(source), 'Source must be an immutable commit');
  assert.ok(['push', 'workflow_dispatch'].includes(run.event), 'PR artifacts cannot authorize release');
  assert.equal(run.head_branch, 'main');
  assert.equal(run.head_sha, source);
  assert.equal(run.repository.full_name, repository);
  assert.equal(run.head_repository.full_name, repository);
  assert.equal(run.path, '.github/workflows/check.yml');
  assert.equal(run.status, 'completed');
  assert.equal(run.conclusion, 'success');
}
export function assertMainAttestation(record, run, source, version) {
  assert.equal(record.schema, 2);
  assert.ok(HISTORICAL_REPOSITORIES.includes(record.repository), 'Release evidence has an unexpected repository');
  assert.equal(record.sha, source);
  assert.equal(record.runId, run.id); assert.equal(record.runAttempt, run.run_attempt);
  assert.equal(record.event, run.event); assert.equal(record.ref, 'refs/heads/main');
  assert.ok(['fast', 'full'].includes(record.scope));
  assert.equal(record.workflowVersion, version, 'Main validation policy changed');
}
// A read-only release-gate PR may have a site-only requested source, so it can
// use the newest audited browser Check ancestor whose attestation matches that
// selected immutable source's policy. Publication verifies the exact source.
export function selectEvidenceSource({ requested, proof, runs, compare, verify }) {
  assert.ok(isSource(requested));
  const seen = new Set();
  const sources = proof ? [requested, ...runs.map(run => run.head_sha)] : [requested];
  for (const source of sources) {
    if (!isSource(source) || seen.has(source)) continue;
    seen.add(source);
    if (source !== requested) try {
      const relation = compare(source, requested);
      if (relation.merge_base_commit?.sha !== source || !['ahead', 'identical'].includes(relation.status)) continue;
    } catch { continue; /* An unavailable comparison is not proof of ancestry. */ }
    for (const run of runs) {
      if (run.head_sha !== source) continue;
      if (verify(run, source)) return { source, run };
    }
  }
  return null;
}
// Reused PR evidence has its own exact-attempt attestation and tree proof. Only
// read-only PR proof may rely on it without a current main-attempt artifact.
export function verifyFastEvidence({ direct, readOnlyProof, verifyMain, verifyReuse }) {
  if (!direct) {
    if (!verifyReuse()) return false;
    if (readOnlyProof) return true;
  }
  return verifyMain();
}
export function assertReleaseEvidence(candidate) {
  assert.equal(candidate.schema, 1);
  assert.ok(isSource(candidate.source));
  assert.equal(candidate.scope, 'full');
  assert.match(candidate.workflowVersion, /^[a-f0-9]{64}$/);
  const evidence = candidate.automated;
  assert.equal(evidence.result, 'passed');
  assert.equal(evidence.source, candidate.source);
  assert.equal(evidence.workflowVersion, candidate.workflowVersion);
  assert.equal(evidence.scope, 'full', 'Linux-only checks cannot authorize a release');
  assert.equal(candidate.manual?.source, candidate.source, 'Missing source-bound manual evidence');
  assert.ok(Object.keys(candidate.browsers).length > 0);
  for (const [browser, artifact] of Object.entries(candidate.browsers)) {
    assert.ok(['chrome', 'edge', 'firefox'].includes(browser));
    assert.equal(evidence.packages[browser], artifact.sha256, 'Candidate/package hash mismatch');
    for (const os of [...requiredOperatingSystems('full'), ...(browser === 'firefox' ? ['android'] : [])]) {
      const manual = candidate.manual.browsers?.[browser]?.[os];
      assert.ok(manual, `Missing ${browser} ${os === 'android' ? 'Android physical device' : os} evidence`);
      assert.equal(manual.result, 'passed');
      assert.equal(manual.version, candidate.version);
      assert.equal(manual.sha256, artifact.sha256, 'Manual evidence is for another package');
      assert.match(manual.evidence, /^docs\/evidence\/[A-Za-z0-9_./-]+$/);
      for (const scenario of Object.keys(desktopScenarios)) assert.equal(manual.scenarios?.[scenario], 'passed', `Missing ${browser}/${os}/${scenario}`);
      if (os === 'android') { assert.ok(manual.device && manual.browser, 'Android needs an actual device and browser record'); }
    }
    if (browser === 'firefox') {
      assert.equal(evidence.signedFirefox?.result, 'passed', 'Missing signed Firefox installation/upgrade evidence');
      assert.equal(evidence.signedFirefox.sha256, artifact.sha256);
    }
  }
}
export function assertPromotion(current, next, rollback) {
  assert.equal(next.sequence, current.sequence + 1, 'Invalid release sequence');
  assert.equal(next.previous, digest(JSON.stringify(current)), 'Stale previous approved manifest');
  if (next.rollback) {
    assert.ok(rollback, 'Missing approved rollback target');
    assert.deepEqual(next.browsers, rollback.browsers, 'Invalid rollback installers');
    assert.deepEqual(next.demo, rollback.demo, 'Invalid rollback demo');
  }
}

export function assertPromotionBase(base, comparison) {
  assert.equal(comparison.merge_base_commit.sha, base, 'Promotion branch must include current main; update the branch and dispatch Check again');
  assert.ok(['ahead', 'identical'].includes(comparison.status));
}
