import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { artifactBytes, digest, findReleaseByTag, isSource, validateManifest } from './approved-release.mjs';
import { assertPromotion, assertReleaseEvidence, assertPromotionBase } from './release-gate.mjs';
import { workflowVersion as currentWorkflowVersion, requiredRunners } from '../ci/ci-policy.mjs';
import { assertReleaseSource, requiredCheckJobs } from './release-automation.mjs';
import { activeRepository, parseReleaseAssetLocation } from './release-repository.mjs';

const repository = activeRepository();
const retiredManifestDigest = '18cedc5f1f240877054d28fbc4aa5dd584ae2ca172fcaecc9a8dc1f8c147cd8a';
const api = path => JSON.parse(execFileSync('gh', ['api', `repos/${repository}/${path}`], { encoding: 'utf8', timeout: 60000 }));
function assertReleaseAsset(location, tag, filename, message) {
  const parsed = parseReleaseAssetLocation(location);
  assert.deepEqual(parsed && { tag: parsed.tag, filename: parsed.filename }, { tag, filename }, message);
}
function manifestAt(source) {
  assert.ok(isSource(source));
  return JSON.parse(Buffer.from(api(`contents/releases/approved.json?ref=${source}`).content, 'base64'));
}
async function originalValidation(runId, runAttempt, { artifactName = `validated-release-${runAttempt}`, filename = 'validation.json' } = {}) {
  const { artifacts } = api(`actions/runs/${runId}/artifacts?per_page=100`);
  const matches = artifacts.filter(a => a.name === artifactName && !a.expired);
  assert.equal(matches.length, 1, 'Missing trusted release artifact; do not promote an expired candidate');
  assert.ok(matches[0].size_in_bytes < 32 * 1024 * 1024);
  const directory = await mkdtemp(join(tmpdir(), 'anmerko-release-record-'));
  try {
    const archive = join(directory, 'record.zip');
    await writeFile(archive, execFileSync('gh', ['api', `repos/${repository}/actions/artifacts/${matches[0].id}/zip`],
      { maxBuffer: 32 * 1024 * 1024, timeout: 60000 }));
    return execFileSync('unzip', ['-p', archive, filename], { maxBuffer: 1024 * 1024, timeout: 30000 });
  } finally { await rm(directory, { recursive: true, force: true }); }
}
function assertSuccessfulRun(run, jobs, expected) {
  assert.equal(run.path, '.github/workflows/release.yml'); assert.equal(run.event, 'workflow_dispatch');
  assert.equal(run.head_branch, 'main'); assert.equal(run.repository.full_name, repository);
  assert.equal(run.head_repository.full_name, repository); assert.equal(run.status, 'completed');
  assert.equal(run.conclusion, 'success'); assert.equal(run.run_attempt, expected.runAttempt);
  for (const name of ['Resolve release source', 'Prepare and test exact packages', 'Release gate',
    ...requiredRunners('full').map(os => `Release desktop (${os}) / Browser scenarios`)]) {
    const found = jobs.filter(job => job.name === name);
    assert.equal(found.length, 1, `Missing or duplicate release job: ${name}`);
    assert.equal(found[0].status, 'completed'); assert.equal(found[0].conclusion, 'success');
  }
}
export function assertArchiveRetirement(current, next) {
  assert.equal(digest(JSON.stringify(current)), retiredManifestDigest, 'Archive retirement requires the exact sequence-8 manifest');
  assert.deepEqual(next, { schema: 2, sequence: current.sequence + 1, previous: retiredManifestDigest,
    validation: { kind: 'retire-demo-archive' }, browsers: current.browsers },
  'Archive retirement may only remove obsolete demo metadata');
}
export async function verifyApproved({ next, current, get = api, read = artifactBytes, original = originalValidation,
  policy = currentWorkflowVersion, rollback, active = repository } = {}) {
  validateManifest(next);
  if (JSON.stringify(current) === JSON.stringify(next)) return;
  assert.ok(current, 'An existing approved manifest is required');
  if (next.validation?.kind === 'retire-demo-archive') { assertArchiveRetirement(current, next); return; }
  assert.equal(current.schema, 2, 'Approved promotions require a schema-2 predecessor');
  assertPromotion(current, next, rollback);
  if (next.rollback) return;
  if (next.validation?.kind === 'automation') {
    const { runId, runAttempt, source, controller, checkRun, version, phase, payloadFingerprint, record } = next.validation;
    assert.ok(Number.isSafeInteger(runId) && Number.isSafeInteger(runAttempt) && Number.isSafeInteger(checkRun));
    assert.ok(isSource(source)); assert.ok(isSource(controller)); assert.match(version, /^\d+\.\d+\.\d+$/); assert.match(phase, /^[a-z0-9-]+$/);
    const run = get(`actions/runs/${runId}`);
    assert.equal(run.path, '.github/workflows/release.yml'); assert.ok(['workflow_dispatch', 'schedule', 'workflow_run'].includes(run.event));
    assert.equal(run.head_branch, 'main'); assert.equal(run.head_sha, controller);
    assert.equal(run.repository?.full_name, active); assert.equal(run.head_repository?.full_name, active);
    assert.equal(run.status, 'completed'); assert.equal(run.conclusion, 'success'); assert.equal(run.run_attempt, runAttempt);
    assertReleaseSource(controller, source, get(`compare/${source}...${controller}`));
    const currentMain = get('git/ref/heads/main').object.sha;
    assertReleaseSource(currentMain, source, get(`compare/${source}...${currentMain}`));
    const jobs = get(`actions/runs/${runId}/attempts/${runAttempt}/jobs?per_page=100`).jobs;
    const releaseJobs = jobs.filter(job => job.name === 'One-button release');
    assert.equal(releaseJobs.length, 1); assert.equal(releaseJobs[0].status, 'completed'); assert.equal(releaseJobs[0].conclusion, 'success');
    const check = get(`actions/runs/${checkRun}`);
    assert.equal(check.path, '.github/workflows/check.yml'); assert.equal(check.head_sha, source);
    assert.ok(['main', `codex/release-source-${source}`].includes(check.head_branch), 'Check must run on main or the exact release snapshot');
    assert.equal(check.status, 'completed'); assert.equal(check.conclusion, 'success');
    assert.equal(check.repository?.full_name, active); assert.equal(check.head_repository?.full_name, active);
    requiredCheckJobs(get(`actions/runs/${checkRun}/attempts/${check.run_attempt || 1}/jobs?per_page=100`).jobs);
    const actionArtifacts = get(`actions/runs/${runId}/artifacts?per_page=100`).artifacts
      .filter(artifact => artifact.name === `release-evidence-${runAttempt}` && !artifact.expired);
    assert.equal(actionArtifacts.length, 1, 'Missing immutable Release evidence artifact');
    const originalBytes = await original(runId, runAttempt, {
      artifactName: `release-evidence-${runAttempt}`, filename: 'release-evidence.json',
    });
    assert.equal(digest(originalBytes), record.sha256, 'Release evidence does not match the authorizing run');
    const evidenceBytes = await read(record); assert.equal(digest(evidenceBytes), record.sha256, 'Durable release evidence checksum mismatch');
    assert.deepEqual(evidenceBytes, originalBytes, 'Durable release evidence differs from the authorizing run');
    const evidence = JSON.parse(evidenceBytes); assert.equal(evidence.schema, 1); assert.equal(evidence.source, source);
    assert.equal(evidence.controller, controller);
    assert.equal(evidence.version, version); assert.equal(evidence.phase, phase); assert.equal(evidence.checkRun, checkRun);
    assert.equal(evidence.payloadFingerprint, payloadFingerprint); assert.match(payloadFingerprint, /^[a-f0-9]{64}$/);
    assert.ok(evidence.files && typeof evidence.files === 'object');
    for (const sha256 of Object.values(evidence.files)) assert.match(sha256, /^[a-f0-9]{64}$/);
    const tag = `automation-${version.replaceAll('.', '-')}-${source}`;
    assertReleaseAsset(record.location, tag, `promotion-${phase}-${controller}.json`,
      'Unexpected durable release evidence location');
    assert.equal(next.previous, digest(JSON.stringify(current)));
    const release = findReleaseByTag(get, tag); assert.equal(release.target_commitish, source);
    const changed = Object.entries(next.browsers).filter(([browser, approved]) => JSON.stringify(approved) !== JSON.stringify(current.browsers[browser]));
    assert.deepEqual(Object.keys(evidence.browsers).sort(), changed.map(([browser]) => browser).sort(), 'Release evidence must name every changed browser only');
    const changedBrowsers = new Set(changed.map(([browser]) => browser));
    for (const [browser, approved] of Object.entries(next.browsers)) {
      if (!changedBrowsers.has(browser)) { assert.deepEqual(approved, current.browsers[browser]); continue; }
      assert.equal(approved.source, source, `${browser} source differs from the authorizing run`);
      const attested = evidence.browsers[browser]; assert.ok(attested, `Missing ${browser} Release evidence`);
      assert.deepEqual(attested, { version: approved.version, filename: approved.artifact.filename, sha256: approved.artifact.sha256 });
      assert.equal(evidence.files[attested.filename], attested.sha256, `${browser} package hash differs from release state`);
      assert.ok(browser === 'firefox' ? approved.version === `${version}.1` : approved.version === version);
      if (browser === 'firefox') assert.match(approved.artifact.filename, /-firefox\.xpi$/, 'Firefox website package must be a freshly signed XPI');
      assertReleaseAsset(approved.artifact.location, tag, approved.artifact.filename,
        `${browser} has an unexpected release asset location`);
      const assets = release.assets.filter(asset => asset.name === approved.artifact.location.split('/').at(-1));
      assert.equal(assets.length, 1); if (assets[0].digest) assert.equal(assets[0].digest, `sha256:${approved.artifact.sha256}`);
      else assert.equal(digest(await read(approved.artifact)), approved.artifact.sha256, `${browser} release asset checksum mismatch`);
    }
    const recordAssets = release.assets.filter(asset => asset.name === `promotion-${phase}-${controller}.json`);
    assert.equal(recordAssets.length, 1); if (recordAssets[0].digest) assert.equal(recordAssets[0].digest, `sha256:${record.sha256}`);
    else assert.equal(digest(await read(record)), record.sha256, 'Durable release evidence asset checksum mismatch');
    return;
  }
  assert.equal(next.validation?.kind, 'release');
  const { runId, runAttempt, workflowVersion, source, record } = next.validation;
  assert.equal(workflowVersion, policy(), 'Release policy changed; revalidate before promotion');
  assert.ok(Number.isSafeInteger(runId) && Number.isSafeInteger(runAttempt));
  const run = get(`actions/runs/${runId}`);
  const { jobs } = get(`actions/runs/${runId}/attempts/${runAttempt}/jobs?per_page=100`);
  assertSuccessfulRun(run, jobs, { runAttempt });
  assert.equal(digest(await original(runId, runAttempt)), record.sha256, 'Forged release validation record');
  const candidate = JSON.parse(await read(record));
  assert.equal(candidate.eligible, true); assertReleaseEvidence(candidate);
  assert.equal(candidate.source, source); assert.equal(candidate.workflowVersion, workflowVersion);
  assert.equal(candidate.previous, next.previous);
  // The original artifact above binds these durable asset locations to this run.
  const expectedTag = `approved-${source}-${runId}-${runAttempt}`;
  assertReleaseAsset(record.location, expectedTag, 'validation.json', 'Unexpected release validation location');
  const release = findReleaseByTag(get, expectedTag);
  assert.equal(release.target_commitish, source);
  assert.deepEqual(Object.keys(next.browsers).sort(), [...new Set([...Object.keys(current.browsers), ...Object.keys(candidate.browsers)])].sort(), 'An approved browser was removed');
  for (const [browser, approved] of Object.entries(next.browsers)) {
    const tested = candidate.browsers[browser];
    if (!tested) { assert.deepEqual(approved, current.browsers[browser], 'Untested browser changed'); continue; }
    assert.equal(approved.version, candidate.version); assert.equal(approved.source, source);
    assert.equal(approved.artifact.sha256, tested.sha256); assert.equal(approved.artifact.filename, tested.filename);
    assertReleaseAsset(approved.artifact.location, expectedTag, tested.filename,
      `${browser} has an unexpected release asset location`);
  }
  // GitHub records SHA-256 for durable assets, including validation.json.
  for (const artifact of [record, ...Object.keys(candidate.browsers).map(browser => next.browsers[browser].artifact)]) {
    const name = artifact.location.split('/').at(-1);
    const assets = release.assets.filter(asset => asset.name === name);
    assert.equal(assets.length, 1);
    if (assets[0].digest) assert.equal(assets[0].digest, `sha256:${artifact.sha256}`);
    else assert.equal(digest(await read(artifact)), artifact.sha256, 'Durable asset checksum mismatch');
  }
}
if (import.meta.main) {
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const next = JSON.parse(await readFile('releases/approved.json', 'utf8'));
  let base;
  if (event.pull_request) base = event.pull_request.base.sha;
  else if (process.env.GITHUB_EVENT_NAME === 'workflow_dispatch') base = api('git/ref/heads/main').object.sha;
  else base = api(`git/commits/${process.env.SOURCE_SHA || process.env.GITHUB_SHA}`).parents[0]?.sha;
  assert.ok(isSource(base), 'Approved verification requires an existing predecessor');
  const current = manifestAt(base);
  if (process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' && JSON.stringify(current) !== JSON.stringify(next))
    assertPromotionBase(base, api(`compare/${base}...${process.env.GITHUB_SHA}`));
  let rollback;
  if (next.rollback) {
    assert.ok(isSource(next.rollback)); const comparison = api(`compare/${next.rollback}...${base}`);
    assert.equal(comparison.merge_base_commit.sha, next.rollback); rollback = manifestAt(next.rollback);
  }
  await verifyApproved({ next, current, rollback });
  console.log(`Approved release manifest ${next.sequence} verified.`);
}
