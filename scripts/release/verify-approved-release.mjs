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
const freshRootImport = Object.freeze({
  // Audited public-repository trust anchor. This is not historical CI evidence:
  // it is valid only for the parentless initial commit that imports these bytes.
  manifestSha256: 'd0981294af4e9771dedb315ad7c5e545dff5a3dcac8275c30fb705a37dd02037',
  sequence: 8,
});
const chromeRecovery = Object.freeze({
  source: 'ee99023240b3f7d47264b6fdc0d720ab43d7011c', version: '0.5.3', runId: 34792169134, runAttempt: 1,
  artifactId: 10327703755, artifactDigest: '8f332700ebabf0fc344aceaf17692081bed0e574e136116b879e1cbff98dad63',
  recordSha256: '9bf135e05e9f45a32405ff14fce3da94c722ebb07ad292b72fe2577b18557eae',
  workflowVersion: '28a6b1de8dadcc4b736056ec3c5f955c80532f38606586e9e771b4b7eef6d7ce',
  filename: 'briefmark-0.5.3.zip', packageSha256: 'cc44a3edac9177a5c598112684e388938f1fb0e75c47d536eed8604ff3a545ee',
});
const firefoxRecovery = Object.freeze({
  source: 'ee99023240b3f7d47264b6fdc0d720ab43d7011c', version: '0.5.3.1', runId: 34792169134, runAttempt: 1,
  versionId: 6484856, fileId: 5029020,
  // Historical AMO receipt with only its machine-local path redacted for public release.
  receiptSha256: '55a3b528b69367bd4c19dea001b2b1867428061770d7aa4ea6ce00faf0f98872',
  originalUnsignedSha256: '26b326565705fc6e6432e33c08c3bff2a61cd56082877dc5f428e57c9253efa1',
  originalSourceSha256: '83f33cde2952cb13943feb15b43a18853df6b7f0e6c629ace9461d3cab1e0479',
  unsignedSha256: 'b005c4685740e6c646631a923c4bb40c3233566fae9283d508db7ccc8eceb07d',
  sourceSha256: '8159b943aface4e262fee65c90c5e2bf3be995c44eb685fe4c366461b256325b',
  filename: 'briefmark-0.5.3.1-firefox.xpi', packageSha256: '2cf9be1f056685f1993d6e1f70913b3af330488f0726bd4decee2ec4419a570d',
});
const api = path => JSON.parse(execFileSync('gh', ['api', `repos/${repository}/${path}`], { encoding: 'utf8', timeout: 60000 }));
function assertHistoricalReleaseAsset(location, tag, filename, message) {
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
  const directory = await mkdtemp(join(tmpdir(), 'briefmark-release-record-'));
  try {
    const archive = join(directory, 'record.zip');
    await writeFile(archive, execFileSync('gh', ['api', `repos/${repository}/actions/artifacts/${matches[0].id}/zip`],
      { maxBuffer: 32 * 1024 * 1024, timeout: 60000 }));
    return execFileSync('unzip', ['-p', archive, filename], { maxBuffer: 1024 * 1024, timeout: 30000 });
  } finally { await rm(directory, { recursive: true, force: true }); }
}
function assertSuccessfulRun(run, jobs, expected) {
  assert.equal(run.path, '.github/workflows/release.yml');
  assert.equal(run.event, 'workflow_dispatch');
  assert.equal(run.head_branch, 'main');
  assert.equal(run.repository.full_name, repository);
  assert.equal(run.head_repository.full_name, repository);
  assert.equal(run.status, 'completed'); assert.equal(run.conclusion, 'success');
  assert.equal(run.run_attempt, expected.runAttempt);
  if (expected.source) assert.equal(run.head_sha, expected.source);
  for (const name of ['Resolve release source', 'Prepare and test exact packages', 'Release gate',
    ...requiredRunners('full').map(os => `Release desktop (${os}) / Browser scenarios`)]) {
    const found = jobs.filter(job => job.name === name);
    assert.equal(found.length, 1, `Missing or duplicate release job: ${name}`);
    assert.equal(found[0].status, 'completed'); assert.equal(found[0].conclusion, 'success');
  }
}
async function verifyChromeRecovery(next, current, { get, read, original }) {
  const expected = chromeRecovery;
  assert.equal(digest(JSON.stringify(current)), '85073cf71c8ff7dc3b598c0971ef566acc36038883a53c8e6d4de6a1333d3264', 'Recovery requires the pinned bootstrap predecessor');
  assert.deepEqual(next.validation, {
    kind: 'chrome-automated-recovery', runId: expected.runId, runAttempt: expected.runAttempt,
    artifactId: expected.artifactId, artifactDigest: expected.artifactDigest, recordSha256: expected.recordSha256,
    source: expected.source,
    note: 'Pinned recovery of an exact automatically tested Chrome package; no manual, store, or Firefox approval is claimed.',
  });
  assert.deepEqual(Object.keys(next.browsers).sort(), ['chrome', 'firefox']);
  assert.deepEqual(next.browsers.firefox, current.browsers.firefox, 'Recovery cannot change Firefox');
  assert.deepEqual(next.demo, current.demo, 'Recovery cannot change the demo');
  assert.deepEqual(next.browsers.chrome, { version: expected.version, source: expected.source, artifact: {
    filename: expected.filename, location: 'releases/0-5-3/briefmark-0.5.3.zip', sha256: expected.packageSha256,
  } });
  const run = get(`actions/runs/${expected.runId}`);
  const { jobs } = get(`actions/runs/${expected.runId}/attempts/${expected.runAttempt}/jobs?per_page=100`);
  assertSuccessfulRun(run, jobs, expected);
  const artifactMatches = get(`actions/runs/${expected.runId}/artifacts?per_page=100`).artifacts
    .filter(artifact => artifact.id === expected.artifactId && artifact.name === `validated-release-${expected.runAttempt}` && !artifact.expired);
  assert.equal(artifactMatches.length, 1, 'Missing pinned recovery validation artifact');
  assert.equal(artifactMatches[0].digest, `sha256:${expected.artifactDigest}`, 'Recovery artifact archive changed');
  const recordBytes = await original(expected.runId, expected.runAttempt);
  assert.equal(digest(recordBytes), expected.recordSha256, 'Recovery validation record changed');
  const record = JSON.parse(recordBytes);
  assert.equal(record.source, expected.source); assert.equal(record.version, expected.version);
  assert.equal(record.scope, 'full'); assert.equal(record.workflowVersion, expected.workflowVersion);
  assert.equal(record.automated?.result, 'passed'); assert.equal(record.automated?.source, expected.source);
  assert.equal(record.automated?.scope, 'full'); assert.equal(record.automated?.workflowVersion, expected.workflowVersion);
  assert.deepEqual(Object.keys(record.browsers), ['chrome']);
  assert.equal(record.browsers.chrome.filename, expected.filename);
  assert.equal(record.browsers.chrome.sha256, expected.packageSha256);
  assert.equal(record.automated.packages.chrome, expected.packageSha256);
  assert.equal(record.eligible, false); assert.equal(record.manual, null);
  assert.match(record.reason, /Missing requested signed package/);
  const packageBytes = await read(next.browsers.chrome.artifact);
  assert.equal(digest(packageBytes), expected.packageSha256, 'Recovery package bytes changed');
}
function archive(path) {
  const entries = execFileSync('unzip', ['-Z1', path], { encoding: 'utf8' }).trim().split('\n').filter(name => name && !name.endsWith('/'));
  assert.equal(entries.length, new Set(entries).size, 'Duplicate Firefox archive entries');
  return Object.fromEntries(entries.map(name => [name, execFileSync('unzip', ['-p', path, name], { maxBuffer: 16 * 1024 * 1024 })]));
}
async function verifyFirefoxRecovery(next, current, { get, read }) {
  const expected = firefoxRecovery;
  assert.equal(digest(JSON.stringify(current)), 'ca2026a75dcfed16b47e6172fb6927751da9962a1e5e00ccd991eaf4d56225d5', 'Recovery requires the pinned Chrome recovery predecessor');
  assert.deepEqual(next.validation, {
    kind: 'firefox-automated-recovery', runId: expected.runId, runAttempt: expected.runAttempt, source: expected.source,
    versionId: expected.versionId, fileId: expected.fileId, receiptSha256: expected.receiptSha256,
    unsignedSha256: expected.unsignedSha256, sourceSha256: expected.sourceSha256, packageSha256: expected.packageSha256,
    note: 'Pinned recovery of an exact automatically tested Firefox payload after official unlisted signing; no signed installation or managed-upgrade evidence is claimed.',
  });
  assert.deepEqual(Object.keys(next.browsers).sort(), Object.keys(current.browsers).sort(), 'Recovery cannot add or remove browsers');
  assert.deepEqual(next.browsers.chrome, current.browsers.chrome, 'Recovery cannot change Chrome');
  assert.deepEqual(next.demo, current.demo, 'Recovery cannot change the demo');
  assert.deepEqual(next.browsers.firefox, { version: expected.version, source: expected.source, artifact: {
    filename: expected.filename, location: `releases/0-5-3/${expected.filename}`, sha256: expected.packageSha256,
  } });
  const run = get(`actions/runs/${expected.runId}`);
  const { jobs } = get(`actions/runs/${expected.runId}/attempts/${expected.runAttempt}/jobs?per_page=100`);
  assertSuccessfulRun(run, jobs, expected);
  const paths = {
    signed: `releases/0-5-3/${expected.filename}`,
    unsigned: 'releases/0-5-3/briefmark-0.5.3.1-firefox-unsigned.zip',
    source: 'releases/0-5-3/briefmark-0.5.3.1-firefox-source.zip',
    originalUnsigned: 'releases/0-5-3/briefmark-0.5.3-firefox-unsigned.zip',
    originalSource: 'releases/0-5-3/briefmark-0.5.3-firefox-source.zip',
    receipt: 'releases/0-5-3/amo-unlisted-0.5.3.1-signed-receipt.json',
  };
  for (const [key, sha256] of Object.entries({ signed: expected.packageSha256, unsigned: expected.unsignedSha256,
    source: expected.sourceSha256, originalUnsigned: expected.originalUnsignedSha256,
    originalSource: expected.originalSourceSha256, receipt: expected.receiptSha256 }))
    assert.equal(digest(await readFile(paths[key])), sha256, `Pinned Firefox ${key} changed`);
  assert.equal(digest(await read(next.browsers.firefox.artifact)), expected.packageSha256, 'Recovery package bytes changed');
  const receipt = JSON.parse(await readFile(paths.receipt));
  assert.equal(receipt.version.id, expected.versionId); assert.equal(receipt.version.file.id, expected.fileId);
  assert.equal(receipt.version.version, expected.version); assert.equal(receipt.version.channel, 'unlisted');
  assert.equal(receipt.version.file.status, 'public'); assert.equal(receipt.version.file.hash, `sha256:${expected.packageSha256}`);
  assert.equal(receipt.version.file.size, 54074); assert.equal(receipt.sha256, expected.packageSha256);
  const signed = archive(paths.signed), unsigned = archive(paths.unsigned), original = archive(paths.originalUnsigned);
  const payload = Object.fromEntries(Object.entries(signed).filter(([name]) => !name.startsWith('META-INF/')));
  assert.deepEqual(Object.keys(payload).sort(), Object.keys(unsigned).sort(), 'Signed Firefox inventory changed');
  for (const name of Object.keys(unsigned)) {
    if (name === 'manifest.json') assert.deepEqual(JSON.parse(payload[name]), JSON.parse(unsigned[name]), 'Signed Firefox manifest changed');
    else assert.equal(digest(payload[name]), digest(unsigned[name]), `Signed Firefox payload changed: ${name}`);
  }
  assert.deepEqual(Object.keys(unsigned).sort(), Object.keys(original).sort(), 'Derived Firefox inventory changed');
  for (const name of Object.keys(original)) {
    if (name !== 'manifest.json') assert.equal(digest(unsigned[name]), digest(original[name]), `Derived Firefox payload changed: ${name}`);
  }
  const derivedManifest = JSON.parse(unsigned['manifest.json']), originalManifest = JSON.parse(original['manifest.json']);
  assert.equal(derivedManifest.version, expected.version); assert.equal(originalManifest.version, '0.5.3');
  delete derivedManifest.version; delete originalManifest.version; assert.deepEqual(derivedManifest, originalManifest, 'Only the Firefox manifest version may differ');
}
export async function verifyApproved({ next, current, get = api, read = artifactBytes, original = originalValidation,
  policy = currentWorkflowVersion, rollback, active = repository } = {}) {
  validateManifest(next);
  if (JSON.stringify(current) === JSON.stringify(next)) return;
  if (!current) {
    // One narrowly pinned migration exception; never a reusable approval type.
    assert.equal(digest(JSON.stringify(next)), '85073cf71c8ff7dc3b598c0971ef566acc36038883a53c8e6d4de6a1333d3264', 'Only the verified bootstrap manifest may initialize approval');
    return;
  }
  assertPromotion(current, next, rollback);
  if (next.rollback) return;
  if (next.validation?.kind === 'chrome-automated-recovery') {
    await verifyChromeRecovery(next, current, { get, read, original });
    return;
  }
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
    assertHistoricalReleaseAsset(record.location, tag, `promotion-${phase}-${controller}.json`,
      'Unexpected durable release evidence location');
    assert.equal(next.previous, digest(JSON.stringify(current)));
    const release = findReleaseByTag(get, tag); assert.equal(release.target_commitish, source);
    assert.deepEqual(next.demo, current.demo, 'Automation cannot change the demo without run-produced demo evidence');
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
      assertHistoricalReleaseAsset(approved.artifact.location, tag, approved.artifact.filename,
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
  if (next.validation?.kind === 'firefox-automated-recovery') {
    await verifyFirefoxRecovery(next, current, { get, read });
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
  assertHistoricalReleaseAsset(record.location, expectedTag, 'validation.json', 'Unexpected release validation location');
  const release = findReleaseByTag(get, expectedTag);
  assert.equal(release.target_commitish, source);
  assert.deepEqual(Object.keys(next.browsers).sort(), [...new Set([...Object.keys(current.browsers), ...Object.keys(candidate.browsers)])].sort(), 'An approved browser was removed');
  for (const [browser, approved] of Object.entries(next.browsers)) {
    const tested = candidate.browsers[browser];
    if (!tested) { assert.deepEqual(approved, current.browsers[browser], 'Untested browser changed'); continue; }
    assert.equal(approved.version, candidate.version); assert.equal(approved.source, source);
    assert.equal(approved.artifact.sha256, tested.sha256); assert.equal(approved.artifact.filename, tested.filename);
    assertHistoricalReleaseAsset(approved.artifact.location, expectedTag, tested.filename,
      `${browser} has an unexpected release asset location`);
  }
  assert.equal(next.demo.source, source); assert.equal(next.demo.version, candidate.version);
  assert.equal(next.demo.entry, candidate.demo.entry);
  assert.deepEqual(Object.keys(next.demo.files).sort(), Object.keys(candidate.demo.files).sort());
  for (const [route, artifact] of Object.entries(next.demo.files)) {
    assert.equal(artifact.sha256, candidate.demo.files[route].sha256);
    assertHistoricalReleaseAsset(artifact.location, expectedTag, candidate.demo.files[route].file,
      `${route} has an unexpected release asset location`);
  }
  // GitHub records SHA-256 for durable assets, including validation.json.
  for (const artifact of [record, ...Object.keys(candidate.browsers).map(browser => next.browsers[browser].artifact), ...Object.values(next.demo.files)]) {
    const name = artifact.location.split('/').at(-1);
    const assets = release.assets.filter(asset => asset.name === name);
    assert.equal(assets.length, 1);
    if (assets[0].digest) assert.equal(assets[0].digest, `sha256:${artifact.sha256}`);
    else assert.equal(digest(await read(artifact)), artifact.sha256, 'Durable asset checksum mismatch');
  }
}
export async function verifyFreshRootImport(next, { manifestBytes, commit, read = artifactBytes } = {}) {
  validateManifest(next);
  assert.deepEqual(commit?.parents, [], 'Fresh-root import requires the parentless initial commit');
  assert.equal(digest(manifestBytes), freshRootImport.manifestSha256, 'Fresh-root approved manifest bytes differ from the audited import');
  assert.equal(next.sequence, freshRootImport.sequence, 'Fresh-root import has an unexpected approval sequence');
  assert.deepEqual(JSON.parse(manifestBytes), next, 'Fresh-root approved manifest does not match its checked bytes');
  for (const release of Object.values(next.browsers)) {
    assert.equal(digest(await read(release.artifact)), release.artifact.sha256,
      `Fresh-root approved installer checksum mismatch: ${release.artifact.filename}`);
  }
}
if (import.meta.main) {
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const manifestBytes = await readFile('releases/approved.json');
  const next = JSON.parse(manifestBytes);
  let base;
  if (event.pull_request) base = event.pull_request.base.sha;
  else if (process.env.GITHUB_EVENT_NAME === 'workflow_dispatch') base = api('git/ref/heads/main').object.sha;
  else {
    const commit = api(`git/commits/${process.env.SOURCE_SHA || process.env.GITHUB_SHA}`);
    if (commit.parents.length === 0) {
      await verifyFreshRootImport(next, { manifestBytes, commit });
      console.log(`Fresh-root approved release manifest ${next.sequence} verified.`);
      process.exit(0);
    }
    base = commit.parents[0].sha;
  }
  let current;
  try { current = manifestAt(base); } catch (error) {
    // A missing file is permitted only for the pinned bootstrap. API failure on
    // any later manifest still fails the bootstrap fingerprint below.
    if (next.sequence !== 1) throw error;
  }
  if (process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' && JSON.stringify(current) !== JSON.stringify(next)) {
    assertPromotionBase(base, api(`compare/${base}...${process.env.GITHUB_SHA}`));
  }
  let rollback;
  if (next.rollback) {
    assert.ok(isSource(next.rollback));
    const comparison = api(`compare/${next.rollback}...${base}`);
    assert.equal(comparison.merge_base_commit.sha, next.rollback, 'Rollback target was never on main');
    rollback = manifestAt(next.rollback);
  }
  await verifyApproved({ next, current, rollback });
  console.log(`Approved release manifest ${next.sequence} verified.`);
}
