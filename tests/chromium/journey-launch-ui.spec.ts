import { expect, test, type Page } from '@playwright/test';
import { buildSync } from 'esbuild';
import { addJourneyApis } from './fixtures/journey-apis';

const bundle = buildSync({ stdin: { resolveDir: process.cwd(), contents: `
  import { mount } from './src/content';
  import styles from './src/panel.css';
  window.launchCalls = 0;
  mount({
    store: { read: async () => undefined, readAll: async () => ({}), write: async () => {}, remove: async () => {}, subscribe: () => () => {} },
    attachStyles: shadow => { const style = document.createElement('style'); style.textContent = styles; shadow.append(style); },
    storageError: 'Storage unavailable', settingsLabel: 'Settings',
    openJourney: async () => {
      window.launchCalls++;
      if (window.rejectLaunch) throw Object.assign(new Error('private backend detail'), window.rejectCode ? { code: window.rejectCode } : {});
    },
    journeyReviewPending: async () => { window.pendingChecks = (window.pendingChecks || 0) + 1; return !!window.reviewPending; },
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
    ...(setup.journeys ? {
      openJourney: async () => { window.journeyOpens = (window.journeyOpens || 0) + 1; },
      journeyReviewPending: async () => !!window.reviewPending,
    } : {}),
    ...(setup.recording ? { watchJourneyRecording: listener => { recordingListener = listener; return () => { recordingListener = null; }; } } : {}),
    // A native sidebar mounts the journey view inside the panel, and follows
    // the phase alone beside it.
    ...(setup.inPanel ? { journeyPhase: async () => {
      window.phaseReads = (window.phaseReads || 0) + 1;
      return (window.journeyState || { phase: 'idle' }).phase;
    }, journeys: {
      read: async () => {
        window.sessionReads = (window.sessionReads || 0) + 1;
        return window.journeyState || { phase: 'idle', epoch: 0 };
      },
      subscribe: listener => {
        const listeners = window.journeyListeners ||= new Set();
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
      list: async () => window.savedJourneys || [],
      deleteSnapshot: async () => {},
      reopen: async journeyId => {
        window.reopened = [...(window.reopened || []), journeyId];
        if (window.rejectReopen) throw Object.assign(new Error('Finish or discard the existing journey before starting another.'), { code: 'busy' });
      },
      start: async () => {}, stop: async () => {},
      // Discarding a save's confirmation leaves the snapshot saved and the
      // session idle. Like the background, a discard naming a saved
      // confirmation refuses any journey that has replaced it.
      discard: async expected => {
        window.discards = (window.discards || 0) + 1;
        window.discardTargets = [...(window.discardTargets || []), expected ?? null];
        window.beforeDiscard?.();
        const phase = window.journeyState?.phase;
        if (expected?.phase === 'saved' && phase && phase !== 'idle'
          && (phase !== 'saved' || (expected.journeyId !== undefined && window.journeyState.journeyId !== expected.journeyId))) {
          throw Object.assign(new Error('Another review tab changed this journey. Reload the review and try again.'), { code: 'stale-review' });
        }
        if (window.journeyState?.phase === 'saved') window.journeyState = { phase: 'idle', epoch: window.journeyState.epoch + 1 };
        for (const listener of window.journeyListeners || []) listener();
      },
    } } : {}),
    ...(setup.native ? { presentation: { native: true, dockViaToolbar: false, sync: async () => {}, changeLayout: async () => {},
      locate: async () => null, hierarchy: async () => null, startCapture: async () => {}, captureError() {}, connect() {} } } : {}),
  });
` }, bundle: true, write: false, format: 'iife', loader: { '.css': 'text' } }).outputFiles[0].text;

