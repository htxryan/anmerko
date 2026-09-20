import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PREVIEW_PREFIX = 'anmerko-site-preview-';
const COMPATIBILITY_DATE = '2026-09-12';
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function runCommand(command, args, options) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { ...options, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolveRun();
      else reject(new Error(`${command} exited with ${signal ? `signal ${signal}` : `code ${code}`}`));
    });
  });
}

function previewName(value) {
  if (!value) throw new Error('ANMERKO_PREVIEW_NAME is required');
  if (!/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(value)) {
    throw new Error('Preview name must be 1-40 lowercase letters, numbers, and hyphens, starting and ending with a letter or number');
  }
  return value;
}

function previewUrl(output, workerName) {
  const records = output.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const target = records.findLast(record => record.type === 'deploy'
    && record.worker_name === workerName && record.targets?.length)?.targets.at(-1);
  if (!target) throw new Error('Wrangler did not report a preview URL');
  return /^https?:\/\//.test(target) ? target : `https://${target}`;
}

export async function deploySitePreview({
  root = repositoryRoot,
  env = process.env,
  run = runCommand,
  log = console.log,
} = {}) {
  const name = previewName(env.ANMERKO_PREVIEW_NAME);
  const workerName = `${PREVIEW_PREFIX}${name}`;

  await run('npm', ['run', 'site:build'], { cwd: root, env });
  await run('npm', ['run', 'site:check'], { cwd: root, env });

  const previewsDir = join(root, 'tasks/site-previews');
  await mkdir(previewsDir, { recursive: true });
  const workDir = await mkdtemp(join(previewsDir, `${name}-`));
  const assetsDir = join(workDir, 'assets');
  const configPath = join(workDir, 'wrangler.json');
  const outputPath = join(workDir, 'wrangler-output.ndjson');
  await cp(join(root, 'site/dist'), assetsDir, { recursive: true });
  await writeFile(configPath, `${JSON.stringify({
    name: workerName,
    compatibility_date: COMPATIBILITY_DATE,
    workers_dev: true,
    preview_urls: false,
    routes: [],
    assets: { directory: './assets', not_found_handling: '404-page' },
  }, null, 2)}\n`);

  const deployEnv = { ...env, WRANGLER_OUTPUT_FILE_PATH: outputPath };
  delete deployEnv.WRANGLER_CI_OVERRIDE_NAME;
  const wrangler = join(root, 'node_modules/wrangler/bin/wrangler.js');
  await run(process.execPath, [wrangler, 'deploy', '--config', configPath, '--dry-run'], { cwd: workDir, env: deployEnv });
  await run(process.execPath, [wrangler, 'deploy', '--config', configPath], { cwd: workDir, env: deployEnv });

  const url = previewUrl(await readFile(outputPath, 'utf8'), workerName);
  log(`Preview URL: ${url}`);
  log(`Preview files: ${workDir}`);
  return { assetsDir, configPath, url, workDir };
}

if (import.meta.main) await deploySitePreview();
