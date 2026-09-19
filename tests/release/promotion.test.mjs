import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { verifyApproved, verifyFreshRootImport } from '../../scripts/verify-approved-release.mjs';
import { digest } from '../../scripts/approved-release.mjs';
import { HISTORICAL_REPOSITORIES, activeRepository } from '../../scripts/release-repository.mjs';
const active = activeRepository();
const inactive = HISTORICAL_REPOSITORIES.find(repository => repository !== active);
const bootstrap = { schema: 1, sequence: 1, previous: null, validation: {
  kind: 'bootstrap', runId: 34759981700, source: 'e197736b17503298387424086c70eeae4d747b41',
  note: 'Preserves existing downloads and demo from successful main Site check; not new platform certification.',
}, browsers: { chrome: { version: '0.5.2', source: 'e197736b17503298387424086c70eeae4d747b41', artifact: {
  filename: 'briefmark-0.5.2.zip', location: 'releases/bootstrap/briefmark-0.5.2.zip',
  sha256: '83bc9709cde0f12cadd94311b58e1a1f7e8da6b373d91c67a31e67836bb32ed0',
} }, firefox: { version: '0.5.0', source: '234c5dd5dedac8ac3ff2e85e840eab1e6b8e46f4', artifact: {
  filename: 'briefmark-0.5.0-firefox.xpi', location: 'site/installers/briefmark-0.5.0-firefox.xpi',
  sha256: '8e716dada54a1451cc1d938eb0b6c7b33a8322e8743d41155f869f42d2bafef1',
} } }, demo: { version: '0.5.2', source: 'e197736b17503298387424086c70eeae4d747b41',
  entry: '/_astro/index.astro_astro_type_script_index_0_lang.BrlARXe4.js', files: {
    '/_astro/index.astro_astro_type_script_index_0_lang.BrlARXe4.js': { location: 'releases/bootstrap/_astro/index.astro_astro_type_script_index_0_lang.BrlARXe4.js', sha256: 'b93e664895fa06ce2f32c16aeb5f34206d9b0c4a8b8c0148c033077433e2ca79' },
    '/_astro/demo-runtime.BnqWqa-3.js': { location: 'releases/bootstrap/_astro/demo-runtime.BnqWqa-3.js', sha256: '03877da7dcada1834c29345fa4cbe98ec75cae6a47928466026adf266a5e1088' },
    '/_astro/privacy.C5Rrn9ZQ.css': { location: 'releases/bootstrap/_astro/privacy.C5Rrn9ZQ.css', sha256: 'ae0512c04c5c4e393b28ce47bb39a8fe137c6a73f04cb473e5ff137826ed113b' },
    '/_astro/panel.BUOyv_dd.css': { location: 'releases/bootstrap/_astro/panel.BUOyv_dd.css', sha256: '3d4174f328f215df7fa78aba247e53771bfe9c98954feb91ac46fd709035854c' },
    '/_astro/preload-helper.B3nfOi5I.js': { location: 'releases/bootstrap/_astro/preload-helper.B3nfOi5I.js', sha256: '298e58483be1903930c5a1661df3e66b3ef02723b34237990ad3a5f5e6052628' },
  } } };
