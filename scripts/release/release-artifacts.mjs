import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { digest } from './approved-release.mjs';
import { assertDesktopPayloads, firefoxScenarios } from '../browsers/check-desktop-payloads.mjs';
import { requiredOperatingSystems } from '../ci/ci-policy.mjs';

export function archivePayload(path) {
  const entries = execFileSync('unzip', ['-Z1', path], { encoding: 'utf8' }).trim().split('\n').filter(name => !name.endsWith('/'));
  assert.equal(new Set(entries).size, entries.length, 'Duplicate archive entries');
  const files = {};
  for (const entry of entries) {
    assert.ok(/^[A-Za-z0-9_./-]+$/.test(entry) && !entry.startsWith('/') && !entry.split('/').includes('..'), 'Unsafe archive entry');
    files[entry] = execFileSync('unzip', ['-p', path, entry], { maxBuffer: 16 * 1024 * 1024 });
  }
  return files;
}
export async function readReports(directory) {
  const files = await readdir(directory, { recursive: true, withFileTypes: true });
  return Promise.all(files.filter(file => file.isFile() && file.name === 'evidence.json')
    .map(async file => JSON.parse(await readFile(join(file.parentPath, file.name), 'utf8'))));
}
export function assertPackageReports(reports, source, archive, firefox = false) {
  assertDesktopPayloads(reports, source, firefox ? ['stable', '142.0'] : [], firefox ? [] : ['chrome', 'edge'], 'full');
  const payload = Object.fromEntries(Object.entries(archive).map(([name, bytes]) => [name, digest(bytes)]));
  for (const report of reports) assert.deepEqual(report.payload, payload, 'Candidate archive differs from tested package');
}
export function assertVersionedPackageReports(reports, source, archive, testedVersion, firefox = false) {
  assertDesktopPayloads(reports, source, firefox ? ['stable', '142.0'] : [], firefox ? [] : ['chrome', 'edge'], 'full');
  const payload = Object.fromEntries(Object.entries(archive).map(([name, bytes]) => [name, digest(bytes)]));
  for (const report of reports) {
    const expected = { ...payload };
    const manifest = JSON.parse(archive['manifest.json']); manifest.version = testedVersion;
    expected['manifest.json'] = digest(Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
    assert.deepEqual(report.payload, expected, 'Release payload differs from tested package beyond the version');
  }
}
export function assertSignedFirefox(reports, source, sha256, version, signed, unsigned) {
  const payload = Object.fromEntries(Object.entries(signed).filter(([name]) => !name.startsWith('META-INF/')));
  assert.deepEqual(Object.keys(payload).sort(), Object.keys(unsigned).sort(), 'Signed candidate file inventory differs');
  for (const [name, bytes] of Object.entries(payload)) {
    if (name === 'manifest.json') assert.deepEqual(JSON.parse(bytes), JSON.parse(unsigned[name]), 'Signed manifest differs');
    else assert.equal(digest(bytes), digest(unsigned[name]), `Signed candidate payload differs: ${name}`);
  }
  for (const os of requiredOperatingSystems('full')) for (const requestedVersion of ['stable', '142.0']) {
    for (const scenario of firefoxScenarios) {
      const matches = reports.filter(r => r.os === os && r.requestedVersion === requestedVersion && r.scenario === scenario && r.signedXpiSha256 === sha256);
      assert.equal(matches.length, 1, `Missing signed Firefox ${os}/${requestedVersion}/${scenario}`);
      const report = matches[0];
      assert.equal(report.sourceSha, source); assert.equal(report.dirty, false);
      assert.equal(report.result, 'passed'); assert.equal(report.teardown, 'passed');
      assert.equal(report.version, version); assert.equal(report.temporary, false); assert.ok(report.signedState > 0);
      if (requestedVersion !== 'stable') assert.equal(report.engine, requestedVersion);
    }
    const updates = reports.filter(r => r.os === os && r.requestedVersion === requestedVersion && r.signedUpdate?.sha256 === sha256);
    assert.equal(updates.length, 1, `Missing signed Firefox upgrade ${os}/${requestedVersion}`);
    const report = updates[0];
    assert.equal(report.sourceSha, source); assert.equal(report.dirty, false);
    assert.equal(report.result, 'passed'); assert.equal(report.teardown, 'passed');
    assert.equal(report.signedUpdate.version, version); assert.equal(report.signedUpdate.temporary, false);
    assert.ok(report.signedUpdate.signedState > 0);
    assert.equal(report.signedUpdate.result, 'passed; normal signed installation and restart');
  }
}
