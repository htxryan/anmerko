import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { requiredOperatingSystems, requiredRunners } from '../scripts/ci-policy.mjs';

test('Windows is not required in either CI scope while on hold', () => {
  assert.deepEqual(requiredOperatingSystems('fast'), ['linux']);
  assert.deepEqual(requiredOperatingSystems('full'), ['darwin', 'linux']);
  assert.deepEqual(requiredRunners('fast'), ['ubuntu-latest']);
  assert.deepEqual(requiredRunners('full'), ['ubuntu-latest', 'macos-latest']);
});

test('Windows jobs are excluded from both matrices and blocked at the reusable workflow', () => {
  for (const name of ['check', 'release-validation']) {
    const workflow = readFileSync(`.github/workflows/${name}.yml`, 'utf8');
    assert.match(workflow, /exclude:\s*\n\s*- os: windows-latest/);
  }
  const releaseController = readFileSync('.github/workflows/release.yml', 'utf8');
  assert.doesNotMatch(releaseController, /windows-latest|runs-on:[^\n]*[Ww]indows/);
  const desktop = readFileSync('.github/workflows/desktop.yml', 'utf8');
  assert.match(desktop, /if: \$\{\{ !cancelled\(\) && !startsWith\(inputs\.os, 'windows-'\) \}\}/);
});
