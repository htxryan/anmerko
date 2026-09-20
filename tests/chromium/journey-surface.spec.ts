import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { buildSync } from 'esbuild';

type Harness = {
  log: any[];
  listeners: Array<(message: unknown, sender: any) => void>;
  response: any;
  client?: any;
  pending?: Promise<void>;
  resolveGrant?: (granted: boolean) => void;
  rejectGrant?: (error: Error) => void;
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
      log: [], listeners: [], response: { ok: true, value: { phase: 'idle', epoch: 0 } },
    };
    (globalThis as any).chrome = {
      runtime: {
        id: 'test-extension',
        getURL: (path: string) => `chrome-extension://test-extension/${path}`,
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
      permissions: {
        request(details: unknown) {
          harness.log.push({ kind: 'permission', details: structuredClone(details) });
          return new Promise<boolean>((resolve, reject) => {
            harness.resolveGrant = resolve;
            harness.rejectGrant = reject;
          });
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

test('requests optional access synchronously before native start and cancels a pending grant', async ({ page }) => {
  await page.addScriptTag({ content: clientBundle });
  const immediate = await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).surfaceHarness;
    harness.client = (globalThis as HarnessWindow).clientModule.createJourneyClient(
      () => ({ ownerTabId: 12, ownerWindowId: 34 }),
    );
    harness.pending = harness.client.start(false);
    return { log: structuredClone(harness.log), enteredValues: harness.client.supportsEnteredValues };
  });
  expect(immediate).toEqual({
    log: [{ kind: 'permission', details: { origins: ['<all_urls>'], permissions: ['webNavigation'] } }],
    enteredValues: false,
  });
  await page.evaluate(() => (globalThis as HarnessWindow).surfaceHarness.resolveGrant?.(true));
  await page.evaluate(() => (globalThis as HarnessWindow).surfaceHarness.pending);
  expect(await page.evaluate(() => (globalThis as HarnessWindow).surfaceHarness.log)).toEqual([
    { kind: 'permission', details: { origins: ['<all_urls>'], permissions: ['webNavigation'] } },
    { kind: 'message', message: { type: 'ANMERKO_JOURNEY_START', ownerTabId: 12, ownerWindowId: 34 } },
  ]);

  await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).surfaceHarness;
    harness.log.length = 0;
    harness.pending = harness.client.start(false);
    void harness.client.stop();
  });
  expect(await page.evaluate(() => (globalThis as HarnessWindow).surfaceHarness.log)).toEqual([
    { kind: 'permission', details: { origins: ['<all_urls>'], permissions: ['webNavigation'] } },
    { kind: 'message', message: { type: 'ANMERKO_JOURNEY_STOP' } },
  ]);
  await page.evaluate(() => (globalThis as HarnessWindow).surfaceHarness.resolveGrant?.(true));
  await page.evaluate(() => (globalThis as HarnessWindow).surfaceHarness.pending);
  expect(await page.evaluate(() => (globalThis as HarnessWindow).surfaceHarness.log.filter(entry => entry.message?.type === 'ANMERKO_JOURNEY_START'))).toEqual([]);

  await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).surfaceHarness;
    harness.log.length = 0;
    harness.pending = harness.client.start(false);
    void harness.client.discard();
    harness.resolveGrant?.(true);
  });
  await page.evaluate(() => (globalThis as HarnessWindow).surfaceHarness.pending);
  expect(await page.evaluate(() => (globalThis as HarnessWindow).surfaceHarness.log)).toEqual([
    { kind: 'permission', details: { origins: ['<all_urls>'], permissions: ['webNavigation'] } },
    { kind: 'message', message: { type: 'ANMERKO_JOURNEY_DISCARD' } },
  ]);

  expect(await page.evaluate(async () => {
    const harness = (globalThis as HarnessWindow).surfaceHarness;
    harness.log.length = 0;
    harness.pending = harness.client.start(false);
    void harness.client.stop();
    harness.rejectGrant?.(new Error('private browser rejection'));
    try { await harness.pending; return 'cancelled'; }
    catch (error) { return error instanceof Error ? error.message : String(error); }
  })).toBe('cancelled');
});

