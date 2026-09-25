import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { buildSync } from 'esbuild';

type Harness = {
  log: any[];
  listeners: Array<(message: unknown, sender: any) => void>;
  manifest: Record<string, unknown>;
  response: any;
  client?: any;
  pending?: Promise<void>;
};
type HarnessWindow = typeof globalThis & {
  clientModule: { createJourneyClient(owner?: () => { ownerTabId?: number; ownerWindowId?: number }, intent?: string): any };
  surfaceHarness: Harness;
};

const clientBundle = buildSync({
  entryPoints: ['src/journey-client.ts'], bundle: true, write: false, format: 'iife', globalName: 'clientModule',
}).outputFiles[0].text;

function pageBundle(enabled: boolean) {
  return buildSync({
    entryPoints: ['src/journey-page.ts'], bundle: true, write: false, format: 'iife',
    loader: { '.css': 'text' }, define: { __ANMERKO_JOURNEYS__: String(enabled) },
  }).outputFiles[0].text;
}

async function installChrome(page: Page) {
  await page.evaluate(() => {
    const harness: Harness = {
      log: [], listeners: [], manifest: { background: { service_worker: 'background.js' } },
      response: { ok: true, value: { phase: 'idle', epoch: 0 } },
    };
    (globalThis as any).chrome = {
      runtime: {
        id: 'test-extension',
        getURL: (path: string) => `chrome-extension://test-extension/${path}`,
        getManifest: () => structuredClone(harness.manifest),
        sendMessage: async (message: unknown) => {
          harness.log.push({ kind: 'message', message: structuredClone(message) });
          return structuredClone(harness.response);
        },
        onMessage: {
          addListener: (listener: Harness['listeners'][number]) => { harness.listeners.push(listener); },
          removeListener: (listener: Harness['listeners'][number]) => {
            const index = harness.listeners.indexOf(listener);
            if (index >= 0) harness.listeners.splice(index, 1);
          },
        },
      },
    };
    (globalThis as HarnessWindow).surfaceHarness = harness;
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto('http://127.0.0.1:4173');
  await installChrome(page);
});

test('performs a native start without requesting optional access', async ({ page }) => {
  await page.addScriptTag({ content: clientBundle });
  const immediate = await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).surfaceHarness;
    harness.client = (globalThis as HarnessWindow).clientModule.createJourneyClient(
      () => ({ ownerTabId: 12, ownerWindowId: 34 }),
    );
    harness.pending = harness.client.start(false);
    return {
      log: structuredClone(harness.log),
      enteredValues: harness.client.supportsEnteredValues,
      permissionsApi: typeof (globalThis as any).chrome.permissions,
    };
  });
  expect(immediate).toEqual({
    log: [{ kind: 'message', message: { type: 'ANMERKO_JOURNEY_START', ownerTabId: 12, ownerWindowId: 34, includeEnteredValues: false } }],
    enteredValues: true,
    permissionsApi: 'undefined',
  });
  await page.evaluate(() => (globalThis as HarnessWindow).surfaceHarness.pending);
  expect(await page.evaluate(() => (globalThis as HarnessWindow).surfaceHarness.log
    .some(entry => entry.kind === 'permission'))).toBe(false);
});

