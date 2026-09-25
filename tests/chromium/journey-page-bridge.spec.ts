import { expect, test, type Page } from '@playwright/test';
import { buildSync } from 'esbuild';
import { validateJourneyEventBatch } from '../../src/journey-events';

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
  strip(): { text: string; buttonHeight: number; hostMarkup: string; buttonRect: { x: number; y: number; width: number; height: number };
    hostRect: { x: number; y: number; width: number; height: number }; groupLabel: string | null; buttonLabel: string | null;
    alert: string | null } | null;
  listenerCount(): number;
};
type BridgeWindow = typeof globalThis & {
  anmerkoJourneyPageBridge: {
    bindJourneyPage(onDispose?: () => void): () => void;
    watchJourneyPageRecording(listener: (recording: boolean) => void): () => void;
    sidePanelJourneyCommands(): { journeyPhase(): Promise<string> };
  };
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
        const hostRect = host.getBoundingClientRect();
        return {
          text: stripRoot.textContent || '', buttonHeight: rect.height, hostMarkup: host.outerHTML,
          buttonRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          hostRect: { x: hostRect.x, y: hostRect.y, width: hostRect.width, height: hostRect.height },
          groupLabel: stripRoot.querySelector('[role="group"]')?.getAttribute('aria-label') ?? null,
          buttonLabel: button.getAttribute('aria-label'),
          alert: stripRoot.querySelector('[role="alert"]')?.textContent ?? null,
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
  expect(repeated.value.recording).toBeUndefined();

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

test('visual-viewport-only changes advance generation and update the visible viewport', async ({ page }) => {
  const first = (await dispatch(page, { type: 'ANMERKO_JOURNEY_PAGE_IDENTIFY' })).value;
  expect(first.generation).toBe(0);

  await page.evaluate(() => {
    const viewing = globalThis as BridgeWindow;
    viewing.disposeJourneyPage();
    const fake = Object.assign(new EventTarget(), {
      width: 1280, height: 720, offsetLeft: 0, offsetTop: 0, scale: 1,
    });
    Object.defineProperty(window, 'visualViewport', { value: fake, configurable: true });
    (window as any).anmerkoVisualViewportFake = fake;
    viewing.disposeJourneyPage = viewing.anmerkoJourneyPageBridge.bindJourneyPage();
  });

  const baseline = (await dispatch(page, { type: 'ANMERKO_JOURNEY_PAGE_IDENTIFY' })).value;
  expect(baseline.generation).toBe(0);
  expect(baseline.viewport).toEqual({ width: 1280, height: 720 });
  expect(baseline.scroll).toEqual({ x: 0, y: 0 });

  await page.evaluate(() => {
    const fake = (window as any).anmerkoVisualViewportFake;
    fake.width = 640; fake.height = 360; fake.scale = 2;
    fake.dispatchEvent(new Event('resize'));
  });
  const zoomed = (await dispatch(page, { type: 'ANMERKO_JOURNEY_PAGE_IDENTIFY' })).value;
  expect(zoomed.viewport).toEqual({ width: 640, height: 360 });
  expect(zoomed.generation).toBeGreaterThan(baseline.generation);

  await page.evaluate(() => {
    const fake = (window as any).anmerkoVisualViewportFake;
    fake.offsetLeft = 120; fake.offsetTop = 80;
    fake.dispatchEvent(new Event('scroll'));
  });
  const panned = (await dispatch(page, { type: 'ANMERKO_JOURNEY_PAGE_IDENTIFY' })).value;
  expect(panned.scroll).toEqual({ x: 120, y: 80 });
  expect(panned.viewport).toEqual({ width: 640, height: 360 });
  expect(panned.generation).toBeGreaterThan(zoomed.generation);
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
  expect((await dispatch(page, { type: 'ANMERKO_JOURNEY_PAGE_IDENTIFY' })).value.recording)
    .toEqual({ sessionId: 'session-1', epoch: 1 });
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
    .toEqual({ ok: false, error: 'Journey command unavailable.' });  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_PAGE_STATUS', sessionId: 'session-1', epoch: 1, count: 4 })).toMatchObject({ ok: true });
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
  expect((await dispatch(page, { type: 'ANMERKO_JOURNEY_PAGE_IDENTIFY' })).value.recording).toBeUndefined();
  await expect(page.locator('anmerko-journey-strip')).toHaveCount(0);
  expect(await page.evaluate(() => (globalThis as BridgeWindow).bridgeHarness.disconnectedPorts)).toEqual([0]);
  await page.getByRole('button', { name: 'Normal action' }).click();
  expect(await page.evaluate(() => (globalThis as BridgeWindow).bridgeHarness.portMessages)).toHaveLength(1);
  expect(await page.evaluate(() => (globalThis as BridgeWindow).normalActions)).toBe(3);
});

test('the strip follows the visual viewport above an on-screen keyboard, reports recording, and cleans up', async ({ page }) => {
  await page.evaluate(() => {
    const viewing = globalThis as BridgeWindow;
    viewing.disposeJourneyPage();
    const fake = Object.assign(new EventTarget(), {
      width: innerWidth, height: innerHeight, offsetLeft: 0, offsetTop: 0, scale: 1,
    });
    const signals: AbortSignal[] = [];
    const add = fake.addEventListener.bind(fake);
    fake.addEventListener = ((type: string, listener: EventListener, options?: AddEventListenerOptions) => {
      if (options?.signal) signals.push(options.signal);
      add(type, listener, options);
    }) as typeof fake.addEventListener;
    Object.defineProperty(window, 'visualViewport', { value: fake, configurable: true });
    const recordingEvents: boolean[] = [];
    Object.assign(window as any, { anmerkoVisualViewportFake: fake, anmerkoStripSignals: signals, anmerkoRecordingEvents: recordingEvents });
    viewing.anmerkoJourneyPageBridge.watchJourneyPageRecording(recording => recordingEvents.push(recording));
    viewing.disposeJourneyPage = viewing.anmerkoJourneyPageBridge.bindJourneyPage();
  });
  const identity = (await dispatch(page, { type: 'ANMERKO_JOURNEY_PAGE_IDENTIFY' })).value;
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_PAGE_START', sessionId: 'session-1', epoch: 1,
    documentToken: identity.documentToken, expectedUrl: identity.url, startedAt: new Date().toISOString() })).toMatchObject({ ok: true });
  expect(await page.evaluate(() => (window as any).anmerkoRecordingEvents)).toEqual([true]);
  const viewportHeight = await page.evaluate(() => innerHeight);
  const resting = (await page.evaluate(() => (globalThis as BridgeWindow).bridgeHarness.strip()))!.buttonRect;
  expect(resting.y + resting.height).toBeLessThanOrEqual(viewportHeight - 12);
  // The floating panel reserves the bottom 72px while recording (panel.css); the strip fits inside it.
  expect((await page.locator('anmerko-journey-strip').boundingBox())!.y).toBeGreaterThanOrEqual(viewportHeight - 72);

  // A collapsing browser toolbar covers less than a keyboard: the strip stays
  // on the visible bottom edge.
  await page.evaluate(() => {
    const fake = (window as any).anmerkoVisualViewportFake;
    fake.height = innerHeight - 60;
    fake.dispatchEvent(new Event('resize'));
  });
  const lifted = (await page.evaluate(() => (globalThis as BridgeWindow).bridgeHarness.strip()))!.buttonRect;
  expect(lifted.y + lifted.height).toBeLessThanOrEqual(viewportHeight - 60 - 12);
  expect(lifted.y + lifted.height).toBeGreaterThan(viewportHeight - 60 - 40);

  // A 300px keyboard covers the bottom of the layout viewport, where the
  // browser scrolls the field being typed into: the strip moves to the top.
  await page.evaluate(() => {
    const fake = (window as any).anmerkoVisualViewportFake;
    fake.height = innerHeight - 300;
    fake.dispatchEvent(new Event('resize'));
  });
  const raised = (await page.evaluate(() => (globalThis as BridgeWindow).bridgeHarness.strip()))!.hostRect;
  expect(raised.y).toBe(12);
  expect(raised.y + raised.height).toBeLessThanOrEqual(viewportHeight - 300 - 12);

  // Scrolling the visual viewport while the keyboard is open keeps it on the visible top edge.
  await page.evaluate(() => {
    const fake = (window as any).anmerkoVisualViewportFake;
    fake.offsetTop = 100;
    fake.dispatchEvent(new Event('scroll'));
  });
  const panned = (await page.evaluate(() => (globalThis as BridgeWindow).bridgeHarness.strip()))!.hostRect;
  expect(panned.y).toBe(112);

  // Once the keyboard closes the strip returns to the bottom edge.
  await page.evaluate(() => {
    const fake = (window as any).anmerkoVisualViewportFake;
    fake.offsetTop = 0;
    fake.height = innerHeight;
    fake.dispatchEvent(new Event('resize'));
  });
  const lowered = (await page.evaluate(() => (globalThis as BridgeWindow).bridgeHarness.strip()))!.buttonRect;
  expect(lowered.y + lowered.height).toBeLessThanOrEqual(viewportHeight - 12);
  expect(lowered.y + lowered.height).toBeGreaterThan(viewportHeight - 40);

  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_PAGE_STOP', sessionId: 'session-1', epoch: 1 })).toMatchObject({ ok: true });
  await expect(page.locator('anmerko-journey-strip')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).anmerkoRecordingEvents)).toEqual([true, false]);
  const signals = await page.evaluate(() => ((window as any).anmerkoStripSignals as AbortSignal[]).map(signal => signal.aborted));
  expect(signals.length).toBeGreaterThan(0);
  expect(signals.every(Boolean)).toBe(true);
});

