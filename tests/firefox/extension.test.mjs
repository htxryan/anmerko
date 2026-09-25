import { assertElementFeedback, assertFeedbackArchive } from '../shared/expected-feedback.ts';
import { desktopScenarios } from '../shared/desktop-scenarios.mjs';
import {
  componentContextFallbackScenarios,
  componentContextMixedScenarios,
  componentContextPositiveScenarios,
  componentFixtureUrl,
} from '../shared/component-context-scenarios.mjs';
import { startFixtureServer } from '../fixtures/component-context/server.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { readFile, readdir, mkdir, writeFile, mkdtemp, rm, cp, realpath } from 'node:fs/promises';
import { tmpdir, release, arch } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve, join, relative } from 'node:path';
import { Builder, By, until } from 'selenium-webdriver';
import { Command } from 'selenium-webdriver/lib/command.js';
import { Pointer } from 'selenium-webdriver/lib/input.js';
import firefox from 'selenium-webdriver/firefox.js';
import { artifactBytes } from '../../scripts/release/approved-release.mjs';
import { FIREFOX_GUID } from '../../scripts/release/release-names.mjs';

let server, origin, componentServer, componentOrigin, componentFixtureHealth;
before(async () => {
  const html = await readFile('tests/fixtures/demo/index.html');
  server = createServer((_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end(html); });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  origin = `http://127.0.0.1:${server.address().port}`;
  componentServer = await startFixtureServer();
  componentOrigin = componentServer.origin;
  componentFixtureHealth = await (await fetch(`${componentOrigin}/healthz`)).json();
  await mkdir('artifacts', { recursive: true });
});
after(async () => {
  const results = await Promise.allSettled([
    componentServer?.close(),
    new Promise((done, reject) => server.close(error => error ? reject(error) : done())),
  ]);
  const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
  if (errors.length) throw new AggregateError(errors, 'Firefox fixture teardown failed');
});

async function suspendBackground(driver, extensionId = FIREFOX_GUID) {
  await driver.setContext('chrome');
  try {
    // Exercise Firefox's real event-page idle shutdown in this disposable profile.
    // This does not reload the add-on or destroy the sidebar document.
    const state = await driver.executeAsyncScript((extensionId, done) => {
      const extension = WebExtensionPolicy.getByID(extensionId).extension;
      extension.terminateBackground({ disableResetIdleForTest: true }).then(() => done(extension.backgroundState), error => done(String(error)));
    }, extensionId);
    assert.equal(state, 'stopped');
  } finally { await driver.setContext('content'); }
}

