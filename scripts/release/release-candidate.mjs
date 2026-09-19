import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { digest, isSource } from './approved-release.mjs';
import { assertFastEvidence, assertMainAttestation, assertReleaseEvidence, selectEvidenceSource, verifyFastEvidence } from './release-gate.mjs';
import { archivePayload, assertPackageReports, assertSignedFirefox, readReports } from './release-artifacts.mjs';
import { workflowVersion } from '../ci/ci-policy.mjs';
import { findReusableCheck, readSource } from '../ci/reuse-ci.mjs';
import { activeRepository } from './release-repository.mjs';
import { releaseArtifacts, releaseArtifactsFromCandidate } from './release-names.mjs';

const repository = activeRepository();
const command = (file, args, options = {}) => execFileSync(file, args, { encoding: 'utf8', timeout: 60000, ...options });
const api = (path, filter = '.') => JSON.parse(command('gh', ['api', `repos/${repository}/${path}`, '--jq', filter]));
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const output = (key, value) => appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
const evidenceFailure = error => error?.name === 'AssertionError'
  ? 'Evidence validation failed'
  : 'GitHub evidence request unavailable';
async function resolveSource() {
  const requestedSource = process.env.RELEASE_SOURCE;
  const readOnlyProof = process.env.RELEASE_PROOF === 'true';
  const validationPolicyRoot = readOnlyProof ? process.env.VALIDATION_POLICY_ROOT : '.';
  if (readOnlyProof) assert.ok(validationPolicyRoot && validationPolicyRoot !== '.', 'Read-only proof requires its checked-out source policy');
  assert.ok(isSource(requestedSource), 'Supply the full immutable source commit');
  // Large file patches can exceed execFileSync's buffer; ancestry needs only these fields.
  const comparison = api(`compare/${requestedSource}...main`, '{status, merge_base_commit: {sha: .merge_base_commit.sha}}');
  assert.ok(['ahead', 'identical'].includes(comparison.status), 'Release source must be on main');
  assert.equal(comparison.merge_base_commit.sha, requestedSource);
  const runs = api(readOnlyProof
    ? 'actions/workflows/check.yml/runs?branch=main&event=push&status=success&per_page=100'
    : `actions/workflows/check.yml/runs?head_sha=${requestedSource}&status=success&per_page=100`,
  '{workflow_runs: [.workflow_runs[] | {id, run_attempt, event, head_branch, head_sha, repository: {full_name: .repository.full_name}, head_repository: {full_name: .head_repository.full_name}, path, status, conclusion}]}').workflow_runs;
  const policyVersion = readOnlyProof ? null : workflowVersion({ root: validationPolicyRoot });
  const sourcePolicies = new Map();
  const policyFor = source => {
    if (!readOnlyProof) return policyVersion;
    if (!sourcePolicies.has(source)) sourcePolicies.set(source, workflowVersion({ root: validationPolicyRoot, ref: source }));
    return sourcePolicies.get(source);
  };
  const rejected = [];
  const selected = selectEvidenceSource({
    requested: requestedSource,
    proof: readOnlyProof,
    runs,
    compare: (candidate, requested) => api(`compare/${candidate}...${requested}`, '{status, merge_base_commit: {sha: .merge_base_commit.sha}}'),
    verify(run, candidateSource) {
      let stage = 'run identity';
      try {
        const candidatePolicy = policyFor(candidateSource);
        assertFastEvidence(run, candidateSource);
        stage = 'required Check jobs';
        const { jobs } = api(`actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`);
        const names = ['Lint and types', 'Chrome', 'Firefox / Android'];
        if (run.event === 'push') names.push('Changed paths');
        const direct = names.every(name => jobs.filter(job => job.name === name && job.status === 'completed' && job.conclusion === 'success').length === 1)
          && jobs.some(job => /^Desktop browsers \(ubuntu-latest\)( \/ Browser scenarios)?$/.test(job.name) && job.conclusion === 'success');
        return verifyFastEvidence({
          direct,
          readOnlyProof,
          verifyReuse() {
            stage = 'reused PR evidence';
            return Boolean(findReusableCheck({ repository, commit: candidateSource, event: 'push', ref: 'refs/heads/main',
              scope: 'fast', version: candidatePolicy }));
          },
          verifyMain() {
            stage = 'Check attestation artifact';
            const { artifacts } = api(`actions/runs/${run.id}/artifacts?per_page=100`);
            const artifact = artifacts.find(a => a.name === `ci-source-${run.run_attempt}` && !a.expired && a.size_in_bytes <= 65536);
            assert.ok(artifact, 'Missing current main validation attestation');
            stage = 'Check attestation';
            const attestation = readSource(repository, artifact);
            // Proof reads the selected immutable source policy without executing it.
            assertMainAttestation(attestation, run, candidateSource, candidatePolicy);
            return true;
          },
        });
      } catch (error) {
        if (rejected.length < 3) rejected.push(`${stage}: ${evidenceFailure(error)}`);
      }
      return false;
    },
  });
  assert.ok(selected, `No valid successful main fast-check evidence for this source; run Check on main first${rejected.length ? ` (${rejected.join('; ')})` : ''}`);
  const { run: fastRun, source } = selected;
  assert.ok(!readOnlyProof || process.env.PUBLISH_RELEASE !== 'true', 'Read-only proof cannot publish');
  if (process.env.PUBLISH_RELEASE === 'true') assert.ok(process.env.CANDIDATE_RUN, 'Publication requires the saved, manually tested candidate run');
  if (process.env.CANDIDATE_RUN) {
    assert.match(process.env.CANDIDATE_RUN, /^\d+$/, 'Invalid candidate run ID');
    const prior = api(`actions/runs/${process.env.CANDIDATE_RUN}`);
    assert.equal(prior.path, '.github/workflows/release.yml');
    assert.equal(prior.event, 'workflow_dispatch', 'Untrusted PR artifacts cannot become release inputs');
    assert.equal(prior.head_branch, 'main');
    assert.equal(prior.repository.full_name, repository); assert.equal(prior.head_repository.full_name, repository);
    assert.equal(prior.status, 'completed'); assert.equal(prior.conclusion, 'success');
    output('candidate-attempt', prior.run_attempt);
  }
  const pkg = JSON.parse(Buffer.from(api(`contents/package.json?ref=${source}`).content, 'base64'));
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  if (process.env.RELEASE_VERSION) assert.equal(pkg.version, process.env.RELEASE_VERSION, 'Requested version differs from source');
  for (const [value, pattern] of [[process.env.SIGNED_XPI, /^site\/installers\/[A-Za-z0-9_.-]+\.xpi$/],
    [process.env.MANUAL_EVIDENCE, /^docs\/evidence\/[A-Za-z0-9_/-]+\.json$/]]) {
    if (value) assert.match(value, pattern, 'Invalid source evidence path');
  }
  output('source', source); output('version', pkg.version); output('fast-run', fastRun.id);
}

