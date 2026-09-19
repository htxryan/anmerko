import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export function obsoleteLegacyUrls(body, allowed = new Set()) {
  return [...body.matchAll(/https:\/\/briefmark\.app[^\s"'<>)]*/g)]
    .map(match => match[0]).filter(url => !allowed.has(url));
}

export function deploymentRouteChecks(main404, support404) {
  return [
    { path: '/docs/development/', status: 404, expectedHash: main404 },
    { path: '/docs/tasks/', status: 404, expectedHash: main404 },
    { path: '/__deployment_missing__', status: 404, expectedHash: main404 },
    { path: '/support/__deployment_missing__', status: 404, expectedHash: support404 },
    { path: '/support', status: 307, location: '/support/' },
  ];
}

export async function verifySite({
  root = '.', baseUrl = 'https://anmerko.com', fetchImpl = fetch,
  attempts = 5, retryDelayMs = 2000,
} = {}) {
  const checks = [];
  for (const directory of ['site/dist', 'artifacts/store-site']) {
    const dir = join(root, directory);
    // Fail before HTTP requests if the artifact lost its headers or entry point.
    await readFile(join(dir, '_headers'));
    await readFile(join(dir, directory === 'site/dist' ? 'index.html' : 'support/index.html'));
    const files = await readdir(dir, { recursive: true, withFileTypes: true });
    for (const file of files.filter(entry => entry.isFile())) {
      if (['_headers', '_redirects', '404.html'].includes(file.name)) continue;
      const localPath = join(file.parentPath, file.name);
      const relative = localPath.slice(dir.length + 1).replaceAll('\\', '/');
      const path = `/${relative}`.replace(/index\.html$/, '').replace(/\.html$/, '');
      checks.push({ path, status: 200, expectedHash: hash(await readFile(localPath)) });
    }
  }
  const main404 = hash(await readFile(join(root, 'site/dist/404.html')));
  const support404 = hash(await readFile(join(root, 'artifacts/store-site/404.html')));
  checks.push(...deploymentRouteChecks(main404, support404));
  const approved = JSON.parse(await readFile(join(root, 'site/dist/release-manifest.json'), 'utf8'));
  const allowedLegacyUrls = new Set(Object.values(approved.browsers || {})
    .map(browser => browser?.artifact?.filename)
    .filter(filename => /^briefmark-[\w.-]+\.(?:zip|xpi)$/.test(filename || ''))
    .map(filename => `https://briefmark.app/downloads/${filename}`));
  for (const directory of ['site/dist', 'artifacts/store-site']) {
    const dir = join(root, directory);
    const files = await readdir(dir, { recursive: true, withFileTypes: true });
    for (const file of files.filter(entry => entry.isFile() && /\.(?:html|css|js|json|xml|txt)$/.test(entry.name))) {
      const body = await readFile(join(file.parentPath, file.name), 'utf8');
      const obsolete = obsoleteLegacyUrls(body, allowedLegacyUrls);
      if (obsolete.length) throw new Error(`Obsolete live Briefmark URL in ${file.name}: ${obsolete[0]}`);
    }
  }
  // Limit requests while still checking every lazy module and search asset.
  const results = [];
  for (let index = 0; index < checks.length; index += 6) {
    results.push(...await Promise.all(checks.slice(index, index + 6).map(async check => {
      let result;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
          const response = await fetchImpl(new URL(check.path, baseUrl), {
            redirect: 'manual', signal: AbortSignal.timeout(15000),
            headers: { 'Cache-Control': 'no-cache' },
          });
          const actualHash = hash(Buffer.from(await response.arrayBuffer()));
          const location = response.headers.get('location');
          result = {
            path: check.path, status: response.status, sha256: actualHash,
            attempts: attempt,
            ok: response.status === check.status
              && (!check.expectedHash || actualHash === check.expectedHash)
              && (!check.location || location === check.location),
          };
        } catch (error) {
          result = { path: check.path, attempts: attempt, ok: false, error: error.message };
        }
        if (result.ok) break;
        if (attempt < attempts) await delay(retryDelayMs);
      }
      return result;
    })));
  }
  return { verifiedAt: new Date().toISOString(), ok: results.every(check => check.ok), checks: results };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const report = await verifySite({ root: process.argv[2], baseUrl: process.argv[3] });
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}
