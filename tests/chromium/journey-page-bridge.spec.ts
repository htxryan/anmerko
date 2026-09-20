import { expect, test, type Page } from '@playwright/test';
import { buildSync } from 'esbuild';

type MessageSender = { id?: string; url?: string; tab?: { id: number } };
type BridgeHarness = {
  dispatch(message: unknown, sender?: MessageSender): Promise<any>;
  manifest: Record<string, unknown>;
  sent: any[];
  portMessages: any[];
  portNames: string[];
  disconnectedPorts: number[];
  disconnectPort(index: number): void;
  failNextPortPost: boolean;
  response: unknown;
  rejectSend: boolean;
  shortenHideTimeout: boolean;
  strip(): { text: string; buttonHeight: number; hostMarkup: string; buttonRect: { x: number; y: number; width: number; height: number } } | null;
  listenerCount(): number;
};
type BridgeWindow = typeof globalThis & {
  anmerkoJourneyPageBridge: { bindJourneyPage(onDispose?: () => void): () => void };
  bridgeHarness: BridgeHarness;
  disposeJourneyPage: () => void;
  normalActions: number;
};

const bundle = buildSync({
  entryPoints: ['src/journey-page-bridge.ts'],
  bundle: true,
  write: false,
  format: 'iife',
  globalName: 'anmerkoJourneyPageBridge',
}).outputFiles[0].text;

const mountedOverlayBundle = buildSync({
  stdin: { resolveDir: process.cwd(), contents: `
    import { mount } from './src/content';
    import { privateImage } from './src/screenshot';
    import styles from './src/panel.css';
    globalThis.mountJourneyCaptureFixture = () => {
      const controller = mount({
        store: { read: async () => undefined, readAll: async () => ({}), write: async () => {}, remove: async () => {}, subscribe: () => () => {} },
        attachStyles: shadow => { const style = document.createElement('style'); style.textContent = styles; shadow.append(style); },
        storageError: 'Storage unavailable', settingsLabel: 'Settings',
      });
      const host = document.querySelector('anmerko-overlay');
      const image = privateImage('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="red"/></svg>', 'Nested capture image');
      image.style.cssText = 'position:fixed!important;top:40px!important;right:40px!important;width:64px!important;height:64px!important;z-index:2147483647!important;visibility:visible!important;background:rgb(255,0,0)!important;';
      host.shadowRoot.querySelector('.app').append(image);
      return controller.ready;
    };
  ` },
  bundle: true,
  write: false,
  format: 'iife',
  loader: { '.css': 'text' },
}).outputFiles[0].text;

const background = { id: 'test-extension', url: 'chrome-extension://test-extension/background.js' };

async function dispatch(page: Page, message: unknown, sender: MessageSender = background) {
  return page.evaluate(({ message, sender }) => (globalThis as BridgeWindow).bridgeHarness.dispatch(message, sender), { message, sender });
}

async function screenshotPixel(page: Page, x: number, y: number) {
  const png = await page.screenshot();
  return page.evaluate(async ({ data, x, y }) => {
    const bytes = Uint8Array.from(atob(data), character => character.charCodeAt(0));
    const image = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const canvas = document.createElement('canvas');
    canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0);
    const [red, green, blue, alpha] = context.getImageData(x, y, 1, 1).data;
    image.close();
    return { red, green, blue, alpha };
  }, { data: png.toString('base64'), x, y });
}