const recovery = structuredClone(bootstrap);
Object.assign(recovery, { sequence: 2, previous: digest(JSON.stringify(bootstrap)), validation: {
  kind: 'chrome-automated-recovery', runId: 34792169134, runAttempt: 1, artifactId: 10327703755,
  artifactDigest: '8f332700ebabf0fc344aceaf17692081bed0e574e136116b879e1cbff98dad63',
  recordSha256: '9bf135e05e9f45a32405ff14fce3da94c722ebb07ad292b72fe2577b18557eae',
  source: 'ee99023240b3f7d47264b6fdc0d720ab43d7011c',
  note: 'Pinned recovery of an exact automatically tested Chrome package; no manual, store, or Firefox approval is claimed.',
} });
recovery.browsers.chrome = { version: '0.5.3', source: recovery.validation.source, artifact: {
  filename: 'briefmark-0.5.3.zip', location: 'releases/0-5-3/briefmark-0.5.3.zip',
  sha256: 'cc44a3edac9177a5c598112684e388938f1fb0e75c47d536eed8604ff3a545ee',
} };
const firefoxRecovery = structuredClone(recovery);
Object.assign(firefoxRecovery, { sequence: 3, previous: 'ca2026a75dcfed16b47e6172fb6927751da9962a1e5e00ccd991eaf4d56225d5', validation: {
  kind: 'firefox-automated-recovery', runId: 34792169134, runAttempt: 1,
  source: 'ee99023240b3f7d47264b6fdc0d720ab43d7011c', versionId: 6484856, fileId: 5029020,
  receiptSha256: '55a3b528b69367bd4c19dea001b2b1867428061770d7aa4ea6ce00faf0f98872',
  unsignedSha256: 'b005c4685740e6c646631a923c4bb40c3233566fae9283d508db7ccc8eceb07d',
  sourceSha256: '8159b943aface4e262fee65c90c5e2bf3be995c44eb685fe4c366461b256325b',
  packageSha256: '2cf9be1f056685f1993d6e1f70913b3af330488f0726bd4decee2ec4419a570d',
  note: 'Pinned recovery of an exact automatically tested Firefox payload after official unlisted signing; no signed installation or managed-upgrade evidence is claimed.',
} });
firefoxRecovery.browsers.firefox = { version: '0.5.3.1', source: firefoxRecovery.validation.source, artifact: {
  filename: 'briefmark-0.5.3.1-firefox.xpi', location: 'releases/0-5-3/briefmark-0.5.3.1-firefox.xpi',
  sha256: firefoxRecovery.validation.packageSha256,
} };
test('bootstrap preserves precisely the historical approval and later unchanged builds need no expired CI artifacts', async () => {
  await verifyApproved({ next: bootstrap });
  await verifyApproved({ next: bootstrap, current: structuredClone(bootstrap), get: () => assert.fail('No network needed for unchanged approval') });
  const forged = structuredClone(bootstrap);forged.browsers.chrome.version = '9.9.9';
  await assert.rejects(verifyApproved({ next: forged }), /bootstrap/);
});
test('fresh-root import admits only the audited manifest before checking every installer', async () => {
  const manifestBytes = await readFile(new URL('../../releases/approved.json', import.meta.url));
  const next = JSON.parse(manifestBytes);
  const marker = new Error('installer read reached');
  await assert.rejects(verifyFreshRootImport(next, {
    manifestBytes, commit: { parents: [] }, read: async () => { throw marker; },
  }), error => error === marker, 'the exact committed manifest reaches installer verification');
  await assert.rejects(verifyFreshRootImport(next, {
    manifestBytes, commit: { parents: [{ sha: 'a'.repeat(40) }] }, read: async () => assert.fail('non-root must not read installers'),
  }), /parentless/);
  await assert.rejects(verifyFreshRootImport(next, {
    manifestBytes: Buffer.from('forged'), commit: { parents: [] }, read: async () => assert.fail('forged manifest must not read installers'),
  }), /manifest bytes/);
  await assert.rejects(verifyFreshRootImport(next, {
    manifestBytes, commit: { parents: [] }, read: async () => Buffer.from('forged installer'),
  }), /installer checksum/);
});
test('pinned Chrome recovery accepts only the original automated run, record, package and browser change', async () => {
  const record = await readFile(new URL('../../releases/0-5-3/validation.json', import.meta.url));
  const installer = await readFile(new URL('../../releases/0-5-3/briefmark-0.5.3.zip', import.meta.url));
  const run = { path: '.github/workflows/release.yml', event: 'workflow_dispatch', head_branch: 'main',
    head_sha: recovery.validation.source, repository: { full_name: active },
    head_repository: { full_name: active }, status: 'completed', conclusion: 'success', run_attempt: 1 };
  const jobs = ['Resolve release source', 'Prepare and test exact packages', 'Release gate',
    ...['ubuntu-latest', 'macos-latest'].map(os => `Release desktop (${os}) / Browser scenarios`)]
    .map(name => ({ name, status: 'completed', conclusion: 'success' }));
  const artifact = { id: recovery.validation.artifactId, name: 'validated-release-1', expired: false,
    digest: `sha256:${recovery.validation.artifactDigest}` };
  const get = path => path.endsWith('/artifacts?per_page=100') ? { artifacts: [artifact] } : path.includes('/jobs?') ? { jobs } : run;
  const options = { next: recovery, current: bootstrap, get, original: async () => record, read: async () => installer };
  await verifyApproved(options);
  await assert.rejects(verifyApproved({ ...options, read: async () => Buffer.from('other package') }), /package bytes changed/);
  const wrongSource = structuredClone(recovery); wrongSource.validation.source = 'a'.repeat(40);
  await assert.rejects(verifyApproved({ ...options, next: wrongSource }), /deep-equal|Expected values/);
  const wrongRun = structuredClone(recovery); wrongRun.validation.runId++;
  await assert.rejects(verifyApproved({ ...options, next: wrongRun }), /deep-equal|Expected values/);
  const changedFirefox = structuredClone(recovery); changedFirefox.browsers.firefox.version = '9.9.9';
  await assert.rejects(verifyApproved({ ...options, next: changedFirefox }), /cannot change Firefox/);
});
test('automation promotion is bound to its completed Release evidence, full Check and exact signed packages', async () => {
  const source = 'a'.repeat(40), controller = 'b'.repeat(40), version = '0.5.4', phase = 'website';
  const packages = {
    chrome: { version, filename: `briefmark-${version}.zip`, sha256: digest('chrome') },
    edge: { version, filename: `briefmark-${version}-edge.zip`, sha256: digest('chrome') },
    firefox: { version: `${version}.1`, filename: `briefmark-${version}.1-firefox.xpi`, sha256: digest('signed firefox') },
  };
  const files = Object.fromEntries(Object.values(packages).map(entry => [entry.filename, entry.sha256]));
  const evidence = { schema: 1, source, controller, version, phase, checkRun: 456, payloadFingerprint: 'f'.repeat(64), files, browsers: packages };
  const evidenceBytes = Buffer.from(JSON.stringify(evidence));
  const tag = `automation-${version.replaceAll('.', '-')}-${source}`, base = `https://github.com/htxryan/briefmark/releases/download/${tag}`;
  const next = { ...structuredClone(recovery), sequence: 3, previous: digest(JSON.stringify(recovery)), validation: {
    kind: 'automation', runId: 123, runAttempt: 2, source, controller, checkRun: 456, version, phase,
    payloadFingerprint: evidence.payloadFingerprint,
    record: { location: `${base}/promotion-${phase}-${controller}.json`, sha256: digest(evidenceBytes) },
  }, browsers: Object.fromEntries(Object.entries(packages).map(([browser, entry]) => [browser, { version: entry.version, source,
    artifact: { filename: entry.filename, location: `${base}/${entry.filename}`, sha256: entry.sha256 } }])) };
  const releaseRun = { path: '.github/workflows/release.yml', event: 'schedule', head_branch: 'main', head_sha: controller,
    repository: { full_name: active }, head_repository: { full_name: active },
    status: 'completed', conclusion: 'success', run_attempt: 2 };
  const checkRun = { path: '.github/workflows/check.yml', event: 'workflow_dispatch', head_branch: `codex/release-source-${source}`, head_sha: source,
    repository: { full_name: active }, head_repository: { full_name: active }, status: 'completed', conclusion: 'success' };
  const success = name => ({ name, status: 'completed', conclusion: 'success' });
  const checkJobs = ['Changed paths', 'Lint and types', 'Chrome', 'Firefox / Android',
    'Desktop browsers (ubuntu-latest) / Browser scenarios', 'Desktop browsers (macos-latest) / Browser scenarios'].map(success);
  const release = { tag_name: tag, target_commitish: source, assets: [
    { name: `promotion-${phase}-${controller}.json`, digest: `sha256:${digest(evidenceBytes)}` },
    ...Object.values(packages).map(entry => ({ name: entry.filename, digest: `sha256:${entry.sha256}` })),
  ] };
  const actionsArtifact = { id: 789, name: 'release-evidence-2', expired: false };
  const get = path => {
    if (path === 'actions/runs/123') return releaseRun;
    if (path.includes('actions/runs/123/attempts/2/jobs')) return { jobs: [success('One-button release')] };
    if (path === 'actions/runs/123/artifacts?per_page=100') return { artifacts: [actionsArtifact] };
    if (path === 'actions/runs/456') return checkRun;
    if (path.includes('actions/runs/456/attempts/')) return { jobs: checkJobs };
    if (path === 'git/ref/heads/main') return { object: { sha: controller } };
    if (path === `compare/${source}...${controller}`) return { merge_base_commit: { sha: source }, status: 'ahead' };
    if (path.startsWith('compare/')) return { merge_base_commit: { sha: source }, status: 'ahead' };
    if (path === 'releases?per_page=100&page=1') return [release];
    assert.fail(`Unexpected API request: ${path}`);
  };
  const read = async artifact => artifact.location.endsWith('.json') ? evidenceBytes
    : Buffer.from(artifact.filename.includes('firefox') ? 'signed firefox' : 'chrome');
  const options = { next, current: recovery, get, read, original: async () => evidenceBytes };
  await verifyApproved(options);

  await assert.rejects(verifyApproved({ ...options, active: 'someone/fork' }), /Expected values/);
  const repositoryMismatch = path => path === 'actions/runs/456'
    ? { ...checkRun, repository: { full_name: inactive } } : get(path);
  const headRepositoryMismatch = path => path === 'actions/runs/456'
    ? { ...checkRun, head_repository: { full_name: inactive } } : get(path);
  await assert.rejects(verifyApproved({ ...options, get: repositoryMismatch }), /Expected values/);
  await assert.rejects(verifyApproved({ ...options, get: headRepositoryMismatch }), /Expected values/);

  const rejectMutation = async (mutate, pattern) => {
    const changed = structuredClone(next); mutate(changed);
    await assert.rejects(verifyApproved({ ...options, next: changed }), pattern);
  };
  await rejectMutation(value => { value.validation.runId = 124; }, /run|Expected/);
  await rejectMutation(value => { value.validation.source = 'b'.repeat(40); }, /source|Expected/);
  await rejectMutation(value => { value.browsers.chrome.artifact.sha256 = digest('forged'); }, /hash|sha|Expected/i);
  await rejectMutation(value => { value.browsers.firefox.artifact.filename = `briefmark-${version}.1-firefox-unsigned.zip`; }, /signed|xpi/i);
  await assert.rejects(verifyApproved({ ...options, original: async () => Buffer.from('forged evidence') }), /evidence|record|changed|Expected/i);
  checkJobs.find(job => job.name.startsWith('Desktop browsers (macos-latest)')).conclusion = 'failure';
  await assert.rejects(verifyApproved(options), /macOS|Check job/);
});
test('pinned Firefox recovery accepts only exact AMO-signed bytes from the tested payload', async () => {
  const installer = await readFile(new URL('../../releases/0-5-3/briefmark-0.5.3.1-firefox.xpi', import.meta.url));
  const run = { path: '.github/workflows/release.yml', event: 'workflow_dispatch', head_branch: 'main',
    head_sha: firefoxRecovery.validation.source, repository: { full_name: active },
    head_repository: { full_name: active }, status: 'completed', conclusion: 'success', run_attempt: 1 };
  const jobs = ['Resolve release source', 'Prepare and test exact packages', 'Release gate',
    ...['ubuntu-latest', 'macos-latest'].map(os => `Release desktop (${os}) / Browser scenarios`)]
    .map(name => ({ name, status: 'completed', conclusion: 'success' }));
  const get = path => path.includes('/jobs?') ? { jobs } : run;
  const options = { next: firefoxRecovery, current: recovery, get, read: async () => installer };
  await verifyApproved(options);
  await assert.rejects(verifyApproved({ ...options, read: async () => Buffer.from('tampered signed package') }), /package bytes changed/);
  const changedChrome = structuredClone(firefoxRecovery); changedChrome.browsers.chrome.version = '9.9.9';
  await assert.rejects(verifyApproved({ ...options, next: changedChrome }), /cannot change Chrome/);
  const addedEdge = structuredClone(firefoxRecovery); addedEdge.browsers.edge = structuredClone(addedEdge.browsers.chrome);
  addedEdge.browsers.edge.artifact.filename = 'briefmark-0.5.3-edge.zip';
  await assert.rejects(verifyApproved({ ...options, next: addedEdge }), /cannot add or remove browsers/);
  const forgedReceipt = structuredClone(firefoxRecovery); forgedReceipt.validation.fileId++;
  await assert.rejects(verifyApproved({ ...options, next: forgedReceipt }), /deep-equal|Expected values/);
});
test('even a successful full run cannot authorize a forged durable validation record', async () => {
  const next = { ...bootstrap, sequence: 2, previous: digest(JSON.stringify(bootstrap)), validation: {
    kind: 'release', runId: 123, runAttempt: 1, source: 'a'.repeat(40), workflowVersion: 'b'.repeat(64),
    record: { location: 'https://github.com/htxryan/briefmark/releases/download/fake/validation.json', sha256: 'c'.repeat(64) },
  } };
  await assert.rejects(verifyApproved({ next, current: bootstrap, policy: () => 'new policy', get: () => assert.fail('Reject stale policy before network') }), /policy changed/);
  const run = { path: '.github/workflows/release.yml', event: 'workflow_dispatch', head_branch: 'main',
    repository: { full_name: active }, head_repository: { full_name: active },
    status: 'completed', conclusion: 'success', run_attempt: 1 };
  const jobs = ['Resolve release source','Prepare and test exact packages','Release gate',
    ...['ubuntu-latest','windows-latest','macos-latest'].map(os => `Release desktop (${os}) / Browser scenarios`)]
    .map(name => ({ name, status: 'completed', conclusion: 'success' }));
  const get = path => path.includes('/jobs?') ? { jobs } : run;
  await assert.rejects(verifyApproved({ next, current: bootstrap, get, policy: () => 'b'.repeat(64), original: async () => Buffer.from('actual trusted record') }), /Forged/);
  for (const conclusion of ['skipped','cancelled','failure',null]) {
    jobs[2].conclusion = conclusion;
    await assert.rejects(verifyApproved({ next, current: bootstrap, get, policy: () => 'b'.repeat(64) }));
  }
});

