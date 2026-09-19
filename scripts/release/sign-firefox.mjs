import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { buildVersion } from '../extension/build-version.mjs';
import { CURRENT_PRODUCT, FIREFOX_GUID } from './release-names.mjs';

export function firefoxSourcePath(version) {
  assert.match(version, /^\d+\.\d+\.\d+(?:\.\d+)?$/, 'Expected a Firefox release version');
  return `artifacts/${CURRENT_PRODUCT}-${version}-firefox-source.zip`;
}

export async function assertFirefoxSigningInputs({ version, manifestPath = 'dist-firefox/manifest.json', sourcePath }) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.equal(manifest.version, version, 'Firefox signing manifest has the wrong version');
  assert.equal(manifest.browser_specific_settings?.gecko?.id, FIREFOX_GUID, 'Firefox signing manifest has the wrong GUID');
  await access(sourcePath);
}

const run = (command, args) => {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};

async function main() {
  if (!process.env.WEB_EXT_API_KEY || !process.env.WEB_EXT_API_SECRET) {
    console.error('Mozilla signing credentials are not configured. Set WEB_EXT_API_KEY and WEB_EXT_API_SECRET in external credential storage, or submit the prepared package through the Mozilla Add-ons Developer Hub. Do not paste credentials into chat or commit them. See docs/release-process.md.');
    process.exit(1);
  }
  const packageVersion = JSON.parse(await readFile('package.json', 'utf8')).version;
  const version = buildVersion(packageVersion);
  const sourcePath = firefoxSourcePath(version);
  run('npm', ['run', 'package:firefox']);
  await assertFirefoxSigningInputs({ version, sourcePath });
  run(process.execPath, ['scripts/browsers/web-ext.mjs', 'sign', '--source-dir', 'dist-firefox',
    '--channel', 'unlisted', '--artifacts-dir', 'artifacts/firefox-signed', '--upload-source-code', sourcePath]);
}

if (import.meta.main) await main();
