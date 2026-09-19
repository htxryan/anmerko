import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from '@playwright/test';
import { installSession, unpackedId, writeHelpers } from '../scripts/install-chrome.mjs';

const exec = promisify(execFile);
const id = 'a'.repeat(32), token = 'b'.repeat(48), version = '0.5.1';
const origin = `chrome-extension://${id}`;

test('update confirmation rejects other origins, tokens, and stale workers', async t => {
  const opened = [];
  const session = await installSession({id, token, version, openPage: async url => opened.push(url)});
  t.after(() => session.cancel());
  const request = (path, from = origin) => fetch(`http://127.0.0.1:${session.port}/${path}`, {headers:{Origin:from}});
  assert.equal((await request(`${token}/begin`, 'https://example.com')).status, 403);
  assert.equal((await request('wrong/begin')).status, 403);
  const verified = `${token}/verified?${new URLSearchParams({id, version, build:token})}`;
  assert.equal((await request(verified)).status, 409);
  assert.equal((await request(`${token}/begin`)).status, 200);
  assert.equal((await request(`${token}/verified?${new URLSearchParams({id, version, build:'old'})}`)).status, 409);
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(opened.length, 1);
  assert.equal(new URLSearchParams(new URL(opened[0]).hash.slice(1)).get('phase'), 'verify');
  assert.equal((await request(verified)).status, 200);
  await session.done;
});

test('missing Chrome confirmation fails and closes the listener', async () => {
  const session = await installSession({id, token, version, openPage: async () => {}, timeoutMs:50});
  await assert.rejects(session.done, /Chrome did not confirm/);
  await assert.rejects(fetch(`http://127.0.0.1:${session.port}/`));
});

test('the release packager refuses temporary update code before touching an archive', async t => {
  const root = await mkdtemp(resolve(tmpdir(), 'anmerko-installer-package-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  await cp('dist', resolve(root, 'dist'), {recursive:true});
  await writeFile(resolve(root, 'package.json'), JSON.stringify({name:'anmerko',version}));
  await writeHelpers(resolve(root, 'dist'), token);
  await assert.rejects(exec(process.execPath, [resolve('scripts/package.mjs')], {cwd:root}), error => /Development update helper detected/.test(error.stderr));
});

test('Chrome reloads new code without changing the ID, permissions, or saved data', {timeout:60000}, async t => {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'anmerko-installer-browser-')));
  let context;
  t.after(async () => {
    try { await context?.close(); }
    finally { await rm(root, {recursive:true, force:true}); }
  });
  const outdir = resolve(root, 'extension');
  await cp('dist', outdir, {recursive:true});
  const manifest = await readFile(resolve(outdir, 'manifest.json'), 'utf8');
  const currentVersion = JSON.parse(manifest).version;
  context = await chromium.launchPersistentContext(resolve(root,'profile'), {
    channel:'chromium', headless:true,
    args:[`--disable-extensions-except=${outdir}`,`--load-extension=${outdir}`],
  });
  // Match the one-time developer-mode setup of a normal unpacked installation.
  // Command-line loading alone does not enable it in a disposable profile.
  const setup = await context.newPage();
  await setup.goto('chrome://extensions/');
  await setup.getByRole('button', {name:'Developer mode', exact:true}).click();
  await setup.close();
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  assert.equal(extensionId, unpackedId(await realpath(outdir)));
  await worker.evaluate(() => chrome.storage.local.set({
    'anmerko:prompt-preamble':'My existing preamble',
    'installer-test-note': {comment:'Keep this saved comment'},
  }));
  // First update adds previously nonexistent helper files to an installed extension.
  // A second update keeps the same version but must prove a different worker build.
  for (const build of ['c'.repeat(48), 'd'.repeat(48)]) {
    await writeHelpers(outdir, build);
    const openPage = async url => {
      const page = await context.newPage();
      await page.goto(url, {waitUntil:'domcontentloaded'}).catch(error => {
        if (!page.isClosed()) throw error;
      });
    };
    const session = await installSession({id:extensionId, version:currentVersion, token:build, openPage, timeoutMs:20000});
    try { await openPage(session.url); await session.done; }
    catch (error) {
      const details = await context.newPage();
      await details.goto(`chrome://extensions/?id=${extensionId}`);
      await details.getByRole('heading', {name:'anmerko', exact:true}).waitFor({timeout:5000});
      t.diagnostic(await details.locator('body').ariaSnapshot());
      throw error;
    }
    finally { session.cancel(); }
    assert.equal(await readFile(resolve(outdir, 'manifest.json'), 'utf8'), manifest);
  }
  const active = context.serviceWorkers().find(worker => new URL(worker.url()).host === extensionId);
  const stored = await active.evaluate(() => chrome.storage.local.get(['anmerko:prompt-preamble','installer-test-note']));
  assert.deepEqual(stored, {
    'anmerko:prompt-preamble':'My existing preamble',
    'installer-test-note': {comment:'Keep this saved comment'},
  });
});