async function mountPanel(page: Page, setup: { journeys?: boolean; native?: boolean; recording?: boolean; inPanel?: boolean },
  globals: Record<string, unknown> = {}) {
  await page.goto('http://127.0.0.1:4173');
  await page.evaluate(({ value, globals }) => { Object.assign(window, globals); (window as any).panelSetup = value; }, { value: setup, globals });
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
  // Every refusal names what to do on this page; none sends the reader to the
  // toolbar, which cannot help while a journey tab is pending or recording.
  const guidance: Array<[string | undefined, string]> = [
    [undefined, 'Could not open the journey tab. Try again.'],
    ['busy', 'A journey is already recording in another tab. Stop it there, then try again.'],
    ['owner-unavailable', 'anmerko could not use this page for a journey. Keep this tab in front and try again. If it still fails, reload the page.'],
    ['initial-capture-failed', 'The first journey screenshot failed. Keep this tab in front and try again.'],
    ['launch-expired', 'That journey tab expired. Choose Record journey again.'],
    ['session-storage-failed', 'Journey storage failed. Choose Record journey again to open the journey tab and reset journey storage.'],
    ['stale-review', 'The journey changed in another anmerko view. Choose Review journey to see the latest version.'],
    ['unreachable', 'anmerko could not reach the extension. Reload this page, then try again.'],
  ];
  await page.evaluate('window.rejectLaunch = true');
  for (const [code, text] of guidance) {
    await page.evaluate(value => { (window as any).rejectCode = value; }, code);
    await panel.getByRole('button', { name: 'More Comment Options' }).click();
    await panel.getByRole('menuitem', { name: 'Record journey', exact: true }).click();
    await expect(panel.locator('.status'), code ?? 'generic').toHaveText(text);
    await expect(page.getByText('private backend detail')).toHaveCount(0);
    await expect(panel.getByText(/Reopen anmerko from the toolbar/)).toHaveCount(0);
  }
});

