import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectScope, requiredOperatingSystems, assertSelectedJobs } from '../scripts/ci-policy.mjs';
test('ordinary extension PRs select Linux and high-risk, manual or labeled PRs select every enabled OS', () => {
  assert.equal(selectScope({ event: 'pull_request', highRisk: false, labels: [] }), 'fast');
  for (const input of [{ highRisk: true }, { labels: ['full-ci'] }, { event: 'workflow_dispatch' }]) {
    assert.equal(selectScope({ event: 'pull_request', highRisk: false, labels: [], ...input }), 'full');
  }
  assert.deepEqual(requiredOperatingSystems('fast'), ['linux']);
  assert.deepEqual(requiredOperatingSystems('full'), ['darwin', 'linux']);
  assert.throws(() => requiredOperatingSystems(undefined));
});
test('required aggregate cannot accept a skipped, cancelled or missing selected matrix', () => {
  for (const status of ['failure', 'cancelled', 'skipped', undefined]) {
    assert.throws(() => assertSelectedJobs({ desktop: status, lint: 'success' }, ['desktop', 'lint']));
  }
  assert.doesNotThrow(() => assertSelectedJobs({ desktop: 'success', lint: 'success' }, ['desktop', 'lint']));
});
