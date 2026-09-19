import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deploymentRouteChecks, obsoleteLegacyUrls } from '../scripts/verify-site-deployment.mjs';

test('deployment verifier covers private docs, task paths, both 404 workers and bare support', () => {
  assert.deepEqual(deploymentRouteChecks('main-404', 'support-404'), [
    { path: '/docs/development/', status: 404, expectedHash: 'main-404' },
    { path: '/docs/tasks/', status: 404, expectedHash: 'main-404' },
    { path: '/__deployment_missing__', status: 404, expectedHash: 'main-404' },
    { path: '/support/__deployment_missing__', status: 404, expectedHash: 'support-404' },
    { path: '/support', status: 307, location: '/support/' },
  ]);
});

test('deployment verifier rejects obsolete live origins with exact historical download exceptions', () => {
  const historical = 'https://briefmark.app/downloads/briefmark-0.5.4.zip';
  const allowed = new Set([historical]);
  assert.deepEqual(obsoleteLegacyUrls(`<a href="${historical}">old package</a>`, allowed), []);
  assert.deepEqual(obsoleteLegacyUrls('https://briefmark.app/docs/usage/', allowed), ['https://briefmark.app/docs/usage/']);
  assert.deepEqual(obsoleteLegacyUrls(`${historical}?latest=1`, allowed), [`${historical}?latest=1`]);
});