test.beforeEach(async ({ page }) => {
  await page.goto('http://127.0.0.1:4173/journey?item=green&item=large#start');
  await page.evaluate(() => {
    const listeners: Array<(message: any, sender: MessageSender, respond: (value: unknown) => void) => boolean | void> = [];
    let stripRoot: ShadowRoot | null = null;
    const originalAttach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function(init) {
      const root = originalAttach.call(this, init);
      if (this.localName === 'anmerko-journey-strip') stripRoot = root;
      return root;
    };
    const nativeTimeout = window.setTimeout.bind(window);
    const ports: Array<{ disconnect(): void }> = [];
    const harness: BridgeHarness = {
      manifest: { background: { service_worker: 'background.js' } },
      sent: [], portMessages: [], portNames: [], disconnectedPorts: [],
      response: { ok: true }, rejectSend: false, shortenHideTimeout: false,
      failNextPortPost: false,
      disconnectPort(index) { ports[index]?.disconnect(); },
      dispatch(message, sender = background) {
        const listener = listeners[0];
        if (!listener) return Promise.resolve(undefined);
        return new Promise(resolve => {
          let answered = false;
          const respond = (value: unknown) => { if (!answered) { answered = true; resolve(value); } };
          const pending = listener(message, sender, respond);
          if (pending !== true && !answered) queueMicrotask(() => resolve(undefined));
        });
      },
      strip() {
        const host = document.querySelector('anmerko-journey-strip');
        const button = stripRoot?.querySelector('button');
        if (!host || !stripRoot || !button) return null;
        const rect = button.getBoundingClientRect();
        return {
          text: stripRoot.textContent || '', buttonHeight: rect.height, hostMarkup: host.outerHTML,
          buttonRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        };
      },
      listenerCount: () => listeners.length,
    };
    window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: any[]) => nativeTimeout(
      handler, timeout === 5_000 && harness.shortenHideTimeout ? 50 : timeout, ...args,
    )) as typeof window.setTimeout;
    (globalThis as any).chrome = {
      runtime: {
        id: 'test-extension',
        getURL: (path: string) => `chrome-extension://test-extension/${path}`,
        getManifest: () => structuredClone(harness.manifest),
        onMessage: {
          addListener: (listener: typeof listeners[number]) => { listeners.push(listener); },
          removeListener: (listener: typeof listeners[number]) => {
            const index = listeners.indexOf(listener);
            if (index >= 0) listeners.splice(index, 1);
          },
        },
        sendMessage: (message: unknown) => {
          harness.sent.push(structuredClone(message));
          return harness.rejectSend ? Promise.reject(new Error('private failure')) : Promise.resolve(harness.response);
        },
        connect: ({ name }: { name: string }) => {
          const disconnectListeners: Array<() => void> = [];
          const index = ports.length;
          let connected = true;
          const port = {
            name,
            postMessage(message: unknown) {
              if (!connected) throw new Error('disconnected');
              if (harness.failNextPortPost) {
                harness.failNextPortPost = false;
                throw new Error('disconnected');
              }
              harness.portMessages.push(structuredClone(message));
            },
            disconnect() {
              if (!connected) return;
              connected = false;
              harness.disconnectedPorts.push(index);
              for (const listener of disconnectListeners) listener();
            },
            onDisconnect: {
              addListener(listener: () => void) { disconnectListeners.push(listener); },
              removeListener(listener: () => void) {
                const listenerIndex = disconnectListeners.indexOf(listener);
                if (listenerIndex >= 0) disconnectListeners.splice(listenerIndex, 1);
              },
            },
          };
          ports.push(port);
          harness.portNames.push(name);
          return port;
        },
      },
    };
    (globalThis as BridgeWindow).bridgeHarness = harness;
  });
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => {
    (globalThis as BridgeWindow).disposeJourneyPage = (globalThis as BridgeWindow).anmerkoJourneyPageBridge.bindJourneyPage();
  });
});

test('accepts only the exact manifest-derived background sender URL', async ({ page }) => {
  const message = { type: 'ANMERKO_JOURNEY_PAGE_IDENTIFY' };
  expect((await dispatch(page, message, background)).ok).toBe(true);
  expect((await dispatch(page, message, { id: 'test-extension' })).ok).toBe(true);
  expect(await dispatch(page, message, {
    id: 'test-extension', url: 'chrome-extension://test-extension/_generated_background_page.html',
  })).toEqual({ ok: false, error: 'Journey command unavailable.' });

  await page.evaluate(() => {
    (globalThis as BridgeWindow).bridgeHarness.manifest = { background: { scripts: ['background.js'] } };
  });
  const generated = 'chrome-extension://test-extension/_generated_background_page.html';
  expect((await dispatch(page, message, { id: 'test-extension', url: generated })).ok).toBe(true);
  for (const sender of [
    { id: 'other-extension', url: generated },
    { id: 'test-extension', url: generated, tab: { id: 1 } },
    { id: 'test-extension', url: 'chrome-extension://test-extension/background.js' },
    { id: 'test-extension', url: 'chrome-extension://test-extension/sidebar.html' },
    { id: 'test-extension', url: 'chrome-extension://test-extension/journey.html' },
    { id: 'test-extension', url: `${generated}?from=page` },
    { id: 'test-extension', url: `${generated}#fragment` },
    { id: 'test-extension', url: `${generated}/nested` },
    { id: 'test-extension', url: 'https://example.test/_generated_background_page.html' },
  ]) {
    expect(await dispatch(page, message, sender)).toEqual({ ok: false, error: 'Journey command unavailable.' });
  }
});

