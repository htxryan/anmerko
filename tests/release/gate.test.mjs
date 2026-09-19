import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertReleaseEvidence, assertPromotion, assertFastEvidence, assertMainAttestation, selectEvidenceSource, verifyFastEvidence } from '../../scripts/release/release-gate.mjs';
import { digest } from '../../scripts/release/approved-release.mjs';
import { activeRepository } from '../../scripts/release/release-repository.mjs';
const source = 'a'.repeat(40), hash = 'b'.repeat(64);
const active = activeRepository();
const inactive = active === 'htxryan/briefmark' ? 'htxryan/anmerko' : 'htxryan/briefmark';
function candidate() {
  return { schema: 1, source, scope: 'full', workflowVersion: hash, version: '1.0.0', previous: hash,
    browsers: { chrome: { sha256: hash } },
    automated: { source, scope: 'full', workflowVersion: hash, result: 'passed', packages: { chrome: hash } },
    manual: { source, browsers: { chrome: Object.fromEntries(['darwin','linux','win32'].map(os => [os, {
      sha256: hash, version: '1.0.0', result: 'passed', evidence: `docs/evidence/${os}.json`,
      scenarios: Object.fromEntries(['P1','P2','P3','P4','P5','P6','P7','P8'].map(id => [id, 'passed'])),
    }])) } },
  };
}
test('release eligibility requires exact full evidence and complete native platform records', () => {
  assert.doesNotThrow(() => assertReleaseEvidence(candidate()));
  for (const mutate of [c => { c.automated.scope = 'fast'; }, c => { c.automated.result = 'skipped'; },
    c => { c.automated.packages.chrome = 'c'.repeat(64); }, c => { c.automated.source = 'c'.repeat(40); },
    c => { delete c.manual.browsers.chrome.darwin; }, c => { c.manual.browsers.chrome.linux.scenarios.P8 = 'unrun'; },
    c => { c.manual.browsers.chrome.linux.sha256 = 'c'.repeat(64); }, c => { c.automated.workflowVersion = 'old'; }]) {
    const c = candidate(); mutate(c); assert.throws(() => assertReleaseEvidence(c));
  }
});
test('Firefox requires signed installation/upgrade and physical Android evidence independently', () => {
  const c = candidate();c.browsers.firefox = { sha256: hash };c.automated.packages.firefox = hash;
  c.manual.browsers.firefox = structuredClone(c.manual.browsers.chrome);
  assert.throws(() => assertReleaseEvidence(c), /signed|Android/);
  c.automated.signedFirefox = { result: 'passed', sha256: hash };
  assert.throws(() => assertReleaseEvidence(c), /Android/);
  c.manual.browsers.firefox.android = { ...c.manual.browsers.chrome.linux, device: 'physical phone',
    browser: 'Firefox 155', evidence: 'docs/evidence/android.json' };
  assert.doesNotThrow(() => assertReleaseEvidence(c));
});
test('fast source evidence must be completed, successful and from trusted main Check', () => {
  const run = { event: 'push', head_branch: 'main', head_sha: source, repository: { full_name: active },
    head_repository: { full_name: active }, path: '.github/workflows/check.yml', status: 'completed', conclusion: 'success' };
  assert.doesNotThrow(() => assertFastEvidence(run, source));
  for (const overrides of [{ conclusion: 'cancelled' }, { status: 'in_progress' }, { event: 'pull_request' }, { head_sha: 'old' }, { path: 'other.yml' }]) {
    assert.throws(() => assertFastEvidence({ ...run, ...overrides }, source));
  }
  const renamed = { ...run, repository: { full_name: inactive }, head_repository: { full_name: inactive } };
  assert.doesNotThrow(() => assertFastEvidence(renamed, source, inactive));
  assert.throws(() => assertFastEvidence(run, source, inactive));
});
test('promotion serializes on previous manifest and rollback must restore an approved manifest', () => {
  const current = { sequence: 3, browsers: { chrome: 'current' }, demo: 'current demo' };
  const next = { sequence: 4, previous: digest(JSON.stringify(current)), browsers: { chrome: 'new' }, demo: 'new demo' };
  assert.doesNotThrow(() => assertPromotion(current, next));
  assert.throws(() => assertPromotion({ ...current, sequence: 4 }, next), /stale|sequence/);
  assert.throws(() => assertPromotion(current, { ...next, sequence: 3 }), /sequence/);
  const approved = { browsers: { chrome: 'old' }, demo: 'old demo' };
  assert.throws(() => assertPromotion(current, { ...next, rollback: 'old' }, approved), /rollback/);
  assert.doesNotThrow(() => assertPromotion(current, { ...next, ...approved, rollback: 'old' }, approved));
});

