import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deploymentRouteChecks, noncanonicalSiteUrls } from '../../scripts/deployment/verify-site-deployment.mjs';

test('deployment verifier covers private docs, task paths, both 404 workers and bare support', () => {
  assert.deepEqual(deploymentRouteChecks('main-404', 'support-404'), [
    { path: '/docs/development/', status: 404, expectedHash: 'main-404' },
    { path: '/docs/tasks/', status: 404, expectedHash: 'main-404' },
    { path: '/__deployment_missing__', status: 404, expectedHash: 'main-404' },
    { path: '/support/__deployment_missing__', status: 404, expectedHash: 'support-404' },
    { path: '/support', status: 307, location: '/support/' },
  ]);
});

test('deployment verifier rejects approved downloads on noncanonical origins or altered URLs', () => {
  const filename = 'approved-package-0.5.4.zip';
  const canonical = `https://anmerko.com/downloads/${filename}`;
  const noncanonical = `https://downloads.invalid/downloads/${filename}`;
  const approved = new Set([filename]);
  assert.deepEqual(noncanonicalSiteUrls(`<a href="${canonical}">package</a>`, approved), []);
  assert.deepEqual(noncanonicalSiteUrls(noncanonical, approved), [noncanonical]);
  const noncanonicalDocs = 'https://docs.invalid/docs/usage/';
  assert.deepEqual(noncanonicalSiteUrls(noncanonicalDocs, approved), [noncanonicalDocs]);
  assert.deepEqual(noncanonicalSiteUrls(`${canonical}?latest=1`, approved), [`${canonical}?latest=1`]);
  assert.deepEqual(noncanonicalSiteUrls('https://example.com/project/', approved), []);
});
