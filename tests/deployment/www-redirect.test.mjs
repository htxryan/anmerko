import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

const configPath = resolve('site/wrangler-www.jsonc');

async function configuredWorker() {
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const modulePath = resolve(dirname(configPath), config.main);
  const worker = (await import(pathToFileURL(modulePath))).default;
  return { config, worker };
}

test('www Worker config loads the redirect module for the canonical custom domain', async () => {
  const { config, worker } = await configuredWorker();
  assert.equal(config.name, 'anmerko-www-redirect');
  assert.deepEqual(config.routes, [{ pattern: 'www.anmerko.com', custom_domain: true }]);
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
  assert.equal(typeof worker.fetch, 'function');
});

test('www Worker permanently redirects the complete path and query to the apex host', async () => {
  const { worker } = await configuredWorker();
  const response = await worker.fetch(new Request('https://www.anmerko.com/docs/install/?channel=firefox&source=www'));
  assert.equal(response.status, 308);
  assert.equal(response.headers.get('location'), 'https://anmerko.com/docs/install/?channel=firefox&source=www');
});

test('www Worker rejects requests for any other host', async () => {
  const { worker } = await configuredWorker();
  const response = await worker.fetch(new Request('https://anmerko.com/private?source=www'));
  assert.equal(response.status, 421);
  assert.equal(await response.text(), 'Misdirected Request');
});
