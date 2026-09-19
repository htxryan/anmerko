#!/usr/bin/env node
// Development only. The normal build/package commands remove these helpers.
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { appendFile, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';

const exec = promisify(execFile);
const helper = 'anmerko-dev-install';

export function unpackedId(path, key) {
  const input = key ? Buffer.from(key, 'base64') : path;
  return createHash('sha256').update(input).digest('hex').slice(0, 32)
    .replace(/[0-9a-f]/g, char => String.fromCharCode(97 + parseInt(char, 16)));
}

// Only the matching extension and this one invocation can acknowledge an update.
// No comments, page URLs, settings, or other user data enter this listener.
export async function installSession({ id, version, token, openPage, timeoutMs = 30000 }) {
  const origin = `chrome-extension://${id}`;
  let port, timer, verifyTimer, started = false, settled = false;
  let complete, fail;
  const done = new Promise((resolve, reject) => { complete = resolve; fail = reject; });
  // The caller may still be opening Chrome when an early failure arrives.
  done.catch(() => {});
  const finish = error => {
    if (settled) return;
    settled = true;
    clearTimeout(timer); clearTimeout(verifyTimer);
    server.close();
    if (error) fail(error); else complete();
  };
  const page = phase => `${origin}/${helper}.html#${new URLSearchParams({ port, token, phase })}`;
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    if (request.headers.host !== `127.0.0.1:${port}` || request.headers.origin !== origin) {
      response.writeHead(403).end(); return;
    }
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Access-Control-Allow-Private-Network', 'true');
    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    if (!['GET', 'OPTIONS'].includes(request.method) || !url.pathname.startsWith(`/${token}/`)) {
      response.writeHead(403).end(); return;
    }
    if (request.method === 'OPTIONS') {
      response.setHeader('Access-Control-Allow-Methods', 'GET');
      response.writeHead(204).end(); return;
    }
    if (url.pathname === `/${token}/begin` && !started) {
      started = true;
      response.end('Reload accepted');
      // runtime.reload closes the first helper tab. A new page verifies the new worker.
      verifyTimer = setTimeout(() => openPage(page('verify')).catch(finish), 1000);
    } else if (url.pathname === `/${token}/verified` && started &&
      url.searchParams.get('version') === version && url.searchParams.get('build') === token &&
      url.searchParams.get('id') === id) {
      response.end('Verified');
      finish();
    } else if (url.pathname === `/${token}/failed`) {
      response.end('Failed');
      finish(new Error('Chrome could not verify the new anmerko worker. See the update tab for details.'));
    } else {
      response.writeHead(409).end('Unexpected or stale update acknowledgement');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  port = server.address().port;
  timer = setTimeout(() => finish(new Error('Chrome did not confirm the update. Ensure anmerko is enabled and loaded from this checkout’s dist/ folder in the Chrome profile receiving the update tab.')),
    timeoutMs);
  return { done, url: page('reload'), port, cancel: finish };
}

export async function writeHelpers(outdir, token) {
  await writeFile(resolve(outdir, `${helper}.html`), `<!doctype html><html lang="en"><meta charset="utf-8"><title>Updating anmerko</title><h1>Updating anmerko</h1><p id="status">Waiting for Chrome…</p><script src="${helper}.js?${token}"></script></html>`);
  await writeFile(resolve(outdir, `${helper}.js`), `
const token = ${JSON.stringify(token)};
const params = new URLSearchParams(location.hash.slice(1));
const status = document.querySelector('#status');
const port = Number(params.get('port'));
async function update() {
  if (params.get('token') !== token || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Run the development update command again.');
  const report = async (event, values = {}) => {
    const response = await fetch('http://127.0.0.1:' + port + '/' + token + '/' + event + '?' + new URLSearchParams(values), {cache:'no-store', credentials:'omit'});
    if (!response.ok) throw new Error('The local update command rejected this acknowledgement.');
  };
  try {
    if (params.get('phase') === 'reload') {
      await report('begin');
      chrome.runtime.reload();
    } else if (params.get('phase') === 'verify') {
      const result = await chrome.runtime.sendMessage({type:'ANMERKO_DEV_VERIFY', token});
      if (result?.build !== token || result?.id !== chrome.runtime.id) throw new Error('The new extension worker did not respond.');
      await report('verified', result);
      status.textContent = 'anmerko ' + result.version + ' is ready. Refresh the website before using it.';
      document.title = 'anmerko ' + result.version + ' updated';
      const tab = await chrome.tabs.getCurrent();
      if (tab?.id) await chrome.tabs.remove(tab.id);
    } else throw new Error('Unknown update step.');
  } catch (error) {
    await report('failed').catch(() => {});
    throw error;
  }
}
update().catch(error => { status.textContent = error.message; });
`);
  await appendFile(resolve(outdir, 'background.js'), `
// Local development update verification; never included by build/package.
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type === 'ANMERKO_DEV_VERIFY' && message.token === ${JSON.stringify(token)} && sender.id === chrome.runtime.id && sender.url?.startsWith(chrome.runtime.getURL('${helper}.html') + '#')) {
    respond({id:chrome.runtime.id, version:chrome.runtime.getManifest().version, build:${JSON.stringify(token)}});
  }
});
`);
}

async function main() {
  const { values } = parseArgs({ options: { help: { type: 'boolean', short: 'h' }, 'extension-id': { type: 'string' } } });
  if (values.help) {
    console.log('Usage: npm run chrome:install [-- --extension-id ID]\nBuild the current checkout and reload its existing unpacked installation in Chrome on macOS.\nFirst install: enable Developer mode at chrome://extensions and Load unpacked → dist/.\nKeep using the same folder to preserve saved comments and settings.');
    return;
  }
  if (process.platform !== 'darwin') throw new Error('Automatic Chrome updating currently supports macOS. Use npm run build, then Load unpacked or Reload at chrome://extensions on other systems.');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const result = await exec(process.execPath, [resolve(root, 'scripts/build.mjs')], { cwd: root });
  process.stdout.write(result.stdout);
  const outdir = await realpath(resolve(root, 'dist'));
  const manifest = JSON.parse(await readFile(resolve(outdir, 'manifest.json'), 'utf8'));
  const id = values['extension-id'] || unpackedId(outdir, manifest.key);
  if (!/^[a-p]{32}$/.test(id)) throw new Error('Extension ID must contain exactly 32 letters a–p.');
  const token = randomBytes(24).toString('hex');
  await writeHelpers(outdir, token);
  const openPage = url => exec('open', ['-a', 'Google Chrome', url]).then(() => {});
  const session = await installSession({ id, version: manifest.version, token, openPage });
  console.log(`Updating anmerko ${manifest.version} (${id}) from ${outdir}`);
  console.log('First install only: Load unpacked → this dist/ folder at chrome://extensions, then rerun this command.');
  const stop = () => session.cancel(new Error('Update cancelled.'));
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    await openPage(session.url);
    await session.done;
    console.log(`Verified: anmerko ${manifest.version} is running in Chrome. Saved comments and settings remain in the same installation.\nRefresh the website before using anmerko.`);
  } finally {
    session.cancel();
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