test('direct main checks must carry the current schema, scope and policy fingerprint', async () => {
  const { assertMainAttestation } = await import('../../scripts/release/release-gate.mjs');
  const run = { id: 123, run_attempt: 1, event: 'push' };
  const record = { schema: 2, repository: 'htxryan/briefmark', sha: source, scope: 'fast', workflowVersion: hash,
    runId: 123, runAttempt: 1, event: 'push', ref: 'refs/heads/main' };
  assert.doesNotThrow(() => assertMainAttestation(record, run, source, hash));
  assert.doesNotThrow(() => assertMainAttestation({ ...record, repository: 'htxryan/anmerko' }, run, source, hash));
  assert.throws(() => assertMainAttestation({ ...record, repository: 'someone/fork' }, run, source, hash), /repository/);
  for (const patch of [{ schema: 1 }, { scope: 'unknown' }, { workflowVersion: 'old' }, { sha: 'old' },
    { runAttempt: 2 }, { runId: 124 }, { event: 'pull_request' }, { ref: 'refs/heads/feature' }]) {
    assert.throws(() => assertMainAttestation({ ...record, ...patch }, run, source, hash));
  }
});

test('policy fingerprint reads an alternate tracked tree without executing it', async t => {
  const { workflowVersion } = await import('../../scripts/ci/ci-policy.mjs');
  const root = await mkdtemp(join(tmpdir(), 'anmerko-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'scripts'), { recursive: true });
  await writeFile(join(root, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(join(root, 'scripts/policy.mjs'), 'throw new Error("must only be read");\n');
  await writeFile(join(root, 'scripts/policy.bin'), Buffer.from([0, 255, 10]));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'first']);
  const firstRef = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const first = workflowVersion({ root });
  assert.equal(workflowVersion({ root, ref: firstRef }), first);
  await writeFile(join(root, 'package.json'), '{"name":"changed"}\n');
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'second']);
  const secondRef = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const treeRef = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim();
  assert.notEqual(workflowVersion({ root, ref: secondRef }), first);
  assert.equal(workflowVersion({ root, ref: firstRef }), first);
  assert.throws(() => workflowVersion({ root, ref: 'HEAD' }), /immutable commit/);
  assert.throws(() => workflowVersion({ root, ref: treeRef }));
  assert.throws(() => workflowVersion({ root, ref: '0'.repeat(40) }));
  await rm(join(root, 'scripts/policy.mjs'));
  assert.throws(() => workflowVersion({ root }), /ENOENT/);
});

