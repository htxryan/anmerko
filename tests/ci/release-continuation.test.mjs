import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const workflow = name => readFileSync(`.github/workflows/${name}.yml`, 'utf8');

test('only successful explicit Check and Deploy jobs dispatch resume-only release callbacks', () => {
  const check = workflow('check');
  assert.match(check, /continue-release:[\s\S]*github\.event_name == 'workflow_dispatch'[\s\S]*needs\.desktop\.result == 'success'[\s\S]*needs\.site\.result == 'success'/);
  assert.match(check, /github\.ref_name == 'main'[\s\S]*codex\/release-source-[\s\S]*codex\/automated-release-/);
  assert.match(check, /permissions:[\s\S]*actions: write[\s\S]*gh workflow run release\.yml[^\n]*resume-only=true/);
  const deploy = workflow('deploy');
  assert.match(deploy, /continue-release:[\s\S]*github\.event_name == 'workflow_dispatch'[\s\S]*needs\.deploy\.result == 'success'/);
  assert.match(deploy, /gh workflow run release\.yml[^\n]*resume-only=true/);
});

test('Release self-continuation requires newly written promotion evidence', () => {
  const release = workflow('release');
  assert.match(release, /actions\/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1/);
  assert.match(release, /client-id: \$\{\{ vars\.RELEASE_APP_CLIENT_ID \}\}/);
  assert.doesNotMatch(release, /\n\s+app-id:/);
  assert.match(release, /resume-only:[\s\S]*default: false/);
  assert.match(release, /hashFiles\('artifacts\/release-evidence\.json'\) != ''[\s\S]*resume-only=true/);
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