test('binds fallback actions to one intent and authenticates change notifications', async ({ page }) => {
  await page.addScriptTag({ content: clientBundle });
  await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).surfaceHarness;
    harness.client = (globalThis as HarnessWindow).clientModule.createJourneyClient(undefined, 'launch_nonce-1234567890');
  });
  expect(await page.evaluate(() => (globalThis as HarnessWindow).surfaceHarness.client.supportsEnteredValues)).toBe(true);
  await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).surfaceHarness;
    harness.pending = harness.client.start(true);
  });
  await page.evaluate(() => (globalThis as HarnessWindow).surfaceHarness.pending);
  await page.evaluate(async () => {
    const harness = (globalThis as HarnessWindow).surfaceHarness;
    await harness.client.read(); await harness.client.stop(); await harness.client.discard();
  });
  expect(await page.evaluate(() => (globalThis as HarnessWindow).surfaceHarness.log)).toEqual([
    { kind: 'message', message: { type: 'ANMERKO_JOURNEY_START', intent: 'launch_nonce-1234567890', includeEnteredValues: true } },
    { kind: 'message', message: { type: 'ANMERKO_JOURNEY_STATE' } },
    { kind: 'message', message: { type: 'ANMERKO_JOURNEY_STOP', intent: 'launch_nonce-1234567890' } },
    { kind: 'message', message: { type: 'ANMERKO_JOURNEY_DISCARD' } },
  ]);

  const notifications = await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).surfaceHarness;
    let count = 0;
    const accepted: string[] = [];
    const unsubscribe = harness.client.subscribe(() => { count++; });
    const message = { type: 'ANMERKO_JOURNEY_CHANGED' };
    const emit = (label: string, sender: unknown) => {
      const before = count;
      for (const listener of harness.listeners) listener(message, sender);
      if (count > before) accepted.push(label);
    };
    emit('wrong-id', { id: 'other-extension' });
    emit('tab', { id: 'test-extension', tab: { id: 1 }, url: 'https://example.test/' });
    emit('sidebar', { id: 'test-extension', url: 'chrome-extension://test-extension/sidebar.html' });
    emit('journey', { id: 'test-extension', url: 'chrome-extension://test-extension/journey.html' });
    emit('worker-query', { id: 'test-extension', url: 'chrome-extension://test-extension/background.js?query=1' });
    emit('worker-hash', { id: 'test-extension', url: 'chrome-extension://test-extension/background.js#hash' });
    emit('worker-prefix', { id: 'test-extension', url: 'chrome-extension://test-extension/background.js/prefix' });
    emit('external', { id: 'test-extension', url: 'https://example.test/background.js' });
    emit('undefined', { id: 'test-extension' });
    emit('worker', { id: 'test-extension', url: 'chrome-extension://test-extension/background.js' });
    harness.manifest = { background: { scripts: ['background.js'] } };
    emit('worker-under-scripts', { id: 'test-extension', url: 'chrome-extension://test-extension/background.js' });
    emit('generated-query', { id: 'test-extension', url: 'chrome-extension://test-extension/_generated_background_page.html?query=1' });
    emit('generated-hash', { id: 'test-extension', url: 'chrome-extension://test-extension/_generated_background_page.html#hash' });
    emit('generated-prefix', { id: 'test-extension', url: 'chrome-extension://test-extension/_generated_background_page.html/nested' });
    emit('generated-tab', { id: 'test-extension', url: 'chrome-extension://test-extension/_generated_background_page.html', tab: { id: 2 } });
    emit('generated', { id: 'test-extension', url: 'chrome-extension://test-extension/_generated_background_page.html' });
    unsubscribe();
    for (const listener of harness.listeners) listener(message, { id: 'test-extension' });
    return { accepted, count, listeners: harness.listeners.length };
  });
  expect(notifications).toEqual({ accepted: ['undefined', 'worker', 'generated'], count: 3, listeners: 0 });
});

test('rejects invalid launch context before start and sanitizes failures', async ({ page }) => {
  await page.addScriptTag({ content: clientBundle });
  expect(await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).surfaceHarness;
    harness.client = (globalThis as HarnessWindow).clientModule.createJourneyClient();
    try { harness.client.start(false); return 'no error'; }
    catch (error) { return error instanceof Error ? error.message : String(error); }
  })).toBe('Open anmerko from a website before starting a journey.');
  expect(await page.evaluate(() => (globalThis as HarnessWindow).surfaceHarness.log)).toEqual([]);
  expect(await page.evaluate(() => {
    const client = (globalThis as HarnessWindow).clientModule.createJourneyClient(() => { throw new Error('private owner error'); });
    try { client.start(false); return 'no error'; }
    catch (error) { return error instanceof Error ? error.message : String(error); }
  })).toBe('Open anmerko from a website before starting a journey.');

  await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).surfaceHarness;
    harness.client = (globalThis as HarnessWindow).clientModule.createJourneyClient(() => ({ ownerTabId: 1, ownerWindowId: 2 }));
    harness.response = { ok: false, code: 'busy', error: 'private backend details' };
    harness.pending = harness.client.start(false);
  });
  expect(await page.evaluate(async () => {
    try { await (globalThis as HarnessWindow).surfaceHarness.pending; return 'no error'; }
    catch (error) { return error instanceof Error ? error.message : String(error); }
  })).toBe('Finish or discard the existing journey before starting another.');

  await page.evaluate(() => {
    (globalThis as HarnessWindow).surfaceHarness.response = {
      ok: false, code: 'session-storage-failed', error: 'private storage details',
    };
  });
  expect(await page.evaluate(async () => {
    try { await (globalThis as HarnessWindow).surfaceHarness.client.read(); return 'no error'; }
    catch (error) { return error instanceof Error ? error.message : String(error); }
  })).toBe('Journey storage failed. Reset journey storage to continue. A previous draft or the latest action may be lost.');

  await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).surfaceHarness;
    harness.response = { ok: false, code: '__proto__', error: 'private backend details' };
    harness.pending = harness.client.start(false);
  });
  expect(await page.evaluate(async () => {
    try { await (globalThis as HarnessWindow).surfaceHarness.pending; return 'no error'; }
    catch (error) { return error instanceof Error ? error.message : String(error); }
  })).toBe('Could not update the journey. Try again.');
});

