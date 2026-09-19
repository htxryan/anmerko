import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { archivePayload } from './release-artifacts.mjs';
import { artifactBytes, digest, findReleaseByTag, validateManifest } from './approved-release.mjs';
import { requiredCheckJobs } from './release-automation.mjs';
import { advanceReleaseState, firefoxWebsiteVersion } from './release-state.mjs';
import { createAmoClient, createAmoJwtProvider, createChromeServiceAccountTokenProvider, createChromeStoreClient } from './store-api.mjs';
import { activeRepository } from './release-repository.mjs';
import { FIREFOX_GUID, releaseArtifactsFromState } from './release-names.mjs';

const repository = activeRepository(), directory = 'artifacts';
const gh = (args, options = {}) => execFileSync('gh', args, { encoding: 'utf8', timeout: 120000, maxBuffer: 32 * 1024 * 1024, ...options });
const api = path => JSON.parse(gh(['api', `repos/${repository}/${path}`]));
const optional = path => { try { return api(path); } catch (error) { if (String(error.stderr).includes('(HTTP 404)')) return null; throw error; } };
const mutate = (method, path, body) => JSON.parse(gh(['api', `repos/${repository}/${path}`, '--method', method, '--input', '-'], { input: JSON.stringify(body) }));
const mutatePull = (method, path, body) => {
  assert.ok(process.env.RELEASE_PR_TOKEN, 'Dedicated release PR identity is unavailable');
  return JSON.parse(gh(['api', `repos/${repository}/${path}`, '--method', method, '--input', '-'], {
    input: JSON.stringify(body), env: { ...process.env, GH_TOKEN: process.env.RELEASE_PR_TOKEN },
  }));
};

export function promotableCheck(runs, head) {
  return runs.find(run => run.path === '.github/workflows/check.yml' && run.head_sha === head && run.event === 'workflow_dispatch'
    && run.repository?.full_name === repository && run.head_repository?.full_name === repository
    && (run.head_branch === 'main' || run.head_branch.startsWith('codex/automated-release-'))
    && run.status === 'completed' && run.conclusion === 'success') || null;
}
export function successfulDeploy(runs, head) {
  return runs.find(run => run.path === '.github/workflows/deploy.yml' && run.head_sha === head && run.event === 'workflow_dispatch'
    && run.repository?.full_name === repository && run.head_repository?.full_name === repository
    && run.status === 'completed' && run.conclusion === 'success') || null;
}
export function chromeReviewState(result, version) {
  const published = result.status?.publishedItemRevisionStatus?.distributionChannels || [];
  return published.some(channel => channel.crxVersion === version) ? 'published' : 'pending-review';
}
export function firefoxReviewNotes(version, sourceZipPath) {
  return `Review the matching source archive ${basename(sourceZipPath)} for extension version ${version}.

Build with Node.js 24 or later from the extracted source archive root:
npm ci
RELEASE_VERSION=${version} npm run build:firefox

The resulting dist-firefox directory is the submitted extension. esbuild bundles TypeScript and embeds panel.css without minifying or obfuscating it. The listed and website/unlisted variants are distinct packages; use this submission's matching source archive. The unlisted package has no custom update URL; users update it manually in the same Firefox profile.`;
}
export function assertSignedVariant(signed, unsigned, expectedVersion) {
  const signedPayload = archivePayload(signed), unsignedPayload = archivePayload(unsigned);
  assert.ok(Object.keys(signedPayload).some(name => name === 'META-INF/mozilla.rsa'), 'Firefox XPI lacks Mozilla signature');
  const names = Object.keys(signedPayload).filter(name => !name.startsWith('META-INF/'));
  assert.deepEqual(names.sort(), Object.keys(unsignedPayload).sort());
  for (const name of names) {
    if (name === 'manifest.json') {
      const manifest = JSON.parse(signedPayload[name]);
      assert.equal(manifest.version, expectedVersion);
      assert.equal(manifest.browser_specific_settings?.gecko?.id, FIREFOX_GUID, 'Firefox GUID changed');
      assert.deepEqual(manifest, JSON.parse(unsignedPayload[name]), 'Signed Firefox manifest changed');
    }
    else assert.equal(digest(signedPayload[name]), digest(unsignedPayload[name]), `Signed Firefox changed payload: ${name}`);
  }
}

