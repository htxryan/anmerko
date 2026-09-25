import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Builder } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';
import { Command } from 'selenium-webdriver/lib/command.js';
import { binaryPaths } from 'selenium-webdriver/common/seleniumManager.js';
import { FIREFOX_GUID } from '../../scripts/release/release-names.mjs';
import { adb, deviceSerial, firefoxApk, installedVersion, rootDevice, screencap } from './device.mjs';

// A quick sanity check of release Firefox for Android on a disposable emulator
// or device: the unchanged production package loads as a temporary add-on and
// opens its panel from the browser action. Desktop suites cover the behavior.
const firefoxPackage = 'org.mozilla.firefox';
const expectedHost = 'anmerko-overlay';
let server, origin, serial, rooted, apk, addon, geckodriver, output, temp;

before(async () => {
  serial = deviceSerial();
  // Android 11+ rejects adb pushes into app-specific external storage, so a
  // rootable emulator keeps the geckodriver profile in /data/local/tmp.
  rooted = rootDevice();
  apk = await firefoxApk(process.env.FIREFOX_ANDROID_CACHE || join(tmpdir(), 'anmerko-android-apk'));
  if (installedVersion(firefoxPackage) !== apk.version) adb('install', '-r', '-g', apk.file);
  assert.equal(installedVersion(firefoxPackage), apk.version);

  const manifest = JSON.parse(await readFile('dist-firefox/manifest.json', 'utf8'));
  assert.equal(manifest.version, JSON.parse(await readFile('package.json', 'utf8')).version, 'Run npm run build:firefox first');
  assert.equal(manifest.browser_specific_settings.gecko.id, FIREFOX_GUID);
  assert.ok(manifest.browser_specific_settings.gecko_android, 'The package must declare Firefox for Android support');
  temp = await mkdtemp(join(tmpdir(), 'anmerko-android-'));
  execFileSync('zip', ['-qr', join(temp, 'anmerko.zip'), '.'], { cwd: 'dist-firefox' });
  addon = (await readFile(join(temp, 'anmerko.zip'))).toString('base64');

  const html = await readFile('tests/fixtures/demo/index.html');
  server = createServer((_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end(html); });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();
  // The device reaches the host fixture through its own loopback address.
  adb('reverse', `tcp:${port}`, `tcp:${port}`);
  origin = `http://127.0.0.1:${port}`;

  geckodriver = process.env.GECKODRIVER
    || binaryPaths(['--driver', 'geckodriver', '--output', 'json']).driverPath;
  output = resolve('artifacts', `android-firefox-${Date.now()}`);
  await mkdir(output, { recursive: true });
});

after(async () => {
  try { adb('reverse', '--remove-all'); } catch { /* the device may be gone */ }
  await new Promise(done => server ? server.close(done) : done());
  if (temp) await rm(temp, { recursive: true, force: true });
});

test('Firefox for Android opens the production panel from the browser action', { timeout: 120000 }, async t => {
  const options = new firefox.Options().enableMobile(firefoxPackage);
  Object.assign(options.get('moz:firefoxOptions'), {
    // geckodriver's device capability is androidDeviceSerial.
    androidDeviceSerial: serial,
    // Firefox for Android 153+ skips onboarding only for automation launches.
    androidIntentArguments: ['-a', 'android.intent.action.VIEW', '-d', 'about:blank', '--ez', 'automationtest', 'true'],
  });
  // System access lets chrome-context scripts reach GeckoView's extension
  // bridge. Only this disposable profile on a disposable device receives it.
  const service = new firefox.ServiceBuilder(geckodriver)
    .addArguments('--allow-system-access', '--android-storage', rooted ? 'internal' : 'auto');
  const driver = await new Builder().forBrowser('firefox').setFirefoxOptions(options).setFirefoxService(service).build();
  t.after(() => driver.quit());
  t.diagnostic(`Firefox for Android ${apk.version} (${apk.abi}, Gecko ${(await driver.getCapabilities()).get('browserVersion')})`);
  const screenshot = async label => {
    await writeFile(join(output, `${label}.png`), await driver.takeScreenshot(), 'base64');
    await writeFile(join(output, `${label}-device.png`), screencap());
  };

  try {
    await driver.manage().setTimeouts({ pageLoad: 30000, script: 15000 });
    driver.getExecutor().defineCommand('installAddon', 'POST', '/session/:sessionId/moz/addon/install');
    assert.equal(await driver.execute(new Command('installAddon').setParameter('addon', addon).setParameter('temporary', true)), FIREFOX_GUID);

    await driver.get(origin);
    const injected = () => driver.executeScript(host => !!document.querySelector(host), expectedHost);
    assert.equal(await injected(), false, 'nothing is injected before the user activates anmerko');

    // Firefox for Android's Extensions menu calls this GeckoView entry point,
    // which grants activeTab and dispatches action.onClicked for the open tab.
    await driver.setContext('chrome');
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
    await driver.setContext('content');
    assert.equal(error, null);

    await driver.wait(() => driver.executeScript(host => !!document.querySelector(host)?.shadowRoot.querySelector('.panel'), expectedHost),
      15000, `${expectedHost} opens after the browser action`);
    assert.match(await driver.executeScript(() => navigator.userAgent), /Android/);
    assert.equal(await driver.executeScript(host => !!document.querySelector(host).shadowRoot.querySelector('[aria-label="Dock sidebar"]'), expectedHost),
      false, 'docking stays unavailable on Android');
    await screenshot('panel');
  } catch (error) {
    await screenshot('failure').catch(() => {});
    throw error;
  }
});