async function prepare() {
  const root = resolve('candidate'), directory = 'artifacts/release-candidate';
  const source = command('git', ['rev-parse', 'HEAD'], { cwd: root }).trim();
  assert.equal(source, process.env.RELEASE_SOURCE);
  assert.equal(command('git', ['status', '--porcelain'], { cwd: root }).trim(), '', 'Candidate checkout must be clean');
  const { name: candidateProduct, version } = await json(join(root, 'package.json'));
  let names = releaseArtifacts(version, candidateProduct);
  assert.equal(version, process.env.RELEASE_VERSION);
  const selected = (process.env.RELEASE_BROWSERS || 'chrome,edge,firefox').split(',');
  assert.ok(selected.length && new Set(selected).size === selected.length && selected.every(b => ['chrome','edge','firefox'].includes(b)), 'Unknown or duplicate browser');
  await mkdir(directory, { recursive: true });
  let previousCandidate;
  if (process.env.CANDIDATE_RUN) {
    previousCandidate = await json(join(directory, 'candidate.json'));
    assert.equal(previousCandidate.source, source, 'Saved candidate is for another source');
    assert.equal(previousCandidate.version, version);
    assert.equal(previousCandidate.workflowVersion, workflowVersion(), 'Revalidate after a workflow change');
    names = releaseArtifactsFromCandidate(previousCandidate);
  } else for (const script of ['package', 'package:firefox']) command('npm', ['run', script], { cwd: root, stdio: 'inherit', timeout: 300000 });
  if (!previousCandidate) for (const name of [names.chrome, names.listed, names.listedSource]) {
    await cp(join(root, 'artifacts', name), join(directory, name));
  }
  const browsers = {};
  for (const browser of selected) {
    const filename = browser === 'firefox' ? names.listedXpi : names[browser];
    if (browser === 'firefox') {
      if (!process.env.SIGNED_XPI) continue; // Automated proof can finish; eligibility below still blocks Firefox.
      await cp(process.env.SIGNED_XPI, join(directory, filename));
    } else if (browser === 'edge') await cp(join(directory, names.chrome), join(directory, filename));
    browsers[browser] = { filename, sha256: digest(await readFile(join(directory, filename))) };
  }
  const approved = await json('releases/approved.json');
  if (previousCandidate) assert.equal(previousCandidate.previous, digest(JSON.stringify(approved)), 'Stale saved candidate');
  let manual = null;
  if (process.env.MANUAL_EVIDENCE) {
    manual = await json(process.env.MANUAL_EVIDENCE);
    for (const records of Object.values(manual.browsers || {})) for (const record of Object.values(records)) {
      assert.match(record.evidence, /^docs\/evidence\/[A-Za-z0-9_/-]+\.(json|md|html)$/);
      await readFile(record.evidence);
    }
  }
  const record = { schema: 1, source, version, scope: 'full', workflowVersion: workflowVersion(),
    fastRun: Number(process.env.FAST_RUN), previous: digest(JSON.stringify(approved)),
    requestedBrowsers: selected, browsers, manual };
  await writeFile(join(directory, 'candidate.json'), JSON.stringify(record, null, 2) + '\n');
}