test('a page panel offers a pending review, relabels Record journey, and asks again when recording ends or the reader returns', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mountPanel(page, { journeys: true, recording: true });
  const panel = page.getByRole('complementary', { name: 'anmerko feedback panel' });
  const entry = panel.getByText('A recorded journey is waiting for review.', { exact: true });
  const review = panel.getByRole('button', { name: 'Review journey', exact: true });
  await expect(panel).toBeVisible();
  await expect(entry).toHaveCount(1);
  await expect(entry).toBeHidden();
  await page.getByRole('button', { name: 'More Comment Options' }).click();
  await expect(page.getByRole('menuitem', { name: 'Record journey', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');

  // Recording ends: the panel comes back and offers the review.
  await page.evaluate(() => { (window as any).reviewPending = true; (window as any).setJourneyRecording(true); });
  await expect(panel).toBeHidden();
  await page.evaluate(() => (window as any).setJourneyRecording(false));
  await expect(panel).toBeVisible();
  await expect(entry).toBeVisible();
  await expect(review).toBeVisible();
  await page.getByRole('button', { name: 'More Comment Options' }).click();
  await expect(page.getByRole('menuitem', { name: 'Review journey', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await review.click();
  expect(await page.evaluate('window.journeyOpens')).toBe(1);

  // Saved or discarded in the journey tab: the entry leaves when the reader returns.
  await page.evaluate(() => {
    (window as any).reviewPending = false;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(entry).toBeHidden();
  await page.getByRole('button', { name: 'More Comment Options' }).click();
  await expect(page.getByRole('menuitem', { name: 'Record journey', exact: true })).toBeVisible();
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
  await page.evaluate(addJourneyApis);
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
  await page.evaluate(addJourneyApis);
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
  await expect(page.getByRole('alert')).toBeEmpty();
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

test('saved journeys in the comments view reopen for review and lead to the journey view that manages them', async ({ page }) => {
  await mountPanel(page, { journeys: true, native: true, inPanel: true }, { savedJourneys: [
    { journeyId: 'J1', revision: 2, updatedAt: '2026-09-21T01:00:00.000Z', stepCount: 3, spansPages: true, expected: 'Checkout keeps the item' },
    { journeyId: 'J2', revision: 1, updatedAt: '2026-09-21T02:00:00.000Z', stepCount: 1, spansPages: false },
  ] });
  await page.evaluate(() => (window as any).controller.applyState({ url: location.href, draft: null, scope: 'page', picking: false, settings: false }));
  const panel = page.getByRole('complementary', { name: 'anmerko feedback panel' });
  const saved = panel.getByRole('region', { name: 'Saved journeys' });
  await expect(saved.locator('li')).toHaveCount(2);
  const reopen = saved.getByRole('button', { name: /^Reopen journey: Checkout keeps the item, saved / });
  await expect(reopen).toBeVisible();
  await expect(saved.getByRole('button', { name: /^Reopen journey: Untitled journey, saved / })).toBeVisible();

  // A journey in progress refuses the reopen with guidance for this view.
  await page.evaluate(() => { (window as any).rejectReopen = true; });
  await reopen.click();
  await expect(panel.locator('.status')).toHaveText('Finish or discard the current journey before reopening a saved one.');
  await expect(page.locator('anmerko-overlay .journey-container')).toHaveCount(0);
  await page.evaluate(() => { (window as any).rejectReopen = false; });
  await reopen.click();
  expect(await page.evaluate('window.reopened')).toEqual(['J1', 'J1']);
  const back = page.getByRole('button', { name: 'Back to comments', exact: true });
  await expect(back).toBeFocused();
  await back.click();

  // Manage opens the journey view on its Saved journeys list, where delete lives.
  await saved.getByRole('button', { name: 'Manage saved journeys', exact: true }).click();
  const view = page.locator('anmerko-overlay .journey-container');
  await expect(view.getByRole('heading', { name: 'Saved journeys' })).toBeFocused();
  await expect(view.getByRole('button', { name: /^Delete journey: Checkout keeps the item/ })).toBeVisible();
});

test('Manage saved journeys closes a save confirmation first and waits while a journey is in progress', async ({ page }) => {
  await mountPanel(page, { journeys: true, native: true, inPanel: true }, {
    savedJourneys: [{ journeyId: 'J1', revision: 2, updatedAt: '2026-09-21T01:00:00.000Z', stepCount: 3, spansPages: false, expected: 'Checkout keeps the item' }],
    journeyState: { phase: 'saved', epoch: 5, journeyId: 'J1', revision: 2 },
  });
  await page.evaluate(() => (window as any).controller.applyState({ url: location.href, draft: null, scope: 'page', picking: false, settings: false }));
  const panel = page.getByRole('complementary', { name: 'anmerko feedback panel' });
  const saved = panel.getByRole('region', { name: 'Saved journeys' });
  const manage = saved.getByRole('button', { name: 'Manage saved journeys', exact: true });
  const reopen = saved.getByRole('button', { name: /^Reopen journey: Checkout keeps the item, saved / });
  const held = saved.getByText('Finish or discard the current journey to reopen or manage saved journeys.', { exact: true });
  const view = page.locator('anmerko-overlay .journey-container');
  const notify = (state: unknown) => page.evaluate(value => {
    (window as any).journeyState = value;
    for (const listener of (window as any).journeyListeners) listener();
  }, state);

  // Right after a save the session still holds its confirmation, which lists
  // nothing. Manage closes it and lands on the list, where delete lives.
  await expect(held).toBeHidden();
  await expect(manage).toBeEnabled();
  await manage.click();
  await expect(view.getByRole('heading', { name: 'Saved journeys' })).toBeFocused();
  await expect(view.getByRole('heading', { name: 'Journey saved' })).toHaveCount(0);
  await expect(view.getByRole('button', { name: /^Delete journey: Checkout keeps the item/ })).toBeVisible();
  expect(await page.evaluate('window.discards')).toBe(1);
  // The discard names the saved confirmation it closes.
  expect(await page.evaluate('window.discardTargets')).toEqual([{ phase: 'saved', journeyId: 'J1' }]);
  await page.getByRole('button', { name: 'Back to comments', exact: true }).click();

  // While a journey records or waits for review, the view has no list and a
  // saved journey cannot reopen: both wait, and say why.
  for (const phase of ['recording', 'reviewing', 'saving']) {
    await notify({ phase, epoch: 7 });
    await expect(held, phase).toBeVisible();
    await expect(manage, phase).toBeDisabled();
    await expect(reopen, phase).toBeDisabled();
    await expect(manage, phase).toHaveAttribute('aria-describedby', 'saved-journeys-note');
  }
  await notify({ phase: 'idle', epoch: 8 });
  await expect(held).toBeHidden();
  await expect(manage).toBeEnabled();
  await expect(reopen).toBeEnabled();
  await expect(manage).not.toHaveAttribute('aria-describedby', /./);

  // A review that begins elsewhere before this panel hears of it is caught at
  // the click: nothing is discarded and nothing opens.
  await page.evaluate(() => { (window as any).journeyState = { phase: 'reviewing', epoch: 9 }; });
  await manage.click();
  await expect(panel.locator('.status')).toHaveText('Finish or discard the current journey to reopen or manage saved journeys.');
  await expect(view).toHaveCount(0);
  expect(await page.evaluate('window.discards')).toBe(1);
  await expect(held).toBeVisible();

  // Another view reopens a journey after this panel read the saved
  // confirmation but before its discard lands: the reopened review is left
  // alone, and the panel says why nothing opened.
  await notify({ phase: 'saved', epoch: 10, journeyId: 'J1', revision: 2 });
  await expect(manage).toBeEnabled();
  await page.evaluate(() => {
    (window as any).beforeDiscard = () => { (window as any).journeyState = { phase: 'reviewing', epoch: 1 }; };
  });
  await panel.locator('.status').evaluate(status => { status.textContent = ''; });
  await manage.click();
  await expect(panel.locator('.status')).toHaveText('Finish or discard the current journey to reopen or manage saved journeys.');
  await expect(view).toHaveCount(0);
  expect(await page.evaluate('window.journeyState')).toEqual({ phase: 'reviewing', epoch: 1 });
  expect(await page.evaluate('window.discardTargets')).toEqual([{ phase: 'saved', journeyId: 'J1' }, { phase: 'saved', journeyId: 'J1' }]);
});

test('a native panel offers a pending review and opens the journey view for it', async ({ page }) => {
  await mountPanel(page, { journeys: true, native: true, inPanel: true }, { journeyState: { phase: 'saving', epoch: 3 } });
  await page.evaluate(() => (window as any).controller.applyState({ url: location.href, draft: null, scope: 'page', picking: false, settings: false }));
  const panel = page.getByRole('complementary', { name: 'anmerko feedback panel' });
  await expect(panel.getByText('A recorded journey is waiting for review.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'More Comment Options' }).click();
  await expect(page.getByRole('menuitem', { name: 'Review journey', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await panel.getByRole('button', { name: 'Review journey', exact: true }).click();
  await expect(page.locator('anmerko-overlay .journey-container').getByRole('heading', { name: 'Saving journey' })).toBeVisible();
  await page.getByRole('button', { name: 'Back to comments', exact: true }).click();
  // The review closes elsewhere; the background's change notice clears the entry.
  await page.evaluate(() => { (window as any).journeyState = { phase: 'idle', epoch: 4 }; for (const listener of (window as any).journeyListeners) listener(); });
  await expect(panel.getByText('A recorded journey is waiting for review.', { exact: true })).toBeHidden();
});

test('a native panel follows journey changes by phase alone and reads the session only for the journey view', async ({ page }) => {
  await mountPanel(page, { journeys: true, native: true, inPanel: true }, { journeyState: { phase: 'recording', epoch: 2 } });
  await page.evaluate(() => (window as any).controller.applyState({ url: location.href, draft: null, scope: 'page', picking: false, settings: false }));
  const panel = page.getByRole('complementary', { name: 'anmerko feedback panel' });
  const reads = () => page.evaluate(() => ({ phase: (window as any).phaseReads || 0, session: (window as any).sessionReads || 0 }));
  const notify = (state: unknown) => page.evaluate(value => {
    (window as any).journeyState = value;
    for (const listener of (window as any).journeyListeners) listener();
  }, state);
  await expect.poll(async () => (await reads()).phase).toBeGreaterThan(0);
  // Every recorded step notifies the panel; each costs one phase read, never
  // the session and its screenshots.
  const before = (await reads()).phase;
  for (let step = 0; step < 10; step++) await notify({ phase: 'recording', epoch: 2 });
  await notify({ phase: 'reviewing', epoch: 2 });
  await expect(panel.getByText('A recorded journey is waiting for review.', { exact: true })).toBeVisible();
  expect(await reads()).toEqual({ phase: before + 11, session: 0 });
  // The journey view shows the session, so it reads it; closing the view stops that.
  await panel.getByRole('button', { name: 'Review journey', exact: true }).click();
  await expect.poll(async () => (await reads()).session).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Back to comments', exact: true }).click();
  const closed = (await reads()).session;
  for (let step = 0; step < 5; step++) await notify({ phase: 'reviewing', epoch: 2 });
  await expect.poll(async () => (await reads()).phase).toBeGreaterThanOrEqual(before + 16);
  expect((await reads()).session).toBe(closed);
});
