import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifySite } from '../scripts/verify-site-deployment.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'anmerko-deployment-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = {
    'site/dist/index.html': 'current brochure',
    'site/dist/docs/index.html': 'current docs',
    'site/dist/_astro/demo.js': 'current demo',
    'site/dist/downloads/extension.zip': 'ZIP bytes',
    'site/dist/downloads/extension.xpi': 'signed XPI bytes',
    'site/dist/release-manifest.json': '{"browsers":{}}',
    'site/dist/404.html': 'main not found',
    'site/dist/_headers': '/*\n  X-Content-Type-Options: nosniff',
    'artifacts/store-site/support/index.html': 'current help',
    'artifacts/store-site/support/privacy/index.html': 'current policy',
    'artifacts/store-site/404.html': 'support not found',
    'artifacts/store-site/_headers': '/*\n  X-Content-Type-Options: nosniff',
  };
  for (const [file, bytes] of Object.entries(files)) {
    const path = join(root, file);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, bytes);
  }
  const responses = new Map([
    ['/', [200, 'current brochure']],
    ['/docs/', [200, 'current docs']],
    ['/_astro/demo.js', [200, 'current demo']],
    ['/downloads/extension.zip', [200, 'ZIP bytes']],
    ['/downloads/extension.xpi', [200, 'signed XPI bytes']],
    ['/release-manifest.json', [200, '{"browsers":{}}']],
    ['/support/', [200, 'current help']],
    ['/support/privacy/', [200, 'current policy']],
    ['/docs/development/', [404, 'main not found']],
    ['/docs/tasks/', [404, 'main not found']],
    ['/__deployment_missing__', [404, 'main not found']],
    ['/support/__deployment_missing__', [404, 'support not found']],
    ['/support', [307, '', { location: '/support/' }]],
  ]);
  const fetchImpl = async (url, options) => {
    assert.equal(options.redirect, 'manual', 'Do not follow an Access login redirect');
    const path = new URL(url).pathname;
    assert.ok(responses.has(path), `Unexpected published path ${path}`);
    const [status, body, headers] = responses.get(path);
    return new Response(body, { status, headers });
  };
  return { options: { root, fetchImpl, attempts: 1, retryDelayMs: 0 }, responses };
}

test('accepts matching pages, lazy assets, installers, support routes and 404s', async t => {
  const { options } = await fixture(t);
  const report = await verifySite(options);
  assert.equal(report.ok, true);
  assert.equal(report.checks.length, 13);
});

test('fails when a signed installer is changed or a lazy asset is stale', async t => {
  const { options, responses } = await fixture(t);
  responses.set('/downloads/extension.xpi', [200, 'different signed bytes']);
  responses.set('/_astro/demo.js', [200, 'old demo']);
  const report = await verifySite(options);
  assert.equal(report.ok, false);
  assert.deepEqual(report.checks.filter(c => !c.ok).map(c => c.path).sort(),
    ['/_astro/demo.js', '/downloads/extension.xpi']);
});

test('fails for authentication redirects, leaked development docs and wrong support redirects', async t => {
  const { options, responses } = await fixture(t);
  responses.set('/', [302, '', { location: 'https://login.example/' }]);
  responses.set('/docs/development/', [200, 'private development guide']);
  responses.set('/support', [307, '', { location: '/' }]);
  const report = await verifySite(options);
  assert.equal(report.ok, false);
  assert.equal(report.checks.filter(c => !c.ok).length, 3);
});

test('retries propagation delays and transient network failures, then stops on success', async t => {
  const { options } = await fixture(t);
  let calls = 0;
  const realFetch = options.fetchImpl;
  options.attempts = 3;
  options.fetchImpl = (url, config) => {
    if (new URL(url).pathname === '/') {
      calls++;
      if (calls === 1) throw new Error('connection reset');
      if (calls === 2) return new Response('old brochure');
    }
    return realFetch(url, config);
  };
  assert.equal((await verifySite(options)).ok, true);
  assert.equal(calls, 3);
});

test('reports permanent network failure after bounded retries', async t => {
  const { options } = await fixture(t);
  options.attempts = 2;
  options.fetchImpl = () => { throw new Error('network unavailable'); };
  const report = await verifySite(options);
  assert.equal(report.ok, false);
  assert.ok(report.checks.every(c => !c.ok && c.attempts === 2));
});

test('rejects an incomplete artifact before making public requests', async t => {
  const { options } = await fixture(t);
  await rm(join(options.root, 'site/dist/_headers'));
  options.fetchImpl = () => assert.fail('Incomplete artifacts must fail before HTTP verification');
  await assert.rejects(verifySite(options), /ENOENT/);
});

test('a later docs-only merge can deploy, while stale website or manifest builds cannot', async () => {
  const { canDeployAfter } = await import('../scripts/deployment-eligibility.mjs');
  const comparison = files => ({ merge_base_commit: { sha: 'source' }, status: 'ahead', files: files.map(filename => ({ filename })) });
  assert.equal(canDeployAfter('source', 'latest', comparison(['docs/release-process.md'])), true);
  for (const path of ['src/content.ts', 'src/panel.css', 'src/comment-card.ts', 'src/support-icon.ts', 'public/icons/128.png', 'releases/approved.json', 'site/src/pages/index.astro', 'scripts/build-site.mjs', 'package-lock.json']) {
    assert.equal(canDeployAfter('source', 'latest', comparison([path])), false);
  }
  assert.equal(canDeployAfter('source', 'latest', comparison(Array(300).fill('docs/a.md'))), false);
  assert.equal(canDeployAfter('source', 'latest', { ...comparison([]), merge_base_commit: { sha: 'other' } }), false);
});