test('identifies one document, advances resize generation, and rejects non-background commands', async ({ page }) => {
  const first = await dispatch(page, { type: 'ANMERKO_JOURNEY_PAGE_IDENTIFY' }, { id: 'test-extension' });
  expect(first.ok).toBe(true);
  expect(first.value).toMatchObject({
    url: 'http://127.0.0.1:4173/journey?item=green&item=large#start',
    viewport: { width: 1280, height: 720 }, scroll: { x: 0, y: 0 }, generation: 0, visible: true,
  });
  expect(first.value.documentToken).toMatch(/^[0-9a-f-]{36}$/i);
  const repeated = await dispatch(page, { type: 'ANMERKO_JOURNEY_PAGE_IDENTIFY' });
  expect(repeated.value.documentToken).toBe(first.value.documentToken);

  await page.setViewportSize({ width: 1100, height: 700 });
  const resized = await dispatch(page, { type: 'ANMERKO_JOURNEY_PAGE_IDENTIFY' });
  expect(resized.value).toMatchObject({ documentToken: first.value.documentToken, viewport: { width: 1100, height: 700 } });
  expect(resized.value.generation).toBeGreaterThan(first.value.generation);

  const start = { type: 'ANMERKO_JOURNEY_PAGE_START', sessionId: 'session-1', epoch: 1,
    documentToken: first.value.documentToken, startedAt: new Date().toISOString() };
  for (const sender of [
    { id: 'other-extension' },
    { id: 'test-extension', tab: { id: 1 }, url: 'http://127.0.0.1:4173/journey' },
    { id: 'test-extension', url: 'chrome-extension://test-extension/sidebar.html' },
  ]) {
    expect(await dispatch(page, start, sender)).toEqual({ ok: false, error: 'Journey command unavailable.' });
  }
  expect(await page.locator('anmerko-journey-strip').count()).toBe(0);
});

test('each binding owns a fresh document token after explicit disposal and pagehide', async ({ page }) => {
  const first = (await dispatch(page, { type: 'ANMERKO_JOURNEY_PAGE_IDENTIFY' })).value.documentToken;
  await page.evaluate(() => (globalThis as BridgeWindow).disposeJourneyPage());
  expect(await page.evaluate(() => (globalThis as BridgeWindow).bridgeHarness.listenerCount())).toBe(0);

  await page.evaluate(() => {
    (globalThis as BridgeWindow).disposeJourneyPage = (globalThis as BridgeWindow).anmerkoJourneyPageBridge.bindJourneyPage();
  });
  const second = (await dispatch(page, { type: 'ANMERKO_JOURNEY_PAGE_IDENTIFY' })).value.documentToken;
  expect(second).not.toBe(first);

  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  expect(await page.evaluate(() => (globalThis as BridgeWindow).bridgeHarness.listenerCount())).toBe(0);
  await page.evaluate(() => {
    (globalThis as BridgeWindow).disposeJourneyPage = (globalThis as BridgeWindow).anmerkoJourneyPageBridge.bindJourneyPage();
  });
  const third = (await dispatch(page, { type: 'ANMERKO_JOURNEY_PAGE_IDENTIFY' })).value.documentToken;
  expect(third).not.toBe(second);
});

