import { copyPrompt } from '../shared/clipboard.ts';
import { assertElementFeedback, assertFeedbackArchive } from '../shared/expected-feedback.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createDesktopSession } from '../shared/desktop-session.mjs';
import { sidebar } from '../shared/chromium-sidebar.ts';
import {
  componentContextFallbackScenarios,
  componentContextMixedScenarios,
  componentContextPositiveScenarios,
  componentFixtureUrl,
} from '../shared/component-context-scenarios.mjs';

const extensionPanel = page => page.getByRole('complementary', { name: 'anmerko feedback panel' });

function componentTarget(page, scenario) {
  let locator = page.locator(scenario.target.selectorPath[0]);
  for (const selector of scenario.target.selectorPath.slice(1)) locator = locator.locator(selector);
  return locator;
}

async function waitForComponentFixture(page) {
  await page.waitForFunction(() => globalThis.__ANMERKO_FIXTURE__?.ready === true
    || globalThis.__BRIEFMARK_ANGULAR_FIXTURE__?.ready === true);
}

async function fixturePrivacyReads(page) {
  return page.evaluate(() => globalThis.__BRIEFMARK_ANGULAR_FIXTURE__?.sentinels.reads
    || globalThis.__ANMERKO_FIXTURE__?.privacyReads);
}

test('production permissions deny injection before activation and explain protected pages', { timeout: 60000 }, async t => {
  const session = await createDesktopSession({ scenario: 'activation' });
  t.after(() => session.close());
  const worker = session.context.serviceWorkers().find(worker => worker.url().endsWith('/background.js'))
    || await session.context.waitForEvent('serviceworker');
  const denied = await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    try { await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }); return false; }
    catch { return true; }
  });
  assert.equal(denied, true);
  await expect(session.page.locator('anmerko-overlay')).toHaveCount(0);
  await session.page.goto('chrome://extensions/');
  const opening = session.context.waitForEvent('page');
  await session.activate();
  const unavailable = await opening;
  await expect(unavailable.getByRole('heading', { name: 'Page not supported' })).toBeVisible();
  await expect(unavailable.getByText('Open a website and select anmerko from the Extensions menu.')).toBeVisible();
  session.evidence.scenarios.P1 = 'partial: no pre-granted injection; protected-page action opens actionable guidance';
  session.evidence.result = 'passed';
});

