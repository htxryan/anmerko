import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

export function continueRelease({
  repository = process.env.GITHUB_REPOSITORY,
  execFileSyncImpl = execFileSync,
  log = console.log,
} = {}) {
  assert.match(repository ?? '', /^[^/]+\/[^/]+$/, 'GITHUB_REPOSITORY must name an owner and repository');
  const response = execFileSyncImpl(
    'gh',
    ['api', `repos/${repository}/actions/workflows/release.yml`],
    { encoding: 'utf8', timeout: 30000 },
  );
  const { state } = JSON.parse(response);

  if (state === 'disabled_manually' || state === 'disabled_inactivity') {
    log(`Release workflow is ${state}; leaving the release paused.`);
    return 'paused';
  }

  assert.equal(state, 'active', `Unexpected Release workflow state: ${state ?? '<missing>'}`);
  execFileSyncImpl(
    'gh',
    ['workflow', 'run', 'release.yml', '--repo', repository, '--ref', 'main', '-f', 'resume-only=true'],
    { stdio: 'inherit', timeout: 30000 },
  );
  return 'dispatched';
}

if (import.meta.main) continueRelease();