test('a fully attested promotion serves the tested installers and retains demo archives only as evidence', async () => {
  const { copyApprovedDownloads } = await import('../../scripts/approved-release.mjs');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const source = 'a'.repeat(40), policy = 'b'.repeat(64), version = '0.5.3';
  const filename = `briefmark-${version}.zip`, installer = Buffer.from('exact tested package'), demo = Buffer.from('exact tested demo');
  const sha256 = digest(installer), demoHash = digest(demo);
  const candidate = { schema: 1, source, version, scope: 'full', workflowVersion: policy, eligible: true,
    previous: digest(JSON.stringify(bootstrap)), browsers: { chrome: { filename, sha256 } },
    demo: { entry: '/_astro/demo.js', files: { '/_astro/demo.js': { file: 'demo.js', sha256: demoHash } } },
    automated: { result: 'passed', source, scope: 'full', workflowVersion: policy, packages: { chrome: sha256 } },
    manual: { source, browsers: { chrome: Object.fromEntries(['darwin','linux','win32'].map(os => [os, {
      result: 'passed', version, sha256, evidence: `docs/evidence/${os}.json`,
      scenarios: Object.fromEntries(['P1','P2','P3','P4','P5','P6','P7','P8'].map(id => [id, 'passed'])),
    }])) } },
  };
  const bytes = Buffer.from(JSON.stringify(candidate)), tag = `approved-${source}-123-1`;
  const base = `https://github.com/htxryan/briefmark/releases/download/${tag}`;
  const next = { ...bootstrap, sequence: 2, previous: candidate.previous,
    validation: { kind: 'release', runId: 123, runAttempt: 1, source, workflowVersion: policy,
      record: { location: `${base}/validation.json`, sha256: digest(bytes) } },
    browsers: { ...bootstrap.browsers, chrome: { version, source, artifact: { filename, sha256, location: `${base}/${filename}` } } },
    demo: { version, source, entry: '/_astro/demo.js', files: { '/_astro/demo.js': { location: `${base}/demo.js`, sha256: demoHash } } },
  };
  const jobs = ['Resolve release source','Prepare and test exact packages','Release gate',
    ...['ubuntu-latest','windows-latest','macos-latest'].map(os => `Release desktop (${os}) / Browser scenarios`)]
    .map(name => ({ name, status: 'completed', conclusion: 'success' }));
  const run = { path: '.github/workflows/release.yml', event: 'workflow_dispatch', head_branch: 'main',
    repository: { full_name: active }, head_repository: { full_name: active },
    status: 'completed', conclusion: 'success', run_attempt: 1 };
  const release = { tag_name: tag, target_commitish: source, assets: [
    { name: filename, digest: `sha256:${sha256}` }, { name: 'demo.js', digest: `sha256:${demoHash}` },
    { name: 'validation.json', digest: `sha256:${digest(bytes)}` },
  ] };
  const get = path => path.startsWith('releases?') ? [release] : path.includes('/jobs?') ? { jobs } : run;
  const options = { next, current: bootstrap, get, read: async artifact => artifact.location.endsWith('validation.json') ? bytes : artifact.location.endsWith(filename) ? installer : demo, original: async () => bytes, policy: () => policy };
  jobs.splice(jobs.findIndex(job => job.name.includes('windows-latest')), 1);
  await verifyApproved(options);
  const directory = await mkdtemp(join(tmpdir(), 'briefmark-promotion-'));
  try {
    const fetchImpl = async url => new Response(url.endsWith(filename) ? installer : demo);
    await copyApprovedDownloads(next, { output: directory, fetchImpl });
    assert.deepEqual(await readFile(join(directory, 'downloads', filename)), installer);
    await assert.rejects(readFile(join(directory, '_astro', 'demo.js')), { code: 'ENOENT' });
    assert.deepEqual(await readFile(join(directory, 'downloads', bootstrap.browsers.firefox.artifact.filename)),
      await readFile(bootstrap.browsers.firefox.artifact.location));
    await assert.rejects(copyApprovedDownloads(next, { output: directory, fetchImpl: async () => new Response('changed bytes') }), /checksum/);
    assert.deepEqual(await readFile(join(directory, 'downloads', filename)), installer, 'Failed copy preserves approved files');
  } finally { await rm(directory, { recursive: true, force: true }); }
  delete release.assets[0].digest;
  await verifyApproved(options);
  await assert.rejects(verifyApproved({ ...options, read: async artifact => artifact.location.endsWith('validation.json') ? bytes : Buffer.from('changed bytes') }), /checksum/);
  release.assets[0].digest = 'sha256:tampered';
  await assert.rejects(verifyApproved(options));
});