test('trusted page strictly parses launch intent and shares the journey UI only when enabled', async ({ page }) => {
  await page.setContent('<!doctype html><html><head></head><body><main id="journey"></main></body></html>');
  await page.evaluate(() => { location.hash = 'launch=valid_nonce-1234567890'; });
  await page.addScriptTag({ content: pageBundle(true) });
  await expect(page.getByRole('button', { name: 'Start journey', exact: true })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Include entered values' })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Include entered values' })).not.toBeChecked();
  expect(await page.evaluate(() => (globalThis as HarnessWindow).surfaceHarness.log)).toEqual([
    { kind: 'message', message: { type: 'ANMERKO_JOURNEY_STATE' } },
    { kind: 'message', message: { type: 'ANMERKO_JOURNEY_LIST' } },
  ]);
  await page.getByRole('button', { name: 'Start journey', exact: true }).click();
  await expect.poll(async () => (await page.evaluate(() => (globalThis as HarnessWindow).surfaceHarness.log
    .some(entry => entry.message?.type === 'ANMERKO_JOURNEY_START')))).toBe(true);
  expect(await page.evaluate(() => (globalThis as HarnessWindow).surfaceHarness.log
    .filter(entry => entry.kind === 'permission'))).toEqual([]);
  await expect(page.getByRole('alert')).toHaveCount(0);
  // The link is spent after one Start, so the tab explains how to record again.
  await expect(page.getByRole('button', { name: 'Start journey', exact: true })).toHaveCount(0);
  await expect(page.getByText(/^To record a new journey, go to the website tab/)).toBeVisible();
});

for (const hash of ['', 'launch=short', 'launch=valid_nonce-1234567890&extra=1', 'launch=valid%5Fnonce-1234567890', 'launch=invalid/value_1234567890']) {
  test(`offers guidance instead of Start for invalid intent hash ${hash || '(empty)'}`, async ({ page }) => {
    await page.setContent('<!doctype html><html><head></head><body><main id="journey"></main></body></html>');
    await page.evaluate(value => { location.hash = value; }, hash);
    await page.addScriptTag({ content: pageBundle(true) });
    await expect(page.getByRole('heading', { name: 'Record a journey' })).toBeVisible();
    await expect(page.getByText(/^To record a new journey, go to the website tab/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start journey', exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => (globalThis as HarnessWindow).surfaceHarness.log
      .some(entry => entry.message?.type === 'ANMERKO_JOURNEY_START' || entry.kind === 'permission'))).toBe(false);
  });
}

