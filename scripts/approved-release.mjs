import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseReleaseAssetLocation } from './release-repository.mjs';

export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export function findReleaseByTag(get, tag) {
  for (let page = 1; page <= 100; page++) {
    const releases = get(`releases?per_page=100&page=${page}`);
    const release = releases.find(candidate => candidate.tag_name === tag);
    if (release) return release;
    if (releases.length < 100) break;
  }
  assert.fail(`Release not found: ${tag}`);
}
export const isSource = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const safePath = value => typeof value === 'string' && /^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+$/.test(value)
  && !value.split('/').some(part => part === '.' || part === '..');
export function validateArtifact(artifact) {
  assert.match(artifact.sha256, /^[a-f0-9]{64}$/, 'Artifact must have a SHA-256');
  assert.ok((safePath(artifact.location) && /^(releases|site\/installers)\//.test(artifact.location))
    || parseReleaseAssetLocation(artifact.location),
  'Artifact location must be a durable repository file or pinned release asset');
  if (artifact.filename !== undefined) assert.ok(safePath(artifact.filename) && !artifact.filename.includes('/'), 'Unsafe download filename');
}
export function validateManifest(manifest) {
  assert.equal(manifest.schema, 1);
  assert.ok(Number.isSafeInteger(manifest.sequence) && manifest.sequence > 0);
  assert.ok(manifest.previous === null || /^[a-f0-9]{64}$/.test(manifest.previous));
  assert.ok(manifest.browsers.chrome && manifest.browsers.firefox, 'Keep existing approved downloads');
  const filenames = new Set();
  for (const [browser, release] of Object.entries(manifest.browsers)) {
    assert.ok(['chrome', 'firefox', 'edge'].includes(browser), 'Unknown browser');
    assert.match(release.version, browser === 'firefox' ? /^\d+\.\d+\.\d+(?:\.\d+)?$/ : /^\d+\.\d+\.\d+$/);
    assert.ok(isSource(release.source), 'Release source must be immutable');
    assert.ok(release.artifact.filename && !filenames.has(release.artifact.filename), 'Missing or duplicate download filename');
    filenames.add(release.artifact.filename);
    validateArtifact(release.artifact);
  }
  assert.ok(isSource(manifest.demo.source));
  assert.match(manifest.demo.version, /^\d+\.\d+\.\d+$/);
  assert.ok(manifest.demo.files[manifest.demo.entry], 'Demo entry must be approved');
  for (const [path, artifact] of Object.entries(manifest.demo.files)) {
    assert.ok(path.startsWith('/_astro/') && safePath(path.slice(1)), 'Unsafe demo route');
    validateArtifact(artifact);
  }
  return manifest;
}
export async function artifactBytes(artifact, { root = '.', fetchImpl, execFileSyncImpl = execFileSync } = {}) {
  validateArtifact(artifact);
  let bytes;
  if (artifact.location.startsWith('https:')) {
    const response = await (fetchImpl || fetch)(artifact.location, { signal: AbortSignal.timeout(60000) });
    if (response.status === 200) {
      bytes = Buffer.from(await response.arrayBuffer());
    } else {
      // GitHub intentionally returns 404 for release assets in private repositories.
      // Public assets are fetched anonymously; only that private-repository response
      // may use the local gh credential as a fallback.
      assert.equal(response.status, 404, 'Approved artifact unavailable');
      const { repository, tag, filename } = parseReleaseAssetLocation(artifact.location);
      const get = path => JSON.parse(execFileSyncImpl('gh', ['api', `repos/${repository}/${path}`],
        { encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 }));
      const release = findReleaseByTag(get, tag);
      const assets = release.assets.filter(asset => asset.name === filename);
      assert.equal(assets.length, 1, 'Approved release asset unavailable');
      bytes = execFileSyncImpl('gh', ['api', '-H', 'Accept: application/octet-stream',
        `repos/${repository}/releases/assets/${assets[0].id}`], { timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
    }
  } else bytes = await readFile(join(root, artifact.location));
  assert.equal(digest(bytes), artifact.sha256, `Approved artifact checksum mismatch: ${artifact.location}`);
  return bytes;
}
export async function copyApprovedDownloads(manifest, { root = '.', output = 'site/dist', fetchImpl } = {}) {
  validateManifest(manifest);
  // Demo archives remain in historical release records. Astro builds the live
  // demo from the shared UI source; approved downloads must never overwrite it.
  const files = Object.values(manifest.browsers).map(release => [`/downloads/${release.artifact.filename}`, release.artifact]);
  // Verify every byte before modifying the destination.
  const verified = await Promise.all(files.map(async ([path, artifact]) => [path, await artifactBytes(artifact, { root, fetchImpl })]));
  for (const [path, bytes] of verified) {
    const target = join(output, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
  await writeFile(join(output, 'release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}
