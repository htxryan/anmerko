import { expect, test, type Page } from '@playwright/test';
import { buildSync } from 'esbuild';

type MessageSender = { id?: string; url?: string; tab?: { id: number } };
type ObserverWindow = typeof globalThis & {
  observerHarness: {
    dispatch(message: unknown): Promise<any>;
    listenerCount(): number;
    sent: any[];
    stripText(): string | null;
  };
  __anmerkoJourneyPage?: () => void;
};

function observerBundle(enabled: boolean) {
  return buildSync({
    entryPoints: ['src/journey-observer.ts'],
    bundle: true,
    write: false,
    format: 'iife',
    define: { __ANMERKO_JOURNEYS__: String(enabled) },
  }).outputFiles[0].text;
}

const enabledBundle = observerBundle(true);
const disabledBundle = observerBundle(false);
const background = { id: 'test-extension', url: 'chrome-extension://test-extension/background.js' };

async function installHarness(page: Page) {
  await page.evaluate(backgroundSender => {
    const listeners: Array<(message: any, sender: MessageSender, respond: (value: unknown) => void) => boolean | void> = [];
    let stripRoot: ShadowRoot | null = null;
    const originalAttach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function(init) {
      const root = originalAttach.call(this, init);
      if (this.localName === 'anmerko-journey-strip') stripRoot = root;
      return root;
    };
    const harness: ObserverWindow['observerHarness'] = {
      sent: [],
      dispatch(message) {
        const listener = listeners[0];
        if (!listener) return Promise.resolve(undefined);
        return new Promise(resolve => {
          let answered = false;
          const respond = (value: unknown) => { if (!answered) { answered = true; resolve(value); } };
          const pending = listener(message, backgroundSender, respond);
          if (pending !== true && !answered) queueMicrotask(() => resolve(undefined));
        });
      },
      listenerCount: () => listeners.length,
      stripText: () => stripRoot?.textContent || null,
    };
    (globalThis as any).chrome = {
      runtime: {
        id: 'test-extension',
        getURL: (path: string) => `chrome-extension://test-extension/${path}`,
        getManifest: () => ({ background: { service_worker: 'background.js' } }),
        onMessage: {
          addListener: (listener: typeof listeners[number]) => { listeners.push(listener); },
          removeListener: (listener: typeof listeners[number]) => {
            const index = listeners.indexOf(listener);
            if (index >= 0) listeners.splice(index, 1);
          },
        },
        sendMessage: (message: unknown) => { harness.sent.push(structuredClone(message)); return Promise.resolve({ ok: true }); },
      },
    };
    (globalThis as ObserverWindow).observerHarness = harness;
  }, background);
}

test('observer reinjection reuses a live binding and restores a fresh inactive owner binding after pagehide', async ({ page }) => {
  await page.goto('http://127.0.0.1:4173/observer?item=green&item=large#start');
  await page.setContent('<button type="button">Owner action</button>');
  await installHarness(page);
  await page.addScriptTag({ content: enabledBundle });
  await page.addScriptTag({ content: enabledBundle });
  expect(await page.evaluate(() => (globalThis as ObserverWindow).observerHarness.listenerCount())).toBe(1);
  await expect(page.locator('anmerko-overlay')).toHaveCount(0);

  const first = (await page.evaluate(() => (globalThis as ObserverWindow).observerHarness.dispatch({
    type: 'ANMERKO_JOURNEY_PAGE_IDENTIFY',
  }))).value;
  await page.getByRole('button', { name: 'Owner action' }).click();
  expect(await page.evaluate(() => (globalThis as ObserverWindow).observerHarness.sent)).toEqual([]);

  const startedAt = new Date().toISOString();
  expect(await page.evaluate(({ first, startedAt }) => (globalThis as ObserverWindow).observerHarness.dispatch({
    type: 'ANMERKO_JOURNEY_PAGE_START', sessionId: 'session-1', epoch: 1, documentToken: first.documentToken,
    expectedUrl: first.url, count: 2, startedAt,
  }), { first, startedAt })).toMatchObject({ ok: true });
  expect(await page.evaluate(() => (globalThis as ObserverWindow).observerHarness.stripText())).toMatch(/2 steps/);
  await page.getByRole('button', { name: 'Owner action' }).click();
  await expect.poll(() => page.evaluate(() => (globalThis as ObserverWindow).observerHarness.sent.length)).toBe(1);

  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  expect(await page.evaluate(() => ({
    listeners: (globalThis as ObserverWindow).observerHarness.listenerCount(),
    marker: Object.hasOwn(globalThis, '__anmerkoJourneyPage'),
  }))).toEqual({ listeners: 0, marker: false });
  await expect(page.locator('anmerko-journey-strip')).toHaveCount(0);

  await page.addScriptTag({ content: enabledBundle });
  expect(await page.evaluate(() => (globalThis as ObserverWindow).observerHarness.listenerCount())).toBe(1);
  await expect(page.locator('anmerko-overlay')).toHaveCount(0);
  const restored = (await page.evaluate(() => (globalThis as ObserverWindow).observerHarness.dispatch({
    type: 'ANMERKO_JOURNEY_PAGE_IDENTIFY',
  }))).value;
  expect(restored.documentToken).not.toBe(first.documentToken);
  await page.getByRole('button', { name: 'Owner action' }).click();
  expect(await page.evaluate(() => (globalThis as ObserverWindow).observerHarness.sent.length)).toBe(1);

  expect(await page.evaluate(({ restored, startedAt }) => (globalThis as ObserverWindow).observerHarness.dispatch({
    type: 'ANMERKO_JOURNEY_PAGE_START', sessionId: 'session-2', epoch: 1, documentToken: restored.documentToken,
    expectedUrl: restored.url, count: 0, startedAt,
  }), { restored, startedAt })).toMatchObject({ ok: true });
  await page.getByRole('button', { name: 'Owner action' }).click();
  await expect.poll(() => page.evaluate(() => (globalThis as ObserverWindow).observerHarness.sent.length)).toBe(2);

  expect(await page.evaluate(() => {
    const dispose = (globalThis as ObserverWindow).__anmerkoJourneyPage!;
    dispose(); dispose();
    return {
      listeners: (globalThis as ObserverWindow).observerHarness.listenerCount(),
      marker: Object.hasOwn(globalThis, '__anmerkoJourneyPage'),
    };
  })).toEqual({ listeners: 0, marker: false });
  await expect(page.locator('anmerko-journey-strip')).toHaveCount(0);
});

test('observer stays inactive when journeys are disabled or execution is not in the top frame', async ({ page }) => {
  await page.goto('http://127.0.0.1:4173/observer-disabled');
  await installHarness(page);
  await page.addScriptTag({ content: disabledBundle });
  expect(await page.evaluate(() => (globalThis as ObserverWindow).observerHarness.listenerCount())).toBe(0);
  expect(await page.evaluate(() => Object.hasOwn(globalThis, '__anmerkoJourneyPage'))).toBe(false);

  const frameHandle = await page.evaluateHandle(() => {
    const frame = document.createElement('iframe');
    frame.srcdoc = '<!doctype html><html><body>frame</body></html>';
    document.body.append(frame);
    return frame;
  });
  const frameElement = frameHandle.asElement();
  const frame = await frameElement!.contentFrame();
  await frame!.addScriptTag({ content: enabledBundle });
  expect(await frame!.evaluate(() => Object.hasOwn(globalThis, '__anmerkoJourneyPage'))).toBe(false);
  await frameHandle.dispose();
});
