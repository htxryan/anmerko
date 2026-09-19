import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { continueRelease } from '../../scripts/ci/continue-release.mjs';

const workflow = name => readFileSync(`.github/workflows/${name}.yml`, 'utf8');

test('only successful explicit Check and Deploy jobs dispatch resume-only release callbacks', () => {
  const check = workflow('check');
  assert.match(check, /continue-release:[\s\S]*github\.event_name == 'workflow_dispatch'[\s\S]*needs\.desktop\.result == 'success'[\s\S]*needs\.site\.result == 'success'/);
  assert.match(check, /github\.ref_name == 'main'[\s\S]*codex\/release-source-[\s\S]*codex\/automated-release-/);
  assert.match(check, /permissions:[\s\S]*actions: write[\s\S]*steps:\s*\n\s+- uses: actions\/checkout@v7\.0\.1[\s\S]*actions\/setup-node@v7\.0\.0[\s\S]*node-version: 24[\s\S]*node scripts\/ci\/continue-release\.mjs/);
  const deploy = workflow('deploy');
  assert.match(deploy, /continue-release:[\s\S]*github\.event_name == 'workflow_dispatch'[\s\S]*needs\.deploy\.result == 'success'/);
  assert.match(deploy, /continue-release:[\s\S]*steps:\s*\n\s+- uses: actions\/checkout@v7\.0\.1[\s\S]*actions\/setup-node@v7\.0\.0[\s\S]*node-version: 24[\s\S]*node scripts\/ci\/continue-release\.mjs/);
  for (const source of [check, deploy]) {
    assert.doesNotMatch(source, /gh workflow run release\.yml[^\n]*resume-only=true/);
  }
});

test('disabled Release workflows leave successful Check and Deploy callbacks paused', () => {
  for (const state of ['disabled_manually', 'disabled_inactivity']) {
    const calls = [];
    const execFileSyncImpl = (command, args) => {
      calls.push([command, args]);
      return JSON.stringify({ state });
    };
    assert.equal(continueRelease({ repository: 'htxryan/anmerko', execFileSyncImpl, log: () => {} }), 'paused');
    assert.deepEqual(calls, [['gh', ['api', 'repos/htxryan/anmerko/actions/workflows/release.yml']]]);
  }
});

test('an active Release workflow dispatches its resume-only callback', () => {
  const calls = [];
  const execFileSyncImpl = (command, args) => {
    calls.push([command, args]);
    return calls.length === 1 ? JSON.stringify({ state: 'active' }) : '';
  };
  assert.equal(continueRelease({ repository: 'htxryan/anmerko', execFileSyncImpl, log: () => {} }), 'dispatched');
  assert.deepEqual(calls, [
    ['gh', ['api', 'repos/htxryan/anmerko/actions/workflows/release.yml']],
    ['gh', ['workflow', 'run', 'release.yml', '--repo', 'htxryan/anmerko', '--ref', 'main', '-f', 'resume-only=true']],
  ]);
});

test('unknown Release workflow state fails without dispatch', () => {
  const calls = [];
  const execFileSyncImpl = (command, args) => {
    calls.push([command, args]);
    return JSON.stringify({ state: 'deleted' });
  };
  assert.throws(
    () => continueRelease({ repository: 'htxryan/anmerko', execFileSyncImpl, log: () => {} }),
    /Unexpected Release workflow state: deleted/,
  );
  assert.equal(calls.length, 1);
});

test('Release workflow API failures fail without dispatch', () => {
  let calls = 0;
  const execFileSyncImpl = () => {
    calls += 1;
    throw new Error('API unavailable');
  };
  assert.throws(
    () => continueRelease({ repository: 'htxryan/anmerko', execFileSyncImpl, log: () => {} }),
    /API unavailable/,
  );
  assert.equal(calls, 1);
});

test('Release self-continuation requires newly written promotion evidence', () => {
  const release = workflow('release');
  assert.match(release, /actions\/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1/);
  assert.match(release, /client-id: \$\{\{ vars\.RELEASE_APP_CLIENT_ID \}\}/);
  assert.doesNotMatch(release, /\n\s+app-id:/);
  assert.match(release, /resume-only:[\s\S]*default: false/);
  assert.match(release, /hashFiles\('artifacts\/release-evidence\.json'\) != ''[\s\S]*node scripts\/ci\/continue-release\.mjs/);
  assert.doesNotMatch(release, /gh workflow run release\.yml[^\n]*resume-only=true/);
});

test('Release uses exact source-family reports and controller archive code', () => {
  const release = workflow('release');
  assert.match(release, /pattern: \$\{\{ steps\.release\.outputs\.artifact-prefix \}\}-desktop-\*/);
  const verify = release.indexOf('name: Verify packages against Linux and local macOS Check payloads');
  const controller = release.indexOf('ref: ${{ github.sha }}', verify);
  const persist = release.indexOf('name: Persist the atomic candidate before any external mutation');
  assert.ok(verify < controller && controller < persist, 'controller checkout must follow source verification and precede archival');
  assert.equal(release.indexOf('ref: ${{ github.sha }}', controller + 1), -1, 'controller checkout should happen once');
});