test('starts only after a valid command, forwards one trusted click, updates status, and stops synchronously', async ({ page }) => {
  await page.evaluate(() => {
    document.body.innerHTML = '<button type="button">Normal action</button>';
    (globalThis as BridgeWindow).normalActions = 0;
    document.querySelector('button')!.addEventListener('click', () => { (globalThis as BridgeWindow).normalActions++; });
  });
  const identity = (await dispatch(page, { type: 'ANMERKO_JOURNEY_PAGE_IDENTIFY' })).value;
  await page.getByRole('button', { name: 'Normal action' }).click();
  expect(await page.evaluate(() => (globalThis as BridgeWindow).bridgeHarness.sent)).toEqual([]);

  const invalid = await dispatch(page, { type: 'ANMERKO_JOURNEY_PAGE_START', sessionId: 'session-1', epoch: 1,
    documentToken: 'wrong-document', startedAt: new Date().toISOString() });
  expect(invalid).toEqual({ ok: false, error: 'Journey command unavailable.' });
  const startedAt = new Date().toISOString();
  const wrongUrl = await dispatch(page, { type: 'ANMERKO_JOURNEY_PAGE_START', sessionId: 'session-1', epoch: 1,
    documentToken: identity.documentToken, expectedUrl: `${identity.url}wrong`, count: 3, startedAt });
  expect(wrongUrl).toEqual({ ok: false, error: 'Journey command unavailable.' });
  const credentialUrl = identity.url.replace('http://', 'http://user:secret@');
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_PAGE_START', sessionId: 'session-1', epoch: 1,
    documentToken: identity.documentToken, expectedUrl: credentialUrl, count: 3, startedAt }))
    .toEqual({ ok: false, error: 'Journey command unavailable.' });
  const invalidCount = await dispatch(page, { type: 'ANMERKO_JOURNEY_PAGE_START', sessionId: 'session-1', epoch: 1,
    documentToken: identity.documentToken, expectedUrl: identity.url, count: -1, startedAt });
  expect(invalidCount).toEqual({ ok: false, error: 'Journey command unavailable.' });
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_PAGE_START', sessionId: 'session-1', epoch: 1,
    documentToken: identity.documentToken, expectedUrl: identity.url, count: 3, startedAt })).toMatchObject({ ok: true });
  expect(await page.evaluate(() => (globalThis as BridgeWindow).bridgeHarness.portNames))
    .toEqual(['anmerko-journey-events-v1']);
  const strip = await page.evaluate(() => (globalThis as BridgeWindow).bridgeHarness.strip());
  expect(strip?.text).toMatch(/Recording.*3 steps.*Stop/);
  expect(strip?.buttonHeight).toBeGreaterThanOrEqual(44);
  expect(strip?.hostMarkup).not.toContain('session-1');

  await page.getByRole('button', { name: 'Normal action' }).click();
  const portMessages = await page.evaluate(() => (globalThis as BridgeWindow).bridgeHarness.portMessages);
  expect(portMessages).toHaveLength(1);
  expect(portMessages[0]).toMatchObject({ type: 'ANMERKO_JOURNEY_EVENTS', batch: {
    sessionId: 'session-1', epoch: 1, documentToken: identity.documentToken,
  } });
  expect(await page.evaluate(() => (globalThis as BridgeWindow).bridgeHarness.sent
    .some(message => message.type === 'ANMERKO_JOURNEY_EVENTS'))).toBe(false);
  expect(await page.evaluate(() => (globalThis as BridgeWindow).normalActions)).toBe(2);

  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_PAGE_STATUS', sessionId: 'other', epoch: 1, count: 99 }))
    .toEqual({ ok: false, error: 'Journey command unavailable.' });
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_PAGE_STATUS', sessionId: 'session-1', epoch: 1, count: 4 })).toMatchObject({ ok: true });
  expect((await page.evaluate(() => (globalThis as BridgeWindow).bridgeHarness.strip()))?.text).toMatch(/4 steps/);

  await page.evaluate(() => { (globalThis as BridgeWindow).bridgeHarness.response = { ok: false, error: 'private failure' }; });
  const stopButton = (await page.evaluate(() => (globalThis as BridgeWindow).bridgeHarness.strip()))!.buttonRect;
  await page.mouse.click(stopButton.x + stopButton.width / 2, stopButton.y + stopButton.height / 2);
  await expect.poll(() => page.evaluate(() => (globalThis as BridgeWindow).bridgeHarness.sent.some(message => message.type === 'ANMERKO_JOURNEY_STOP'))).toBe(true);
  await expect.poll(() => page.evaluate(() => (globalThis as BridgeWindow).bridgeHarness.strip()?.text)).toContain('Could not stop the journey. Try again.');
  expect((await page.evaluate(() => (globalThis as BridgeWindow).bridgeHarness.strip()))?.text).not.toContain('private failure');

  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_PAGE_STOP', sessionId: 'other', epoch: 2 }))
    .toEqual({ ok: false, error: 'Journey command unavailable.' });
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_PAGE_STOP', sessionId: 'session-1', epoch: 2,
    documentToken: 'stale-document' })).toEqual({ ok: false, error: 'Journey command unavailable.' });
  expect((await page.evaluate(() => (globalThis as BridgeWindow).bridgeHarness.strip()))?.text).toMatch(/4 steps/);
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_PAGE_STOP', sessionId: 'session-1', epoch: 2 })).toMatchObject({ ok: true });
  await expect(page.locator('anmerko-journey-strip')).toHaveCount(0);
  expect(await page.evaluate(() => (globalThis as BridgeWindow).bridgeHarness.disconnectedPorts)).toEqual([0]);
  await page.getByRole('button', { name: 'Normal action' }).click();
  expect(await page.evaluate(() => (globalThis as BridgeWindow).bridgeHarness.portMessages)).toHaveLength(1);
  expect(await page.evaluate(() => (globalThis as BridgeWindow).normalActions)).toBe(3);
});