// Firefox for Android with its keyboard open: the focused field sits at the
// bottom of a 526px visual viewport (493–530), where the strip used to be.
test('the strip keeps clear of the field being typed into while the keyboard is open', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => {
    const viewing = globalThis as BridgeWindow;
    viewing.disposeJourneyPage();
    const fake = Object.assign(new EventTarget(), { width: innerWidth, height: innerHeight, offsetLeft: 0, offsetTop: 0, scale: 1 });
    Object.defineProperty(window, 'visualViewport', { value: fake, configurable: true });
    (window as any).anmerkoVisualViewportFake = fake;
    document.body.innerHTML = `
      <input id="low" aria-label="Low field" style="position:fixed;left:20px;top:493px;height:37px;width:260px;margin:0;box-sizing:border-box">
      <textarea id="high" aria-label="High field" style="position:fixed;left:20px;top:14px;height:40px;width:260px;margin:0;box-sizing:border-box"></textarea>
      <button id="plain" style="position:fixed;left:20px;top:300px">Plain</button>`;
    viewing.disposeJourneyPage = viewing.anmerkoJourneyPageBridge.bindJourneyPage();
  });
  const identity = (await dispatch(page, { type: 'ANMERKO_JOURNEY_PAGE_IDENTIFY' })).value;
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_PAGE_START', sessionId: 'session-1', epoch: 1,
    documentToken: identity.documentToken, expectedUrl: identity.url, startedAt: new Date().toISOString() })).toMatchObject({ ok: true });
  const keyboard = (height: number) => page.evaluate(value => {
    const fake = (window as any).anmerkoVisualViewportFake;
    fake.height = value;
    fake.dispatchEvent(new Event('resize'));
  }, height);
  const clear = async (selector: string, visibleHeight: number) => {
    const strip = (await page.evaluate(() => (globalThis as BridgeWindow).bridgeHarness.strip()))!.hostRect;
    const field = (await page.locator(selector).boundingBox())!;
    const overlaps = strip.y < field.y + field.height && field.y < strip.y + strip.height;
    expect(overlaps, `${selector}: strip ${JSON.stringify(strip)} field ${JSON.stringify(field)}`).toBe(false);
    expect(strip.y).toBeGreaterThanOrEqual(0);
    expect(strip.y + strip.height).toBeLessThanOrEqual(visibleHeight);
    return strip;
  };

  await page.locator('#low').focus();
  await keyboard(526);
  expect((await clear('#low', 526)).y).toBe(12);
  // Focus alone moves it too, before the keyboard resizes anything.
  await keyboard(844);
  await page.locator('#plain').focus();
  await expect.poll(async () => (await page.evaluate(() => (globalThis as BridgeWindow).bridgeHarness.strip()))!.hostRect.y).toBeGreaterThan(700);
  await page.locator('#low').focus();
  expect((await clear('#low', 844)).y).toBe(12);

  // A field at the top keeps the strip on the bottom edge, above the keyboard.
  await page.locator('#high').focus();
  await keyboard(526);
  const low = await clear('#high', 526);
  expect(low.y + low.height).toBeGreaterThan(526 - 40);

  // Leaving the fields returns the strip to the bottom edge.
  await keyboard(844);
  await page.locator('#plain').focus();
  await expect.poll(async () => {
    const strip = (await page.evaluate(() => (globalThis as BridgeWindow).bridgeHarness.strip()))!.hostRect;
    return strip.y + strip.height;
  }).toBe(844 - 12);
});