test('read-only proof binds an ancestor attestation to that source policy', async t => {
  const { workflowVersion } = await import('../../scripts/ci/ci-policy.mjs');
  const root = await mkdtemp(join(tmpdir(), 'anmerko-ancestor-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'scripts'), { recursive: true });
  await writeFile(join(root, 'package.json'), '{"name":"fixture"}\n');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'ancestor']);
  const ancestor = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  await writeFile(join(root, 'scripts/policy.mjs'), 'export const changed = true;\n');
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base']);
  const base = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const unrelated = 'c'.repeat(40);
  const runs = [{ id: 3, head_sha: base }, { id: 2, head_sha: ancestor }, { id: 1, head_sha: unrelated }];
  const compare = (candidate, requested) => {
    assert.equal(requested, base);
    if (candidate === ancestor) return { status: 'ahead', merge_base_commit: { sha: ancestor } };
    return { status: 'diverged', merge_base_commit: { sha: unrelated } };
  };
  const attestation = new Map([[2, { schema: 2, repository: active, sha: ancestor, scope: 'fast',
    workflowVersion: workflowVersion({ root, ref: ancestor }), runId: 2, runAttempt: 1,
    event: 'push', ref: 'refs/heads/main' }]]);
  const verifies = (records, expectedPolicy) => (run, candidate) => {
    const record = records.get(run.id);
    if (!record) return false;
    try {
      assertMainAttestation(record, { id: run.id, run_attempt: 1, event: 'push' }, candidate, expectedPolicy(candidate));
      return true;
    } catch { return false; }
  };
  const verifiesSelectedSource = verifies(attestation, candidate => workflowVersion({ root, ref: candidate }));
  assert.deepEqual(selectEvidenceSource({ requested: base, proof: true, runs, compare, verify: verifiesSelectedSource }),
    { source: ancestor, run: runs[1] });
  // Substituting the requested source's policy cannot authorize its ancestor.
  const verifiesBasePolicy = verifies(attestation, () => workflowVersion({ root, ref: base }));
  assert.equal(selectEvidenceSource({ requested: base, proof: true, runs, compare, verify: verifiesBasePolicy }), null);
  const tampered = new Map([[2, { ...attestation.get(2), workflowVersion: 'tampered' }]]);
  assert.equal(selectEvidenceSource({ requested: base, proof: true, runs, compare,
    verify: verifies(tampered, candidate => workflowVersion({ root, ref: candidate })) }), null);
  // A successful Check on a different main line cannot be selected.
  assert.equal(selectEvidenceSource({ requested: base, proof: true, runs, compare, verify: ({ id }) => id === 1 }), null);
  // Publication resolution never widens the source from its requested commit.
  assert.equal(selectEvidenceSource({ requested: base, proof: false, runs, compare, verify: verifiesSelectedSource }), null);
});

test('only read-only proof may use exact reusable PR evidence without a current main artifact', () => {
  // A rerun may expose a successful site-only main Check but retain its first
  // attempt's artifact name. The linked PR evidence is independently verified.
  const run = { id: 123, run_attempt: 1, event: 'push' };
  const record = { schema: 2, repository: active, sha: source, scope: 'fast', workflowVersion: hash,
    runId: 123, runAttempt: 1, event: 'push', ref: 'refs/heads/main' };
  const validMain = () => { assertMainAttestation(record, run, source, hash); return true; };
  assert.equal(verifyFastEvidence({ direct: false, readOnlyProof: true, verifyReuse: () => true,
    verifyMain: () => assert.fail('Read-only reusable proof must not read a main artifact') }), true);
  assert.equal(verifyFastEvidence({ direct: false, readOnlyProof: true, verifyReuse: () => false,
    verifyMain: () => assert.fail('Invalid reusable evidence must reject before reading main evidence') }), false);
  // Direct evidence always validates its current main attestation.
  assert.equal(verifyFastEvidence({ direct: true, readOnlyProof: true, verifyReuse: () => assert.fail('Direct proof must not reuse'), verifyMain: validMain }), true);
  assert.throws(() => verifyFastEvidence({ direct: true, readOnlyProof: true, verifyReuse: () => assert.fail('Direct proof must not reuse'),
    verifyMain: () => { assertMainAttestation({ ...record, workflowVersion: 'wrong' }, run, source, hash); return true; } }));
  // Production validates its current main attestation even after valid reuse.
  assert.equal(verifyFastEvidence({ direct: false, readOnlyProof: false, verifyReuse: () => true, verifyMain: validMain }), true);
  assert.throws(() => verifyFastEvidence({ direct: false, readOnlyProof: false, verifyReuse: () => true,
    verifyMain: () => { throw new Error('Missing current main attestation'); } }));
});


test('dispatched promotion checks reject branches predating current main policy', async () => {
  const { assertPromotionBase } = await import('../../scripts/release/release-gate.mjs');
  assert.doesNotThrow(() => assertPromotionBase('main', { status: 'ahead', merge_base_commit: { sha: 'main' } }));
  assert.throws(() => assertPromotionBase('new-main', { status: 'diverged', merge_base_commit: { sha: 'old-main' } }), /include current main/);
});

test('release eligibility does not require Windows evidence during the hold', () => {
  const c = candidate();
  delete c.manual.browsers.chrome.win32;
  assert.doesNotThrow(() => assertReleaseEvidence(c));
});