async function verify() {
  const directory = 'artifacts/release-candidate', candidate = await json(join(directory, 'candidate.json'));
  assert.equal(candidate.source, process.env.RELEASE_SOURCE);
  assert.equal(candidate.workflowVersion, workflowVersion(), 'Workflow changed after candidate preparation');
  assert.equal(process.env.DESKTOP_RESULT, 'success', 'Missing/failed/cancelled/skipped release matrix');
  const reports = await readReports('artifacts/release-reports');
  const names = releaseArtifactsFromCandidate(candidate);
  const chromium = archivePayload(join(directory, names.chrome));
  const firefox = archivePayload(join(directory, names.listed));
  for (const files of [chromium, firefox]) assert.equal(JSON.parse(files['manifest.json']).version, candidate.version);
  assertPackageReports(reports.filter(r => ['chrome','edge'].includes(r.browser)), candidate.source, chromium);
  assertPackageReports(reports.filter(r => r.browser === 'firefox' && Object.keys(r.payload || {}).length), candidate.source, firefox, true);
  candidate.automated = { result: 'passed', source: candidate.source, scope: 'full', workflowVersion: candidate.workflowVersion, packages: {} };
  for (const [browser, artifact] of Object.entries(candidate.browsers)) {
    const file = join(directory, artifact.filename);
    assert.equal(digest(await readFile(file)), artifact.sha256, 'Candidate hash changed');
    if (browser === 'firefox') {
      assertSignedFirefox(reports, candidate.source, artifact.sha256, candidate.version, archivePayload(file), firefox);
      candidate.automated.signedFirefox = { result: 'passed', sha256: artifact.sha256 };
    } else assert.deepEqual(archivePayload(file), chromium);
    candidate.automated.packages[browser] = artifact.sha256;
  }
  let eligible = true, reason;
  try {
    assert.deepEqual(Object.keys(candidate.browsers).sort(), candidate.requestedBrowsers.toSorted(), 'Missing requested signed package');
    assertReleaseEvidence(candidate);
  } catch (error) { eligible = false; reason = error.message; }
  await writeFile(join(directory, 'validation.json'), JSON.stringify({ ...candidate, eligible, reason, publishRequested: process.env.PUBLISH_RELEASE === 'true' }, null, 2) + '\n');
  output('eligible', eligible);
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Full candidate automation passed for ${candidate.source}. Publication eligible: ${eligible}. ${reason || ''}\n`);
  if (process.env.PUBLISH_RELEASE === 'true') assert.ok(eligible, reason);
}

if (import.meta.main) {
  const operations = { resolve: resolveSource, prepare, verify };
  assert.ok(operations[process.argv[2]], 'Expected resolve, prepare or verify');
  await operations[process.argv[2]]();
}
