import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { Builder, By, until } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';
import { Command } from 'selenium-webdriver/lib/command.js';
import { Pointer } from 'selenium-webdriver/lib/input.js';
import { binaryPaths } from 'selenium-webdriver/common/seleniumManager.js';
import { FIREFOX_GUID } from '../../scripts/release/release-names.mjs';
import { adb, deviceSerial, firefoxApk, installedVersion, rootDevice, screencap, shell } from './device.mjs';

// Release Firefox for Android on a disposable emulator or device. geckodriver
// enables Marionette through GeckoView's automation config; the unchanged
// production package is installed as a temporary add-on.
const firefoxPackage = 'org.mozilla.firefox';
const expectedHost = 'anmerko-overlay';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
let server, origin, serial, rooted, apk, addon, payload, geckodriver, output, temp;

before(async () => {
  serial = deviceSerial();
  // Android 11+ rejects adb pushes into app-specific external storage, so a
  // rootable emulator keeps the geckodriver profile in /data/local/tmp.
  rooted = rootDevice();
  temp = await mkdtemp(join(tmpdir(), 'anmerko-android-'));
  output = resolve('artifacts', `android-firefox-${Date.now()}`);
  await mkdir(output, { recursive: true });
  apk = await firefoxApk(process.env.FIREFOX_ANDROID_CACHE || join(tmpdir(), 'anmerko-android-apk'));
  if (installedVersion(firefoxPackage) !== apk.version) adb('install', '-r', '-g', apk.file);
  assert.equal(installedVersion(firefoxPackage), apk.version);

  const manifest = JSON.parse(await readFile('dist-firefox/manifest.json', 'utf8'));
  assert.equal(manifest.version, JSON.parse(await readFile('package.json', 'utf8')).version, 'Run npm run build:firefox first');
  assert.equal(manifest.browser_specific_settings.gecko.id, FIREFOX_GUID);
  assert.ok(manifest.browser_specific_settings.gecko_android, 'The package must declare Firefox for Android support');
  payload = {};
  for (const file of (await readdir('dist-firefox', { recursive: true, withFileTypes: true })).filter(file => file.isFile())) {
    const path = join(file.parentPath, file.name);
    payload[relative('dist-firefox', path).replaceAll('\\', '/')] = hash(await readFile(path));
  }
  assert.ok(!Object.keys(payload).some(name => /dev-install|test-bootstrap/.test(name)));
  const archive = join(temp, 'anmerko.zip');
  execFileSync('zip', ['-qr', archive, '.'], { cwd: 'dist-firefox' });
  addon = (await readFile(archive)).toString('base64');

  const html = await readFile('tests/fixtures/demo/index.html');
  server = createServer((_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end(html); });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();
  // The device reaches the host fixture through its own loopback address.
  adb('reverse', `tcp:${port}`, `tcp:${port}`);
  origin = `http://127.0.0.1:${port}`;

  geckodriver = process.env.GECKODRIVER
    || binaryPaths(['--driver', 'geckodriver', '--output', 'json']).driverPath;
});

after(async () => {
  try { adb('reverse', '--remove-all'); } catch { /* the device may be gone */ }
  await new Promise(done => server ? server.close(done) : done());
  if (temp) await rm(temp, { recursive: true, force: true });
});