function assertOwnedPromotion(apiCall, pr, branch) {
  assert.ok(['github-actions[bot]', 'briefmark-release-automation[bot]'].includes(pr.user?.login), 'Promotion PR has an unexpected author');
  assert.equal(pr.head?.ref, branch); assert.equal(pr.head?.repo?.full_name, repository); assert.equal(pr.base?.ref, 'main');
  const head = apiCall(`git/ref/heads/${branch}`).object.sha;
  const commit = apiCall(`git/commits/${head}`); assert.equal(commit.parents.length, 1);
  const parent = commit.parents[0].sha;
  const owned = apiCall(`compare/${parent}...${head}`);
  assert.equal(owned.total_commits, 1); assert.deepEqual(owned.files.map(file => file.filename), ['releases/approved.json']);
  return { head, parent };
}

async function uploadImmutable(tag, source, paths) {
  const release = findReleaseByTag(api, tag);
  assert.equal(release.target_commitish, source);
  assert.ok(release.draft || release.prerelease, 'Release is no longer an active draft or prerelease');
  const existing = new Map(release.assets.map(asset => [asset.name, asset]));
  for (const path of paths) {
    const name = basename(path), sha256 = digest(await readFile(path)), asset = existing.get(name);
    if (!asset) gh(['release', 'upload', tag, path, '--repo', repository]);
    else if (asset.digest) assert.equal(asset.digest, `sha256:${sha256}`, `Durable release asset changed: ${name}`);
    else assert.equal(digest(await artifactBytes({ filename: name, sha256, location: `https://github.com/${repository}/releases/download/${tag}/${name}` })), sha256);
  }
}

async function saveState(state, tag, source) {
  const path = join(directory, `state-${String(state.revision).padStart(3, '0')}.json`);
  await writeFile(path, JSON.stringify(state, null, 2) + '\n'); await uploadImmutable(tag, source, [path]);
}