test('the strip is a labelled group whose Stop names the journey and whose failure wraps and is announced', async ({ page }) => {
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 700 });
    const identity = (await dispatch(page, { type: 'ANMERKO_JOURNEY_PAGE_IDENTIFY' })).value;
    expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_PAGE_START', sessionId: `session-${width}`, epoch: 1,
      documentToken: identity.documentToken, expectedUrl: identity.url, count: 12, startedAt: new Date().toISOString() })).toMatchObject({ ok: true });
    let strip = (await page.evaluate(() => (globalThis as BridgeWindow).bridgeHarness.strip()))!;
    expect(strip.groupLabel).toBe('anmerko journey recording');
    expect(strip.buttonLabel).toBe('Stop recording journey');
    expect(strip.alert).toBe('');
    await page.evaluate(() => { (globalThis as BridgeWindow).bridgeHarness.response = { ok: false, error: 'private failure' }; });
    await page.mouse.click(strip.buttonRect.x + strip.buttonRect.width / 2, strip.buttonRect.y + strip.buttonRect.height / 2);
    await expect.poll(async () => (await page.evaluate(() => (globalThis as BridgeWindow).bridgeHarness.strip()))!.alert)
      .toBe('Could not stop the journey. Try again.');
    strip = (await page.evaluate(() => (globalThis as BridgeWindow).bridgeHarness.strip()))!;
    expect(strip.hostRect.x).toBe(12);
    expect(strip.hostRect.x + strip.hostRect.width, `${width}px`).toBeLessThanOrEqual(width - 12);
    expect(strip.hostRect.y + strip.hostRect.height, `${width}px`).toBeLessThanOrEqual(700 - 12);
    expect(await page.evaluate(() => document.documentElement.scrollWidth), `${width}px`).toBeLessThanOrEqual(width);
    expect(strip.buttonRect.height).toBeGreaterThanOrEqual(44);
    await page.evaluate(() => { (globalThis as BridgeWindow).bridgeHarness.response = { ok: true }; });
    expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_PAGE_STOP', sessionId: `session-${width}`, epoch: 1 })).toMatchObject({ ok: true });
  }
});

