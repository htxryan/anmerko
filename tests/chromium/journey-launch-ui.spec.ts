import { expect, test, type Page } from '@playwright/test';
import { buildSync } from 'esbuild';

const bundle = buildSync({ stdin: { resolveDir: process.cwd(), contents: `
  import { mount } from './src/content';
  import styles from './src/panel.css';
  window.launchCalls = 0;
  mount({
    store: { read: async () => undefined, readAll: async () => ({}), write: async () => {}, remove: async () => {}, subscribe: () => () => {} },
    attachStyles: shadow => { const style = document.createElement('style'); style.textContent = styles; shadow.append(style); },
    storageError: 'Storage unavailable', settingsLabel: 'Settings',
    openJourney: async () => { window.launchCalls++; if (window.rejectLaunch) throw new Error('private backend detail'); },
  });
` }, bundle: true, write: false, format: 'iife', loader: { '.css': 'text' } }).outputFiles[0].text;

// Mounts the shared panel with the optional runtime pieces set on window.panelSetup.
const panelBundle = buildSync({ stdin: { resolveDir: process.cwd(), contents: `
  import { mount } from './src/content';
  import styles from './src/panel.css';
  const setup = window.panelSetup || {};
  let recordingListener = null;
  window.setJourneyRecording = value => recordingListener?.(value);
  window.controller = mount({
    store: { read: async () => undefined, readAll: async () => ({}), write: async () => {}, remove: async () => {}, subscribe: () => () => {} },
    attachStyles: shadow => { const style = document.createElement('style'); style.textContent = styles; shadow.append(style); },
    storageError: 'Storage unavailable', settingsLabel: 'Settings', capture: () => new Promise(() => {}),
    ...(setup.journeys ? { openJourney: async () => {} } : {}),
    ...(setup.recording ? { watchJourneyRecording: listener => { recordingListener = listener; return () => { recordingListener = null; }; } } : {}),
    // A native sidebar mounts the journey view inside the panel.
    ...(setup.inPanel ? { journeys: {
      read: async () => ({ phase: 'idle', epoch: 0 }), subscribe: () => () => {}, list: async () => [],
      start: async () => {}, stop: async () => {}, discard: async () => {},
    } } : {}),
    ...(setup.native ? { presentation: { native: true, dockViaToolbar: false, sync: async () => {}, changeLayout: async () => {},
      locate: async () => null, hierarchy: async () => null, startCapture: async () => {}, captureError() {}, connect() {} } } : {}),
  });
` }, bundle: true, write: false, format: 'iife', loader: { '.css': 'text' } }).outputFiles[0].text;

async function mountPanel(page: Page, setup: { journeys?: boolean; native?: boolean; recording?: boolean; inPanel?: boolean }) {
  await page.goto('http://127.0.0.1:4173');
  await page.evaluate(value => { (window as any).panelSetup = value; }, setup);
  await page.addScriptTag({ content: panelBundle });
}

// Exercises the real journey page module (src/journey-page.ts) with a stubbed
// extension API: the launch intent in the hash is already consumed, so Start
// rejects with a launch-expired code and the page must swap to guidance.
const journeyPageBundle = buildSync({ stdin: { resolveDir: process.cwd(), contents: `
  import './src/journey-page';
` }, bundle: true, write: false, format: 'iife', loader: { '.css': 'text' }, define: { __TARGET_JOURNEYS__: 'true' } }).outputFiles[0].text;

