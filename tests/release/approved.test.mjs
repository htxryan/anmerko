import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { artifactBytes, copyApprovedDownloads, digest, findReleaseByTag, validateManifest } from '../../scripts/approved-release.mjs';

const source = 'a'.repeat(40);
function manifest() {
  return { schema: 1, sequence: 1, previous: null,
    browsers: Object.fromEntries(['chrome', 'firefox'].map((name, index) => [name, {
      version: `0.5.${index}`, source, artifact: { location: `releases/${name}.zip`, filename: `${name}.zip`, sha256: digest(name) },
    }])), demo: { version: '0.5.0', source, entry: '/_astro/demo.js',
      files: { '/_astro/demo.js': { location: 'releases/demo.js', sha256: digest('approved demo') } } },
  };
}
test('site builds copy exact approved installers without loading or replacing the current demo', async t => {
  const root = await mkdtemp(join(tmpdir(), 'anmerko-approved-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'releases'));
  for (const name of ['chrome', 'firefox']) await writeFile(join(root, `releases/${name}.zip`), name);
  // The archive is deliberately unavailable: the live demo belongs to Astro.
  await mkdir(join(root, 'site/dist/_astro'), { recursive: true });
  await writeFile(join(root, 'site/dist/_astro/demo.js'), 'current shared UI');
  await writeFile(join(root, 'package.json'), '{"version":"99.0.0"}');
  const release = manifest();
  await copyApprovedDownloads(release, { root, output: join(root, 'site/dist') });
  assert.equal(await readFile(join(root, 'site/dist/downloads/chrome.zip'), 'utf8'), 'chrome');
  assert.equal(await readFile(join(root, 'site/dist/_astro/demo.js'), 'utf8'), 'current shared UI');
  assert.deepEqual(JSON.parse(await readFile(join(root, 'site/dist/release-manifest.json'))), release);
  await writeFile(join(root, 'releases/firefox.zip'), 'tampered signed bytes');
  await assert.rejects(copyApprovedDownloads(release, { root, output: join(root, 'other') }), /checksum/);
});
test('rejects malformed identity, unsafe artifact paths and unpinned remote locations', () => {
  for (const mutate of [m => { m.browsers.chrome.source = 'main'; }, m => { m.browsers.chrome.artifact.filename = '../escape'; },
    m => { m.demo.entry = '/outside.js'; }, m => { m.browsers.chrome.artifact.location = '../escape'; },
    m => { m.browsers.chrome.artifact.location = 'https://evil.example/file'; }, m => { m.browsers.chrome.artifact.sha256 = ''; }]) {
    const m = manifest(); mutate(m); assert.throws(() => validateManifest(m));
  }
});
test('accepts pinned release assets from the historical and renamed repositories only', () => {
  for (const repository of ['briefmark', 'anmerko']) {
    const m = manifest();
    m.browsers.chrome.artifact.location = `https://github.com/htxryan/${repository}/releases/download/automation-0-5-4-source/briefmark-0.5.4.zip`;
    assert.equal(validateManifest(m), m);
  }

  for (const location of [
    'https://github.com/someone/briefmark/releases/download/automation-0-5-4-source/briefmark-0.5.4.zip',
    'https://github.com/htxryan/other/releases/download/automation-0-5-4-source/briefmark-0.5.4.zip',
    'https://example.com/htxryan/anmerko/releases/download/automation-0-5-4-source/briefmark-0.5.4.zip',
    'https://github.com/htxryan/anmerko/releases/download/../briefmark-0.5.4.zip',
    'https://github.com/htxryan/anmerko/releases/download/%2e%2e/briefmark-0.5.4.zip',
    'https://github.com/htxryan/anmerko/releases/download/automation-0-5-4-source/%2e%2e%2fsecret',
    'https://github.com/htxryan/briefmark/releases/download/automation-0-5-4-source/.',
    'https://github.com/htxryan/briefmark/releases/download/automation-0-5-4-source/..',
    'https://github.com/htxryan/anmerko/releases/download/automation-0-5-4-source/.',
    'https://github.com/htxryan/anmerko/releases/download/automation-0-5-4-source/..',
    'https://github.com/htxryan/anmerko/releases/download/automation-0-5-4-source/anmerko-0.5.4.zip\n',
  ]) {
    const m = manifest();
    m.browsers.chrome.artifact.location = location;
    assert.throws(() => validateManifest(m), /Artifact location/);
  }
});
test('public release downloads do not need a GitHub credential', async () => {
  const bytes = Buffer.from('approved public asset');
  const artifact = {
    location: 'https://github.com/htxryan/anmerko/releases/download/automation-0-5-4-source/anmerko-0.5.4.zip',
    filename: 'anmerko-0.5.4.zip',
    sha256: digest(bytes),
  };
  await assert.doesNotReject(artifactBytes(artifact, {
    fetchImpl: async () => new Response(bytes),
    execFileSyncImpl: () => assert.fail('public download must not use gh'),
  }));
});
test('private release downloads fall back to the validated repository', async () => {
  const bytes = Buffer.from('approved renamed asset');
  const artifact = {
    location: 'https://github.com/htxryan/anmerko/releases/download/automation-0-5-4-source/anmerko-0.5.4.zip',
    filename: 'anmerko-0.5.4.zip',
    sha256: digest(bytes),
  };
  const calls = [];
  const execFileSyncImpl = (command, args) => {
    calls.push([command, args]);
    if (args[1] === 'repos/htxryan/anmerko/releases?per_page=100&page=1') {
      return JSON.stringify([{ tag_name: 'automation-0-5-4-source', assets: [{ id: 42, name: 'anmerko-0.5.4.zip' }] }]);
    }
    if (args.at(-1) === 'repos/htxryan/anmerko/releases/assets/42') return bytes;
    assert.fail(`Unexpected command: ${command} ${args.join(' ')}`);
  };

  assert.deepEqual(await artifactBytes(artifact, { fetchImpl: async () => new Response(null, { status: 404 }), execFileSyncImpl }), bytes);
  assert.deepEqual(calls.map(([, args]) => args), [
    ['api', 'repos/htxryan/anmerko/releases?per_page=100&page=1'],
    ['api', '-H', 'Accept: application/octet-stream', 'repos/htxryan/anmerko/releases/assets/42'],
  ]);

  await assert.rejects(
    artifactBytes({ ...artifact, sha256: digest('different bytes') }, { fetchImpl: async () => new Response(null, { status: 404 }), execFileSyncImpl }),
    /checksum mismatch/,
  );
});
test('draft releases are resolved from the paginated release list', () => {
  const draft = { tag_name: 'automation-0-5-3-source', draft: true };
  const get = path => {
    assert.equal(path, 'releases?per_page=100&page=1');
    return [draft];
  };
  assert.equal(findReleaseByTag(get, draft.tag_name), draft);
});
