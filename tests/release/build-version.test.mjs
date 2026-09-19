import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildVersion } from '../../scripts/extension/build-version.mjs';

test('build version defaults to package version and permits Mozilla four-part variants', () => {
  assert.equal(buildVersion('0.5.3', ''), '0.5.3');
  assert.equal(buildVersion('0.5.3', '0.5.3.1'), '0.5.3.1');
  for (const unsafe of ['v0.5.3', '0.5', '0.5.3-beta', '0.5.3.1.2']) assert.throws(() => buildVersion('0.5.3', unsafe));
});
