import { chromium } from '@playwright/test';
import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir, release, arch } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { desktopScenarios } from './desktop-scenarios.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export async function createDesktopSession({ scenario = 'manual' } = {}) {
  const browser = process.env.ANMERKO_DESKTOP_BROWSER || 'chrome';
  const executable = process.env.ANMERKO_DESKTOP_EXECUTABLE;
  assert.ok(executable, 'Run through scripts/browsers/test-desktop.mjs to select an installed browser');
  const temp = await mkdtemp(join(tmpdir(), 'anmerko-desktop-'));
  const extension = join(temp, 'extension');
  const output = resolve('artifacts', `desktop-${browser}-${process.platform}-${Date.now()}`);
  let server;
  const session = { context: undefined, evidence: {
    scenario, result: 'incomplete', teardown: 'incomplete',
    coverage: desktopScenarios,
    scenarios: Object.fromEntries(Object.keys(desktopScenarios).map(id => [id, 'unrun'])), console: [], requests: [],
  }, output };
  const evidence = session.evidence;
  session.close = async () => {
    try {
      if (session.page && !session.page.isClosed()) await session.page.screenshot({ path: join(output, 'final.png') });
    } catch (error) { evidence.screenshotError = String(error); }
    try {
      await session.context?.close();
      if (server?.listening) await new Promise(done => server.close(done));
      await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      evidence.teardown = 'passed';
    } catch (error) {
      evidence.teardown = 'failed';
      evidence.teardownError = String(error);
      throw error;
    } finally {
      await writeFile(join(output, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
    }
  };
  try {
    await mkdir(output, { recursive: true });
    await cp('dist', extension, { recursive: true });
    const files = (await readdir(extension, { recursive: true, withFileTypes: true })).filter(file => file.isFile());
    const payload = {};
    for (const file of files) {
      const absolute = join(file.parentPath, file.name);
      payload[absolute.slice(extension.length + 1).replaceAll('\\', '/')] = hash(await readFile(absolute));
    }
    const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
    const expected = JSON.parse(await readFile('public/manifest.json', 'utf8'));
    expected.version = JSON.parse(await readFile('package.json', 'utf8')).version;
    assert.deepEqual(manifest, expected, 'Build the unchanged production Chrome manifest first');
    assert.ok(!files.some(file => /briefmark-dev-install|test-bootstrap/.test(file.name)), 'Development helpers must not enter acceptance');
    const html = await readFile('tests/fixtures/demo/index.html');
    server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(html); });
    await new Promise(done => server.listen(0, '127.0.0.1', done));
    session.origin = `http://127.0.0.1:${server.address().port}`;
    Object.assign(evidence, {
      date: new Date().toISOString(), browser, executable, os: process.platform, osRelease: release(), architecture: arch(),
      sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      dirty: !!execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(),
      route: 'unpacked production manifest; CDP extension action', version: manifest.version, manifest, payload,
      storeInstall: 'unrun', storeUpdate: 'unrun', manualToolbar: 'unrun',
    });
    session.start = async () => {
      session.context = await chromium.launchPersistentContext(join(temp, 'profile'), {
        executablePath: executable, headless: false, viewport: null,
        ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging', '--window-size=1440,1000'],
      });
      session.context.setDefaultTimeout(10000);
      session.cdp = await session.context.browser().newBrowserCDPSession();
      evidence.engine = await session.cdp.send('Browser.getVersion');
      session.id = (await session.cdp.send('Extensions.loadUnpacked', { path: extension })).id;
      evidence.extensionId = session.id;
      // Installation returns before the background module is always ready.
      const worker = session.context.serviceWorkers().find(worker => worker.url() === `chrome-extension://${session.id}/background.js`)
        || await session.context.waitForEvent('serviceworker', { predicate: worker => worker.url() === `chrome-extension://${session.id}/background.js` });
      assert.deepEqual(await worker.evaluate(() => chrome.runtime.getManifest()), manifest);
      session.page = await session.context.newPage();
      session.page.on('console', message => { if (['error', 'warning'].includes(message.type())) evidence.console.push(message.text()); });
      session.page.on('pageerror', error => evidence.console.push(error.message));
      session.page.on('request', request => evidence.requests.push({ url: request.url(), method: request.method() }));
      await session.page.goto(session.origin);
      // Headed CI can finish navigation before its native window has a viewport.
      await session.page.waitForFunction(() => innerWidth > 0 && innerHeight > 0);
      evidence.viewport = await session.page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio }));
    };
    session.activate = async (page = session.page) => {
      await page.bringToFront();
      const { targetInfos } = await session.cdp.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }, { exclude: true }] });
      const targets = targetInfos.filter(target => target.url === page.url() && target.embedderData?.tabActive);
      assert.equal(targets.length, 1, 'Exactly one active browser tab target must match the test page');
      await session.cdp.send('Extensions.triggerAction', { id: session.id, targetId: targets[0].targetId });
    };
    await session.start();
    console.log(`${browser}: ${evidence.engine.product}; ${executable}; evidence: ${output}`);
    return session;
  } catch (error) {
    evidence.error = String(error);
    await session.close();
    throw error;
  }
}