test('the native side panel asks the background for the journey phase alone', async ({ page }) => {
  const ask = (response: unknown) => page.evaluate(async value => {
    const viewing = globalThis as BridgeWindow;
    viewing.bridgeHarness.response = value;
    viewing.bridgeHarness.sent.length = 0;
    try { return { phase: await viewing.anmerkoJourneyPageBridge.sidePanelJourneyCommands().journeyPhase(), sent: viewing.bridgeHarness.sent }; }
    catch (error) { return { error: (error as Error).message, code: (error as { code?: string }).code, sent: viewing.bridgeHarness.sent }; }
  }, response);
  expect(await ask({ ok: true, value: 'reviewing' })).toEqual({ phase: 'reviewing', sent: [{ type: 'ANMERKO_JOURNEY_PHASE' }] });
  expect(await ask({ ok: true, value: 'saved' })).toMatchObject({ phase: 'saved' });
  // Anything but a phase, such as a whole session, is refused.
  expect(await ask({ ok: true, value: { phase: 'reviewing' } })).toMatchObject({ error: 'Journey command unavailable.' });
  expect(await ask(undefined)).toMatchObject({ error: 'Could not update the journey.' });
  expect(await ask({ ok: false, error: 'Journey storage failed.', code: 'session-storage-failed' }))
    .toMatchObject({ error: 'Journey storage failed.', code: 'session-storage-failed' });
});