test('page overlays request a trusted journey surface without mounting raw review', async ({ page }) => {
  await page.goto('http://127.0.0.1:4173');
  await page.addScriptTag({ content: bundle });
  const panel = page.getByRole('complementary', { name: 'anmerko feedback panel' });
  await panel.getByRole('button', { name: 'More Comment Options' }).click();
  await panel.getByRole('menuitem', { name: 'Record journey', exact: true }).click();
  expect(await page.evaluate('window.launchCalls')).toBe(1);
  await expect(page.getByRole('region', { name: 'Journey recording and review' })).toHaveCount(0);
  await expect(page.locator('.journey-view')).toHaveCount(0);
  await page.evaluate('window.rejectLaunch = true');
  await panel.getByRole('button', { name: 'More Comment Options' }).click();
  await panel.getByRole('menuitem', { name: 'Record journey', exact: true }).click();
  await expect(panel.getByText('Could not open the journey. Reopen anmerko from the toolbar and try again.', { exact: true })).toBeVisible();
  await expect(page.getByText('private backend detail')).toHaveCount(0);
});

test('consumed launch intent shows guidance instead of a dead start', async ({ page }) => {
  await page.goto('http://127.0.0.1:4173');
  await page.setContent('<!doctype html><html><body><main id="journey"></main></body></html>');
  await page.evaluate(`location.hash = '#launch=${'a'.repeat(16)}'`);
  await page.evaluate(`window.chrome = {
    runtime: {
      sendMessage: async message => {
        if (message && message.type === 'ANMERKO_JOURNEY_STATE') return { ok: true, value: { phase: 'idle', epoch: 0 } };
        if (message && message.type === 'ANMERKO_JOURNEY_START') return { ok: false, code: 'launch-expired' };
        return { ok: false };
      },
      onMessage: { addListener: () => {}, removeListener: () => {} },
    },
    permissions: { request: async () => true },
  };`);
  await page.addScriptTag({ content: journeyPageBundle });
  await expect(page.getByRole('button', { name: 'Start journey', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Start journey', exact: true }).click();
  const heading = page.getByRole('heading', { name: 'This journey link already opened' });
  await expect(heading).toBeFocused();
  await expect(page.getByText('Each journey link works once. Return to the website tab and choose Record journey to start a fresh journey.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start journey', exact: true })).toHaveCount(0);
  // The guidance keeps the journey surface's styling instead of bare HTML.
  const section = page.locator('section.journey-view');
  await expect(section).toContainText('anmerko');
  expect(await section.evaluate(element => getComputedStyle(element).paddingTop)).toBe('24px');
});

test('a journey tab keeps Start and Cancel start while its one start is in flight, and keeps a failure that arrives while hidden', async ({ page }) => {
  await page.goto('http://127.0.0.1:4173');
  await page.setContent('<!doctype html><html><body><main id="journey"></main></body></html>');
  await page.evaluate(`location.hash = '#launch=${'a'.repeat(16)}'`);
  await page.evaluate(`
    let visible = true;
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visible ? 'visible' : 'hidden' });
    document.hasFocus = () => visible;
    window.setVisible = value => {
      visible = value;
      document.dispatchEvent(new Event('visibilitychange'));
      if (value) window.dispatchEvent(new Event('focus'));
    };
    window.chrome = {
      runtime: {
        getManifest: () => ({ background: { service_worker: 'background.js' } }),
        sendMessage: message => {
          if (message && message.type === 'ANMERKO_JOURNEY_STATE') return Promise.resolve({ ok: true, value: { phase: 'idle', epoch: 0 } });
          if (message && message.type === 'ANMERKO_JOURNEY_LIST') return Promise.resolve({ ok: true, value: [] });
          // The background shows the website tab, then cannot reach it.
          if (message && message.type === 'ANMERKO_JOURNEY_START') return new Promise(resolve => { window.failStart = () => resolve({ ok: false, code: 'owner-unavailable' }); });
          return Promise.resolve({ ok: false });
        },
        onMessage: { addListener: () => {}, removeListener: () => {} },
      },
    };
  `);
  await page.addScriptTag({ content: journeyPageBundle });
  const start = page.getByRole('button', { name: 'Start journey', exact: true });
  await start.click();
  await expect(page.getByRole('button', { name: 'Cancel start', exact: true })).toBeEnabled();
  await expect(start).toBeDisabled();
  await expect(page.getByText(/^To record a new journey, go to the website tab/)).toHaveCount(0);
  await page.evaluate(() => { (window as any).setVisible(false); (window as any).failStart(); });
  const message = 'anmerko could not reach the website tab. On that tab, click anmerko in the browser toolbar or Extensions menu, then try again.';
  const shown = page.locator('.journey-view').getByText(message, { exact: true });
  await expect(shown).toBeAttached();
  await expect(page.getByText(/^To record a new journey, go to the website tab/)).toBeAttached();
  await expect(page.getByRole('alert')).toHaveCount(0);
  // Returning to the tab shows and announces why the start failed.
  await page.evaluate(() => (window as any).setVisible(true));
  await expect(page.getByRole('alert')).toHaveText(message);
  await expect(shown).toBeVisible();
  await expect(shown).toBeFocused();
});

test('panels without a journey client keep exactly the three comment actions', async ({ page }) => {
  await mountPanel(page, {});
  const actions = page.getByRole('group', { name: 'Comment Actions' });
  await expect(actions.getByRole('button')).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'More Comment Options' })).toHaveCount(0);
  await expect(page.locator('anmerko-overlay #comment-menu')).toHaveCount(0);
});

