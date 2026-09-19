import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const exec = promisify(execFile);
// Wrangler currently returns this exact code when the named Worker script is absent.
const ABSENT_CODES = new Set([10007]);

export function classifyWorkerStatus(error, workerName) {
  const detail = `${error?.stdout || ''}\n${error?.stderr || ''}`;
  const namedAbsent = detail.includes(`/workers/scripts/${workerName}/deployments`)
    && /(?:worker|script)[^\n]*(?:not found|does not exist)|could not find[^\n]*(?:worker|script)/i.test(detail);
  const code = Number(detail.match(/\[code:\s*(\d+)\]/i)?.[1]);
  return namedAbsent && ABSENT_CODES.has(code) ? 'absent' : 'error';
}

export async function captureDeploymentState({
  outputDir, workers, newManifestUrl, run = exec, fetchImpl = fetch,
}) {
  await mkdir(outputDir, { recursive: true });
  const states = [];
  for (const worker of workers) {
    try {
      const { stdout } = await run('npx', ['--no-install', 'wrangler', 'deployments', 'status', '--config', worker.config], { encoding: 'utf8' });
      await writeFile(`${outputDir}/previous-${worker.label}.txt`, stdout);
      states.push('present');
    } catch (error) {
      if (classifyWorkerStatus(error, worker.name) !== 'absent') throw error;
      await writeFile(`${outputDir}/previous-${worker.label}.json`, JSON.stringify({ state: 'absent', worker: worker.name }, null, 2) + '\n');
      states.push('absent');
    }
  }
  if (new Set(states).size !== 1) throw new Error('New Worker state is inconsistent; refusing a partial bootstrap');
  const firstDeployment = states[0] === 'absent';
  if (firstDeployment) return { firstDeployment, manifestUrl: null };
  const manifestUrl = newManifestUrl;
  const response = await fetchImpl(manifestUrl, { headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Previous approved manifest request failed (${response.status}) at ${manifestUrl}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const manifest = JSON.parse(bytes.toString('utf8'));
  if (manifest.schema !== 1 || !Number.isInteger(manifest.sequence)) throw new Error('Previous approved manifest has an invalid schema or sequence');
  await writeFile(`${outputDir}/previous-approved.json`, bytes);
  return { firstDeployment, manifestUrl };
}

if (import.meta.main) {
  await captureDeploymentState({
    outputDir: 'artifacts/deployment',
    workers: [
      { label: 'site', name: 'anmerko-site', config: 'site/wrangler.jsonc' },
      { label: 'support', name: 'anmerko-support', config: 'store-site/wrangler.jsonc' },
    ],
    newManifestUrl: 'https://anmerko.com/release-manifest.json',
  });
}