export async function continuePromotion(state, tag, { api: apiCall = api, gh: ghCall = gh, mutate: mutation = mutate,
  mutatePull: pullMutation = mutatePull, save: persist = saveState } = {}) {
  if (!state.promotion || typeof state.promotion !== 'object') return { handled: false, state };
  const { branch, pr: number } = state.promotion;
  const pr = apiCall(`pulls/${number}`);
  if (pr.state === 'closed' && !pr.merged_at && state.promotion.status === 'reopening') {
    assertOwnedPromotion(apiCall, pr, branch);
    pullMutation('PATCH', `pulls/${number}`, { state: 'open' });
    state = advanceReleaseState(state, { promotion: { ...state.promotion, status: 'waiting-for-release' } });
    await persist(state, tag, state.source);
    return { handled: true, state };
  }
  if (pr.state === 'open') {
    const authorizer = apiCall(`actions/runs/${state.promotion.runId}`);
    if (authorizer.status !== 'completed') return { handled: true, state };
    if (authorizer.conclusion !== 'success') {
      state = advanceReleaseState(state, { promotion: null });
      await persist(state, tag, state.source);
      return { handled: false, state };
    }
    const { head, parent } = assertOwnedPromotion(apiCall, pr, branch);
    const runs = apiCall(`actions/workflows/check.yml/runs?head_sha=${head}&per_page=30`).workflow_runs;
    const main = apiCall('git/ref/heads/main').object.sha;
    let refreshed = false;
    if (parent !== main) {
      const ancestry = apiCall(`compare/${parent}...${main}`);
      assert.equal(ancestry.merge_base_commit.sha, parent, 'Promotion base is no longer on main');
      const current = JSON.parse(Buffer.from(apiCall(`contents/releases/approved.json?ref=${main}`).content, 'base64'));
      const promoted = JSON.parse(Buffer.from(apiCall(`contents/releases/approved.json?ref=${head}`).content, 'base64'));
      assert.equal(promoted.previous, digest(JSON.stringify(current)), 'Approved manifest changed while promotion was waiting');
      const tree = mutation('POST', 'git/trees', { base_tree: apiCall(`git/commits/${main}`).tree.sha,
        tree: [{ path: 'releases/approved.json', mode: '100644', type: 'blob', content: JSON.stringify(promoted, null, 2) + '\n' }] });
      const updated = mutation('POST', 'git/commits', { message: `release: publish anmerko ${state.version} ${state.promotion.phase}`,
        tree: tree.sha, parents: [main] });
      mutation('PATCH', `git/refs/heads/${branch}`, { sha: updated.sha, force: true });
      refreshed = true;
    }
    const explicit = promotableCheck(runs, head);
    const explicitActive = runs.some(run => run.path === '.github/workflows/check.yml' && run.event === 'workflow_dispatch'
      && run.head_sha === head && run.repository?.full_name === repository && run.head_repository?.full_name === repository
      && ['queued', 'in_progress', 'requested', 'waiting'].includes(run.status));
    if (refreshed || (!explicit && !explicitActive)) ghCall(['workflow', 'run', 'check.yml', '--repo', repository, '--ref', branch]);
    const pullRequestRuns = runs.filter(run => run.path === '.github/workflows/check.yml' && run.event === 'pull_request'
      && run.head_sha === head && run.repository?.full_name === repository
      && run.head_repository?.full_name === repository).sort((a, b) => (b.id || 0) - (a.id || 0));
    const latestPullRequestRun = pullRequestRuns[0];
    if (refreshed || latestPullRequestRun?.conclusion === 'action_required') {
      state = advanceReleaseState(state, { promotion: { ...state.promotion, status: 'reopening' } });
      await persist(state, tag, state.source);
      pullMutation('PATCH', `pulls/${number}`, { state: 'closed' });
      pullMutation('PATCH', `pulls/${number}`, { state: 'open' });
      state = advanceReleaseState(state, { promotion: { ...state.promotion, status: 'waiting-for-release' } });
      await persist(state, tag, state.source);
      return { handled: true, state };
    }
    const pullRequestCheck = latestPullRequestRun?.status === 'completed' && latestPullRequestRun.conclusion === 'success'
      ? latestPullRequestRun : null;
    if (!pullRequestCheck) return { handled: true, state };
    requiredCheckJobs(apiCall(`actions/runs/${pullRequestCheck.id}/attempts/${pullRequestCheck.run_attempt || 1}/jobs?per_page=100`).jobs);
    if (!explicit) return { handled: true, state };
    const merged = mutation('PUT', `pulls/${number}/merge`, { sha: head, merge_method: 'squash', commit_title: `Release anmerko ${state.version} (#${number})` });
    assert.equal(merged.merged, true, merged.message); ghCall(['workflow', 'run', 'check.yml', '--repo', repository, '--ref', 'main']);
    state = advanceReleaseState(state, { promotion: { ...state.promotion, status: 'merged' }, website: { deployment: 'waiting-for-main-check' } });
    await persist(state, tag, state.source); return { handled: true, state };
  }
  assert.ok(pr.merged_at, 'Promotion PR closed without merge');
  const main = apiCall('git/ref/heads/main').object.sha;
  if (state.website.deployment === 'dispatched') {
    const deployments = apiCall(`actions/workflows/deploy.yml/runs?head_sha=${main}&event=workflow_dispatch&per_page=30`).workflow_runs;
    if (successfulDeploy(deployments, main)) {
      state = advanceReleaseState(state, { promotion: null, website: { deployment: 'published' } }); await persist(state, tag, state.source);
      return { handled: true, state };
    }
    if (deployments.some(run => ['queued', 'in_progress', 'requested', 'waiting'].includes(run.status))) return { handled: true, state };
  }
  const checks = apiCall(`actions/workflows/check.yml/runs?head_sha=${main}&per_page=30`).workflow_runs;
  const check = promotableCheck(checks, main);
  if (check) {
    ghCall(['workflow', 'run', 'deploy.yml', '--repo', repository, '--ref', 'main', '-f', `check-run=${check.id}`]);
    state = advanceReleaseState(state, { website: { deployment: 'dispatched' } }); await persist(state, tag, state.source);
  } else if (!checks.some(run => ['queued', 'in_progress', 'requested', 'waiting'].includes(run.status))) ghCall(['workflow', 'run', 'check.yml', '--repo', repository, '--ref', 'main']);
  return { handled: true, state };
}