test('production action, native docking, comments, capture, export and restart', { timeout: 90000 }, async t => {
  const session = await createDesktopSession({ scenario: 'workflow' });
  t.after(() => session.close());
  let page = session.page;
  const panel = () => page.getByRole('complementary', { name: 'anmerko feedback panel' });
  const width = await page.evaluate(() => innerWidth);
  await session.activate();
  let dock = await sidebar(session.context, page);
  await expect.poll(() => page.evaluate(() => innerWidth)).toBeLessThan(width - 200);
  assert.equal(session.evidence.manifest.host_permissions, undefined);
  assert.equal(session.evidence.manifest.background.service_worker, 'background.js');
  session.evidence.scenarios.P1 = 'partial: CDP action grants activeTab and opens native sidebar';
  // Native sidebar targets can have a ready DOM before their view is painted.
  // Capture that view: Chrome 152 on CI cannot capture this target's surface.
  await expect(async () => {
    const screenshot = await dock.command('Page.captureScreenshot', { format: 'png', fromSurface: false });
    await writeFile(join(session.output, 'native-sidebar.png'), screenshot.data, 'base64');
  }).toPass({ timeout: 10000 });
  await dock.click('.dock');
  await expect(panel()).toBeVisible();
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width);
  await panel().getByRole('button', { name: 'Select Element' }).click();
  await page.locator('#hero-title').click({ position: { x: 10, y: 10 } });
  await panel().getByLabel('Comment', { exact: true }).fill('Make this headline clearer.');
  await panel().getByRole('button', { name: 'Dock sidebar', exact: true }).click();
  dock = await sidebar(session.context, page);
  await expect.poll(() => dock.value('#comment')).toBe('Make this headline clearer.');
  await dock.click('.dock');
  await expect(panel().getByLabel('Comment', { exact: true })).toHaveValue('Make this headline clearer.');
  await panel().getByLabel('Comment', { exact: true }).press('Control+Enter');
  await expect(panel().locator('.note')).toHaveCount(1);
  await panel().getByRole('button', { name: 'Minimize comments', exact: true }).click();
  await page.getByRole('button', { name: 'Show anmerko comments' }).click();
  await expect(panel()).toBeVisible();
  session.evidence.scenarios.P6 = 'partial: native dock/float, draft retention, minimize/reopen, keyboard save';
  await panel().getByRole('button', { name: 'Extension settings' }).click();
  await panel().getByRole('button', { name: 'Dark', exact: false }).click();
  await panel().getByLabel('Prompt Preamble').fill('Apply these changes and report the results.');
  await panel().getByRole('button', { name: 'Save Preamble', exact: true }).click();
  await expect(panel().locator('.preamble-status')).toHaveText('Preamble saved.');
  await panel().getByRole('button', { name: 'Back', exact: false }).click();

  // A known page fixture makes the real capture's pixels and crop measurable.
  await page.evaluate(() => {
    const swatch = document.createElement('div');
    swatch.style.cssText = 'position:fixed;left:100px;top:100px;width:200px;height:120px;background:rgb(11,132,77);z-index:10';
    document.body.append(swatch);
  });
  await panel().getByRole('button', { name: 'Take Screenshot' }).click();
  await expect(page.getByRole('dialog', { name: 'Select screenshot region' })).toBeVisible();
  // Keep input evidence when a native desktop event interrupts the CDP drag.
  await page.evaluate(() => {
    window.anmerkoPointerTrace = [];
    window.anmerkoPointerAbort = new AbortController();
    for (const type of ['pointerdown', 'pointermove', 'pointerup']) document.addEventListener(type, event => {
      window.anmerkoPointerTrace.push({ type, x: event.clientX, y: event.clientY, buttons: event.buttons, trusted: event.isTrusted });
    }, { capture: true, signal: window.anmerkoPointerAbort.signal });
  });
  await page.mouse.move(110, 110); await page.mouse.down(); await page.mouse.move(290, 210, { steps: 8 }); await page.mouse.up();
  session.evidence.pointerTrace = await page.evaluate(() => {
    window.anmerkoPointerAbort.abort();
    return window.anmerkoPointerTrace;
  });
  await page.screenshot({ path: join(session.output, 'capture-region.png') });
  await page.getByRole('button', { name: 'Use Screenshot' }).click();
  await panel().getByLabel('Comment', { exact: true }).fill('Keep this green region.');
  await panel().getByRole('button', { name: 'Save', exact: true }).click();
  await expect(panel().locator('.note')).toHaveCount(2);
  const worker = session.context.serviceWorkers().find(worker => worker.url().endsWith('/background.js'));
  const data = await worker.evaluate(() => chrome.storage.local.get(null));
  const shot = Object.values(data).find(note => note?.screenshot)?.screenshot;
  assert.ok(shot, 'real screenshot saved');
  const scale = await page.evaluate(() => devicePixelRatio);
  assert.equal(shot.width, Math.round(180 * scale)); assert.equal(shot.height, Math.round(100 * scale));
  const pixel = await page.evaluate(async data => {
    const img = new Image(); img.src = data; await img.decode();
    const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height;
    const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0);
    return Array.from(ctx.getImageData(30, 30, 1, 1).data);
  }, shot.dataUrl);
  assert.deepEqual(pixel, [11, 132, 77, 255]);
  session.evidence.scenarios.P3 = `partial: real activeTab capture, ${shot.width}x${shot.height} PNG, correct green pixels; other capture scenarios remain manual`;
  const prompt = await copyPrompt(page);
  assert.match(prompt, /2 comments across 1 page/);
  assert.match(prompt, /Make this headline clearer\./);
  assert.match(prompt, /Apply these changes and report the results\./);
  assert.doesNotMatch(prompt, /data:image|do-not-export/);
  await panel().getByRole('button', { name: 'Copy Prompt' }).click();
  await expect(panel().getByRole('status')).toContainText('Copied 2 comments');
  // Only the test reader gets clipboard-read; injection/capture still use activeTab.
  await session.context.grantPermissions(['clipboard-read'], { origin: session.origin });
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  await writeFile(join(session.output, 'clipboard.txt'), clipboard);
  // Windows clipboard text uses CRLF; Markdown/ZIP bytes remain canonical LF.
  assert.equal(clipboard.replaceAll('\r\n', '\n'), prompt);
  const downloading = page.waitForEvent('download');
  await panel().getByRole('button', { name: 'Download Markdown + Images' }).click();
  const download = await downloading;
  await download.saveAs(join(session.output, 'feedback.zip'));
  const zip = await readFile(join(session.output, 'feedback.zip'));
  assertElementFeedback(prompt, '#hero-title');
  assertFeedbackArchive(zip, prompt, Buffer.from(shot.dataUrl.split(',')[1], 'base64'));
  await writeFile(join(session.output, 'prompt.md'), prompt);
  session.evidence.scenarios.P5 = 'partial: copied prompt validated; ZIP central directory/CRC, Markdown and PNG bytes validated; clipboard denial remains manual';

  await session.context.close();
  await session.start();
  page = session.page;
  await session.activate(); dock = await sidebar(session.context, page);
  await dock.click('.dock');
  await expect(panel().locator('.note')).toHaveCount(2);
  await expect(panel()).toHaveCSS('background-color', 'rgb(21, 28, 41)');
  expect(await copyPrompt(page)).toBe(prompt);
  session.evidence.scenarios.P4 = 'partial: comments, images, theme and preamble survive real browser restart; store update unrun';
  await panel().locator('.note').first().getByRole('button', { name: 'Edit', exact: true }).click();
  await panel().getByLabel('Comment', { exact: true }).fill('Revised headline feedback.');
  await panel().getByRole('button', { name: 'Save', exact: true }).click();
  await expect(panel().locator('.note').first()).toContainText('Revised headline feedback.');
  await panel().locator('.note').first().getByRole('button', { name: 'Delete', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: 'Delete Comment?', exact: true });
  await expect(confirmation.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await expect(panel().locator('.note')).toHaveCount(2);
  await confirmation.getByRole('button', { name: 'Delete Comment', exact: true }).click();
  await expect(panel().locator('.note')).toHaveCount(1);
  await page.goto(`${session.origin}/pricing`); await session.activate();
  dock = await sidebar(session.context, page); await dock.click('.dock');
  await expect(panel().locator('.note')).toHaveCount(0);
  await panel().getByLabel('Comment scope').selectOption('all');
  await expect(panel().locator('.note')).toHaveCount(1);
  session.evidence.scenarios.P2 = 'partial: select/save/edit/delete, page scope, draft transitions and restart persistence';
  assert.deepEqual(session.evidence.console, []);
  assert.ok(session.evidence.requests.every(request => request.url.startsWith(session.origin + '/')));
  session.evidence.scenarios.P7 = 'partial: unchanged permissions, no page errors or nonlocal page requests; security regressions covered separately';
  session.evidence.result = 'passed';
});

