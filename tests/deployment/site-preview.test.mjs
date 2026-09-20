import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { deploySitePreview } from '../../scripts/deployment/deploy-site-preview.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'anmerko-preview-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'site/dist'), { recursive: true });
  await writeFile(join(root, 'site/dist/index.html'), 'built site');
  return root;
}

test('rejects invalid names before running build or touching deployment state', async t => {
  const root = await fixture(t);
  for (const env of [
    {},
    { ANMERKO_PREVIEW_NAME: '' },
    ...['PR17', '-pr17', 'pr17-', 'pr_17', '../pr17', 'pr17;echo x', 'a'.repeat(41)]
      .map(ANMERKO_PREVIEW_NAME => ({ ANMERKO_PREVIEW_NAME })),
  ]) {
    const calls = [];
    await assert.rejects(
      deploySitePreview({ root, env, run: (...args) => calls.push(args) }),
      /lowercase letters, numbers, and hyphens|ANMERKO_PREVIEW_NAME/,
    );
    assert.equal(calls.length, 0);
  }
  await assert.rejects(() => access(join(root, 'tasks/site-previews')), { code: 'ENOENT' });
});

test('stops before snapshot or deploy when build or site checks fail', async t => {
  for (const failedCommand of ['site:build', 'site:check']) {
    const root = await fixture(t);
    const calls = [];
    const run = async (command, args) => {
      calls.push([command, ...args]);
      if (args.includes(failedCommand)) throw new Error(`${failedCommand} failed`);
    };
    await assert.rejects(
      deploySitePreview({ root, env: { ANMERKO_PREVIEW_NAME: 'pr17' }, run }),
      new RegExp(`${failedCommand} failed`),
    );
    assert.deepEqual(calls.map(call => call.slice(1)), failedCommand === 'site:build'
      ? [['run', 'site:build']]
      : [['run', 'site:build'], ['run', 'site:check']]);
    await assert.rejects(() => access(join(root, 'tasks/site-previews')), { code: 'ENOENT' });
  }
});

test('deploys an isolated snapshot with a fixed preview Worker configuration', async t => {
  const root = await fixture(t);
  const calls = [];
  const messages = [];
  const run = async (command, args, options) => {
    calls.push({ command, args, options });
    if (args.includes('--dry-run')) {
      await writeFile(join(root, 'site/dist/index.html'), 'changed after snapshot');
    } else if (args[0]?.endsWith('/node_modules/wrangler/bin/wrangler.js')) {
      await writeFile(options.env.WRANGLER_OUTPUT_FILE_PATH, `${JSON.stringify({
        type: 'deploy',
        worker_name: 'anmerko-site-preview-pr17',
        targets: ['anmerko-site-preview-pr17.example.workers.dev'],
        version_id: 'version-1',
      })}\n`);
    }
  };

  const result = await deploySitePreview({
    root,
    env: { ANMERKO_PREVIEW_NAME: 'pr17', WRANGLER_CI_OVERRIDE_NAME: 'anmerko-site' },
    run,
    log: message => messages.push(message),
  });

  assert.deepEqual(calls.map(({ args }) => args), [
    ['run', 'site:build'],
    ['run', 'site:check'],
    [join(root, 'node_modules/wrangler/bin/wrangler.js'), 'deploy', '--config', result.configPath, '--dry-run'],
    [join(root, 'node_modules/wrangler/bin/wrangler.js'), 'deploy', '--config', result.configPath],
  ]);
  assert.equal(await readFile(join(result.assetsDir, 'index.html'), 'utf8'), 'built site');
  assert.equal(await readFile(join(root, 'site/dist/index.html'), 'utf8'), 'changed after snapshot');
  assert.deepEqual(JSON.parse(await readFile(result.configPath, 'utf8')), {
    name: 'anmerko-site-preview-pr17',
    compatibility_date: '2026-09-12',
    workers_dev: true,
    preview_urls: false,
    routes: [],
    assets: { directory: './assets', not_found_handling: '404-page' },
  });
  assert.ok(result.workDir.startsWith(join(root, 'tasks/site-previews/pr17-')));
  assert.equal(result.url, 'https://anmerko-site-preview-pr17.example.workers.dev');
  assert.ok(messages.includes(`Preview URL: ${result.url}`));
  for (const call of calls.slice(2)) {
    assert.equal(call.command, process.execPath);
    assert.equal(call.options.cwd, result.workDir);
    assert.equal(call.options.env.WRANGLER_CI_OVERRIDE_NAME, undefined);
  }
});
