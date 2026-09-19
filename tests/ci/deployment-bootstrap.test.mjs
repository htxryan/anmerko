import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureDeploymentState, classifyWorkerStatus } from '../../scripts/deployment/capture-deployment-state.mjs';

const workers = [
  { label: 'site', name: 'anmerko-site', config: 'site/wrangler.jsonc' },
  { label: 'support', name: 'anmerko-support', config: 'site/support/wrangler.jsonc' },
];
const absent = name => Object.assign(new Error('missing'), { stderr: `API /workers/scripts/${name}/deployments failed. This Worker does not exist on your account. [code: 10007]` });
const response = value => new Response(JSON.stringify(value), { status: 200 });

test('first deployment records exact Worker absence without depending on a prior deployment', async () => {
  const outputDir = await mkdtemp(join(tmpdir(), 'anmerko-bootstrap-'));
  const result = await captureDeploymentState({ outputDir, workers,
    newManifestUrl: 'https://anmerko.com/release-manifest.json',
    run: async (_file, args) => {
      throw absent(args.at(-1) === 'site/wrangler.jsonc' ? 'anmerko-site' : 'anmerko-support');
    },
    fetchImpl: async () => assert.fail('a first deployment has no predecessor manifest'),
  });
  assert.equal(result.firstDeployment, true);
  assert.equal(result.manifestUrl, null);
  assert.deepEqual(JSON.parse(await readFile(join(outputDir, 'previous-site.json'))), { state: 'absent', worker: 'anmerko-site' });
  await assert.rejects(readFile(join(outputDir, 'previous-approved.json')));
});

test('subsequent deployment records versions and requires the new-origin manifest', async () => {
  const outputDir = await mkdtemp(join(tmpdir(), 'anmerko-next-'));
  const result = await captureDeploymentState({ outputDir, workers,
    newManifestUrl: 'https://anmerko.com/release-manifest.json',
    run: async () => ({ stdout: 'Version ID: known-good\n' }),
    fetchImpl: async url => { assert.equal(url, 'https://anmerko.com/release-manifest.json'); return response({ schema: 1, sequence: 7 }); },
  });
  assert.equal(result.firstDeployment, false);
  assert.match(await readFile(join(outputDir, 'previous-support.txt'), 'utf8'), /known-good/);
});

test('auth, network, arbitrary and partial-state failures are never treated as bootstrap absence', async () => {
  assert.equal(classifyWorkerStatus({ stderr: 'Authentication error [code: 10000]' }, 'anmerko-site'), 'error');
  assert.equal(classifyWorkerStatus(absent('another-site'), 'anmerko-site'), 'error');
  assert.equal(classifyWorkerStatus(absent('anmerko-site-old'), 'anmerko-site'), 'error');
  assert.equal(classifyWorkerStatus(absent('old-anmerko-site'), 'anmerko-site'), 'error');
  const outputDir = await mkdtemp(join(tmpdir(), 'anmerko-error-'));
  await assert.rejects(captureDeploymentState({ outputDir, workers,
    newManifestUrl: 'new',
    run: async (_file, args) => args.at(-1) === 'site/wrangler.jsonc' ? Promise.reject(absent('anmerko-site')) : ({ stdout: 'present' }),
    fetchImpl: async () => assert.fail('must not fetch'),
  }), /inconsistent/);
  await assert.rejects(captureDeploymentState({ outputDir, workers,
    newManifestUrl: 'new', run: async () => ({ stdout: 'present' }),
    fetchImpl: async () => { throw new Error('network unavailable'); },
  }), /network unavailable/);
});

test('deploy workflow captures rollback state before publishing and retains the old concurrency lock', async () => {
  const workflow = await readFile('.github/workflows/deploy.yml', 'utf8');
  assert.match(workflow, /group: briefmark-production/);
  assert.match(workflow, /node scripts\/deployment\/capture-deployment-state\.mjs[\s\S]*wrangler deploy --config site\/wrangler\.jsonc/);
  assert.match(workflow, /wrangler deploy --config site\/support\/wrangler\.jsonc --assets release\/artifacts\/store-site/);
  assert.match(workflow, /environment:[\s\S]*url: https:\/\/anmerko\.com/);
});