test('retries one failed post, reconnects on a later batch, and disposes the active port', async ({ page }) => {
  await page.evaluate(() => { document.body.innerHTML = '<button type="button">Continue</button>'; });
  const identity = (await dispatch(page, { type: 'ANMERKO_JOURNEY_PAGE_IDENTIFY' })).value;
  expect(await dispatch(page, {
    type: 'ANMERKO_JOURNEY_PAGE_START', sessionId: 'session-1', epoch: 1,
    documentToken: identity.documentToken, expectedUrl: identity.url, count: 1, startedAt: new Date().toISOString(),
  })).toMatchObject({ ok: true });
  await page.evaluate(() => { (globalThis as BridgeWindow).bridgeHarness.failNextPortPost = true; });

  await page.getByRole('button', { name: 'Continue' }).click();
  expect(await page.evaluate(() => ({
    names: (globalThis as BridgeWindow).bridgeHarness.portNames,
    messages: (globalThis as BridgeWindow).bridgeHarness.portMessages,
  }))).toMatchObject({
    names: ['anmerko-journey-events-v1', 'anmerko-journey-events-v1'],
    messages: [{ type: 'ANMERKO_JOURNEY_EVENTS' }],
  });
  expect(await page.evaluate(() => (globalThis as BridgeWindow).bridgeHarness.disconnectedPorts)).toEqual([0]);

  await page.evaluate(() => (globalThis as BridgeWindow).bridgeHarness.disconnectPort(1));
  await page.getByRole('button', { name: 'Continue' }).click();
  expect(await page.evaluate(() => ({
    names: (globalThis as BridgeWindow).bridgeHarness.portNames,
    messages: (globalThis as BridgeWindow).bridgeHarness.portMessages,
  }))).toMatchObject({
    names: ['anmerko-journey-events-v1', 'anmerko-journey-events-v1', 'anmerko-journey-events-v1'],
    messages: [{ type: 'ANMERKO_JOURNEY_EVENTS' }, { type: 'ANMERKO_JOURNEY_EVENTS' }],
  });

  await page.evaluate(() => (globalThis as BridgeWindow).disposeJourneyPage());
  expect(await page.evaluate(() => (globalThis as BridgeWindow).bridgeHarness.disconnectedPorts)).toEqual([0, 1, 2]);
});

