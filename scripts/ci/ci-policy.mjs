import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

// Temporary CI hold; restore scheduling and evidence together after issue #1.
export const windowsChecksEnabled = false;
export const windowsHoldReason = 'Windows checks are on hold: https://github.com/htxryan/anmerko/issues/1';

export const selectScope = ({ event, highRisk, labels = [] }) =>
  event === 'workflow_dispatch' || highRisk || labels.includes('full-ci') ? 'full' : 'fast';
export function requiredOperatingSystems(scope) {
  assert.ok(['fast', 'full'].includes(scope), 'Unknown validation scope');
  return (scope === 'full' ? ['darwin', 'linux', 'win32'] : ['linux'])
    .filter(os => windowsChecksEnabled || os !== 'win32');
}
export function requiredRunners(scope) {
  assert.ok(['fast', 'full'].includes(scope), 'Unknown validation scope');
  return (scope === 'full' ? ['ubuntu-latest', 'windows-latest', 'macos-latest'] : ['ubuntu-latest'])
    .filter(os => windowsChecksEnabled || os !== 'windows-latest');
}
export function assertSelectedJobs(results, selected) {
  for (const name of selected) assert.equal(results[name], 'success', `Required job ${name} did not succeed`);
}
export function workflowVersion({ root = '.', ref } = {}) {
  if (ref !== undefined) {
    assert.match(ref, /^[a-f0-9]{40}$/, 'Policy ref must be an immutable commit');
    execFileSync('git', ['-C', root, 'cat-file', '-e', `${ref}^{commit}`], { stdio: 'ignore' });
  }
  // Retain the legacy test prefixes so immutable historical refs keep their original fingerprint;
  // tests/ covers every current suite and both Playwright configs.
  const tracked = ['.github', 'scripts', 'tests-ci', 'tests-release', 'tests-shared', 'tests-desktop', 'tests-firefox',
    'tests-dev', 'tests', 'package.json', 'package-lock.json', 'playwright.config.ts'];
  const paths = execFileSync('git', ['-C', root, ...(ref === undefined ? ['ls-files'] : ['ls-tree', '-r', '--name-only', ref, '--']), ...tracked],
    { encoding: 'utf8' }).trim().split('\n');
  const hash = createHash('sha256');
  for (const path of paths.sort()) {
    const bytes = ref === undefined ? readFileSync(join(root, path))
      : execFileSync('git', ['-C', root, 'show', `${ref}:${path}`]);
    hash.update(path).update('\0').update(bytes).update('\0');
  }
  return hash.digest('hex');
}
if (import.meta.main) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const scope = selectScope({ event: process.env.GITHUB_EVENT_NAME, highRisk: process.env.HIGH_RISK === 'true',
    labels: event.pull_request?.labels?.map(label => label.name) });
  const matrix = requiredRunners(scope);
  appendFileSync(process.env.GITHUB_OUTPUT, `scope=${scope}\nmatrix=${JSON.stringify(matrix)}\n`);
}
