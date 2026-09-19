import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { artifactBytes, digest, validateManifest } from './approved-release.mjs';
import { assertReleaseEvidence } from './release-gate.mjs';
import { workflowVersion } from '../ci/ci-policy.mjs';
import { missingReleaseAssets, assertPromotionBranch } from './release-resume.mjs';
import { releaseNotes } from './release-notes.mjs';
import { activeRepository } from './release-repository.mjs';

const repository = activeRepository(), directory = 'artifacts/release-candidate';
const gh = args => execFileSync('gh', args, { encoding: 'utf8', timeout: 60000 });
const api = path => JSON.parse(gh(['api', `repos/${repository}/${path}`]));
const optionalApi = path => {
  try { return api(path); } catch (error) {
    if (String(error.stderr).includes('(HTTP 404)')) return null;
    throw error;
  }
};
const candidate = JSON.parse(await readFile(join(directory, 'validation.json'), 'utf8'));
assert.equal(process.env.GITHUB_EVENT_NAME, 'workflow_run');
const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
const run = event.workflow_run;
assert.equal(run.event, 'workflow_dispatch'); assert.equal(run.head_branch, 'main');
assert.equal(run.repository.full_name, repository); assert.equal(run.head_repository.full_name, repository); assert.equal(run.conclusion, 'success');
assert.equal(candidate.publishRequested, true);
assert.equal(candidate.eligible, true);
assertReleaseEvidence(candidate);
assert.equal(candidate.workflowVersion, workflowVersion(), 'Validation workflow changed; revalidate candidate');
const base = api('git/ref/heads/main').object.sha;
assert.equal(base, execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), 'Main moved after publisher checkout; retry on current main');
const approved = JSON.parse(Buffer.from(api(`contents/releases/approved.json?ref=${base}`).content, 'base64'));
assert.equal(candidate.previous, digest(JSON.stringify(approved)), 'Stale release candidate; current release is preserved');
const tag = `approved-${candidate.source}-${run.id}-${run.run_attempt}`;
const url = `https://github.com/${repository}/releases/download/${tag}`;
const files = [join(directory, 'validation.json')];
const next = { ...approved, sequence: approved.sequence + 1, previous: candidate.previous,
  validation: { kind: 'release', runId: Number(run.id), runAttempt: Number(run.run_attempt),
    source: candidate.source, workflowVersion: candidate.workflowVersion,
    record: { location: `${url}/validation.json`, sha256: digest(await readFile(join(directory, 'validation.json'))) } } };
for (const [browser, artifact] of Object.entries(candidate.browsers)) {
  const old = approved.browsers[browser]?.version.split('.').map(Number) || [0,0,0];
  const version = candidate.version.split('.').map(Number);
  assert.ok(version.some((part, i) => part > old[i] && version.slice(0, i).every((n, j) => n === old[j])), 'A release must increase its browser version');
  const path = join(directory, artifact.filename);
  assert.equal(digest(await readFile(path)), artifact.sha256, 'Publication package hash mismatch');
  files.push(path);
  next.browsers = { ...next.browsers, [browser]: { version: candidate.version, source: candidate.source,
    artifact: { filename: artifact.filename, sha256: artifact.sha256, location: `${url}/${artifact.filename}` } } };
}
validateManifest(next);
await writeFile(join(directory, 'approved.json'), JSON.stringify(next, null, 2) + '\n');
files.push(join(directory, 'approved.json'));
await writeFile(join(directory, 'release-notes.md'), releaseNotes(candidate));
// No rebuilding here. Create privately, resume only matching assets, then expose.
const expected = Object.fromEntries(await Promise.all(files.map(async file => [basename(file), digest(await readFile(file))])));
assert.equal(Object.keys(expected).length, files.length, 'Duplicate publication filenames');
let release = optionalApi(`releases/tags/${tag}`);
if (!release) {
  gh(['release', 'create', tag, '--repo', repository, '--target', candidate.source, '--prerelease', '--draft',
    '--title', `Validated anmerko ${candidate.version}`, '--notes-file', join(directory, 'release-notes.md')]);
  release = api(`releases/tags/${tag}`);
}
// Older GitHub assets may lack server digests; authenticate and hash those bytes.
for (const asset of release.assets) if (!asset.digest) {
  asset.digest = `sha256:${digest(await artifactBytes({ location: `${url}/${asset.name}`, sha256: expected[asset.name] }))}`;
}
const missing = missingReleaseAssets(release, candidate.source, expected);
if (missing.length) gh(['release', 'upload', tag, ...files.filter(file => missing.includes(basename(file))), '--repo', repository]);
const complete = api(`releases/tags/${tag}`);
for (const asset of complete.assets) if (!asset.digest) asset.digest = `sha256:${digest(await artifactBytes({ location: `${url}/${asset.name}`, sha256: expected[asset.name] }))}`;
assert.deepEqual(missingReleaseAssets(complete, candidate.source, expected), []);
if (complete.draft) gh(['release', 'edit', tag, '--draft=false', '--repo', repository]);
// Use the Git data API: no shell interpolation of metadata, no direct main writes.
const post = (path, body) => JSON.parse(execFileSync('gh', ['api', `repos/${repository}/${path}`, '--method', 'POST', '--input', '-'],
  { input: JSON.stringify(body), encoding: 'utf8', timeout: 60000 }));
const branch = `codex/release-${run.id}-${run.run_attempt}`;
const existing = optionalApi(`git/ref/heads/${branch}`);
if (existing) {
  const commit = api(`git/commits/${existing.object.sha}`);
  const comparison = api(`compare/${commit.parents[0]?.sha}...${existing.object.sha}`);
  const actual = JSON.parse(Buffer.from(api(`contents/releases/approved.json?ref=${existing.object.sha}`).content, 'base64'));
  assertPromotionBranch(commit, comparison, actual, next);
} else {
  const tree = post('git/trees', { base_tree: api(`git/commits/${base}`).tree.sha, tree: [
    { path: 'releases/approved.json', mode: '100644', type: 'blob', content: JSON.stringify(next, null, 2) + '\n' },
  ] });
  const commit = post('git/commits', { message: `release: promote validated anmerko ${candidate.version}`, tree: tree.sha, parents: [base] });
  post('git/refs', { ref: `refs/heads/${branch}`, sha: commit.sha });
}
const prs = api(`pulls?state=all&head=htxryan:${branch}&base=main`);
assert.ok(prs.length <= 1, 'Ambiguous promotion pull request');
const pr = prs[0] || post('pulls', { base: 'main', head: branch, title: `Promote validated anmerko ${candidate.version}`,
  body: `Promotes the exact packages validated from ${candidate.source}.\n\nFull release validation: https://github.com/${repository}/actions/runs/${run.id}\n\nThe manifest records the previous release for rollback. Site CI and deployment verify approval and exact bytes again.\n` });
assert.equal(pr.state, 'open', 'Promotion PR is closed; inspect it before retrying');
console.log(pr.html_url);

// GITHUB_TOKEN-created PRs do not emit another workflow event. Dispatch Check
// explicitly on the branch. A retry starts fresh checks for the same exact tree.
gh(['workflow', 'run', 'check.yml', '--repo', repository, '--ref', branch]);