test('binds fallback actions to one intent and authenticates change notifications', async ({ page }) => {
  await page.addScriptTag({ content: clientBundle });
  await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).surfaceHarness;
    harness.client = (globalThis as HarnessWindow).clientModule.createJourneyClient(undefined, 'launch_nonce-1234567890');
  });
  expect(await page.evaluate(() => (globalThis as HarnessWindow).surfaceHarness.client.supportsEnteredValues)).toBe(false);
  await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).surfaceHarness;
    harness.pending = harness.client.start(true);
    harness.resolveGrant?.(true);
  });
  await page.evaluate(() => (globalThis as HarnessWindow).surfaceHarness.pending);
  await page.evaluate(async () => {
    const harness = (globalThis as HarnessWindow).surfaceHarness;
    await harness.client.read(); await harness.client.stop(); await harness.client.discard();
  });
  expect(await page.evaluate(() => (globalThis as HarnessWindow).surfaceHarness.log)).toEqual([
    { kind: 'permission', details: { origins: ['<all_urls>'], permissions: ['webNavigation'] } },
    { kind: 'message', message: { type: 'ANMERKO_JOURNEY_START', intent: 'launch_nonce-1234567890' } },
    { kind: 'message', message: { type: 'ANMERKO_JOURNEY_STATE' } },
    { kind: 'message', message: { type: 'ANMERKO_JOURNEY_STOP', intent: 'launch_nonce-1234567890' } },
    { kind: 'message', message: { type: 'ANMERKO_JOURNEY_DISCARD' } },
  ]);

  const notifications = await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).surfaceHarness;
    let count = 0;
    const unsubscribe = harness.client.subscribe(() => { count++; });
    const message = { type: 'ANMERKO_JOURNEY_CHANGED' };
    for (const sender of [
      { id: 'other-extension' },
      { id: 'test-extension', tab: { id: 1 }, url: 'https://example.test/' },
      { id: 'test-extension', url: 'chrome-extension://test-extension/sidebar.html' },
      { id: 'test-extension' },
      { id: 'test-extension', url: 'chrome-extension://test-extension/background.js' },
    ]) for (const listener of harness.listeners) listener(message, sender);
    unsubscribe();
    for (const listener of harness.listeners) listener(message, { id: 'test-extension' });
    return { count, listeners: harness.listeners.length };
  });
  expect(notifications).toEqual({ count: 2, listeners: 0 });
});

test('rejects invalid launch context before requesting access and sanitizes failures', async ({ page }) => {
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
    harness.pending = harness.client.start(false);
    harness.resolveGrant?.(false);
  });
  expect(await page.evaluate(async () => {
    try { await (globalThis as HarnessWindow).surfaceHarness.pending; return 'no error'; }
    catch (error) { return error instanceof Error ? error.message : String(error); }
  })).toBe('Allow access to all websites to record a journey, then try again.');

  await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).surfaceHarness;
    harness.response = { ok: false, code: 'busy', error: 'private backend details' };
    harness.pending = harness.client.start(false);
    harness.resolveGrant?.(true);
  });
  expect(await page.evaluate(async () => {
    try { await (globalThis as HarnessWindow).surfaceHarness.pending; return 'no error'; }
    catch (error) { return error instanceof Error ? error.message : String(error); }
  })).toBe('Finish or discard the existing journey before starting another.');

  await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).surfaceHarness;
    harness.response = { ok: false, code: 'private-code', error: 'private backend details' };
    harness.pending = harness.client.start(false);
    harness.resolveGrant?.(true);
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
  await expect(page.getByText('Entered values: Off', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (globalThis as HarnessWindow).surfaceHarness.log)).toEqual([
    { kind: 'message', message: { type: 'ANMERKO_JOURNEY_STATE' } },
  ]);
  await page.getByRole('button', { name: 'Start journey', exact: true }).click();
  expect(await page.evaluate(() => (globalThis as HarnessWindow).surfaceHarness.log[1])).toEqual(
    { kind: 'permission', details: { origins: ['<all_urls>'], permissions: ['webNavigation'] } },
  );
  await page.evaluate(() => (globalThis as HarnessWindow).surfaceHarness.resolveGrant?.(false));
  await expect(page.getByRole('alert')).toHaveText('Allow access to all websites to record a journey, then try again.');
});

for (const hash of ['', 'launch=short', 'launch=valid_nonce-1234567890&extra=1', 'launch=valid%5Fnonce-1234567890', 'launch=invalid/value_1234567890']) {
  test(`does not grant or launch for invalid intent hash ${hash || '(empty)'}`, async ({ page }) => {
    await page.setContent('<!doctype html><html><head></head><body><main id="journey"></main></body></html>');
    await page.evaluate(value => { location.hash = value; }, hash);
    await page.addScriptTag({ content: pageBundle(true) });
    await expect(page.getByRole('button', { name: 'Start journey', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Start journey', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText('Open anmerko from a website before starting a journey.');
    expect(await page.evaluate(() => (globalThis as HarnessWindow).surfaceHarness.log.some(entry => entry.kind === 'permission'))).toBe(false);
  });
}

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
