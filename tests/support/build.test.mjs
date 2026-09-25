import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';

test('public build removes stale files and publishes only help, privacy and a 404 page', async () => {
  await mkdir('artifacts/store-site/downloads', { recursive: true });
  await writeFile('artifacts/store-site/downloads/private-installer.zip', 'must never publish');
  execFileSync(process.execPath, ['scripts/site/build-support-site.mjs']);
  const files = (await readdir('artifacts/store-site', { recursive: true, withFileTypes: true }))
    .filter(entry => entry.isFile())
    .map(entry => `${entry.parentPath}/${entry.name}`.replaceAll('\\', '/').split('artifacts/store-site/')[1]);
  assert.deepEqual(files.sort(), ['404.html', '_headers', 'support/index.html', 'support/privacy/index.html']);
  const policy = await readFile('artifacts/store-site/support/privacy/index.html', 'utf8');
  assert.match(policy, /Saved comments stay in the browser profile/);
  assert.match(policy, /clipboardWrite/);
  assert.doesNotMatch(policy, /<script|https:\/\/github\.com|\/downloads\/|\/docs\/install\//);
  assert.match(policy, /href="\/support\/"/);
  assert.match(policy, /href="\/support\/privacy\/"/);
  assert.match(policy, /rel="canonical" href="https:\/\/anmerko\.com\/support\/privacy\/"/);
  assert.doesNotMatch(policy, /href="\/(?:privacy\/)?"/);
});

test('store support and privacy pages explain the journeys update for each installation type', async () => {
  execFileSync(process.execPath, ['scripts/site/build-support-site.mjs']);
  const help = await readFile('artifacts/store-site/support/index.html', 'utf8');
  assert.match(help, /If Chrome or Edge turned anmerko off after an update, open the browser(?:'|&#39;|’)s Extensions page and accept the new permission/);
  assert.match(help, /<code>comments\.md<\/code>, or <code>prompt\.md<\/code> for a journey/);
  const policy = await readFile('artifacts/store-site/support/privacy/index.html', 'utf8');
  assert.match(policy, /When a store installation updates from a version without journeys, desktop Chrome and Edge turn anmerko off/);
  assert.match(policy, /A manual ZIP installation in Chrome or Edge doesn(?:'|&#39;|’)t ask/);
  assert.doesNotMatch(policy, /When anmerko updates from a version without journeys/);
  assert.match(policy, /private or incognito windows/);
});

test('public routes cover the support namespace without replacing the main site', async () => {
  const config = JSON.parse(await readFile('site/support/wrangler.jsonc', 'utf8'));
  assert.deepEqual(config.routes, [
    { pattern: 'anmerko.com/support', zone_name: 'anmerko.com' },
    { pattern: 'anmerko.com/support/*', zone_name: 'anmerko.com' },
  ]);
  assert.equal(config.assets.directory, '../../artifacts/store-site');
  assert.equal(config.assets.not_found_handling, '404-page');
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
});