async function deliver() {
  const source = process.env.RELEASE_SOURCE, version = process.env.RELEASE_VERSION, tag = process.env.RELEASE_TAG;
  const stateFiles = (await readdir(directory)).filter(name => /^state-\d{3}\.json$/.test(name)).sort();
  let state = JSON.parse(await readFile(join(directory, stateFiles.at(-1)), 'utf8'));
  const webVersion = firefoxWebsiteVersion(version);
  const names = releaseArtifactsFromState(state);
  const paths = Object.fromEntries(Object.entries(names).filter(([, name]) => typeof name === 'string').map(([key, name]) => [key, join(directory, name)]));
  await uploadImmutable(tag, source, [paths.chrome, paths.listed, paths.listedSource, paths.web, paths.webSource, join(directory, 'state-001.json')]);
  const candidateRelease = findReleaseByTag(api, tag);
  if (candidateRelease.draft) gh(['release', 'edit', tag, '--repo', repository, '--draft=false', '--prerelease=true']);
  const listings = JSON.parse(await readFile('docs/store/listings.json', 'utf8'));
  const amo = createAmoClient({ jwt: createAmoJwtProvider({ issuer: process.env.WEB_EXT_API_KEY, secret: process.env.WEB_EXT_API_SECRET }), addonId: listings.mozillaAddOns.addonId });
  state = advanceReleaseState(state, { website: { chrome: 'ready', edge: 'ready' } });
  try {
    const account = JSON.parse(process.env.CWS_SERVICE_ACCOUNT_JSON);
    const chrome = createChromeStoreClient({ accessToken: createChromeServiceAccountTokenProvider({ clientEmail: account.client_email, privateKey: account.private_key }), publisherId: process.env.CWS_PUBLISHER_ID, itemId: listings.chromeWebStore.listingId });
    const result = await chrome.release({ zipPath: paths.chrome, expectedVersion: version });
    state = advanceReleaseState(state, { stores: { chrome: chromeReviewState(result, version) } });
  } catch (error) { state = advanceReleaseState(state, { stores: { chrome: `retry:${error.code || 'error'}` } }); }
  try {
    const listed = await amo.releaseListed({ zipPath: paths.listed, sourceZipPath: paths.listedSource, version,
      metadata: { approval_notes: firefoxReviewNotes(version, paths.listedSource) } });
    state = advanceReleaseState(state, { stores: { firefox: listed.version.file?.status === 'public' ? 'published' : 'pending-review' } });
  } catch (error) { state = advanceReleaseState(state, { stores: { firefox: `retry:${error.code || 'error'}` } }); }
  try {
    const unlisted = await amo.signUnlisted({ zipPath: paths.web, sourceZipPath: paths.webSource, version: webVersion,
      metadata: { approval_notes: firefoxReviewNotes(webVersion, paths.webSource) } });
    const bytes = await amo.downloadSignedXpi({ version: webVersion, expectedVersionId: unlisted.version.id });
    await writeFile(paths.xpi, bytes); assertSignedVariant(paths.xpi, paths.web, webVersion); await uploadImmutable(tag, source, [paths.xpi]);
    state = advanceReleaseState(state, { website: { firefox: 'ready' } });
  } catch (error) { state = advanceReleaseState(state, { website: { firefox: error.code === 'NOT_SIGNED' ? 'waiting-for-signature' : `retry:${error.code || 'error'}` } }); }
  await saveState(state, tag, source);
  const continuation = await continuePromotion(state, tag);
  state = continuation.state;
  if (continuation.handled) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Website\nPromotion: ${JSON.stringify(state.promotion)}; deployment: ${state.website.deployment}.\n\n### Stores\nChrome: ${state.stores.chrome}; Firefox: ${state.stores.firefox}.\n`);
    return;
  }
  const main = api('git/ref/heads/main').object.sha;
  const approved = JSON.parse(Buffer.from(api(`contents/releases/approved.json?ref=${main}`).content, 'base64'));
  const url = `https://github.com/${repository}/releases/download/${tag}`;
  const artifact = async path => ({ filename: basename(path), location: `${url}/${basename(path)}`, sha256: digest(await readFile(path)) });
  const browsers = {};
  if (approved.browsers.chrome.source !== source || approved.browsers.chrome.version !== version) {
    browsers.chrome = { version, filename: basename(paths.chrome), sha256: digest(await readFile(paths.chrome)) };
    const edgePath = paths.edge; await writeFile(edgePath, await readFile(paths.chrome)); await uploadImmutable(tag, source, [edgePath]);
    browsers.edge = { version, filename: basename(edgePath), sha256: digest(await readFile(edgePath)) };
  }
  if (state.website.firefox === 'ready' && (approved.browsers.firefox.source !== source || approved.browsers.firefox.version !== webVersion)) browsers.firefox = { version: webVersion, filename: basename(paths.xpi), sha256: digest(await readFile(paths.xpi)) };
  if (!Object.keys(browsers).length) {
    if (state.complete) {
      gh(['release', 'edit', tag, '--repo', repository, '--draft=false', '--prerelease=false']);
      try { gh(['api', `repos/${repository}/git/refs/heads/codex/release-source-${source}`, '--method', 'DELETE']); }
      catch (error) { if (!String(error.stderr).includes('(HTTP 422)') && !String(error.stderr).includes('(HTTP 404)')) throw error; }
    }
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Website\nChrome: ${state.website.chrome}; Edge: ${state.website.edge}; Firefox: ${state.website.firefox}; deployment: ${state.website.deployment}.\n\n### Stores\nChrome: ${state.stores.chrome}; Firefox: ${state.stores.firefox}. Pending review remains resumable.\n`);
    return;
  }
  const phase = browsers.firefox ? 'firefox' : 'chromium';
  const files = { ...state.files };
  for (const item of Object.values(browsers)) files[item.filename] = item.sha256;
  const controller = process.env.GITHUB_SHA;
  assert.match(controller, /^[a-f0-9]{40}$/, 'Release controller must be an immutable commit');
  const evidence = { schema: 1, source, controller, version, phase, checkRun: state.checkRun, payloadFingerprint: state.payloadFingerprint, files, browsers };
  const evidencePath = join(directory, 'release-evidence.json'); await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
  const durableRecord = join(directory, `promotion-${phase}-${controller}.json`); await writeFile(durableRecord, await readFile(evidencePath)); await uploadImmutable(tag, source, [durableRecord]);
  const next = { ...approved, sequence: approved.sequence + 1, previous: digest(JSON.stringify(approved)), validation: {
    kind: 'automation', runId: Number(process.env.GITHUB_RUN_ID), runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT), source, controller, checkRun: state.checkRun,
    version, phase, payloadFingerprint: state.payloadFingerprint,
    record: { location: `${url}/${basename(durableRecord)}`, sha256: digest(await readFile(durableRecord)) },
  }, browsers: { ...approved.browsers } };
  for (const [browser, item] of Object.entries(browsers)) next.browsers[browser] = { version: item.version, source, artifact: await artifact(join(directory, item.filename)) };
  validateManifest(next);
  const branch = `codex/automated-release-${version.replaceAll('.', '-')}-${phase}`;
  const base = api('git/ref/heads/main').object.sha;
  const existing = optional(`git/ref/heads/${branch}`);
  if (existing) {
    const comparison = api(`compare/${base}...${existing.object.sha}`);
    assert.equal(comparison.total_commits, 1, 'Interrupted promotion branch has unexpected history');
    assert.deepEqual(comparison.files.map(file => file.filename), ['releases/approved.json'], 'Interrupted promotion branch changed unexpected files');
  }
  const tree = mutate('POST', 'git/trees', { base_tree: api(`git/commits/${base}`).tree.sha, tree: [{ path: 'releases/approved.json', mode: '100644', type: 'blob', content: JSON.stringify(next, null, 2) + '\n' }] });
  const commit = mutate('POST', 'git/commits', { message: `release: publish anmerko ${version} ${phase}`, tree: tree.sha, parents: [base] });
  if (existing) mutate('PATCH', `git/refs/heads/${branch}`, { sha: commit.sha, force: true });
  else mutate('POST', 'git/refs', { ref: `refs/heads/${branch}`, sha: commit.sha });
  const prs = api(`pulls?state=all&head=htxryan:${branch}&base=main`);
  assert.ok(prs.length <= 1, 'Ambiguous promotion pull request');
  const body = `Publishes exact packages from Release run ${process.env.GITHUB_RUN_ID}. Store review is independent.`;
  const pr = prs[0] || mutatePull('POST', 'pulls', { base: 'main', head: branch, title: `Release anmerko ${version} ${phase}`, body });
  assert.equal(pr.state, 'open', 'Interrupted promotion PR is not open');
  if (prs[0]) mutatePull('PATCH', `pulls/${pr.number}`, { body });
  state = advanceReleaseState(state, { promotion: { phase, branch, pr: pr.number, runId: Number(process.env.GITHUB_RUN_ID), status: 'waiting-for-release' } });
  await saveState(state, tag, source);
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Website\nChrome: ${state.website.chrome}; Edge: ${state.website.edge}; Firefox: ${state.website.firefox}. Promotion: ${pr.html_url}\n\n### Stores\nChrome: ${state.stores.chrome}; Firefox: ${state.stores.firefox}.\n`);
}

if (import.meta.main) await deliver();