test('every review surface styles the screenshot mask dialog', async ({ page }) => {
  const maskDialogRadius = () => {
    const host = Array.from(document.documentElement.children).find(element => element.shadowRoot?.querySelector('.app'));
    const dialog = document.createElement('dialog');
    dialog.className = 'journey-image-review';
    (host?.shadowRoot?.querySelector('.app') ?? document.body).append(dialog);
    return getComputedStyle(dialog).borderTopLeftRadius;
  };
  await page.setContent('<!doctype html><html><head></head><body><main id="journey"></main></body></html>');
  await page.addScriptTag({ content: pageBundle(true) });
  await expect(page.getByRole('heading', { name: 'Record a journey' })).toBeVisible();
  expect(await page.evaluate(maskDialogRadius)).toBe('12px');

  const sidebarBundle = buildSync({
    entryPoints: ['tests/chromium/fixtures/native-sidebar-harness.ts'], bundle: true, write: false, format: 'iife',
    loader: { '.css': 'text' }, define: { __ANMERKO_JOURNEYS__: 'true' },
  }).outputFiles[0].text;
  await page.goto('http://127.0.0.1:4173/sidebar.html');
  await page.addScriptTag({ content: sidebarBundle });
  await expect(page.getByRole('complementary', { name: 'anmerko feedback panel' })).toBeVisible();
  expect(await page.evaluate(maskDialogRadius)).toBe('12px');

  // A dark sidebar keeps the dialog's warning text on theme tokens, readable on its dark surface.
  expect(await page.evaluate(() => {
    const app = Array.from(document.documentElement.children)
      .map(element => element.shadowRoot?.querySelector('.app')).find(Boolean)!;
    app.setAttribute('data-theme', 'dark');
    const dialog = app.querySelector('.journey-image-review')!;
    const danger = document.createElement('button');
    danger.className = 'journey-image-review__button journey-image-review__button--danger';
    const error = document.createElement('p');
    error.className = 'journey-image-review__error';
    dialog.append(danger, error);
    return [getComputedStyle(dialog).backgroundColor, getComputedStyle(danger).color, getComputedStyle(error).color];
  })).toEqual(['rgb(28, 37, 53)', 'rgb(255, 170, 165)', 'rgb(255, 170, 165)']);
});

test('the journey tab drops the body margin and leaves room to scroll its last control above a dynamic toolbar', async ({ page }) => {
  const html = await readFile('public/journey.html', 'utf8');
  await page.setViewportSize({ width: 390, height: 700 });
  await page.setContent(html.replace('<script src="journey.js"></script>', ''));
  await page.evaluate(() => { location.hash = 'launch=valid_nonce-1234567890'; });
  await page.addScriptTag({ content: pageBundle(true) });
  await expect(page.getByRole('button', { name: 'Start journey', exact: true })).toBeVisible();
  const layout = await page.evaluate(() => {
    const view = document.querySelector('.journey-view')!;
    const buttons = [...view.querySelectorAll('button')];
    const last = buttons.at(-1)!.getBoundingClientRect();
    return {
      bodyMargin: getComputedStyle(document.body).margin,
      paddingBottom: parseFloat(getComputedStyle(view).paddingBottom),
      room: document.documentElement.scrollHeight - (last.bottom + scrollY),
    };
  });
  expect(layout.bodyMargin).toBe('0px');
  // Firefox for Android lays the page out about 65px taller than it shows.
  expect(layout.paddingBottom).toBeGreaterThanOrEqual(96);
  expect(layout.room).toBeGreaterThanOrEqual(96);
});

test('feature-off page renders an unavailable message without contacting the background', async ({ page }) => {
  await page.setContent('<!doctype html><html><head></head><body><main id="journey"></main></body></html>');
  await page.evaluate(() => { location.hash = 'launch=valid_nonce-1234567890'; });
  await page.addScriptTag({ content: pageBundle(false) });
  await expect(page.getByRole('heading', { name: 'Journey recording unavailable' })).toBeVisible();
  expect(await page.evaluate(() => (globalThis as HarnessWindow).surfaceHarness.log)).toEqual([]);
});

test('bundled page has a viewport, external script, and no web-accessible exposure', async () => {
  const [html, manifestText] = await Promise.all([
    readFile('public/journey.html', 'utf8'), readFile('public/manifest.json', 'utf8'),
  ]);
  expect(html).toMatch(/<meta name="viewport"/);
  expect(html).toMatch(/<script src="journey\.js"><\/script>/);
  expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/);
  expect(html).not.toMatch(/<style\b|\sstyle=/);
  const manifest = JSON.parse(manifestText);
  expect(JSON.stringify(manifest.web_accessible_resources ?? [])).not.toContain('journey.html');
});