test('prepare and finish hide only a matching capture and every stop path restores inline display and visibility', async ({ page }) => {
  await page.evaluate(() => {
    document.body.insertAdjacentHTML('beforeend', '<anmerko-overlay></anmerko-overlay><anmerko-image></anmerko-image>');
    document.querySelector<HTMLElement>('anmerko-overlay')!.style.setProperty('display', 'inline-flex', 'important');
    document.querySelector<HTMLElement>('anmerko-overlay')!.style.setProperty('visibility', 'visible', 'important');
    document.querySelector<HTMLElement>('anmerko-image')!.setAttribute('data-anmerko-capture-hidden', 'original');
    document.querySelector<HTMLElement>('anmerko-image')!.style.display = 'grid';
    document.querySelector<HTMLElement>('anmerko-image')!.style.visibility = 'collapse';
  });
  const identity = (await dispatch(page, { type: 'ANMERKO_JOURNEY_PAGE_IDENTIFY' })).value;
  await dispatch(page, { type: 'ANMERKO_JOURNEY_PAGE_START', sessionId: 'session-1', epoch: 1,
    documentToken: identity.documentToken, startedAt: new Date().toISOString() });

  const prepared = await dispatch(page, { type: 'ANMERKO_JOURNEY_PAGE_PREPARE', captureId: 'capture-1', documentToken: identity.documentToken });
  expect(prepared).toMatchObject({ ok: true, value: { documentToken: identity.documentToken } });
  expect(await page.locator('anmerko-overlay, anmerko-image, anmerko-journey-strip').evaluateAll(elements => elements.map(element => ({
    display: (element as HTMLElement).style.getPropertyValue('display'),
    displayPriority: (element as HTMLElement).style.getPropertyPriority('display'),
    visibility: (element as HTMLElement).style.getPropertyValue('visibility'),
    visibilityPriority: (element as HTMLElement).style.getPropertyPriority('visibility'),
    captureHidden: element.getAttribute('data-anmerko-capture-hidden'),
  })))).toEqual([
    { display: 'none', displayPriority: 'important', visibility: 'hidden', visibilityPriority: 'important', captureHidden: '' },
    { display: 'none', displayPriority: 'important', visibility: 'hidden', visibilityPriority: 'important', captureHidden: '' },
    { display: 'none', displayPriority: 'important', visibility: 'hidden', visibilityPriority: 'important', captureHidden: '' },
  ]);
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_PAGE_FINISH', captureId: 'stale-capture' }))
    .toEqual({ ok: false, error: 'Journey command unavailable.' });
  await expect(page.locator('anmerko-overlay')).toHaveCSS('visibility', 'hidden');
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_PAGE_FINISH', captureId: 'capture-1' })).toMatchObject({ ok: true });
  expect(await page.locator('anmerko-overlay, anmerko-image, anmerko-journey-strip').evaluateAll(elements => elements.map(element => ({
    display: (element as HTMLElement).style.getPropertyValue('display'),
    displayPriority: (element as HTMLElement).style.getPropertyPriority('display'),
    visibility: (element as HTMLElement).style.getPropertyValue('visibility'),
    visibilityPriority: (element as HTMLElement).style.getPropertyPriority('visibility'),
    captureHidden: element.getAttribute('data-anmerko-capture-hidden'),
  })))).toEqual([
    { display: 'inline-flex', displayPriority: 'important', visibility: 'visible', visibilityPriority: 'important', captureHidden: null },
    { display: 'grid', displayPriority: '', visibility: 'collapse', visibilityPriority: '', captureHidden: 'original' },
    { display: 'block', displayPriority: 'important', visibility: '', visibilityPriority: '', captureHidden: null },
  ]);

  await dispatch(page, { type: 'ANMERKO_JOURNEY_PAGE_PREPARE', captureId: 'capture-stop', documentToken: identity.documentToken });
  await dispatch(page, { type: 'ANMERKO_JOURNEY_PAGE_STOP', sessionId: 'session-1', epoch: 2 });
  await expect(page.locator('anmerko-journey-strip')).toHaveCount(0);
  await expect(page.locator('anmerko-overlay')).toHaveCSS('visibility', 'visible');
  expect(await page.locator('anmerko-overlay').evaluate(element => (element as HTMLElement).style.getPropertyValue('display'))).toBe('inline-flex');
  expect(await page.locator('anmerko-overlay').evaluate(element => (element as HTMLElement).style.getPropertyPriority('display'))).toBe('important');
  expect(await page.locator('anmerko-image').evaluate(element => (element as HTMLElement).style.visibility)).toBe('collapse');
  expect(await page.locator('anmerko-image').evaluate(element => (element as HTMLElement).style.display)).toBe('grid');
  expect(await page.locator('anmerko-overlay').getAttribute('data-anmerko-capture-hidden')).toBeNull();
  expect(await page.locator('anmerko-image').getAttribute('data-anmerko-capture-hidden')).toBe('original');

  await page.evaluate(() => { (globalThis as BridgeWindow).bridgeHarness.shortenHideTimeout = true; });
  await dispatch(page, { type: 'ANMERKO_JOURNEY_PAGE_PREPARE', captureId: 'capture-timeout', documentToken: identity.documentToken });
  await expect(page.locator('anmerko-overlay')).toHaveCSS('visibility', 'hidden');
  await page.waitForTimeout(75);
  await expect(page.locator('anmerko-overlay')).toHaveCSS('visibility', 'visible');
  expect(await page.locator('anmerko-overlay').evaluate(element => (element as HTMLElement).style.display)).toBe('inline-flex');
  expect(await page.locator('anmerko-overlay').getAttribute('data-anmerko-capture-hidden')).toBeNull();
  expect(await page.locator('anmerko-image').getAttribute('data-anmerko-capture-hidden')).toBe('original');

  await dispatch(page, { type: 'ANMERKO_JOURNEY_PAGE_START', sessionId: 'session-2', epoch: 3,
    documentToken: identity.documentToken, startedAt: new Date().toISOString() });
  await dispatch(page, { type: 'ANMERKO_JOURNEY_PAGE_PREPARE', captureId: 'capture-pagehide', documentToken: identity.documentToken });
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  await expect(page.locator('anmerko-journey-strip')).toHaveCount(0);
  await expect(page.locator('anmerko-overlay')).toHaveCSS('visibility', 'visible');
  expect(await page.locator('anmerko-overlay').evaluate(element => (element as HTMLElement).style.display)).toBe('inline-flex');
  expect(await page.locator('anmerko-overlay').getAttribute('data-anmerko-capture-hidden')).toBeNull();
  expect(await page.locator('anmerko-image').getAttribute('data-anmerko-capture-hidden')).toBe('original');
  expect(await page.evaluate(() => (globalThis as BridgeWindow).bridgeHarness.listenerCount())).toBe(0);
});

