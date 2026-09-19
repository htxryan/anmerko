import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';

test('public build removes stale files and publishes only help, privacy and a 404 page', async () => {
  await mkdir('artifacts/store-site/downloads', { recursive: true });
  await writeFile('artifacts/store-site/downloads/private-installer.zip', 'must never publish');
  execFileSync(process.execPath, ['scripts/build-store-site.mjs']);
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

test('public routes cover the support namespace without replacing the main site', async () => {
  const config = JSON.parse(await readFile('store-site/wrangler.jsonc', 'utf8'));
  assert.deepEqual(config.routes, [
    { pattern: 'anmerko.com/support', zone_name: 'anmerko.com' },
    { pattern: 'anmerko.com/support/*', zone_name: 'anmerko.com' },
  ]);
  assert.equal(config.assets.not_found_handling, '404-page');
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
});