test('entered values collect only with an explicit flag and merge before the click', async ({ page }) => {
  await page.evaluate(() => {
    document.body.innerHTML = '<input type="text" name="nickname" aria-label="Nickname"><button type="button">Send</button>';
  });
  const identity = (await dispatch(page, { type: 'ANMERKO_JOURNEY_PAGE_IDENTIFY' })).value;
  const startedAt = new Date().toISOString();
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_PAGE_START', sessionId: 'session-1', epoch: 1,
    documentToken: identity.documentToken, expectedUrl: identity.url, startedAt, includeEnteredValues: 'yes' }))
    .toEqual({ ok: false, error: 'Journey command unavailable.' });
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_PAGE_START', sessionId: 'session-1', epoch: 1,
    documentToken: identity.documentToken, expectedUrl: identity.url, startedAt }))
    .toMatchObject({ ok: true });

  await page.getByLabel('Nickname').fill('green');
  await page.getByRole('button', { name: 'Send' }).click();
  let portMessages = await page.evaluate(() => (globalThis as BridgeWindow).bridgeHarness.portMessages);
  expect(portMessages).toHaveLength(1);
  expect(portMessages[0].batch.events.map((event: any) => event.kind)).toEqual(['click']);
  expect(portMessages[0].batch.events.every((event: any) => !('enteredValue' in event))).toBe(true);

  await dispatch(page, { type: 'ANMERKO_JOURNEY_PAGE_STOP', sessionId: 'session-1', epoch: 1 });
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_PAGE_START', sessionId: 'session-1', epoch: 2,
    documentToken: identity.documentToken, expectedUrl: identity.url, startedAt, includeEnteredValues: true }))
    .toMatchObject({ ok: true });
  await page.getByLabel('Nickname').fill('blue');
  await page.getByRole('button', { name: 'Send' }).click();
  portMessages = await page.evaluate(() => (globalThis as BridgeWindow).bridgeHarness.portMessages);
  expect(portMessages).toHaveLength(2);
  expect(portMessages[1].batch.events.map((event: any) => event.kind)).toEqual(['field-change', 'click']);
  expect(portMessages[1].batch.events[0].enteredValue).toEqual({ kind: 'text', value: 'blue', truncated: false });
});

test('a tap right after an excluded password edit keeps a valid click while the keyboard pans the viewport', async ({ page }) => {
  await page.evaluate(() => {
    document.body.innerHTML = '<input type="password" name="password" aria-label="Password">'
      + '<button type="button" style="position:absolute;left:40px;top:600px">Sign in</button>';
    document.querySelector('button')!.addEventListener('click', () => history.pushState(null, '', '#signed-in'));
  });
  const identity = (await dispatch(page, { type: 'ANMERKO_JOURNEY_PAGE_IDENTIFY' })).value;
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_PAGE_START', sessionId: 'session-1', epoch: 1,
    documentToken: identity.documentToken, expectedUrl: identity.url, startedAt: new Date().toISOString(),
    includeEnteredValues: true })).toMatchObject({ ok: true });

  await page.getByLabel('Password').fill('correct horse');
  // Editing the field raised the soft keyboard: the visible viewport is the
  // top 400 px of the layout viewport, panned down 300 px to keep the field
  // and the button in view.
  await page.evaluate(() => {
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: { width: 1280, height: 400, offsetLeft: 0, offsetTop: 300, scale: 1,
        addEventListener() {}, removeEventListener() {} },
    });
  });
  const button = await page.getByRole('button', { name: 'Sign in' }).boundingBox();
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/#signed-in$/);

  const portMessages = await page.evaluate(() => (globalThis as BridgeWindow).bridgeHarness.portMessages);
  expect(portMessages).toHaveLength(1);
  const batch = portMessages[0].batch;
  expect(batch.events.map((event: any) => event.kind)).toEqual(['click']);
  expect(JSON.stringify(batch)).not.toContain('correct horse');
  expect(batch.events[0].target).toMatchObject({
    label: 'Sign in', viewport: { width: 1280, height: 400 }, scroll: { x: 0, y: 300 },
  });
  // The point is measured from the visible viewport's corner, like the screenshot.
  const { point } = batch.events[0].target;
  expect(Math.abs(point.x - (button!.x + button!.width / 2))).toBeLessThanOrEqual(1);
  expect(Math.abs(point.y - (button!.y + button!.height / 2 - 300))).toBeLessThanOrEqual(1);
  // The background drops a whole batch whose click point lies outside its viewport.
  expect(validateJourneyEventBatch(batch)).toMatchObject({ ok: true });
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
