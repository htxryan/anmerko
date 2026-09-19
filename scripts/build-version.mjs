import assert from 'node:assert/strict';

export function buildVersion(packageVersion, override = process.env.RELEASE_VERSION) {
  const version = override || packageVersion;
  assert.match(version, /^\d+\.\d+\.\d+(?:\.\d+)?$/, 'RELEASE_VERSION must contain three or four numeric parts');
  return version;
}