test('prepare removes the real mounted overlay and nested visible image from captured pixels', async ({ page }) => {
  await page.evaluate(() => {
    document.body.style.cssText = 'margin:0;min-height:100vh;background:rgb(5,17,29)';
    const hostile = document.createElement('style');
    hostile.textContent = 'anmerko-overlay, anmerko-overlay[data-anmerko-capture-hidden] { display:block!important; visibility:visible!important; }';
    document.head.append(hostile);
  });
  await page.addScriptTag({ content: mountedOverlayBundle });
  await page.evaluate(() => (globalThis as any).mountJourneyCaptureFixture());
  const overlay = page.locator('anmerko-overlay');
  const beforeStyle = await overlay.evaluate(host => ({
    display: getComputedStyle(host).display,
    visibility: getComputedStyle(host).visibility,
  }));
  expect(beforeStyle).toEqual({ display: 'inline', visibility: 'visible' });
  const sample = await overlay.evaluate(host => {
    const image = host.shadowRoot!.querySelector('anmerko-image')!;
    const rect = image.getBoundingClientRect();
    return { x: Math.floor(rect.x + rect.width / 2), y: Math.floor(rect.y + rect.height / 2) };
  });
  expect(await screenshotPixel(page, sample.x, sample.y)).toEqual({ red: 255, green: 0, blue: 0, alpha: 255 });

  const identity = (await dispatch(page, { type: 'ANMERKO_JOURNEY_PAGE_IDENTIFY' })).value;
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_PAGE_PREPARE', captureId: 'capture-mounted', documentToken: identity.documentToken }))
    .toMatchObject({ ok: true });
  await expect(overlay).toHaveCSS('display', 'none');
  await expect(overlay).toHaveCSS('visibility', 'hidden');
  expect(await overlay.evaluate(host => getComputedStyle(host.shadowRoot!.querySelector('anmerko-image')!).visibility)).toBe('visible');
  expect(await screenshotPixel(page, sample.x, sample.y)).toEqual({ red: 5, green: 17, blue: 29, alpha: 255 });

  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_PAGE_FINISH', captureId: 'capture-mounted' })).toMatchObject({ ok: true });
  await expect(overlay).toHaveCSS('display', beforeStyle.display);
  await expect(overlay).toHaveCSS('visibility', beforeStyle.visibility);
  expect(await screenshotPixel(page, sample.x, sample.y)).toEqual({ red: 255, green: 0, blue: 0, alpha: 255 });
});