async function session(t, run) {
  const options = new firefox.Options().enableMobile(firefoxPackage)
    .setPreference('dom.events.testing.asyncClipboard', true);
  Object.assign(options.get('moz:firefoxOptions'), {
    // geckodriver's device capability is androidDeviceSerial.
    androidDeviceSerial: serial,
    androidStorage: rooted ? 'internal' : 'auto',
    // Firefox for Android 153+ skips onboarding only for automation launches.
    androidIntentArguments: ['-a', 'android.intent.action.VIEW', '-d', 'about:blank', '--ez', 'automationtest', 'true'],
  });
  // System access lets chrome-context scripts reach GeckoView's extension
  // bridge. Only this disposable profile on a disposable device receives it.
  const driver = await new Builder().forBrowser('firefox').setFirefoxOptions(options)
    .setFirefoxService(new firefox.ServiceBuilder(geckodriver).addArguments('--allow-system-access')).build();
  const evidence = {
    date: new Date().toISOString(), scenario: t.name, result: 'failed', browser: 'firefox-android',
    package: firefoxPackage, firefoxVersion: apk.version, abi: apk.abi, apkSha256: hash(await readFile(apk.file)),
    device: { serial, rooted, model: shell('getprop ro.product.model'), release: shell('getprop ro.build.version.release'),
      sdk: shell('getprop ro.build.version.sdk') },
    engine: (await driver.getCapabilities()).get('browserVersion'),
    route: 'temporary unchanged production build; GeckoView browser action click',
    sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), payload,
  };
  t.diagnostic(`Firefox for Android ${apk.version} (Gecko ${evidence.engine}) on Android ${evidence.device.release}`);
  const name = t.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  t.after(async () => {
    await writeFile(join(output, `${name}.json`), JSON.stringify(evidence, null, 2) + '\n');
    await driver.quit();
  });
  await driver.manage().setTimeouts({ pageLoad: 30000, script: 15000 });
  driver.getExecutor().defineCommand('installAddon', 'POST', '/session/:sessionId/moz/addon/install');
  assert.equal(await driver.execute(new Command('installAddon').setParameter('addon', addon).setParameter('temporary', true)), FIREFOX_GUID);

  const ui = selector => driver.executeScript((selector, host) => document.querySelector(host)?.shadowRoot.querySelector(selector), selector, expectedHost);
  const click = async selector => (await ui(selector)).click();
  const count = () => driver.executeScript(host => document.querySelector(host)?.shadowRoot.querySelectorAll('.note').length ?? 0, expectedHost);
  // Firefox for Android's Extensions menu calls this GeckoView entry point,
  // which grants activeTab and dispatches action.onClicked for the open tab.
  const activate = async () => {
    await driver.setContext('chrome');
    try {
      const error = await driver.executeAsyncScript((id, done) => {
        const { GeckoViewWebExtension } = ChromeUtils.importESModule('resource://gre/modules/GeckoViewWebExtension.sys.mjs');
        // browserActionClick ignores extensions whose action has not registered yet.
        const click = attempt => {
          if (!GeckoViewWebExtension.browserActions.get(WebExtensionPolicy.getByID(id)?.extension)) {
            if (attempt < 100) setTimeout(click, 100, attempt + 1);
            else done('the browser action never registered');
            return;
          }
          GeckoViewWebExtension.browserActionClick(id).then(() => done(null), reason => done(String(reason)));
        };
        click(0);
      }, FIREFOX_GUID);
      assert.equal(error, null);
    } finally { await driver.setContext('content'); }
  };
  const tap = async element => {
    const point = await driver.executeScript(element => {
      element.scrollIntoView({ block: 'center' });
      const r = element.getBoundingClientRect();
      const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
      return { x, y, hitsTarget: element.contains(document.elementFromPoint(x, y)) };
    }, element);
    assert.ok(point.hitsTarget, 'the touch target is visible and unobstructed');
    const finger = new Pointer('finger', Pointer.Type.TOUCH);
    await driver.actions().insert(finger, finger.move({ x: point.x, y: point.y, duration: 0 }), finger.press())
      .pause(80, finger).insert(finger, finger.release()).perform();
  };
  const save = async text => {
    const field = await driver.wait(() => ui('#comment'), 10000, 'the comment editor opens');
    await field.sendKeys(text);
    await click('.save');
    await driver.wait(() => driver.executeScript((text, host) => {
      const root = document.querySelector(host)?.shadowRoot;
      return root && !root.querySelector('#comment')
        && [...root.querySelectorAll('.note .comment')].some(node => node.textContent === text);
    }, text, expectedHost), 10000, 'saving renders the committed comment');
  };
  const screenshot = async label => {
    await writeFile(join(output, `${name}-${label}.png`), await driver.takeScreenshot(), 'base64');
    await writeFile(join(output, `${name}-${label}-device.png`), screencap());
  };
  try {
    await run({ driver, ui, click, count, activate, tap, save, screenshot, evidence });
    evidence.result = 'passed';
  } catch (error) {
    evidence.error = String(error);
    await screenshot('failure').catch(() => {});
    throw error;
  }
}

test('Firefox for Android activates the production package and keeps touch feedback after reload', { timeout: 240000 }, async t => session(t, async ({ driver, ui, click, count, activate, tap, save, screenshot, evidence }) => {
  await driver.get(origin);
  assert.equal(await driver.executeScript(host => !!document.querySelector(host), expectedHost), false,
    'nothing is injected before the user activates anmerko');
  await activate();
  await driver.wait(() => ui('.panel'), 15000, `${expectedHost} opens after the browser action`);
  evidence.viewport = await driver.executeScript(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio, ua: navigator.userAgent }));
  assert.match(evidence.viewport.ua, /Android/);
  assert.equal(await driver.executeScript(host => !!document.querySelector(host).shadowRoot.querySelector('[aria-label="Dock sidebar"]'), expectedHost),
    false, 'docking stays unavailable on Android');

  await click('.select');
  await tap(await driver.findElement(By.id('primary-cta')));
  assert.equal(await driver.getCurrentUrl(), `${origin}/`, 'selecting the link does not follow it');
  await save('Android touch feedback.');
  assert.equal(await count(), 1);
  await screenshot('saved');

  await click('.copy');
  await driver.wait(async () => /Copied/.test(await (await ui('.status')).getText()), 10000, 'the prompt is copied');
  const prompt = await driver.executeScript(() => navigator.clipboard.readText());
  assert.match(prompt, /#primary-cta/);
  assert.match(prompt, /Android touch feedback\./);

  await driver.navigate().refresh();
  await driver.wait(async () => !(await driver.executeScript(host => !!document.querySelector(host), expectedHost)), 10000);
  await activate();
  await driver.wait(async () => await count() === 1, 15000, 'the saved comment returns after reload and reactivation');
  await screenshot('reloaded');
}));

test('Firefox for Android explains protected pages instead of injecting', { timeout: 240000 }, async t => session(t, async ({ driver, activate }) => {
  await driver.get('about:blank');
  const before = await driver.getAllWindowHandles();
  await activate();
  await driver.wait(async () => (await driver.getAllWindowHandles()).length === before.length + 1, 15000, 'a guidance tab opens');
  await driver.switchTo().window((await driver.getAllWindowHandles()).find(handle => !before.includes(handle)));
  await driver.wait(until.titleIs('anmerko — Unsupported page'), 15000);
  assert.match(await driver.findElement(By.css('h1')).getText(), /Page not supported/);
}));
