import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { archivePayload, assertVersionedPackageReports, readReports } from './release-artifacts.mjs';
import { artifactBytes, digest } from './approved-release.mjs';
import { advanceReleaseState, assertTrustedCheck, compareVersions, firefoxWebsiteVersion, initialReleaseState, nextReleaseVersion, parseVersion, releaseDigest } from './release-state.mjs';
import { activeRepository } from './release-repository.mjs';
import { LEGACY_PRODUCT, releaseArtifacts } from './release-names.mjs';

const repository = activeRepository();
const gh = args => execFileSync('gh', args, { encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
const api = path => JSON.parse(gh(['api', `repos/${repository}/${path}`]));
const output = (key, value) => appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);

export function checkArtifactPrefix(packageJson, version) {
  assert.ok(Object.hasOwn(packageJson, 'name'), 'Release source package name is missing');
  return releaseArtifacts(version, packageJson.name).product;
}

export function requiredCheckJobs(jobs) {
  const names = jobs.filter(job => job.status === 'completed' && job.conclusion === 'success').map(job => job.name);
  for (const expected of ['Changed paths', 'Lint and types', 'Chrome', 'Firefox / Android']) assert.ok(names.includes(expected), `Missing successful Check job: ${expected}`);
  assert.ok(names.some(name => name.startsWith('Desktop browsers (ubuntu-latest)')), 'Missing successful Linux desktop Check');
  assert.ok(names.some(name => name.startsWith('Desktop browsers (macos-latest)')), 'Missing successful local macOS desktop Check');
}

export function candidateFingerprint(files) {
  const entries = Object.entries(files).sort(([a], [b]) => a.localeCompare(b));
  return releaseDigest(entries.map(([name, sha256]) => `${name}\0${sha256}\n`).join(''));
}

export function changesExtensionPayload(files) {
  return files.some(({ filename }) => /^(src|public)\//.test(filename)
    || ['package.json', 'package-lock.json', 'tsconfig.json',
      'scripts/build.mjs', 'scripts/build-version.mjs', 'scripts/browser-targets.mjs',
      'scripts/extension/build.mjs', 'scripts/extension/build-version.mjs', 'scripts/extension/browser-targets.mjs'].includes(filename));
}

export function assertReleaseSource(currentMain, source, comparison) {
  assert.equal(comparison.merge_base_commit.sha, source, 'Release source is no longer on main');
  assert.ok(['ahead', 'identical'].includes(comparison.status));
  assert.match(currentMain, /^[a-f0-9]{40}$/);
}

export function activeTrustedCheck(runs, source, branches, active = repository) {
  return runs.some(run => run.path === '.github/workflows/check.yml' && run.event === 'workflow_dispatch'
    && run.head_sha === source && branches.includes(run.head_branch)
    && run.repository?.full_name === active && run.head_repository?.full_name === active
    && ['queued', 'in_progress', 'requested', 'waiting'].includes(run.status));
}

const stateAssets = release => (release.assets || []).filter(asset => /^state-\d+\.json$/.test(asset.name))
  .sort((a, b) => Number(a.name.match(/\d+/)[0]) - Number(b.name.match(/\d+/)[0]));

export function latestReleaseState(release, ghCall = gh) {
  const asset = stateAssets(release).at(-1);
  if (!asset) return null;
  const bytes = ghCall(['api', '-H', 'Accept: application/octet-stream', `repos/${repository}/releases/assets/${asset.id}`]);
  const raw = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  assert.equal(asset.digest, `sha256:${digest(raw)}`, 'Release state asset digest does not match its bytes');
  const state = JSON.parse(raw.toString('utf8'));
  assert.equal(state.revision, Number(asset.name.match(/\d+/)[0]), 'Release state revision does not match its asset');
  assertReleaseIdentity(release, state);
  return state;
}

function assertReleaseIdentity(release, state) {
  const match = /^automation-(\d+)-(\d+)-(\d+)-([a-f0-9]{40})$/.exec(release.tag_name);
  assert.ok(match, 'Malformed pending release tag');
  const plan = JSON.parse(release.body);
  const version = `${match[1]}.${match[2]}.${match[3]}`, source = match[4];
  assert.equal(release.target_commitish, source, 'Release target does not match its tag');
  assert.equal(plan.source, source, 'Release plan source does not match its tag');
  assert.equal(plan.version, version, 'Release plan version does not match its tag');
  assert.equal(state.source, source, 'Release state source does not match its tag');
  assert.equal(state.version, version, 'Release state version does not match its tag');
  return { plan, source, version };
}

function canSupersede(state, { source, changed }) {
  return state.complete === false && state.website?.deployment === 'published'
    && ['chrome', 'edge', 'firefox'].every(browser => state.website?.[browser] === 'ready')
    && state.promotion === null && state.stores?.chrome === 'published'
    && state.source !== source && changesExtensionPayload(changed);
}

export function assertSupersedable(state, { source, changed, version }) {
  assert.equal(state.complete, false, 'A completed release does not need supersession');
  assert.equal(state.website?.deployment, 'published', 'Publish the previous website release before superseding it');
  for (const browser of ['chrome', 'edge', 'firefox']) assert.equal(state.website?.[browser], 'ready', `Previous ${browser} website package is not ready`);
  assert.equal(state.promotion, null, 'Finish the previous website promotion before superseding it');
  assert.equal(state.stores?.chrome, 'published', 'Publish the previous Chrome version before superseding it');
  assert.notEqual(state.source, source, 'Supersession requires a newer source');
  assert.ok(changesExtensionPayload(changed), 'Supersession requires an extension payload change');
  assert.ok(compareVersions(parseVersion(version), parseVersion(state.version)) > 0, 'Superseding version must exceed the previous release');
}

async function appendState(release, state, ghCall) {
  await mkdir('artifacts', { recursive: true });
  const path = join('artifacts', `state-${String(state.revision).padStart(3, '0')}.json`);
  await writeFile(path, JSON.stringify(state, null, 2) + '\n');
  ghCall(['release', 'upload', release.tag_name, path, '--repo', repository]);
}

async function reconcilePlannedSupersession(release, state, releases, currentMain, apiCall, ghCall) {
  const planned = state.supersession;
  if (planned?.status !== 'planned') return null;
  assert.equal(planned.fromTag, release.tag_name); assert.match(planned.newSource, /^[a-f0-9]{40}$/);
  assert.match(planned.newVersion, /^\d+\.\d+\.\d+$/);
  assert.ok(compareVersions(parseVersion(planned.newVersion), parseVersion(state.version)) > 0, 'Planned superseding version must be newer');
  assert.equal(planned.newTag, `automation-${planned.newVersion.replaceAll('.', '-')}-${planned.newSource}`, 'Planned superseding tag is not deterministic');
  assertReleaseSource(currentMain, planned.newSource, apiCall(`compare/${planned.newSource}...${currentMain}`));
  const plan = { schema: 1, source: planned.newSource, version: planned.newVersion, adopt: false,
    releaseRun: planned.releaseRun, releaseAttempt: planned.releaseAttempt, supersedes: release.tag_name };
  let next = releases.find(candidate => candidate.tag_name === planned.newTag);
  if (!next) {
    ghCall(['release', 'create', planned.newTag, '--repo', repository, '--target', planned.newSource, '--draft', '--prerelease',
      '--title', `anmerko ${planned.newVersion} automated release`, '--notes', JSON.stringify(plan)]);
    next = { tag_name: planned.newTag, draft: true, prerelease: false, created_at: new Date().toISOString(), body: JSON.stringify(plan), assets: [] };
  } else {
    assert.equal(next.target_commitish, planned.newSource); assert.deepEqual(JSON.parse(next.body), plan);
  }
  const superseded = advanceReleaseState(state, { supersession: { ...planned, status: 'superseded' } });
  if (superseded !== state) await appendState(release, superseded, ghCall);
  return next;
}

export async function resolveRelease({ api: apiCall = api, gh: ghCall = gh } = {}) {
  const source = apiCall('git/ref/heads/main').object.sha;
  const event = process.env.GITHUB_EVENT_NAME;
  const override = process.env.RELEASE_VERSION_OVERRIDE || undefined;
  const approved = JSON.parse(Buffer.from(apiCall(`contents/releases/approved.json?ref=${source}`).content, 'base64'));
  const packageJson = JSON.parse(Buffer.from(apiCall(`contents/package.json?ref=${source}`).content, 'base64'));
  const releases = apiCall('releases?per_page=100');
  const candidates = releases.filter(release => release.tag_name.startsWith('automation-')
      && (release.draft || release.prerelease) && !release.name?.startsWith('Abandoned stale'))
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const states = new Map(candidates.map(release => [release.tag_name, latestReleaseState(release, ghCall)]));
  const planning = candidates.filter(release => states.get(release.tag_name)?.supersession?.status === 'planned');
  assert.ok(planning.length <= 1, 'More than one release supersession is planned');
  if (planning.length) {
    const reconciled = await reconcilePlannedSupersession(planning[0], states.get(planning[0].tag_name), releases, source, apiCall, ghCall);
    if (!releases.some(release => release.tag_name === reconciled.tag_name)) candidates.unshift(reconciled);
    states.set(planning[0].tag_name, { ...states.get(planning[0].tag_name), supersession: { ...states.get(planning[0].tag_name).supersession, status: 'superseded' } });
  }
  let pending = candidates.filter(release => states.get(release.tag_name)?.supersession?.status !== 'superseded');
  if (pending.length > 1) throw new Error('More than one automated release is pending');
  if (!pending.length && process.env.RELEASE_RESUME_ONLY === 'true') { output('run', 'false'); return; }
  const completed = releases.find(release => release.tag_name.startsWith('automation-') && !release.draft && !release.prerelease
    && !release.name?.startsWith('Abandoned stale') && release.assets?.some(asset => /^state-\d+\.json$/.test(asset.name)));
  if (!pending.length && completed) {
    const previous = JSON.parse(completed.body);
    const changed = apiCall(`compare/${previous.source}...${source}`).files || [];
    if (!changesExtensionPayload(changed)) {
      output('run', 'false');
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `No extension payload changes since automated release ${previous.version}.\n`);
      return;
    }
  }
  let selectedSource = source;
  if (pending.length) {
    const pendingState = states.get(pending[0].tag_name);
    if (event === 'workflow_dispatch' && process.env.RELEASE_RESUME_ONLY !== 'true' && pendingState
        && pendingState.supersession?.status !== 'planned' && pendingState.source !== source) {
      const changed = apiCall(`compare/${pendingState.source}...${source}`).files || [];
      if (canSupersede(pendingState, { source, changed })) {
        assertReleaseSource(source, pendingState.source, apiCall(`compare/${pendingState.source}...${source}`));
        const version = nextReleaseVersion({ packageVersion: packageJson.version,
          approvedVersions: [...Object.values(approved.browsers).map(browser => browser.version), pendingState.version], override });
        assertSupersedable(pendingState, { source, changed, version });
        const newTag = `automation-${version.replaceAll('.', '-')}-${source}`;
        const supersession = { status: 'planned', fromTag: pending[0].tag_name, newTag, newSource: source, newVersion: version,
          releaseRun: Number(process.env.GITHUB_RUN_ID), releaseAttempt: Number(process.env.GITHUB_RUN_ATTEMPT) };
        const planned = advanceReleaseState(pendingState, { supersession });
        await appendState(pending[0], planned, ghCall);
        const next = await reconcilePlannedSupersession(pending[0], planned, releases, source, apiCall, ghCall);
        pending = [next]; states.set(pending[0].tag_name, null);
      }
    }
    const match = /^automation-(\d+)-(\d+)-(\d+)-([a-f0-9]{40})$/.exec(pending[0].tag_name);
    assert.ok(match, 'Malformed pending release tag');
    const plan = JSON.parse(pending[0].body);
    const pendingVersion = `${match[1]}.${match[2]}.${match[3]}`;
    let pendingSource = match[4], tag = pending[0].tag_name;
    assert.equal(plan.source, pendingSource); assert.equal(plan.version, pendingVersion);
    const built = pending[0].assets.some(asset => asset.name === 'release-candidate.tgz');
    if (!built && pendingSource !== source && !plan.supersedes) {
      ghCall(['release', 'edit', tag, '--repo', repository, '--draft=false', '--title', `Abandoned stale anmerko ${pendingVersion} plan`]);
      pendingSource = source; tag = `automation-${pendingVersion.replaceAll('.', '-')}-${source}`;
      const replacement = JSON.stringify({ ...plan, source });
      ghCall(['release', 'create', tag, '--repo', repository, '--target', source, '--draft', '--prerelease',
        '--title', `anmerko ${pendingVersion} automated release`, '--notes', replacement]);
    }
    selectedSource = pendingSource;
    const selectedPackage = pendingSource === source ? packageJson
      : JSON.parse(Buffer.from(apiCall(`contents/package.json?ref=${pendingSource}`).content, 'base64'));
    const artifactPrefix = checkArtifactPrefix(selectedPackage, pendingVersion);
    output('run', 'true'); output('resume', String(built)); output('source', pendingSource); output('version', pendingVersion); output('tag', tag);
    output('release-run', plan.releaseRun); output('release-attempt', plan.releaseAttempt); output('adopt', String(plan.adopt)); output('artifact-prefix', artifactPrefix);
    if (built) { output('ready', 'true'); return; }
  } else {
    if (event !== 'workflow_dispatch') { output('run', 'false'); return; }
    const changed = apiCall(`compare/${approved.browsers.chrome.source}...${source}`).files || [];
    const recoveryApproval = /^(chrome|firefox)-automated-recovery$/.test(approved.validation.kind)
      && approved.browsers.chrome.version === packageJson.version;
    const adopt = !changesExtensionPayload(changed) || recoveryApproval;
    if (adopt && approved.browsers.chrome.source === source && approved.browsers.firefox.source === source) {
      output('run', 'false');
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `No extension payload changes since the approved ${approved.browsers.chrome.version} release.\n`);
      return;
    }
    const version = nextReleaseVersion({ packageVersion: packageJson.version,
      approvedVersions: Object.values(approved.browsers).map(browser => browser.version), override: override || (adopt ? approved.browsers.chrome.version : undefined),
      adopt: adopt || process.env.ADOPT_EXISTING === 'true' });
    const tag = `automation-${version.replaceAll('.', '-')}-${source}`;
    output('run', 'true'); output('resume', 'false'); output('source', source); output('version', version); output('tag', tag);
    output('adopt', String(adopt || process.env.ADOPT_EXISTING === 'true')); output('artifact-prefix', checkArtifactPrefix(packageJson, version));
    const plan = JSON.stringify({ schema: 1, source, version, adopt, releaseRun: Number(process.env.GITHUB_RUN_ID), releaseAttempt: Number(process.env.GITHUB_RUN_ATTEMPT) });
    ghCall(['release', 'create', tag, '--repo', repository, '--target', source, '--draft', '--prerelease',
      '--title', `anmerko ${version} automated release`, '--notes', plan]);
    output('release-run', process.env.GITHUB_RUN_ID); output('release-attempt', process.env.GITHUB_RUN_ATTEMPT);
  }
  const runs = apiCall(`actions/workflows/check.yml/runs?head_sha=${selectedSource}&per_page=30`).workflow_runs;
  const snapshot = `codex/release-source-${selectedSource}`;
  assertReleaseSource(source, selectedSource, apiCall(`compare/${selectedSource}...${source}`));
  let trusted;
  for (const run of runs) {
    try {
      assertTrustedCheck(run, { source: selectedSource, branches: ['main', snapshot] });
      requiredCheckJobs(apiCall(`actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`).jobs);
      trusted = run; break;
    } catch { /* Search for another complete run. */ }
  }
  if (!trusted) {
    let existing;
    try { existing = apiCall(`git/ref/heads/${snapshot}`); } catch { /* Create the immutable snapshot below. */ }
    if (existing) assert.equal(existing.object.sha, selectedSource, 'Release snapshot branch moved');
    else ghCall(['api', `repos/${repository}/git/refs`, '--method', 'POST', '-f', `ref=refs/heads/${snapshot}`, '-f', `sha=${selectedSource}`]);
    const active = activeTrustedCheck(runs, selectedSource, ['main', snapshot]);
    if (!active) ghCall(['workflow', 'run', 'check.yml', '--repo', repository, '--ref', snapshot]);
    output('ready', 'false');
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${active ? 'Waiting for active' : 'Dispatched'} full Check for ${selectedSource} on ${snapshot}. The continuation will resume this release.\n`);
    return;
  }
  output('ready', 'true'); output('check-run', trusted.id); output('check-attempt', trusted.run_attempt);
}

async function verifyCandidate() {
  const source = process.env.RELEASE_SOURCE, version = process.env.RELEASE_VERSION;
  const reports = await readReports('artifacts/check-reports');
  const testedVersion = JSON.parse(await readFile('package.json', 'utf8')).version;
  const names = releaseArtifacts(version, process.env.ADOPT_EXISTING === 'true' ? LEGACY_PRODUCT : undefined);
  const chromePath = join('artifacts', names.chrome);
  const firefoxPath = join('artifacts', names.web);
  if (process.env.ADOPT_EXISTING === 'true') {
    const approved = JSON.parse(await readFile('releases/approved.json', 'utf8'));
    assert.equal(approved.browsers.chrome.version, version, 'Adoption requires the approved Chrome version');
    await writeFile(chromePath, await artifactBytes(approved.browsers.chrome.artifact));
    if (approved.validation.kind === 'firefox-automated-recovery' && version === '0.5.3') {
      const recoveryFiles = {
        'briefmark-0.5.3-firefox-unsigned.zip': '26b326565705fc6e6432e33c08c3bff2a61cd56082877dc5f428e57c9253efa1',
        'briefmark-0.5.3-firefox-source.zip': '83f33cde2952cb13943feb15b43a18853df6b7f0e6c629ace9461d3cab1e0479',
        'briefmark-0.5.3.1-firefox-unsigned.zip': approved.validation.unsignedSha256,
        'briefmark-0.5.3.1-firefox-source.zip': approved.validation.sourceSha256,
      };
      for (const [name, sha256] of Object.entries(recoveryFiles)) {
        const bytes = await readFile(join('releases/0-5-3', name));
        assert.equal(digest(bytes), sha256, `Pinned Firefox recovery archive changed: ${name}`);
        await writeFile(join('artifacts', name), bytes);
      }
    }
  }
  const chrome = archivePayload(chromePath), firefox = archivePayload(firefoxPath);
  assert.equal(JSON.parse(chrome['manifest.json']).version, version);
  assert.equal(JSON.parse(firefox['manifest.json']).version, firefoxWebsiteVersion(version));
  assertVersionedPackageReports(reports.filter(report => ['chrome', 'edge'].includes(report.browser)), source, chrome, testedVersion);
  assertVersionedPackageReports(reports.filter(report => report.browser === 'firefox' && Object.keys(report.payload || {}).length), source, firefox, testedVersion, true);
  const files = {};
  for (const name of [names.chrome, names.listed, names.listedSource, names.web, names.webSource]) {
    files[name] = digest(await readFile(join('artifacts', name)));
  }
  const payload = Object.fromEntries(Object.entries(chrome).filter(([name]) => name !== 'manifest.json').map(([name, bytes]) => [name, digest(bytes)]));
  const state = initialReleaseState({ source, version, payloadFingerprint: candidateFingerprint(payload), checkRun: Number(process.env.CHECK_RUN),
    releaseRun: Number(process.env.RELEASE_RUN), releaseAttempt: Number(process.env.RELEASE_ATTEMPT) });
  await writeFile('artifacts/state-001.json', JSON.stringify({ ...state, files }, null, 2) + '\n');
}

if (import.meta.main) {
  if (process.argv[2] === 'resolve') await resolveRelease();
  else if (process.argv[2] === 'verify-candidate') await verifyCandidate();
  else throw new Error('Expected resolve or verify-candidate');
}
