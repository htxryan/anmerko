import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { assertFirefoxSigningInputs, firefoxSourcePath } from '../../scripts/release/sign-firefox.mjs';

const fixture = async ({ version = '0.6.0.1', guid = 'briefmark@briefmark.app', source = true } = {}) => {
  const root = await mkdtemp(join(tmpdir(), 'anmerko-sign-'));
  const manifestPath = join(root, 'manifest.json'), sourcePath = join(root, 'source.zip');
  await writeFile(manifestPath, JSON.stringify({ version, browser_specific_settings: { gecko: { id: guid } } }));
  if (source) await writeFile(sourcePath, 'source');
  return { version: '0.6.0.1', manifestPath, sourcePath };
};

test('signing accepts the exact version, immutable Firefox GUID, and source archive', async () => {
  await assertFirefoxSigningInputs(await fixture());
  assert.equal(firefoxSourcePath('0.6.0'), 'artifacts/anmerko-0.6.0-firefox-source.zip');
  assert.equal(firefoxSourcePath('0.6.0.1'), 'artifacts/anmerko-0.6.0.1-firefox-source.zip');
});

test('signing rejects wrong version, GUID, or missing source', async () => {
  await assert.rejects(assertFirefoxSigningInputs(await fixture({ version: '0.6.0' })), /wrong version/);
  await assert.rejects(assertFirefoxSigningInputs(await fixture({ guid: 'anmerko@example.com' })), /wrong GUID/);
  await assert.rejects(assertFirefoxSigningInputs(await fixture({ source: false })), /ENOENT/);
});