test('comment options close and disable during captures, drafts, and disconnection', async ({ page }) => {
  // CSS locators keep working while capture hides the panel.
  const toggle = page.locator('anmerko-overlay .comment-options');
  const menu = page.locator('anmerko-overlay #comment-menu');
  const open = async () => {
    await toggle.click();
    await expect(menu).toBeVisible();
  };
  await mountPanel(page, { journeys: true });
  await open();
  await page.evaluate(() => { void (window as any).controller.startCapture(); });
  await expect(toggle).toBeDisabled();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(menu).toBeHidden();

  await mountPanel(page, { journeys: true });
  await page.getByRole('button', { name: 'New Global Comment', exact: true }).click();
  await expect(toggle).toBeDisabled();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(toggle).toBeEnabled();
  await open();
  await page.evaluate(() => (window as any).controller.connectionFailed());
  await expect(toggle).toBeDisabled();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(menu).toBeHidden();

  // A native panel has no page identity until its startup snapshot arrives.
  await mountPanel(page, { journeys: true, native: true });
  await expect(toggle).toBeDisabled();
  await page.evaluate(() => (window as any).controller.applyState({ url: location.href, draft: null, scope: 'page', picking: false, settings: false }));
  await expect(toggle).toBeEnabled();
});

// The recording strip occupies the bottom-left 72px band of the visible
// viewport (asserted in journey-page-bridge.spec.ts); panel controls stay above it.
const STRIP_BAND = 72;

test('a floating panel steps aside while its page records a journey and returns afterwards', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mountPanel(page, { journeys: true, recording: true });
  const panel = page.getByRole('complementary', { name: 'anmerko feedback panel' });
  const resume = page.getByRole('button', { name: 'Show anmerko comments' });
  await expect(panel).toBeVisible();
  await page.evaluate(() => (window as any).setJourneyRecording(true));
  await expect(panel).toBeHidden();
  await expect(resume).toBeVisible();
  const quick = (await page.getByRole('group', { name: 'Quick Comment Actions' }).boundingBox())!;
  expect(quick.y + quick.height).toBeLessThanOrEqual(844 - STRIP_BAND);
  await page.evaluate(() => (window as any).setJourneyRecording(false));
  await expect(panel).toBeVisible();
  await expect(resume).toBeHidden();

  // Reopened during a recording, the panel keeps Copy Prompt clear of the strip.
  await page.evaluate(() => (window as any).setJourneyRecording(true));
  await resume.click();
  await expect(panel).toBeVisible();
  const copy = (await panel.getByRole('button', { name: 'Copy Prompt' }).boundingBox())!;
  expect(copy.y + copy.height).toBeLessThanOrEqual(844 - STRIP_BAND);
  const sheet = (await panel.boundingBox())!;
  expect(sheet.y).toBeGreaterThanOrEqual(0);
  // The reader chose to reopen it, so the end of the journey leaves it open.
  await page.evaluate(() => (window as any).setJourneyRecording(false));
  await expect(panel).toBeVisible();
  expect((await panel.boundingBox())!.y + (await panel.boundingBox())!.height).toBeGreaterThan(844 - STRIP_BAND);
});