test('production component context covers the native Chrome and Edge fixture matrix', { timeout: 180000 }, async t => {
  const session = await createDesktopSession({ scenario: 'component-context' });
  t.after(() => session.close());
  let page = session.page;
  const first = componentContextPositiveScenarios[0];
  await page.goto(componentFixtureUrl(session.componentOrigin, first));
  await waitForComponentFixture(page);
  await session.activate();
  let dock = await sidebar(session.context, page);
  await dock.click('.dock');
  await expect(extensionPanel(page)).toBeVisible();
  await extensionPanel(page).getByRole('button', { name: 'Extension settings' }).click();
  const preference = extensionPanel(page).getByRole('switch', { name: 'Capture component context' });
  await expect(preference).toHaveAttribute('aria-checked', 'false');
  await extensionPanel(page).getByRole('button', { name: 'Back', exact: false }).click();
  await extensionPanel(page).getByRole('button', { name: 'Select Element', exact: true }).click();
  await componentTarget(page, first).click();
  await expect(extensionPanel(page).locator('.component-context')).toHaveCount(0);
  assert.deepEqual(await fixturePrivacyReads(page), { props: 0, state: 0, source: 0, stack: 0 });
  await extensionPanel(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  await extensionPanel(page).getByRole('button', { name: 'Extension settings' }).click();
  await preference.click();
  await expect(preference).toHaveAttribute('aria-checked', 'true');
  await extensionPanel(page).getByRole('button', { name: 'Back', exact: false }).click();

  const results = [];
  const matrix = [...componentContextPositiveScenarios, ...componentContextFallbackScenarios, ...componentContextMixedScenarios];
  for (const scenario of matrix) {
    const response = await page.goto(componentFixtureUrl(session.componentOrigin, scenario));
    assert.match(response.headers()['content-security-policy'], /connect-src 'none'/);
    await waitForComponentFixture(page);
    await session.activate();
    dock = await sidebar(session.context, page);
    await dock.click('.dock');
    await expect(extensionPanel(page)).toBeVisible();
    await expect(extensionPanel(page).locator('.component-context-toggle')).toHaveAttribute('aria-checked', 'true');
    await extensionPanel(page).getByRole('button', { name: 'Select Element', exact: true }).click();
    const target = componentTarget(page, scenario);
    if (scenario.target.dispatchTarget) await target.dispatchEvent('click');
    else await target.click({ position: scenario.target.clickPosition });
    const row = extensionPanel(page).locator('.component-context');
    if (scenario.expectedPath) {
      await expect(row.locator('.component-context-path')).toHaveText(scenario.expectedPath.join(' → '));
      if (scenario === first) {
        await extensionPanel(page).getByRole('button', { name: 'Dock sidebar', exact: true }).click();
        dock = await sidebar(session.context, page);
        await expect.poll(() => dock.evaluate("return root.querySelector('.component-context-path')?.textContent")).toBe(scenario.expectedPath.join(' → '));
        await dock.click('.dock');
        await expect(extensionPanel(page)).toBeVisible();
        await extensionPanel(page).getByLabel('Comment', { exact: true }).fill('Persist the real component hint.');
        await extensionPanel(page).getByRole('button', { name: 'Save', exact: true }).click();
      } else {
        await extensionPanel(page).getByRole('button', { name: 'Cancel', exact: true }).click();
      }
    } else {
      // Keep the draft open beyond the broker's 750 ms deadline so a wrong
      // late result cannot pass an early absence assertion.
      await page.waitForTimeout(850);
      await expect(row).toHaveCount(0);
      await extensionPanel(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    }
    if (scenario.privacy) assert.ok(Object.values(await fixturePrivacyReads(page)).every(value => value === 0));
    results.push({ id: scenario.id, framework: scenario.framework, version: scenario.version, outcome: scenario.expectedPath ? 'hint' : 'fallback' });
  }

  await session.context.close();
  await session.start();
  page = session.page;
  await page.goto(componentFixtureUrl(session.componentOrigin, first));
  await waitForComponentFixture(page);
  await session.activate();
  dock = await sidebar(session.context, page);
  await dock.click('.dock');
  await expect(extensionPanel(page).locator('.note .component-context-path')).toHaveText(first.expectedPath.join(' → '));
  assert.ok(session.evidence.requests.every(request => !request.url.startsWith('http')
    || request.url.startsWith(session.origin) || request.url.startsWith(session.componentOrigin)));
  session.evidence.componentContextMatrix = results;
  session.evidence.scenarios.P2 = 'partial: component hints survive a real browser restart and native/overlay handoff';
  session.evidence.scenarios.P7 = 'partial: strict-CSP HTTP framework matrix, privacy sentinels and local-only page requests';
  session.evidence.result = 'passed';
});
