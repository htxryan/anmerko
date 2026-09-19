import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolveBrowser } from '../scripts/test-desktop.mjs';

test('desktop launcher selects branded binaries across Windows, macOS and Linux', () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    for (const browser of ['chrome', 'edge', 'brave']) {
      const result = resolveBrowser(browser, { platform, exists: () => true });
      assert.match(result, /chrome|edge|brave/i);
      assert.doesNotMatch(result, /playwright|chromium/i);
    }
  }
});

test('missing browsers and misspelled targets fail instead of falling back to Chromium', () => {
  assert.throws(() => resolveBrowser('chrome', { exists: () => false }), /Chrome.*not found/i);
  assert.throws(() => resolveBrowser('chromium'), /Unsupported browser/);
  assert.throws(() => resolveBrowser('chrome', { platform: 'freebsd' }), /Unsupported OS/);
});

test('an explicit missing executable fails before launching a test', () => {
  assert.throws(() => execFileSync(process.execPath, [
    'scripts/test-desktop.mjs', '--browser', 'chrome', '--executable', '/missing/anmerko-chrome',
  ], { stdio: 'pipe' }), error => {
    assert.equal(error.status, 1);
    assert.match(error.stderr.toString(), /not found/);
    return true;
  });
});