test('a desktop floating panel also clears the recording strip', async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 720 });
  await mountPanel(page, { journeys: true, recording: true });
  const panel = page.getByRole('complementary', { name: 'anmerko feedback panel' });
  await page.evaluate(() => (window as any).setJourneyRecording(true));
  await page.getByRole('button', { name: 'Show anmerko comments' }).click();
  const box = (await panel.boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(720 - STRIP_BAND);
});

test('a native panel ignores page recording', async ({ page }) => {
  await mountPanel(page, { journeys: true, native: true, recording: true });
  const panel = page.getByRole('complementary', { name: 'anmerko feedback panel' });
  await page.evaluate(() => (window as any).setJourneyRecording(true));
  await expect(panel).toBeVisible();
  expect(await page.locator('anmerko-overlay .app').evaluate(element => element.classList.contains('journey-recording'))).toBe(false);
});

function contrast(first: string, second: string): number {
  const luminance = (color: string) => {
    const [r, g, b] = color.match(/\d+(\.\d+)?/g)!.slice(0, 3).map(Number).map(value => {
      const channel = value / 255;
      return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [light, dark] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

test('journey entry points show a focus ring with at least 3:1 contrast in both themes, and Back returns focus', async ({ page }) => {
  await mountPanel(page, { journeys: true, native: true, inPanel: true });
  await page.evaluate(() => (window as any).controller.applyState({ url: location.href, draft: null, scope: 'page', picking: false, settings: false }));
  const options = page.getByRole('button', { name: 'More Comment Options' });
  await expect(options).toBeEnabled();
  const ring = (selector: string) => page.locator(`anmerko-overlay ${selector}`).evaluate(element => {
    // Settle the theme's background transition before sampling colors.
    for (const animation of element.getAnimations()) animation.finish();
    const style = getComputedStyle(element);
    // The ring sits inside the control when its offset is negative, over the control's own fill.
    const behind = parseFloat(style.outlineOffset) < 0 ? style.backgroundColor : getComputedStyle(element.closest('.journey-container, .panel')!).backgroundColor;
    return { outline: style.outlineColor, width: style.outlineWidth, behind };
  });
  for (const theme of ['light', 'dark']) {
    await page.locator('anmerko-overlay .app').evaluate((element, value) => element.setAttribute('data-theme', value), theme);
    await options.focus();
    await page.keyboard.press('ArrowDown');
    const record = page.getByRole('menuitem', { name: 'Record journey', exact: true });
    await expect(record).toBeFocused();
    const recordRing = await ring('.journey-record');
    expect(contrast(recordRing.outline, recordRing.behind), `${theme} record`).toBeGreaterThanOrEqual(3);
    await page.keyboard.press('Escape');
    await expect(options).toBeFocused();
    const optionsRing = await ring('.comment-options');
    expect(optionsRing.width).toBe('3px');
    expect(contrast(optionsRing.outline, optionsRing.behind), `${theme} options`).toBeGreaterThanOrEqual(3);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    const back = page.getByRole('button', { name: 'Back to comments', exact: true });
    await expect(back).toBeFocused();
    const backRing = await ring('.journey-return');
    expect(contrast(backRing.outline, backRing.behind), `${theme} back`).toBeGreaterThanOrEqual(3);
    await page.keyboard.press('Enter');
    await expect(back).toHaveCount(0);
    await expect(options).toBeFocused();
  }
});