async function session(t, run, remoteExtensions = false, signedXpi = process.env.FIREFOX_XPI) {
  const downloads = await mkdtemp(resolve(tmpdir(), 'anmerko-firefox-download-'));
  const profile = await mkdtemp(resolve(tmpdir(), 'anmerko-firefox-profile-'));
  let driver, evidence, output;
  const expectedHost = 'anmerko-overlay';
  const signedManifest = signedXpi
    ? JSON.parse(execFileSync('unzip', ['-p', resolve(signedXpi), 'manifest.json'], { encoding: 'utf8' }))
    : null;
  const extensionId = signedManifest?.browser_specific_settings?.gecko?.id || FIREFOX_GUID;
  assert.match(extensionId, /^\S+@\S+$/, 'Firefox package must declare a Gecko ID');
  const browserActionId = `${extensionId.replace(/[^a-zA-Z0-9_-]/g, '_')}-BAP`;
  t.after(async () => {
    let cleanupError;
    try { if (driver) await driver.quit(); } catch (error) { cleanupError = error; }
    for (const path of [downloads, profile]) {
      try { await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
      catch (error) { cleanupError ||= error; }
    }
    if (evidence) {
      evidence.teardown = cleanupError ? String(cleanupError) : 'passed';
      if (cleanupError) evidence.result = 'failed';
      await writeFile(join(output, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
    }
    if (cleanupError) throw cleanupError;
  });
  const options = new firefox.Options().setBrowserVersion(process.env.FIREFOX_VERSION || 'stable')
    .addArguments('-profile', profile)
    .setPreference('browser.download.folderList', 2).setPreference('browser.download.dir', downloads)
    .setPreference('browser.helperApps.neverAsk.saveToDisk', 'application/zip')
    .setPreference('dom.w3c_touch_events.enabled', 1)
    .setPreference('dom.events.testing.asyncClipboard', true)
    // Route the ordinary-HTTP regression host locally in this disposable profile.
    .setPreference('network.dns.localDomains', 'fixture.invalid')
    // Marionette cannot inspect remote sidebar documents. Same-process extension
    // mode enables interaction assertions; a separate smoke test keeps the default.
    .setPreference('extensions.webextensions.remote', remoteExtensions);
  if (process.env.FIREFOX_HEADLESS !== '0') options.addArguments('-headless');
  if (process.env.FIREFOX_BINARY) options.setBinary(process.env.FIREFOX_BINARY);
  // Privileged automation is restricted to this new, disposable test profile.
  // It clicks Firefox's real toolbar so activeTab is granted normally. The
  // installed extension is the production package, with no test-only permissions.
  const start = async () => {
    driver = await new Builder().forBrowser('firefox').setFirefoxOptions(options)
      .setFirefoxService(new firefox.ServiceBuilder().addArguments('--allow-system-access')).build();
    await driver.manage().setTimeouts({ pageLoad: 15000, script: 15000 });
    await driver.manage().window().setRect({ width: 1440, height: 1050 });
  };
  await start();
  const engine = (await driver.getCapabilities()).get('browserVersion');
  const requestedVersion = process.env.FIREFOX_VERSION || 'stable';
  if (/^\d/.test(requestedVersion)) assert.equal(engine, requestedVersion, 'Firefox must match the requested test version');
  t.diagnostic(`Firefox ${engine}`);
  // A provided Mozilla-signed XPI must pass a normal persistent installation.
  // Development builds use Firefox's temporary-addon mechanism instead.
  const extension = join(await realpath(downloads), 'extension');
  if (!signedXpi) await cp('dist-firefox', extension, { recursive: true });
  // Gecko 142 cannot load content scripts from the uploaded temporary archive
  // after the upload command returns. Keep the unchanged local files alive.
  driver.getExecutor().defineCommand('installLocalAddon', 'POST', '/session/:sessionId/moz/addon/install');
  assert.equal(await driver.execute(new Command('installLocalAddon')
    .setParameter('path', signedXpi ? resolve(signedXpi) : extension)
    .setParameter('temporary', !signedXpi)), extensionId);
  output = resolve('artifacts', `${signedXpi ? 'firefox-signed' : 'desktop-firefox'}-${process.platform}-${Date.now()}`);
  await mkdir(output, { recursive: true });
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const payload = {};
  if (!signedXpi) {
    const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
    assert.equal(manifest.name, 'anmerko');
    assert.equal(manifest.version, JSON.parse(await readFile('package.json', 'utf8')).version);
    // Only a build made with ANMERKO_JOURNEYS=1 adds the journey APIs.
    assert.deepEqual(manifest.permissions, ['activeTab', 'scripting', 'storage', 'clipboardWrite',
      ...(process.env.ANMERKO_JOURNEYS === '1' ? ['alarms', 'webNavigation'] : [])]);
    assert.equal(manifest.host_permissions, undefined);
    assert.equal(manifest.optional_permissions, undefined);
    assert.equal(manifest.optional_host_permissions, undefined);
    assert.equal(manifest.browser_specific_settings.gecko.id, FIREFOX_GUID);
    for (const file of (await readdir(extension, { recursive: true, withFileTypes: true })).filter(file => file.isFile())) {
      const path = join(file.parentPath, file.name);
      payload[relative(extension, path).replaceAll('\\', '/')] = hash(await readFile(path));
    }
    assert.ok(!Object.keys(payload).some(name => /dev-install|test-bootstrap/.test(name)));
  }
  await driver.setContext('chrome');
  const installed = await driver.executeScript(async extensionId => {
    const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
    const addon = await AddonManager.getAddonByID(extensionId);
    return { id: addon.id, version: addon.version, temporary: addon.temporarilyInstalled, signedState: addon.signedState,
      executable: Services.dirsvc.get('XREExeF', Ci.nsIFile).path };
  }, extensionId);
  await driver.setContext('content');
  assert.equal(installed.temporary, !signedXpi);
  if (signedXpi) assert.ok(installed.signedState > 0, 'A persistent candidate must be Mozilla-signed');
  evidence = {
    date: new Date().toISOString(), browser: 'firefox', engine, requestedVersion,
    os: process.platform, osRelease: release(), architecture: arch(), ...installed,
    sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    dirty: !!execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(),
    route: signedXpi ? 'normal signed XPI installation' : 'temporary unchanged production build; native extension menu',
    signedXpiSha256: signedXpi ? hash(await readFile(signedXpi)) : null, payload,
    headless: process.env.FIREFOX_HEADLESS !== '0', remoteExtensions,
    releaseChecklist: desktopScenarios, fullReleaseParity: 'unrun', scenario: t.name, result: 'failed',
    componentFixtures: {
      origin: componentOrigin,
      service: componentFixtureHealth.service,
      contractVersion: componentFixtureHealth.version,
      routes: componentServer.routes.map(({ id, framework, version, mode, path }) => ({ id, framework, version, mode, path })),
    },
    storeInstall: 'unrun', storeUpdate: 'unrun', manualToolbar: 'unrun',
  };
  const restart = async () => {
    assert.ok(signedXpi, 'Restart verification requires a persistent signed installation');
    await driver.quit(); driver = undefined;
    await start();
    await driver.get(origin);
    return driver;
  };
  await driver.get(origin);
  const ui = selector => driver.executeScript((selector, host) => document.querySelector(host)?.shadowRoot.querySelector(selector), selector, expectedHost);
  const click = async selector => (await ui(selector)).click();
  const value = async selector => (await ui(selector)).getAttribute('value');
  const copiedPrompt = async (native = false) => {
    if (native) await dockClick('.copy'); else await click('.copy');
    await driver.wait(async () => native
      ? /Copied/.test(await docked("return root.querySelector('.status').textContent"))
      : /Copied/.test(await (await ui('.status')).getText()), 5000);
    return driver.executeScript(() => navigator.clipboard.readText());
  };
  const count = () => driver.executeScript(host => document.querySelector(host)?.shadowRoot.querySelectorAll('.note').length ?? 0, expectedHost);
  const docked = async expression => {
    await driver.setContext('chrome');
    try {
      return await driver.executeScript((expression, host) => {
        const doc = document.getElementById('sidebar')?.contentDocument?.querySelector('browser')?.contentDocument;
        const root = doc?.querySelector(host)?.shadowRoot;
        return new Function('root', 'doc', expression)(root, doc);
      }, expression, expectedHost);
    } finally { await driver.setContext('content'); }
  };
  const dockClick = async selector => {
    await driver.setContext('chrome');
    try {
      let previous;
      // A restored Firefox sidebar can resize after its draft is available.
      // Wait for consecutive stable bounds before sending a native mouse click.
      const point = await driver.wait(async () => {
        const current = await driver.executeScript((selector, host) => {
          const outer = document.getElementById('sidebar');
          const inner = outer?.contentDocument?.querySelector('browser');
          const doc = inner?.contentDocument;
          const root = doc?.querySelector(host)?.shadowRoot;
          const target = root?.querySelector(selector);
          if (!target || target.disabled || inner.webProgress.isLoadingDocument) return null;
          const a = outer.getBoundingClientRect(), b = inner.getBoundingClientRect(), c = target.getBoundingClientRect();
          const x = c.x + c.width / 2, y = c.y + c.height / 2;
          if (!c.width || !c.height || !target.contains(root.elementFromPoint(x, y))) return null;
          return { x: Math.round(a.x + b.x + x), y: Math.round(a.y + b.y + y), width: c.width, height: c.height };
        }, selector, expectedHost);
        const stable = current && JSON.stringify(current) === JSON.stringify(previous);
        previous = current;
        return stable ? current : false;
      }, 5000, `native sidebar ${selector} should be enabled, unobstructed, and stable`);
      // The default 100ms move can outlive the coordinates just measured.
      await driver.actions().move({ x: point.x, y: point.y, duration: 0 }).click().perform();
    } finally { await driver.setContext('content'); }
  };
  const activateDock = async () => {
    await driver.setContext('chrome');
    await driver.findElement(By.id('unified-extensions-button')).click();
    const item = await driver.wait(until.elementLocated(By.id(browserActionId)), 5000);
    await item.click();
    await driver.setContext('content');
    await driver.wait(() => ui('.panel'), 5000, `${expectedHost} should connect from Firefox’s extension menu`);
    assert.equal(await driver.executeScript(host => !!document.querySelector(host), expectedHost), true);
  };
  const activate = async () => {
    await activateDock();
    await driver.wait(() => docked("return !!root?.querySelector('.dock')"), 5000);
    await dockClick('.dock');
    await driver.wait(async () => (await ui('.panel')).isDisplayed(), 5000);
  };
  const save = async text => {
    const field = await ui('#comment'); await field.clear();
    const current = await driver.wait(async () => {
      const candidate = await ui('#comment');
      return await candidate.getAttribute('value') === '' ? candidate : false;
    }, 5000, 'Comment field should rerender empty after clear');
    await current.sendKeys(text);
    await click('.save');
    await driver.wait(() => driver.executeScript((text, host) => {
      const root = document.querySelector(host)?.shadowRoot;
      return root && !root.querySelector('#comment')
        && [...root.querySelectorAll('.note .comment')].some(field => field.textContent === text.trim());
    }, text, expectedHost), 5000, 'Saving should render the committed comment after the editor closes');
  };
  const comment = async (selector, text) => {
    await click('.select'); await driver.findElement(By.css(selector)).click(); await save(text);
  };
  const tap = async element => {
    const point = await driver.executeScript(element => {
      const r = element.getBoundingClientRect();
      const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
      return { x, y, hitsTarget: element.contains(document.elementFromPoint(x, y)) };
    }, element);
    assert.ok(point.hitsTarget, 'the touch target is visible and unobstructed');
    const finger = new Pointer('finger', Pointer.Type.TOUCH);
    await driver.actions().insert(finger, finger.move({ x: point.x, y: point.y, duration: 0 }), finger.press())
      .pause(80, finger).insert(finger, finger.release()).perform();
    return point;
  };
  try {
    await run({ copiedPrompt, driver, ui, click, value, count, activate, activateDock, docked, dockClick, save, comment, tap, downloads, output, restart, evidence, extensionId, browserActionId });
    evidence.result = 'passed';
  }
  catch (error) {
    evidence.error = String(error);
    await writeFile(`artifacts/firefox-failure-${t.name.replace(/[^a-z0-9]/gi, '-')}.png`, await driver.takeScreenshot(), 'base64');
    t.diagnostic(`Failure status: ${await (await ui('.status'))?.getText().catch(() => '')}`);
    await driver.setContext('chrome');
    evidence.console = await driver.executeScript(() => Services.console.getMessageArray()
      .map(message => message.message).filter(message => /anmerko|moz-extension|content\.js/i.test(message)));
    await writeFile(join(output, 'failure-native.png'), await driver.takeScreenshot(), 'base64');
    t.diagnostic(JSON.stringify(evidence.console));
    await driver.setContext('content');
    throw error;
  }
}

test('Firefox captures regions from the native sidebar and touch input, and downloads local Markdown and PNG files', { timeout: 90000 }, async t => session(t, async ({ copiedPrompt, driver, ui, click, count, activateDock, docked, dockClick, save, downloads, output }) => {
  await driver.executeScript(() => {
    const meta = document.createElement('meta'); meta.httpEquiv = 'Content-Security-Policy'; meta.content = "img-src 'none'"; document.head.append(meta);
    const swatch = document.createElement('div');
    swatch.style.cssText = 'position:fixed;left:100px;top:100px;width:220px;height:140px;background:rgb(11,132,77);z-index:10'; document.body.append(swatch);
  });
  await activateDock();
  await driver.wait(() => docked("return !!root?.querySelector('.capture') && !root.querySelector('.capture').disabled"), 5000);
  await dockClick('.capture');
  await driver.wait(() => ui('.capture-layer'), 5000);
  await driver.actions().move({ x: 110, y: 110 }).press().move({ x: 290, y: 210, duration: 200 }).release().perform();
  await click('.capture-use');
  await driver.wait(() => ui('#comment'), 5000);
  await save('Firefox native screenshot');
  await driver.wait(() => docked("return root.querySelectorAll('.note').length === 1"), 5000);
  await writeFile('artifacts/anmerko-firefox-screenshot-docked.png', await driver.takeScreenshot(), 'base64');

  const markdown = await copiedPrompt(true);
  const base64 = await docked("return root.querySelector('.screenshot-preview').openOrClosedShadowRoot.querySelector('img').src.split(',')[1]");
  await dockClick('.download');
  const zip = resolve(downloads, 'anmerko-comments.zip');
  // Windows exposes the final name before Firefox finishes writing the file.
  // Wait for the ZIP end record, then retain the full independent CRC/byte checks.
  const archive = await driver.wait(async () => {
    const bytes = await readFile(zip).catch(() => null);
    return bytes?.length >= 22 && bytes.readUInt32LE(bytes.length - 22) === 0x06054b50 ? bytes : false;
  }, 5000, 'Firefox finishes downloading the archive');
  assertFeedbackArchive(archive, markdown, Buffer.from(base64, 'base64'));
  await writeFile(join(output, 'feedback.zip'), archive);
  await writeFile(join(output, 'prompt.md'), markdown);
  assert.match(markdown, /Firefox native screenshot/);
  assert.match(markdown, /x 110, y 110, width 180, height 100/);
  const result = await driver.executeScript(async base64 => {
    const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
    const image = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
    return { width: image.width, height: image.height, pixel: Array.from(ctx.getImageData(10,10,1,1).data) };
  }, base64);
  assert.deepEqual(result.pixel, [11, 132, 77, 255]);
  const dpr = await driver.executeScript(() => devicePixelRatio);
  assert.equal(result.width, Math.round(180 * dpr));
  assert.equal(result.height, Math.round(100 * dpr));

  await dockClick('.dock');
  await driver.wait(async () => (await ui('.panel')).isDisplayed(), 5000);
  await driver.manage().window().setRect({ width: 450, height: 920 });
  await click('.capture'); await driver.wait(() => ui('.capture-layer'), 5000);
  const finger = new Pointer('capture-finger', Pointer.Type.TOUCH);
  await driver.actions().insert(finger, finger.move({ x: 50, y: 110, duration: 0 }), finger.press(), finger.move({ x: 320, y: 300, duration: 200 }), finger.release()).perform();
  await writeFile('artifacts/anmerko-firefox-region-touch.png', await driver.takeScreenshot(), 'base64');
  await click('.capture-use'); await save('Firefox touch screenshot');
  await driver.wait(async () => await count() === 2, 5000);
  await driver.navigate().refresh(); await activateDock();
  await driver.wait(() => docked("return root?.querySelectorAll('.note').length === 2"), 5000);
}));

test('Firefox toolbar activation, parent selection, persistence, prompt export, editing and deletion', { timeout: 90000 }, async t => session(t, async ({ copiedPrompt, driver, ui, click, value, count, activate, save, comment }) => {
  await activate();
  await click('.select'); await driver.findElement(By.css('#hero-title em')).click();
  await (await ui('#comment')).sendKeys('Feedback on the entire headline.');
  await click('.parent');
  assert.match(await (await ui('.editor .selector')).getText(), /h1$/);
  assert.equal(await value('#comment'), 'Feedback on the entire headline.');
  await click('.save'); await driver.wait(async () => await count() === 1, 5000);
  await comment('#primary-cta', 'Explain the next step.');
  assert.equal(await driver.getCurrentUrl(), origin + '/');
  await driver.navigate().refresh(); await activate();
  await driver.wait(async () => await count() === 2, 5000);

  const prompt = await copiedPrompt();
  assert.match(prompt, /2 comments across 1 page/); assert.match(prompt, /#hero-title/); assert.match(prompt, /#primary-cta/);
  assert.match(prompt, /## Page 1\n/); assert.match(prompt, /### Comment 1\n\n> /);
  assertElementFeedback(prompt, '#hero-title');
  await writeFile('artifacts/firefox-example-prompt.md', prompt);
  await click('.settings-button');
  await driver.wait(async () => (await ui('#preamble')).isEnabled(), 5000);
  await (await ui('#preamble')).clear(); await (await ui('#preamble')).sendKeys('Apply these changes and report the results.');
  await click('.save-preamble');
  await driver.wait(async () => /Preamble saved/.test(await (await ui('.preamble-status')).getText()), 5000);
  await click('.settings-back');
  assert.match(await copiedPrompt(), /Apply these changes and report the results\./);
  assert.doesNotMatch(await copiedPrompt(), /Review the comments below and propose/);
  await driver.navigate().refresh(); await activate();
  assert.match(await copiedPrompt(), /Apply these changes and report the results\./);
  await click('.copy');
  await driver.wait(async () => /Copied 2/.test(await (await ui('.status')).getText()), 5000);
  await click('.note .edit'); await save('Revised Firefox feedback.');
  assert.match(await (await ui('.note .comment')).getText(), /Revised Firefox feedback/);
  await writeFile('artifacts/anmerko-firefox-desktop.png', await driver.takeScreenshot(), 'base64');
  await click('.note .delete');
  await click('.delete-dialog [value=delete]'); await driver.wait(async () => await count() === 1, 5000);
}));

test('Firefox touch selection and narrow editor preserve drafts without activating the page link', { timeout: 90000 }, async t => session(t, async ({ copiedPrompt, driver, ui, click, value, count, activate, save, tap, evidence }) => {
  await driver.manage().window().setRect({ width: 450, height: 920 });
  await driver.executeScript(() => {
    window.testPointerEvents = [];
    for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'click']) {
      window.addEventListener(type, event => window.testPointerEvents.push({
        type, pointerType: event.pointerType, x: event.clientX, y: event.clientY,
        target: event.target.id || event.target.tagName,
      }), { capture: true });
    }
  });
  await activate(); await click('.select');
  const link = await driver.findElement(By.id('primary-cta'));
  await driver.executeScript(el => el.scrollIntoView({ block: 'center' }), link);
  evidence.touchTarget = await tap(link);
  evidence.touchEvents = await driver.executeScript(() => window.testPointerEvents);
  assert.ok(evidence.touchEvents.some(event => event.pointerType === 'touch'));
  assert.equal(await driver.getCurrentUrl(), origin + '/');
  await driver.wait(() => ui('#comment'), 5000, 'touching the link opens the comment editor');
  await (await ui('#comment')).sendKeys('Phone review draft.');
  await click('.minimize'); await driver.wait(async () => !(await (await ui('.panel')).isDisplayed()), 5000);
  await activate(); assert.equal(await (await ui('.panel')).isDisplayed(), true);
  assert.equal(await value('#comment'), 'Phone review draft.');
  await click('.minimize');
  await driver.wait(async () => (await ui('.resume')).isDisplayed(), 5000);
  await (await ui('.resume')).click(); assert.equal(await value('#comment'), 'Phone review draft.');
  await driver.manage().window().setRect({ width: 450, height: 530 });
  // The native resize returns before visualViewport's resize event on Firefox 142.
  await driver.wait(() => driver.executeScript(() => {
    const r = document.querySelector('anmerko-overlay').shadowRoot.querySelector('.panel').getBoundingClientRect();
    return r.top >= 0 && r.bottom <= innerHeight;
  }), 5000, 'the narrow editor fits after the viewport resize');
  await save('Phone review saved in Firefox.');
  assert.equal(await count(), 1);
  await driver.manage().window().setRect({ width: 450, height: 920 });
  await writeFile('artifacts/anmerko-firefox-mobile-layout.png', await driver.takeScreenshot(), 'base64');
  assert.match(await copiedPrompt(), /#primary-cta/);
  await click('.settings-button');
  await (await ui('#preamble')).clear(); await (await ui('#preamble')).sendKeys('Give a short mobile review.');
  await click('.save-preamble');
  await driver.wait(async () => /Preamble saved/.test(await (await ui('.preamble-status')).getText()), 5000);
  await writeFile('artifacts/anmerko-firefox-preamble-settings.png', await driver.takeScreenshot(), 'base64');
  await click('.reset-preamble');
  await driver.wait(async () => /Default restored/.test(await (await ui('.preamble-status')).getText()), 5000);
  await click('.settings-back');
  assert.match(await copiedPrompt(), /Comments collected with anmerko/);
}));

test('Firefox captures shadow elements, excludes form values, and retains comments after SPA navigation', { timeout: 90000 }, async t => session(t, async ({ copiedPrompt, driver, ui, click, count, activate, save, comment }) => {
  await activate(); await click('.select');
  const shadowButton = await driver.executeScript(() => document.querySelector('#shadow-demo').shadowRoot.querySelector('button'));
  await shadowButton.click(); await save('Review the shadow button.');
  await comment('#sample-form', 'Review this form.');

  const prompt = await copiedPrompt();
  assert.match(prompt, /#shadow-demo/); assert.doesNotMatch(prompt, /do-not-export-password|do-not-export-form-draft/);
  await driver.executeScript(() => history.pushState({}, '', '/another-page'));
  await driver.wait(async () => await count() === 0, 5000);
  const scope = await ui('select');
  await scope.sendKeys('All pages');
  await scope.sendKeys('\uE007');
  await driver.wait(async () => await count() === 2, 5000);
  assert.match(await copiedPrompt(), new RegExp(origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}));

test('Firefox creates and renders element and global comments on ordinary HTTP', { timeout: 90000 }, async t => session(t, async ({ driver, ui, click, count, activate, comment, save }) => {
  await driver.get(origin.replace('127.0.0.1', 'fixture.invalid'));
  assert.deepEqual(await driver.executeScript(() => ({ secure: isSecureContext, uuid: typeof crypto.randomUUID })), { secure: false, uuid: 'undefined' });
  await activate();
  await comment('#hero-title', 'Ordinary HTTP element feedback');
  await click('.global-comment');
  await driver.wait(() => ui('#comment'), 5000, 'HTTP global action opens its editor');
  await save('Ordinary HTTP global feedback');
  await driver.wait(async () => await count() === 2, 5000);
  await driver.navigate().refresh(); await activate();
  await driver.wait(async () => await count() === 2, 5000, 'saved HTTP cards render after reload');
}));

test('Firefox shows a helpful explanation when activation targets a protected page', { timeout: 90000 }, async t => session(t, async ({ driver, browserActionId }) => {
  await driver.get('about:blank'); await driver.setContext('chrome');
  await driver.findElement(By.id('unified-extensions-button')).click();
  await driver.findElement(By.id(browserActionId)).click();
  await driver.setContext('content');
  await driver.wait(async () => (await driver.getAllWindowHandles()).length === 2, 5000);
  await driver.switchTo().window((await driver.getAllWindowHandles()).at(-1));
  await driver.setContext('content');
  await driver.wait(until.titleIs('anmerko — Unsupported page'), 5000);
  assert.match(await driver.findElement(By.css('h1')).getText(), /Page not supported/);
}));


test('Firefox native sidebar resizes the page and retains a draft when floated and minimized', { timeout: 90000 }, async t => session(t, async ({ driver, ui, click, value, activateDock, docked, dockClick }) => {
  const width = await driver.executeScript(() => innerWidth);
  await activateDock();
  await driver.wait(async () => await driver.executeScript(() => innerWidth) < width - 150, 5000, 'docking reduces width');
  await driver.wait(() => docked("return !!root?.querySelector('.select')"), 5000);
  assert.equal(await docked("const brand = root.querySelector('.brand').getBoundingClientRect(), settings = root.querySelector('.settings-button').getBoundingClientRect(), close = root.querySelector('.close').getBoundingClientRect(); return settings.left >= brand.right && close.right <= doc.defaultView.innerWidth;"), true, 'header controls fit the narrow native sidebar without overlapping the brand');
  await dockClick('.select');
  assert.equal(await docked("return !root.querySelector('.panel').hidden"), true);
  await driver.findElement(By.id('hero-title')).click();
  await driver.wait(() => ui('#comment'), 5000);
  await dockClick('.edit-in-sidebar');
  await driver.wait(() => docked("return !!root.querySelector('#comment')"), 5000);
  await docked("const field = root.querySelector('#comment'); field.value = 'Firefox dock draft'; field.dispatchEvent(new doc.defaultView.Event('input', {bubbles:true}));");
  await dockClick('.settings-button');
  await dockClick('.theme-option[data-theme="dark"]');
  await driver.wait(() => docked("return doc.defaultView.getComputedStyle(root.querySelector('.panel')).backgroundColor === 'rgb(21, 28, 41)'"), 5000);
  await dockClick('.dock');
  await driver.wait(async () => await driver.executeScript(() => innerWidth) === width, 5000, 'floating restores width');
  assert.equal(await (await ui('.settings')).isDisplayed(), true);
  assert.equal(await (await ui('.panel')).getCssValue('background-color'), 'rgb(21, 28, 41)');
  await click('.settings-back');
  assert.equal(await value('#comment'), 'Firefox dock draft');
  // Firefox requires an extension UI user gesture, so re-dock from its toolbar.
  await click('.dock');
  assert.match(await (await ui('.status')).getText(), /Firefox’s toolbar/);
  await activateDock();
  await driver.wait(async () => await driver.executeScript(() => innerWidth) < width - 150, 5000, 'docking reduces width');
  await driver.wait(() => docked("return root?.querySelector('#comment')?.value === 'Firefox dock draft'"), 5000);
  await dockClick('.minimize');
  await driver.wait(async () => (await ui('.resume')).isDisplayed(), 5000);
  await click('.resume');
  assert.equal(await value('#comment'), 'Firefox dock draft');
  await activateDock();
  await driver.wait(() => docked("return root?.querySelector('#comment')?.value === 'Firefox dock draft'"), 5000);
  // Reproduce delayed sidebar layout: the draft exists before Save stops moving.
  await docked("root.querySelector('.editor').animate([{transform:'translateY(-120px)'},{transform:'none'}], {duration:400});");
  await dockClick('.save');
  await driver.wait(() => docked("return root.querySelectorAll('.note').length === 1"), 5000, 'final restored draft Save creates one comment');
  await driver.setContext('chrome');
  await writeFile('artifacts/firefox-native-browser.png', await driver.takeScreenshot(), 'base64');
  await driver.setContext('content');
}));

test('Firefox default process isolation opens a native sidebar with the unchanged package', { timeout: 90000 }, async t => session(t, async ({ driver, ui, activateDock }) => {
  const width = await driver.executeScript(() => innerWidth);
  await activateDock();
  await driver.wait(async () => await driver.executeScript(() => innerWidth) < width - 150, 5000, 'docking reduces width');
  // Firefox can resize the page before the remote sidebar handshake hides its
  // temporary page panel. Assert the completed handoff rather than its first frame.
  await driver.wait(async () => !(await (await ui('.panel')).isDisplayed()), 5000, 'native sidebar handoff hides the page panel');
  await driver.setContext('chrome');
  // Page injection and viewport resizing can finish before Firefox has loaded
  // the remote extension document. Wait for that document before testing its
  // close lifecycle; otherwise the test can destroy a still-loading sidebar.
  await driver.wait(() => driver.executeScript(() => {
    const browser = document.getElementById('sidebar').contentDocument.querySelector('browser');
    return browser?.currentURI?.spec.endsWith('/sidebar.html') && !browser.webProgress.isLoadingDocument;
  }), 5000, 'remote sidebar document finishes loading');
  assert.equal(await driver.executeScript(() => document.getElementById('sidebar').contentDocument.querySelector('browser').getAttribute('remote')), 'true');
  await driver.executeScript(() => SidebarController.hide());
  await driver.setContext('content');
  await driver.wait(async () => (await ui('.resume')).isDisplayed(), 5000, 'closing the loaded remote sidebar restores the resume button');
}, true));

test('Firefox reconnects its sidebar after idle background shutdown and a protected tab', { timeout: 90000 }, async t => session(t, async ({ driver, ui, activate, comment, activateDock, docked }) => {
  const savedComment = 'Keep this comment through an idle background restart.';
  // Connection guidance can clear before the sidebar's independent storage read finishes.
  const waitForSavedComment = () => driver.wait(() => docked(`
    const notes = root?.querySelectorAll('.note');
    return notes?.length === 1 && notes[0].querySelector('.comment')?.textContent === ${JSON.stringify(savedComment)};
  `), 5000, 'reconnected sidebar renders the saved comment');
  await activate();
  await comment('#hero-title', savedComment);
  await activateDock();
  await driver.wait(() => docked("return root?.querySelector('.connection-prompt')?.hidden === true"), 5000);
  await waitForSavedComment();
  const normal = await driver.getWindowHandle();
  await suspendBackground(driver);
  await activateDock();
  await driver.wait(() => docked("return root?.querySelector('.connection-prompt')?.hidden === true"), 5000, 'toolbar reconnects after idle shutdown without a tab change');
  await waitForSavedComment();
  assert.equal(await docked("return root.querySelectorAll('.note').length"), 1);
  await suspendBackground(driver);
  await driver.switchTo().newWindow('tab');
  await driver.get('about:preferences');
  await driver.wait(() => docked("return root?.querySelector('.connection-prompt')?.hidden === false"), 5000, 'protected tab shows connection guidance');
  await driver.switchTo().window(normal);
  await activateDock();
  await driver.wait(() => docked("return root?.querySelector('.connection-prompt')?.hidden === true"), 5000, 'toolbar reconnects after protected tab');
  await waitForSavedComment();
  assert.equal(await docked("return root.querySelectorAll('.note').length"), 1);
  assert.equal(await docked("return root.querySelector('.select').disabled"), false);
  assert.equal(await (await ui('.panel')).isDisplayed(), false);
}));

test('Firefox default process isolation reconnects after a protected tab and fresh toolbar activation', { timeout: 90000 }, async t => session(t, async ({ driver, ui, activateDock }) => {
  await activateDock();
  await driver.wait(async () => !(await (await ui('.panel')).isDisplayed()), 5000, 'initial remote sidebar handoff completes');
  const normal = await driver.getWindowHandle();
  await suspendBackground(driver);
  await driver.switchTo().newWindow('tab');
  await driver.get('about:preferences');
  await new Promise(done => setTimeout(done, 500));
  await driver.switchTo().window(normal);
  await activateDock();
  await driver.wait(async () => !(await (await ui('.panel')).isDisplayed()), 5000, 'toolbar reconnects remote sidebar after protected tab');
  await driver.wait(async () => !(await (await ui('.resume')).isDisplayed()), 5000, 'reconnected page has no sidebar-closed resume button');
  await driver.navigate().refresh();
  await activateDock();
  await driver.wait(async () => !(await (await ui('.panel')).isDisplayed()), 5000, 'reload and toolbar reconnect after protected tab');
}, true));

test('Firefox default process isolation reconnects an open sidebar after page reload and a fresh toolbar activation', { timeout: 90000 }, async t => session(t, async ({ driver, ui, activateDock }) => {
  await activateDock();
  await driver.wait(async () => !(await (await ui('.panel')).isDisplayed()), 5000, 'initial remote sidebar handoff completes');
  await driver.navigate().refresh();
  await driver.wait(async () => !(await ui('.panel')), 5000, 'reload removes the previous injected page controller');
  await activateDock();
  await driver.wait(async () => !(await (await ui('.panel')).isDisplayed()), 5000, 'fresh toolbar activation reconnects the existing remote sidebar');
}, true));

// Journeys ship behind ANMERKO_JOURNEYS=1; signed packages and default builds skip.
const journeysBuilt = (() => {
  try { return /\bjourneysEnabled = true\b/.test(readFileSync('dist-firefox/background.js', 'utf8')); }
  catch { return false; }
})();
const journeySkip = process.env.FIREFOX_XPI ? 'journeys are not in signed packages'
  : !journeysBuilt && 'build dist-firefox with ANMERKO_JOURNEYS=1 to run journey tests';

test('Firefox ends a journey on a same-origin reload with page-access-lost and explains it in review', { timeout: 90000, skip: journeySkip }, async t => session(t, async ({ driver, activateDock, docked, dockClick }) => {
  const journey = () => docked("return root?.querySelector('.journey-container')?.innerText ?? ''");
  await activateDock();
  await dockClick('.comment-options');
  await dockClick('.journey-record');
  await driver.wait(async () => /Record a journey/.test(await journey()), 5000, 'the sidebar opens the journey launch view');
  await dockClick('.journey-container .journey-primary');
  await driver.wait(async () => /Recording journey/.test(await journey()), 20000, 'recording starts after the initial screenshot');
  // Firefox ties activeTab to the document: the reload keeps the origin but withdraws access.
  await driver.navigate().refresh();
  await driver.wait(async () => /Review journey/.test(await journey()), 15000, 'the reload ends recording in review');
  const review = await docked(`
    const container = root.querySelector('.journey-container');
    const notice = container.querySelector('.journey-stop-reason');
    return {
      notice: notice?.textContent, styled: notice?.classList.contains('journey-notice'),
      announced: container.querySelector('.journey-live [aria-live="polite"]')?.textContent,
      steps: [...container.querySelectorAll('.journey-steps > li')].map(step => ({
        heading: step.querySelector('h2')?.textContent, text: step.innerText,
      })),
    };
  `);
  assert.equal(review.styled, true);
  assert.equal(review.announced, review.notice, 'the stop reason is announced once through the persistent live region');
  assert.match(review.notice, /^Recording ended because the browser withdrew anmerko's access when the page reloaded or opened another page\. Firefox does this on every page load/);
  assert.deepEqual(review.steps.map(step => step.heading), ['Step 1 · Initial view', 'Step 2 · Navigation']);
  assert.match(review.steps[1].text, new RegExp(`Destination URL\\s+${origin.replace(/[.]/g, '\\.')}/`));
  assert.match(review.steps[1].text, /Screenshot unavailable: screenshot permission was denied\./);
}));

test('Firefox production extension covers the shared component-context fixture matrix', { timeout: 180000 }, async t => session(t, async ({
  copiedPrompt, driver, ui, click, activate, activateDock, docked, dockClick, save, evidence, extensionId,
}) => {
  const matrix = [
    ...componentContextPositiveScenarios,
    ...componentContextFallbackScenarios,
    ...componentContextMixedScenarios,
  ];
  const first = componentContextPositiveScenarios[0];
  const fixtureReady = mixed => driver.wait(() => driver.executeScript(isMixed => isMixed
    ? globalThis.__ANMERKO_FIXTURE__?.ready === true
    : globalThis.__ANMERKO_FIXTURE__?.ready === true
      || globalThis.__BRIEFMARK_ANGULAR_FIXTURE__?.ready === true, mixed), 10000, 'component fixture becomes ready');
  const openScenario = async scenario => {
    const url = componentFixtureUrl(componentOrigin, scenario);
    const response = await fetch(url);
    assert.match(response.headers.get('content-security-policy'), /connect-src 'none'/);
    await response.body?.cancel();
    await driver.get(url);
    await fixtureReady(scenario.route.startsWith('/mixed/'));
    const metadata = await driver.executeScript(() => {
      const fixture = globalThis.__ANMERKO_FIXTURE__;
      const angular = globalThis.__BRIEFMARK_ANGULAR_FIXTURE__;
      return fixture ? { framework: fixture.framework, version: fixture.version, mode: fixture.mode }
        : { framework: angular.framework, version: angular.runtime.angularVersion, mode: angular.runtime.buildMode };
    });
    assert.equal(metadata.version, scenario.version);
  };
  const componentTarget = scenario => driver.executeScript(selectors => {
    let root = document;
    let element;
    for (const selector of selectors) {
      element = root.querySelector(selector);
      if (!element) return null;
      root = element.shadowRoot;
    }
    return element;
  }, scenario.target.selectorPath);
  const selectScenario = async scenario => {
    await click('.select');
    const target = await componentTarget(scenario);
    assert.ok(target, `fixture target should exist: ${scenario.id}`);
    if (scenario.target.dispatchTarget || scenario.target.clickPosition) {
      await driver.executeScript(element => element.dispatchEvent(new MouseEvent('click', {
        bubbles: true, cancelable: true, composed: true,
      })), target);
    } else {
      await target.click();
    }
    await driver.wait(() => ui('#comment'), 5000, `selection opens an editor: ${scenario.id}`);
  };
  const contextPath = async () => {
    const row = await ui('.component-context-path');
    return row ? row.getText() : null;
  };
  const readyComponentPreference = expected => driver.wait(async () => {
    const toggle = await ui('.component-context-toggle');
    if (!toggle || !(await toggle.isEnabled())) return false;
    return await toggle.getAttribute('aria-checked') === expected ? toggle : false;
  }, 5000, `component setting becomes enabled and ${expected === 'true' ? 'on' : 'off'}`);
  const privacyReads = () => driver.executeScript(() => {
    const angular = globalThis.__BRIEFMARK_ANGULAR_FIXTURE__;
    return globalThis.__ANMERKO_FIXTURE__?.privacyReads || angular?.sentinels.reads;
  });

  await openScenario(first);
  await activate();
  await click('.settings-button');
  const preference = await readyComponentPreference('false');
  assert.equal(await preference.getAttribute('aria-checked'), 'false');
  await click('.settings-back');
  await selectScenario(first);
  assert.equal(await contextPath(), null);
  assert.ok(Object.values(await privacyReads()).every(value => value === 0));
  await click('.cancel');
  await click('.settings-button');
  await readyComponentPreference('false');
  await click('.component-context-toggle');
  const enabledPreference = await readyComponentPreference('true');
  assert.equal(await enabledPreference.getAttribute('aria-checked'), 'true');
  await click('.settings-back');

  const outcomes = [];
  for (const scenario of matrix) {
    await openScenario(scenario);
    await activate();
    const persistedPreference = await readyComponentPreference('true');
    assert.equal(await persistedPreference.getAttribute('aria-checked'), 'true');
    await selectScenario(scenario);
    if (scenario.expectedPath) {
      await driver.wait(async () => await contextPath() === scenario.expectedPath.join(' → '), 5000,
        `component path should match for ${scenario.id}`);
    } else {
      // Keep the draft open beyond the broker's 750 ms deadline so a wrong
      // late result cannot pass an early absence assertion.
      await driver.sleep(850);
      assert.equal(await contextPath(), null, `ambiguous or unsupported metadata should fall back: ${scenario.id}`);
    }
    if (scenario.privacy) assert.ok(Object.values(await privacyReads()).every(value => value === 0));
    await click('.cancel');
    outcomes.push({ id: scenario.id, framework: scenario.framework, version: scenario.version,
      outcome: scenario.expectedPath ? 'hint' : 'fallback' });
  }

  await openScenario(first);
  await activate();
  await selectScenario(first);
  await driver.wait(async () => await contextPath() === first.expectedPath.join(' → '), 5000);
  await activateDock();
  await driver.wait(async () => await docked("return root.querySelector('.component-context-path')?.textContent")
    === first.expectedPath.join(' → '), 5000, 'native sidebar retains the component hint');
  await dockClick('.dock');
  await driver.wait(async () => (await ui('.panel')).isDisplayed(), 5000);
  await click('.parent');
  assert.equal(await contextPath(), first.expectedPath.slice(0, -1).join(' → '));
  await click('.cancel');
  await selectScenario(first);
  await save('Keep the Firefox component snapshot.');
  await driver.wait(async () => (await ui('.note .component-context-path'))?.getText()
    .then(text => text === first.expectedPath.join(' → ')), 5000, 'saved card retains the component hint');
  const prompt = await copiedPrompt();
  assert.match(prompt, /React · development metadata/);
  assert.match(prompt, /`App` → `PricingPage` → `PlanCard` → `FeedbackButton`/);
  await suspendBackground(driver, extensionId);
  await activate();
  await driver.wait(async () => (await ui('.note .component-context-path'))?.getText()
    .then(text => text === first.expectedPath.join(' → ')), 5000, 'saved component hint survives background restart');
  await driver.navigate().refresh();
  await fixtureReady(false);
  await activate();
  await driver.wait(async () => (await ui('.note .component-context-path'))?.getText()
    .then(text => text === first.expectedPath.join(' → ')), 5000, 'saved component hint survives page reload');
  await click('.note .edit');
  await click('.remove-component-context');
  await click('.cancel');
  assert.equal(await (await ui('.note .component-context-path')).getText(), first.expectedPath.join(' → '));
  await click('.note .edit');
  await click('.remove-component-context');
  await click('.save');
  assert.equal(await ui('.note .component-context'), null);
  evidence.componentContextMatrix = outcomes;
  evidence.componentContextLifecycle = 'default off, opt-in, native/overlay, parent, saved snapshot, export, background restart, reload and removal passed';
}));

test('Firefox current approved signed package preserves data across restart and same-identity signed update', { timeout: 90000 }, async t => {
  const approved = JSON.parse(await readFile('releases/approved.json', 'utf8'));
  const artifact = approved.browsers.firefox.artifact;
  const baseline = resolve('artifacts', artifact.filename);
  await writeFile(baseline, await artifactBytes(artifact));
  const updateProofRequested = process.env.FIREFOX_UPDATE_PROOF === '1';
  if (updateProofRequested) assert.ok(process.env.FIREFOX_XPI, 'FIREFOX_UPDATE_PROOF requires FIREFOX_XPI');
  return session(t, async ({ copiedPrompt, driver, ui, click, count, activate, comment, restart, evidence, extensionId }) => {
  await activate();
  await comment('#hero-title', 'Keep this feedback through Firefox updates.');
  await click('.settings-button');
  await click('.theme-option[data-theme="dark"]');
  await (await ui('#preamble')).clear();
  await (await ui('#preamble')).sendKeys('Preserve the signed Firefox review.');
  await click('.save-preamble');
  await driver.wait(async () => /Preamble saved/.test(await (await ui('.preamble-status')).getText()), 5000);
  const verifyBaseline = async () => {
    await activate();
    await driver.wait(async () => await count() === 1, 5000, 'signed baseline restores its comment');
    assert.match(await (await ui('.note .comment')).getText(), /Keep this feedback through Firefox updates/);
    assert.equal(await (await ui('.panel')).getCssValue('background-color'), 'rgb(21, 28, 41)');

    assert.match(await copiedPrompt(), /Preserve the signed Firefox review/);
  };
  driver = await restart();
  await verifyBaseline();
  evidence.browserRestart = 'passed; current approved signed package, no reinstallation';
  evidence.signedUpdate = 'unrun; set FIREFOX_UPDATE_PROOF=1 and supply FIREFOX_XPI with a newer same-identity signed release';
  if (process.env.FIREFOX_XPI) {
    const updateManifest = JSON.parse(execFileSync('unzip', ['-p', resolve(process.env.FIREFOX_XPI), 'manifest.json'], { encoding: 'utf8' }));
    assert.equal(updateManifest.browser_specific_settings?.gecko?.id, extensionId,
      'Signed update proof requires the same Firefox identity as the approved package');
    assert.equal(await driver.installAddon(resolve(process.env.FIREFOX_XPI), false), evidence.id);
    await driver.setContext('chrome');
    const updated = await driver.executeScript(async extensionId => {
      const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
      const addon = await AddonManager.getAddonByID(extensionId);
      return { version: addon.version, signedState: addon.signedState, temporary: addon.temporarilyInstalled };
    }, extensionId);
    assert.equal(updated.version, updateManifest.version);
    assert.notEqual(updated.version, evidence.version, 'An update must use a different signed version');
    assert.ok(updated.signedState > 0 && !updated.temporary);
    driver = await restart();
    await driver.navigate().refresh();
    await verifyBaseline();
    evidence.signedUpdate = { result: 'passed; same-identity signed update preserves data', ...updated,
      sha256: createHash('sha256').update(await readFile(process.env.FIREFOX_XPI)).digest('hex') };
  }
  }, false, baseline);
});
