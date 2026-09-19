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

test('deployment verifier rejects exact site routes on noncanonical origins without claiming external docs', () => {
  const filename = 'approved-package-0.5.4.zip';
  const canonical = `https://anmerko.com/downloads/${filename}`;
  const noncanonical = `https://downloads.invalid/downloads/${filename}`;
  const approved = new Set([filename]);
  const published = new Set(['/docs/usage/', `/downloads/${filename}`, '/release-manifest.json']);
  assert.deepEqual(noncanonicalSiteUrls(`<a href="${canonical}">package</a>`, approved, published), []);
  assert.deepEqual(noncanonicalSiteUrls(noncanonical, approved, published), [noncanonical]);
  for (const staleDocs of ['https://docs.invalid/docs/usage/', 'https://www.anmerko.com/docs/usage/']) {
    assert.deepEqual(noncanonicalSiteUrls(staleDocs, approved, published), [staleDocs]);
  }
  assert.deepEqual(noncanonicalSiteUrls(`${canonical}?latest=1`, approved, published), [`${canonical}?latest=1`]);
  assert.deepEqual(noncanonicalSiteUrls(`${canonical}#direct`, approved, published), [`${canonical}#direct`]);
  assert.deepEqual(noncanonicalSiteUrls(
    'https://developer.chrome.com/docs/webstore/program-policies/policies', approved, published), []);
  assert.deepEqual(noncanonicalSiteUrls('https://ryanhenderson.dev/', approved, new Set(['/'])), []);
});
