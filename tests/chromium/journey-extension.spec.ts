import { expect, test, type Page } from '@playwright/test';
import { buildSync } from 'esbuild';
import { JOURNEY_LIMITATIONS } from '../../src/journey-limits';

type Sender = { id?: string; url?: string; frameId?: number; tab?: { id?: number; windowId: number; active?: boolean; url?: string } };
type Harness = {
  dispatch(message: unknown, sender: Sender): Promise<any>;
  connectPort(name: string, sender: Sender): number;
  postPort(index: number, message: unknown): void;
  disconnectPort(index: number): void;
  ports: Array<{ name: string; disconnected: boolean; replies: unknown[] }>;
  pageCommands: any[];
  broadcasts: any[];
  actions: any[];
  createdTabs: any[];
  removedTabs: number[];
  tabUpdates: any[];
  windowUpdates: any[];
  scriptingCalls: any[];
  sessionStorage: Record<string, unknown>;
  alarmCreates: any[];
  alarmClears: string[];
  failStorageSet: boolean;
  failStorageRemove: boolean;
  failStorageGet: boolean;
  failAlarmCreate: boolean;
  deferStorageSet: boolean;
  releaseStorageSet?: () => void;
  failPageStopCount: number;
  sequence: string[];
  tabs: Record<number, { id: number; windowId: number; active: boolean; url: string }>;
  identity: { documentToken: string; url: string; viewport: { width: number; height: number }; scroll: { x: number; y: number }; generation: number; visible: boolean;
    recording?: { sessionId: string; epoch: number } };
  focusedWindowId: number;
  wait: number;
  prepareMismatch: boolean;
  deferPrepare: boolean;
  releasePrepare?: () => void;
  pendingStart?: Promise<unknown>;
  navigationAvailable: boolean;
  deferTabUpdate: boolean;
  releaseTabUpdate?: () => void;
  deferIdentify: boolean;
  releaseIdentify?: () => void;
  deferPageStart: boolean;
  releasePageStart?: () => void;
  deferInjection: boolean;
  releaseInjection?: () => void;
  deferOwnerCheck: boolean;
  releaseOwnerCheck?: () => void;
  deferTabCreate: boolean;
  releaseTabCreate?: () => void;
  captureMode: 'normal' | 'away-and-back' | 'throw';
  events: {
    activated: { emit(value: unknown): void; count(): number };
    updated: { emit(...values: unknown[]): void; count(): number };
    removed: { emit(...values: unknown[]): void; count(): number };
    replaced: { emit(...values: unknown[]): void; count(): number };
    focused: { emit(value: unknown): void; count(): number };
    alarm: { emit(value: unknown): void; count(): number };
    committed: { emit(value: unknown): void; count(): number; filters(): unknown[] };
    history: { emit(value: unknown): void; count(): number; filters(): unknown[] };
    fragment: { emit(value: unknown): void; count(): number; filters(): unknown[] };
  };
  control: { ready: Promise<void>; stopIfRecording(): boolean; openReviewIfAvailable(): boolean };
  reboot(): void;
};
type HarnessWindow = typeof globalThis & { journeyExtension: { bindJourneyExtension(service: { capture(windowId: number): Promise<string>; waitMs(): number }): Harness['control'] }; harness: Harness };

const bundle = buildSync({
  entryPoints: ['src/journey-extension.ts'],
  bundle: true,
  write: false,
  format: 'iife',
  globalName: 'journeyExtension',
}).outputFiles[0].text;

const sidebar = { id: 'test-extension', url: 'chrome-extension://test-extension/sidebar.html' };
const reviewPage = { id: 'test-extension', url: 'chrome-extension://test-extension/journey.html', frameId: 0,
  tab: { id: 80, windowId: 7, active: true, url: 'chrome-extension://test-extension/journey.html' } };
const ownerPage = { id: 'test-extension', url: 'https://example.test/path?item=1#top', frameId: 0,
  tab: { id: 1, windowId: 7, active: true, url: 'https://example.test/path?item=1#top' } };

async function dispatch(page: Page, message: unknown, sender: Sender = sidebar) {
  return page.evaluate(({ message, sender }) => (globalThis as HarnessWindow).harness.dispatch(message, sender), { message, sender });
}

type MaskRect = { x: number; y: number; width: number; height: number };
type ArchiveWindow = typeof globalThis & {
  journeyArchive: { journeyArchive(draft: unknown): Uint8Array<ArrayBuffer> };
};

const archiveBundle = buildSync({
  stdin: { contents: "export { journeyArchive } from './src/journey-export';", resolveDir: process.cwd() },
  bundle: true,
  write: false,
  format: 'iife',
  globalName: 'journeyArchive',
}).outputFiles[0].text;

const unavailable = { ok: false, error: 'Journey command unavailable.' };
const staleReview = { ...unavailable, code: 'stale-review' };

// An 8×4 capture with a red left half and a blue right half, so masked and
// untouched pixels are both recognizable after every re-encode.
async function usePatternedCapture(page: Page) {
  await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 8; canvas.height = 4;
    const context = canvas.getContext('2d')!;
    context.fillStyle = 'rgb(220, 40, 40)'; context.fillRect(0, 0, 4, 4);
    context.fillStyle = 'rgb(40, 40, 220)'; context.fillRect(4, 0, 4, 4);
    (globalThis as any).__journeyPng = canvas.toDataURL('image/png');
  });
}

function patternedPixels(masks: MaskRect[]): number[][] {
  const pixels: number[][] = [];
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 8; x++) {
      const masked = masks.some(rect => x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height);
      pixels.push(masked ? [0, 0, 0, 255] : x < 4 ? [220, 40, 40, 255] : [40, 40, 220, 255]);
    }
  }
  return pixels;
}

async function dataUrlPixels(page: Page, dataUrl: string): Promise<number[][]> {
  return page.evaluate(async dataUrl => {
    const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d')!;
    context.drawImage(bitmap, 0, 0);
    const data = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    const pixels: number[][] = [];
    for (let index = 0; index < data.length; index += 4) pixels.push(Array.from(data.slice(index, index + 4)));
    return pixels;
  }, dataUrl);
}

// Stands in for the review editor: flattens an opaque mask into a copy.
async function maskedPng(page: Page, dataUrl: string, rect: MaskRect): Promise<string> {
  return page.evaluate(async ({ dataUrl, rect }) => {
    const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext('2d')!;
    context.drawImage(bitmap, 0, 0);
    context.fillStyle = '#000';
    context.fillRect(rect.x, rect.y, rect.width, rect.height);
    return canvas.toDataURL('image/png');
  }, { dataUrl, rect });
}

async function reviewWithClickScreenshot(page: Page) {
  await usePatternedCapture(page);
  await dispatch(page, { type: 'ANMERKO_JOURNEY_START', ownerTabId: 1, ownerWindowId: 7 });
  const recording = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value;
  await page.evaluate(({ owner, state }) => {
    const harness = (globalThis as HarnessWindow).harness;
    const port = harness.connectPort('anmerko-journey-events-v1', owner);
    harness.postPort(port, { type: 'ANMERKO_JOURNEY_EVENTS', batch: {
      schemaVersion: 1, sessionId: state.sessionId, epoch: state.epoch,
      documentToken: state.documentToken, localCounter: 1,
      events: [{
        kind: 'click', id: 'image-click', observedAt: new Date().toISOString(), elapsedMs: 20,
        sourceUrl: 'https://example.test/path?item=1#top',
        target: { tag: 'button', selectorPath: ['button'], label: 'Pay', editable: false,
          viewport: { width: 1280, height: 720 }, scroll: { x: 0, y: 10 }, point: { x: 20, y: 20 } },
        image: { status: 'pending', captureId: 'image-click-capture' },
      }],
    } });
  }, { owner: ownerPage, state: recording });
  await expect.poll(async () => (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value.draft.steps
    .map((step: any) => step.image.status)).toEqual(['retained', 'retained']);
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_STOP' })).toEqual({ ok: true });
  const reviewing = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value;
  expect(reviewing.phase).toBe('reviewing');
  return reviewing;
}

test.beforeEach(async ({ page }) => {
  await page.goto('http://127.0.0.1:4173/journey');
  await page.evaluate(() => {
    function extensionEvent() {
      const listeners: Array<(...values: any[]) => void> = [];
      const filters: unknown[] = [];
      return {
        addListener(listener: (...values: any[]) => void, filter?: unknown) { listeners.push(listener); filters.push(filter); },
        removeListener(listener: (...values: any[]) => void) {
          const index = listeners.indexOf(listener);
          if (index >= 0) { listeners.splice(index, 1); filters.splice(index, 1); }
        },
        // Browsers dispatch to the listeners registered when the event fired.
        emit(...values: any[]) { for (const listener of listeners.slice()) listener(...values); },
        count() { return listeners.length; },
        filters() { return structuredClone(filters); },
        clear() { listeners.length = 0; filters.length = 0; },
      };
    }
    const runtimeMessage = extensionEvent();
    const runtimeConnect = extensionEvent();
    const activated = extensionEvent();
    const updated = extensionEvent();
    const removed = extensionEvent();
    const replaced = extensionEvent();
    const focused = extensionEvent();
    const alarm = extensionEvent();
    const committed = extensionEvent();
    const history = extensionEvent();
    const fragment = extensionEvent();
    const canvas = document.createElement('canvas');
    canvas.width = 3; canvas.height = 2;
    canvas.getContext('2d')!.fillRect(0, 0, 3, 2);
    const png = canvas.toDataURL('image/png');
    const harness: Harness = {
      pageCommands: [], broadcasts: [], actions: [], createdTabs: [], removedTabs: [], ports: [],
      tabUpdates: [], windowUpdates: [], scriptingCalls: [], sequence: [],
      sessionStorage: {}, alarmCreates: [], alarmClears: [], failStorageSet: false, failStorageRemove: false,
      failStorageGet: false, failAlarmCreate: false, deferStorageSet: false, failPageStopCount: 0,
      tabs: {
        1: { id: 1, windowId: 7, active: true, url: 'https://private:secret@example.test/path?item=1#top' },
        2: { id: 2, windowId: 7, active: false, url: 'https://other.test/' },
      },
      identity: {
        documentToken: 'document-1', url: 'https://private:secret@example.test/path?item=1#top',
        viewport: { width: 1280, height: 720 }, scroll: { x: 0, y: 10 }, generation: 0, visible: true,
      },
      focusedWindowId: 7, wait: 1, prepareMismatch: false, deferPrepare: false,
      navigationAvailable: true, deferTabUpdate: false,
      deferIdentify: false, deferPageStart: false, deferInjection: false, deferOwnerCheck: false, deferTabCreate: false, captureMode: 'normal',
      events: { activated, updated, removed, replaced, focused, alarm, committed, history, fragment },
      control: undefined as unknown as Harness['control'],
      reboot: undefined as unknown as Harness['reboot'],
      dispatch(message, sender) {
        const listener = (runtimeMessage as any).emitListener as undefined | ((message: unknown, sender: Sender, respond: (value: unknown) => void) => boolean | void);
        if (!listener) return Promise.resolve(undefined);
        return new Promise(resolve => {
          let answered = false;
          const respond = (value: unknown) => { if (!answered) { answered = true; resolve(value); } };
          const pending = listener(message, sender, respond);
          if (pending !== true && !answered) queueMicrotask(() => resolve(undefined));
        });
      },
      connectPort(name, sender) {
        const onMessage = extensionEvent();
        const onDisconnect = extensionEvent();
        const record = { name, disconnected: false, replies: [] as unknown[] };
        const port = {
          name,
          sender: structuredClone(sender),
          onMessage,
          onDisconnect,
          postMessage(message: unknown) { record.replies.push(structuredClone(message)); },
          disconnect() {
            if (record.disconnected) return;
            record.disconnected = true;
            onDisconnect.emit();
          },
        };
        const index = harness.ports.push(record) - 1;
        (record as any).port = port;
        runtimeConnect.emit(port);
        return index;
      },
      postPort(index, message) { (harness.ports[index] as any).port.onMessage.emit(structuredClone(message)); },
      disconnectPort(index) { (harness.ports[index] as any).port.disconnect(); },
    };
    const originalAdd = runtimeMessage.addListener;
    runtimeMessage.addListener = (listener: (...values: any[]) => void) => {
      (runtimeMessage as any).emitListener = listener;
      originalAdd.call(runtimeMessage, listener);
    };
    (globalThis as any).chrome = {
      runtime: {
        id: 'test-extension',
        getURL: (path: string) => `chrome-extension://test-extension/${path}`,
        onMessage: runtimeMessage,
        onConnect: runtimeConnect,
        sendMessage: async (message: unknown) => { harness.broadcasts.push(structuredClone(message)); },
      },
      tabs: {
        get: async (tabId: number) => structuredClone(harness.tabs[tabId]),
        create: async (details: { url: string }) => {
          harness.createdTabs.push(structuredClone(details));
          const id = 80 + harness.createdTabs.length;
          const created = { id, windowId: 7, active: true, url: details.url };
          harness.tabs[id] = created;
          for (const tab of Object.values(harness.tabs)) if (tab.windowId === created.windowId && tab.id !== id) tab.active = false;
          harness.events.activated.emit({ tabId: id, windowId: created.windowId });
          if (harness.deferTabCreate) await new Promise<void>(resolve => { harness.releaseTabCreate = resolve; });
          return structuredClone(created);
        },
        update: async (tabId: number, details: { active?: boolean; url?: string }) => {
          harness.tabUpdates.push({ tabId, details: structuredClone(details) });
          if (harness.deferTabUpdate) await new Promise<void>(resolve => { harness.releaseTabUpdate = resolve; });
          const tab = harness.tabs[tabId];
          if (!tab) throw new Error('missing tab');
          if (details.url !== undefined) tab.url = details.url;
          if (details.active) {
            for (const other of Object.values(harness.tabs)) if (other.windowId === tab.windowId) other.active = false;
            tab.active = true;
            harness.events.activated.emit({ tabId, windowId: tab.windowId });
          }
          return structuredClone(tab);
        },
        remove: async (tabId: number) => {
          harness.removedTabs.push(tabId);
          delete harness.tabs[tabId];
          harness.events.removed.emit(tabId, { windowId: 7 });
        },
        sendMessage: async (tabId: number, message: any, options?: unknown) => {
          harness.pageCommands.push({ tabId, message: structuredClone(message), options: structuredClone(options) });
          harness.sequence.push(message.type);
          if (message.type === 'ANMERKO_JOURNEY_PAGE_IDENTIFY') {
            if (harness.deferIdentify) await new Promise<void>(resolve => { harness.releaseIdentify = resolve; });
            return { ok: true, value: structuredClone(harness.identity) };
          }
          if (message.type === 'ANMERKO_JOURNEY_PAGE_START' && harness.deferPageStart) {
            await new Promise<void>(resolve => { harness.releasePageStart = resolve; });
          }
          if (message.type === 'ANMERKO_JOURNEY_PAGE_START') {
            harness.identity.recording = { sessionId: message.sessionId, epoch: message.epoch };
          }
          const recording = harness.identity.recording;
          if (message.type === 'ANMERKO_JOURNEY_PAGE_STOP' && harness.failPageStopCount > 0) {
            harness.failPageStopCount -= 1;
            throw new Error('page stop failed');
          }
          if (message.type === 'ANMERKO_JOURNEY_PAGE_STOP'
            && recording
            && recording.sessionId === message.sessionId
            && message.epoch >= recording.epoch) delete harness.identity.recording;
          if (message.type === 'ANMERKO_JOURNEY_PAGE_PREPARE') {
            const value = structuredClone(harness.identity);
            if (harness.prepareMismatch) value.generation++;
            if (harness.deferPrepare) return new Promise(resolve => {
              harness.releasePrepare = () => resolve({ ok: true, value });
            });
            return { ok: true, value };
          }
          if (message.type === 'ANMERKO_JOURNEY_PAGE_FINISH') return { ok: true, value: structuredClone(harness.identity) };
          return { ok: true, value: structuredClone(harness.identity) };
        },
        onActivated: activated, onUpdated: updated, onRemoved: removed, onReplaced: replaced,
      },
      windows: {
        get: async (windowId: number) => {
          if (harness.deferOwnerCheck) await new Promise<void>(resolve => { harness.releaseOwnerCheck = resolve; });
          return { id: windowId, focused: harness.focusedWindowId === windowId };
        },
        update: async (windowId: number, details: { focused?: boolean }) => {
          harness.windowUpdates.push({ windowId, details: structuredClone(details) });
          if (details.focused) harness.focusedWindowId = windowId;
          return { id: windowId, focused: harness.focusedWindowId === windowId };
        },
        onFocusChanged: focused,
      },
      storage: {
        session: {
          async get(keys: string[]) {
            if (harness.failStorageGet) throw new Error('session storage get failed');
            return Object.fromEntries(keys.filter(key => Object.hasOwn(harness.sessionStorage, key))
              .map(key => [key, structuredClone(harness.sessionStorage[key])]));
          },
          async set(items: Record<string, unknown>) {
            if (harness.deferStorageSet) await new Promise<void>(resolve => { harness.releaseStorageSet = resolve; });
            if (harness.failStorageSet) throw new Error('session storage set failed');
            Object.assign(harness.sessionStorage, structuredClone(items));
          },
          async remove(keys: string[]) {
            if (harness.failStorageRemove) throw new Error('session storage remove failed');
            for (const key of keys) delete harness.sessionStorage[key];
          },
        },
      },
      alarms: {
        async create(name: string, info: unknown) {
          if (harness.failAlarmCreate) throw new Error('alarm create failed');
          harness.alarmCreates.push({ name, info: structuredClone(info) });
        },
        async clear(name: string) { harness.alarmClears.push(name); return true; },
        onAlarm: alarm,
      },
      scripting: {
        executeScript: async (details: unknown) => {
          harness.scriptingCalls.push(structuredClone(details));
          harness.sequence.push('executeScript');
          if (harness.deferInjection) await new Promise<void>(resolve => { harness.releaseInjection = resolve; });
          return [{ frameId: 0, result: undefined }];
        },
      },
      action: {
        setBadgeText: async (details: unknown) => { harness.actions.push({ method: 'badge', details: structuredClone(details) }); },
        setTitle: async (details: unknown) => { harness.actions.push({ method: 'title', details: structuredClone(details) }); },
      },
    };
    Object.defineProperty((globalThis as any).chrome, 'webNavigation', {
      configurable: true,
      get() {
        if (!harness.navigationAvailable) return undefined;
        return { onCommitted: committed, onHistoryStateUpdated: history, onReferenceFragmentUpdated: fragment };
      },
    });
    (globalThis as HarnessWindow).harness = harness;
    (harness as any).eventBuses = [runtimeMessage, runtimeConnect, activated, updated, removed, replaced,
      focused, alarm, committed, history, fragment];
    (harness as any).runtimeMessage = runtimeMessage;
    (globalThis as any).__journeyPng = png;
  });
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).harness;
    const bind = () => (globalThis as HarnessWindow).journeyExtension.bindJourneyExtension({
      waitMs() { harness.sequence.push('wait'); return harness.wait; },
      async capture() {
        harness.sequence.push('capture');
        if (harness.captureMode === 'throw') throw new Error('private capture error');
        if (harness.captureMode === 'away-and-back') {
          harness.tabs[1].active = false; harness.tabs[2].active = true;
          harness.events.activated.emit({ windowId: 7, tabId: 2 });
          harness.tabs[2].active = false; harness.tabs[1].active = true;
          harness.events.activated.emit({ windowId: 7, tabId: 1 });
        }
        return (globalThis as any).__journeyPng;
      },
    });
    harness.control = bind();
    harness.reboot = () => {
      for (const event of (harness as any).eventBuses) event.clear();
      delete (harness as any).runtimeMessage.emitListener;
      harness.control = bind();
    };
  });
});

test('accepts only the exact sidebar owner and starts with a normalized private capture', async ({ page }) => {
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' }, ownerPage)).toBeUndefined();
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' }, { ...sidebar, id: 'other-extension' })).toBeUndefined();
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' }, { ...sidebar, url: 'chrome-extension://test-extension/popup.html' })).toBeUndefined();
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' }, { ...sidebar, tab: ownerPage.tab })).toBeUndefined();

  const invalid = await dispatch(page, { type: 'ANMERKO_JOURNEY_START', ownerTabId: 1, ownerWindowId: 8 });
  expect(invalid).toEqual({ ok: false, error: 'Journey command unavailable.', code: 'owner-unavailable' });
  expect((await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value).toEqual({ phase: 'idle', epoch: 0 });

  const started = await dispatch(page, { type: 'ANMERKO_JOURNEY_START', ownerTabId: 1, ownerWindowId: 7 });
  expect(started).toMatchObject({ ok: true });
  const state = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value;
  expect(state).toMatchObject({ phase: 'recording', ownerTabId: 1, ownerWindowId: 7, documentToken: 'document-1' });
  expect(state.draft.steps).toHaveLength(1);
  expect(state.draft.steps[0]).toMatchObject({ kind: 'initial', sourceUrl: 'https://example.test/path?item=1#top' });
  const image = Object.values(state.draft.images)[0] as any;
  expect(image).toMatchObject({ captureUrl: 'https://example.test/path?item=1#top', width: 3, height: 2, viewport: { width: 1280, height: 720 }, scroll: { x: 0, y: 10 } });
  expect(image.dataUrl).toMatch(/^data:image\/png;base64,/);
  expect(Number.isFinite(Date.parse(image.capturedAt))).toBe(true);
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_START', ownerTabId: 1, ownerWindowId: 7 }))
    .toEqual({ ok: false, error: 'Journey command unavailable.', code: 'busy' });

  const facts = await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).harness;
    return { sequence: harness.sequence, commands: harness.pageCommands, broadcasts: harness.broadcasts, actions: harness.actions };
  });
  expect(facts.sequence.indexOf('wait')).toBeLessThan(facts.sequence.indexOf('ANMERKO_JOURNEY_PAGE_PREPARE'));
  expect(facts.sequence).toContain('capture');
  expect(facts.sequence.indexOf('capture')).toBeLessThan(facts.sequence.indexOf('ANMERKO_JOURNEY_PAGE_FINISH'));
  expect(facts.commands.every(command => command.options?.frameId === 0)).toBe(true);
  expect(facts.commands.filter(command => command.message.type !== 'ANMERKO_JOURNEY_PAGE_IDENTIFY'))
    .toEqual(expect.arrayContaining([
      expect.objectContaining({ message: expect.objectContaining({
        type: 'ANMERKO_JOURNEY_PAGE_START', documentToken: 'document-1',
        expectedUrl: 'https://example.test/path?item=1#top',
      }) }),
      expect.objectContaining({ message: expect.objectContaining({ type: 'ANMERKO_JOURNEY_PAGE_STATUS', count: 1 }) }),
    ]));
  expect(JSON.stringify(facts.commands)).not.toContain('data:image/png');
  expect(facts.broadcasts.length).toBeGreaterThan(0);
  for (const broadcast of facts.broadcasts) expect(broadcast).toEqual({ type: 'ANMERKO_JOURNEY_CHANGED' });
  expect(facts.actions).toEqual(expect.arrayContaining([
    { method: 'badge', details: { tabId: 1, text: 'REC' } },
    { method: 'title', details: { tabId: 1, title: 'Stop journey recording' } },
  ]));
});

test('persists lifecycle state and enforces recording and review deadlines from alarms', async ({ page }) => {
  await dispatch(page, { type: 'ANMERKO_JOURNEY_START', ownerTabId: 1, ownerWindowId: 7 });
  let state = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value;
  expect(await page.evaluate(() => (globalThis as HarnessWindow).harness.alarmCreates))
    .toContainEqual({ name: 'anmerko-journey-recording-deadline', info: { when: Date.parse(state.deadlineAt) } });
  expect(await page.evaluate(() => Object.keys((globalThis as HarnessWindow).harness.sessionStorage).length)).toBeGreaterThan(0);

  await page.evaluate(deadlineAt => {
    Date.now = () => Date.parse(deadlineAt);
    (globalThis as HarnessWindow).harness.events.alarm.emit({ name: 'anmerko-journey-recording-deadline' });
  }, state.deadlineAt);
  await expect.poll(async () => (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value.phase).toBe('reviewing');
  state = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value;
  expect(state.draft.stoppedAt).toBe(state.draft.updatedAt);
  expect(state.draft.stopReason).toBe('duration-limit');
  expect(await page.evaluate(() => (globalThis as HarnessWindow).harness.alarmCreates)).toEqual(expect.arrayContaining([
    { name: 'anmerko-journey-review-warning', info: { when: Date.parse(state.warningAt) } },
    { name: 'anmerko-journey-review-expiry', info: { when: Date.parse(state.expiresAt) } },
  ]));

  await page.evaluate(expiresAt => {
    Date.now = () => Date.parse(expiresAt);
    (globalThis as HarnessWindow).harness.events.alarm.emit({ name: 'anmerko-journey-review-expiry' });
  }, state.expiresAt);
  await expect.poll(async () => (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value.phase).toBe('idle');
});

test('a review edit restarts the idle window and its alarms, so the review outlives its first expiry', async ({ page }) => {
  await dispatch(page, { type: 'ANMERKO_JOURNEY_START', ownerTabId: 1, ownerWindowId: 7 });
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_STOP' })).toEqual({ ok: true });
  const stopped = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value;
  expect(stopped.phase).toBe('reviewing');

  // The expiry warning shows on the toolbar two minutes before the window ends.
  await page.evaluate(warningAt => {
    const harness = (globalThis as HarnessWindow).harness;
    Date.now = () => Date.parse(warningAt);
    harness.events.alarm.emit({ name: 'anmerko-journey-review-warning' });
  }, stopped.warningAt);
  await expect.poll(() => page.evaluate(() => (globalThis as HarnessWindow).harness.actions.at(-1)))
    .toEqual({ method: 'title', details: { tabId: 1, title: 'Journey review expires soon' } });

  // A minute before that window ends, the reviewer edits the summary.
  const editMs = Date.parse(stopped.expiresAt) - 60_000;
  await page.evaluate(ms => { Date.now = () => ms; }, editMs);
  expect(await dispatch(page, {
    type: 'ANMERKO_JOURNEY_UPDATE_SUMMARY', epoch: stopped.epoch, journeyId: stopped.journeyId,
    revision: stopped.draft.revision, updatedAt: new Date(editMs).toISOString(),
    expected: 'The review stays open.', actual: 'It was discarded mid-edit.',
  })).toEqual({ ok: true });
  const edited = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value;
  expect(edited).toMatchObject({
    phase: 'reviewing',
    warningAt: new Date(editMs + 28 * 60_000).toISOString(),
    expiresAt: new Date(editMs + 30 * 60_000).toISOString(),
  });
  await expect.poll(() => page.evaluate(() => (globalThis as HarnessWindow).harness.alarmCreates.slice(-2))).toEqual([
    { name: 'anmerko-journey-review-warning', info: { when: Date.parse(edited.warningAt) } },
    { name: 'anmerko-journey-review-expiry', info: { when: Date.parse(edited.expiresAt) } },
  ]);
  // The warning no longer applies.
  expect(await page.evaluate(() => (globalThis as HarnessWindow).harness.actions.slice(-2))).toEqual([
    { method: 'badge', details: { tabId: 1, text: '' } },
    { method: 'title', details: { tabId: 1, title: 'Annotate with anmerko' } },
  ]);

  // The expiry the review had after Stop passes without discarding it.
  await page.evaluate(expiresAt => {
    Date.now = () => Date.parse(expiresAt);
    (globalThis as HarnessWindow).harness.events.alarm.emit({ name: 'anmerko-journey-review-expiry' });
  }, stopped.expiresAt);
  await page.waitForTimeout(50);
  expect((await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value).toMatchObject({
    phase: 'reviewing', draft: { expected: 'The review stays open.' },
  });

  await page.evaluate(expiresAt => {
    Date.now = () => Date.parse(expiresAt);
    (globalThis as HarnessWindow).harness.events.alarm.emit({ name: 'anmerko-journey-review-expiry' });
  }, edited.expiresAt);
  await expect.poll(async () => (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value.phase).toBe('idle');
});

test('recovers a recorder across background reboot and accepts a port batch posted before initialization', async ({ page }) => {
  await dispatch(page, { type: 'ANMERKO_JOURNEY_START', ownerTabId: 1, ownerWindowId: 7 });
  const before = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value;
  const event = {
    kind: 'click', id: 'wake-event', observedAt: new Date().toISOString(), elapsedMs: 20,
    sourceUrl: 'https://example.test/path?item=1#top',
    target: { tag: 'button', selectorPath: ['button'], label: 'Continue', editable: false,
      viewport: { width: 1280, height: 720 }, scroll: { x: 0, y: 10 }, point: { x: 20, y: 20 } },
    image: { status: 'pending', captureId: 'wake-capture' },
  };
  const batch = {
    schemaVersion: 1, sessionId: before.sessionId, epoch: before.epoch,
    documentToken: before.documentToken, localCounter: 1, events: [event],
  };

  const port = await page.evaluate(({ owner, batch }) => {
    const harness = (globalThis as HarnessWindow).harness;
    harness.reboot();
    const index = harness.connectPort('anmerko-journey-events-v1', owner);
    harness.postPort(index, { type: 'ANMERKO_JOURNEY_EVENTS', batch });
    return index;
  }, { owner: ownerPage, batch });

  await expect.poll(async () => (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value.draft.steps.length).toBe(2);
  let recovered = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value;
  expect(recovered).toMatchObject({
    phase: 'recording', sessionId: before.sessionId, epoch: before.epoch,
    ownerTabId: before.ownerTabId, documentToken: before.documentToken,
    documentCounters: { [before.documentToken]: 1 },
  });
  await page.evaluate(({ port, batch }) => (globalThis as HarnessWindow).harness.postPort(port, {
    type: 'ANMERKO_JOURNEY_EVENTS', batch: { ...batch, events: [{ ...batch.events[0], id: 'replay-event' }] },
  }), { port, batch });
  await page.waitForTimeout(25);
  recovered = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value;
  expect(recovered.draft.steps).toHaveLength(2);
});

for (const wake of [
  { name: 'fragment', kind: 'same-document' as const, url: 'https://example.test/path?item=1#wake-target' },
  { name: 'document', kind: 'document' as const, url: 'https://example.test/cold-document' },
]) {
  test(`preserves the trusted click before a cold-wake ${wake.name} navigation`, async ({ page }) => {
    await dispatch(page, { type: 'ANMERKO_JOURNEY_START', ownerTabId: 1, ownerWindowId: 7 });
    const before = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value;
    const batch = {
      schemaVersion: 1, sessionId: before.sessionId, epoch: before.epoch,
      documentToken: before.documentToken, localCounter: 1,
      events: [{
        kind: 'click', id: `cold-${wake.name}-click`, observedAt: new Date().toISOString(), elapsedMs: 20,
        sourceUrl: 'https://example.test/path?item=1#top',
        target: { tag: 'button', selectorPath: ['button'], label: 'Navigate', editable: false,
          viewport: { width: 1280, height: 720 }, scroll: { x: 0, y: 10 }, point: { x: 20, y: 20 } },
        image: { status: 'pending', captureId: `cold-${wake.name}-capture` },
      }],
    };

    await page.evaluate(({ owner, batch, nextUrl, kind }) => {
      const harness = (globalThis as HarnessWindow).harness;
      harness.reboot();
      const port = harness.connectPort('anmerko-journey-events-v1', owner);
      harness.postPort(port, { type: 'ANMERKO_JOURNEY_EVENTS', batch });
      harness.tabs[1].url = nextUrl;
      harness.identity = {
        ...harness.identity,
        documentToken: kind === 'document' ? 'cold-wake-document' : harness.identity.documentToken,
        url: nextUrl,
        generation: 0,
      };
      if (kind === 'document') delete harness.identity.recording;
      harness.events[kind === 'document' ? 'committed' : 'fragment']
        .emit({ tabId: 1, frameId: 0, url: nextUrl, documentLifecycle: 'active' });
    }, { owner: ownerPage, batch, nextUrl: wake.url, kind: wake.kind });

    await expect.poll(async () => (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value.draft.steps.length)
      .toBe(before.draft.steps.length + 2);
    const recovered = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value;
    expect(recovered.phase).toBe('recording');
    expect(recovered.draft.steps.slice(-2).map((step: any) => step.kind)).toEqual(['click', 'navigation']);
    expect(recovered.draft.steps.at(-2)).toMatchObject({ id: `cold-${wake.name}-click`, sourceUrl: batch.events[0].sourceUrl });
    expect(recovered.draft.steps.at(-1)).toMatchObject({ navigation: { toUrl: wake.url } });
  });
}

for (const noise of [
  { name: 'subframe commits', details: (index: number) => ({ tabId: 1, frameId: index + 1, url: `https://ads.example/slot-${index}`, documentLifecycle: 'active' }) },
  { name: 'prerendered commits', details: (index: number) => ({ tabId: 1, frameId: 0, url: `https://example.test/prerender-${index}`, documentLifecycle: 'prerender' }) },
]) test(`${noise.name} during a cold wake are not buffered and cannot stop the journey`, async ({ page }) => {
  await dispatch(page, { type: 'ANMERKO_JOURNEY_START', ownerTabId: 1, ownerWindowId: 7 });
  const before = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value;
  const commits = Array.from({ length: 20 }, (_, index) => noise.details(index));
  await page.evaluate(commits => {
    const harness = (globalThis as HarnessWindow).harness;
    harness.reboot();
    // More commits routing ignores than the wake buffer holds, all before
    // the persisted journey is read.
    for (const details of commits) harness.events.committed.emit(details);
  }, commits);
  await page.evaluate(() => (globalThis as HarnessWindow).harness.control.ready);
  const after = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value;
  expect(after).toMatchObject({ phase: 'recording', sessionId: before.sessionId, epoch: before.epoch });
  expect(after.draft.steps).toEqual(before.draft.steps);
});

test('rejects a cold-wake click observed after its same-document navigation', async ({ page }) => {
  await dispatch(page, { type: 'ANMERKO_JOURNEY_START', ownerTabId: 1, ownerWindowId: 7 });
  const before = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value;
  const nextUrl = 'https://example.test/path?item=1#navigation-first';
  await page.evaluate(({ url }) => {
    const harness = (globalThis as HarnessWindow).harness;
    harness.reboot();
    harness.tabs[1].url = url;
    harness.identity.url = url;
    harness.events.fragment.emit({ tabId: 1, frameId: 0, url, documentLifecycle: 'active' });
  }, { url: nextUrl });
  await expect.poll(async () => (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value.draft.steps.length)
    .toBe(before.draft.steps.length + 1);
  // A click stamped with the old URL but observed after the navigation
  // committed is stale page noise, not the initiating action.
  await page.evaluate(({ owner, state }) => {
    const harness = (globalThis as HarnessWindow).harness;
    const port = harness.connectPort('anmerko-journey-events-v1', owner);
    harness.postPort(port, { type: 'ANMERKO_JOURNEY_EVENTS', batch: {
      schemaVersion: 1, sessionId: state.sessionId, epoch: state.epoch,
      documentToken: state.documentToken, localCounter: 1,
      events: [{
        kind: 'click', id: 'late-old-url-click', observedAt: new Date().toISOString(), elapsedMs: 20,
        sourceUrl: 'https://example.test/path?item=1#top',
        target: { tag: 'button', selectorPath: ['button'], label: 'Late', editable: false,
          viewport: { width: 1280, height: 720 }, scroll: { x: 0, y: 10 }, point: { x: 20, y: 20 } },
        image: { status: 'pending', captureId: 'late-old-url-capture' },
      }],
    } });
  }, { owner: ownerPage, state: before });
  await expect.poll(async () => (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value.draft.steps.length)
    .toBe(before.draft.steps.length + 1);
  const recovered = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value;
  expect(recovered.draft.steps.at(-1)).toMatchObject({ kind: 'navigation', navigation: { toUrl: nextUrl } });
  expect(recovered.draft.steps.some((step: any) => step.id === 'late-old-url-click')).toBe(false);
});

test('retains a cold-wake click observed before its same-document navigation', async ({ page }) => {
  await dispatch(page, { type: 'ANMERKO_JOURNEY_START', ownerTabId: 1, ownerWindowId: 7 });
  const before = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value;
  const nextUrl = 'https://example.test/path?item=1#wake-target';
  const clickElapsedMs = before.draft.steps.at(-1).elapsedMs;
  await page.evaluate(({ owner, state, url, elapsedMs }) => {
    const harness = (globalThis as HarnessWindow).harness;
    harness.reboot();
    // The click was captured before the fragment change, but the navigation
    // wins the cold-wake delivery race and commits first.
    const observedAt = new Date().toISOString();
    harness.tabs[1].url = url;
    harness.identity.url = url;
    harness.events.fragment.emit({ tabId: 1, frameId: 0, url, documentLifecycle: 'active' });
    const port = harness.connectPort('anmerko-journey-events-v1', owner);
    harness.postPort(port, { type: 'ANMERKO_JOURNEY_EVENTS', batch: {
      schemaVersion: 1, sessionId: state.sessionId, epoch: state.epoch,
      documentToken: state.documentToken, localCounter: 1,
      events: [{
        kind: 'click', id: 'early-wake-click', observedAt, elapsedMs,
        sourceUrl: 'https://example.test/path?item=1#top',
        target: { tag: 'button', selectorPath: ['button'], label: 'Early', editable: false,
          viewport: { width: 1280, height: 720 }, scroll: { x: 0, y: 10 }, point: { x: 20, y: 20 } },
        image: { status: 'pending', captureId: 'early-wake-capture' },
      }],
    } });
  }, { owner: ownerPage, state: before, url: nextUrl, elapsedMs: clickElapsedMs });
  await expect.poll(async () => (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value.draft.steps.length)
    .toBe(before.draft.steps.length + 2);
  const recovered = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value;
  expect(recovered.phase).toBe('recording');
  expect(recovered.draft.steps.slice(-2).map((step: any) => step.kind)).toEqual(['click', 'navigation']);
  expect(recovered.draft.steps.at(-2)).toMatchObject({
    id: 'early-wake-click', sourceUrl: 'https://example.test/path?item=1#top',
    image: { status: 'unavailable', reason: 'superseded' },
  });
  expect(recovered.draft.steps.at(-1)).toMatchObject({ kind: 'navigation', navigation: { toUrl: nextUrl } });
  const seqs = recovered.draft.steps.slice(-2).map((step: any) => step.seq);
  expect(seqs[1]).toBe(seqs[0] + 1);
});

test('entered values stay off unless the start request opts in, and saved journeys list', async ({ page }) => {
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_LIST' })).toEqual({ ok: true, value: [] });
  const started = await dispatch(page, {
    type: 'ANMERKO_JOURNEY_START', ownerTabId: 1, ownerWindowId: 7, includeEnteredValues: true,
  });
  expect(started).toMatchObject({ ok: true });
  expect((await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value.draft.includeEnteredValues).toBe(true);
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_STOP' })).toEqual({ ok: true });
});

test('a submit click carrying more entered text than a journey keeps is recorded with what fits', async ({ page }) => {
  await usePatternedCapture(page);
  await dispatch(page, { type: 'ANMERKO_JOURNEY_START', ownerTabId: 1, ownerWindowId: 7, includeEnteredValues: true });
  const recording = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value;
  await page.evaluate(({ owner, state }) => {
    const harness = (globalThis as HarnessWindow).harness;
    const port = harness.connectPort('anmerko-journey-events-v1', owner);
    const observedAt = new Date().toISOString();
    const sourceUrl = 'https://example.test/path?item=1#top';
    const field = { tag: 'textarea', selectorPath: ['textarea'], label: 'text field', editable: true,
      viewport: { width: 1280, height: 720 }, scroll: { x: 0, y: 0 } };
    // Nine 2,000-character fields filled, then one click on Submit.
    harness.postPort(port, { type: 'ANMERKO_JOURNEY_EVENTS', batch: {
      schemaVersion: 1, sessionId: state.sessionId, epoch: state.epoch,
      documentToken: state.documentToken, localCounter: 1,
      events: [
        ...Array.from({ length: 9 }, (_, index) => ({
          kind: 'field-change', id: `form-${index}`, observedAt, elapsedMs: 20, sourceUrl, target: field,
          enteredValue: { kind: 'text', value: String.fromCharCode(97 + index).repeat(2_000), truncated: false },
          image: { status: 'pending', captureId: `form-capture-${index}` },
        })),
        { kind: 'click', id: 'submit-click', observedAt, elapsedMs: 20, sourceUrl,
          target: { tag: 'button', selectorPath: ['button'], label: 'Submit', editable: false,
            viewport: { width: 1280, height: 720 }, scroll: { x: 0, y: 0 }, point: { x: 20, y: 20 } },
          image: { status: 'pending', captureId: 'submit-capture' } },
      ],
    } });
  }, { owner: ownerPage, state: recording });
  await expect.poll(async () => (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value.draft.steps
    .slice(1).map((step: any) => step.id)).toEqual([...Array.from({ length: 9 }, (_, index) => `form-${index}`), 'submit-click']);
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_STOP' })).toEqual({ ok: true });
  const stopped = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value;
  expect(stopped.draft.steps.at(-2).enteredValue).toEqual({ kind: 'text', value: 'i'.repeat(384), truncated: true });
  expect(stopped.draft.limitations).toEqual([JOURNEY_LIMITATIONS.enteredValuesTruncated]);
});

test('a save into a full saved-journey store keeps the review and evicts nothing', async ({ page }) => {
  // Another hundred journeys are already saved: the most anmerko keeps.
  await page.evaluate(async count => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('anmerko:journey-store:v1', 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('snapshots', { keyPath: 'journeyId' });
        request.result.createObjectStore('blobs', { keyPath: 'key' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('snapshots', 'readwrite');
      for (let index = 0; index < count; index += 1) {
        tx.objectStore('snapshots').put({
          schemaVersion: 1, journeyId: `saved-${index}`, revision: 1, updatedAt: '2026-09-20T12:00:00.000Z',
          stepCount: 1, manifestBytes: 2, imageBytes: 69, blobIds: [], draft: {},
        });
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, 100);
  const stopped = await reviewWithClickScreenshot(page);
  expect(await dispatch(page, {
    type: 'ANMERKO_JOURNEY_UPDATE_SUMMARY', epoch: stopped.epoch, journeyId: stopped.journeyId,
    revision: stopped.draft.revision, updatedAt: new Date().toISOString(),
    expected: 'The journey is saved.', actual: 'Storage is full.',
  })).toEqual({ ok: true });

  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_SAVE', acknowledged: true }))
    .toEqual({ ok: false, error: 'Journey command unavailable.', code: 'saved-journeys-full' });
  expect((await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value).toMatchObject({
    phase: 'reviewing', journeyId: stopped.journeyId, draft: { expected: 'The journey is saved.' },
  });
  const listed = (await dispatch(page, { type: 'ANMERKO_JOURNEY_LIST' })).value;
  expect(listed).toHaveLength(100);
  expect(listed.some((item: any) => item.journeyId === stopped.journeyId)).toBe(false);
});

test('review summaries and step removal apply with revision guards', async ({ page }) => {
  await dispatch(page, { type: 'ANMERKO_JOURNEY_START', ownerTabId: 1, ownerWindowId: 7 });
  const before = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value;
  await page.evaluate(({ owner, state }) => {
    const harness = (globalThis as HarnessWindow).harness;
    const port = harness.connectPort('anmerko-journey-events-v1', owner);
    harness.postPort(port, { type: 'ANMERKO_JOURNEY_EVENTS', batch: {
      schemaVersion: 1, sessionId: state.sessionId, epoch: state.epoch,
      documentToken: state.documentToken, localCounter: 1,
      events: [{
        kind: 'click', id: 'review-click', observedAt: new Date().toISOString(), elapsedMs: 20,
        sourceUrl: 'https://example.test/path?item=1#top',
        target: { tag: 'button', selectorPath: ['button'], label: 'Go', editable: false,
          viewport: { width: 1280, height: 720 }, scroll: { x: 0, y: 10 }, point: { x: 20, y: 20 } },
        image: { status: 'pending', captureId: 'review-click-capture' },
      }],
    } });
  }, { owner: ownerPage, state: before });
  await expect.poll(async () => (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value.draft.steps.length).toBe(2);
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_STOP' })).toEqual({ ok: true });
  let reviewing = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value;
  expect(reviewing.phase).toBe('reviewing');

  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_SAVE', acknowledged: true }))
    .toEqual({ ok: false, error: 'Journey command unavailable.' });

  const guards = {
    epoch: reviewing.epoch, journeyId: reviewing.journeyId, revision: reviewing.draft.revision,
    updatedAt: new Date().toISOString(),
  };
  expect(await dispatch(page, {
    type: 'ANMERKO_JOURNEY_UPDATE_SUMMARY', ...guards,
    expected: '  The cart keeps its item.  ', actual: 'Checkout is empty.',
  })).toEqual({ ok: true });
  reviewing = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value;
  expect(reviewing.draft.expected).toBe('The cart keeps its item.');
  expect(reviewing.draft.actual).toBe('Checkout is empty.');
  expect(reviewing.draft.revision).toBe(guards.revision + 1);

  expect(await dispatch(page, {
    type: 'ANMERKO_JOURNEY_UPDATE_SUMMARY', ...guards,
    expected: 'Stale write.', actual: 'Stale write.',
  })).toEqual({ ok: false, error: 'Journey command unavailable.', code: 'stale-review' });
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_REMOVE_STEP' }))
    .toEqual({ ok: false, error: 'Journey command unavailable.' });

  const clickId = reviewing.draft.steps[1].id;
  expect(await dispatch(page, {
    type: 'ANMERKO_JOURNEY_REMOVE_STEP', ...guards, revision: guards.revision + 1,
    updatedAt: new Date().toISOString(), stepId: clickId,
  })).toEqual({ ok: true });
  reviewing = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value;
  expect(reviewing.draft.steps.map((step: any) => step.seq)).toEqual([1]);
  expect(reviewing.draft.steps).toHaveLength(1);

  const initialId = reviewing.draft.steps[0].id;
  const redactGuards = {
    epoch: reviewing.epoch, journeyId: reviewing.journeyId, revision: reviewing.draft.revision,
    updatedAt: new Date().toISOString(),
  };
  expect(await dispatch(page, {
    type: 'ANMERKO_JOURNEY_REDACT_URL', ...redactGuards, stepId: initialId, url: 'source',
  })).toEqual({ ok: true });
  reviewing = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value;
  expect(reviewing.draft.steps[0].sourceUrl).toBe('[redacted]');
  expect(reviewing.draft.steps[0].image).toMatchObject({ status: 'retained' });
  expect(await dispatch(page, {
    type: 'ANMERKO_JOURNEY_REDACT_URL', ...redactGuards, revision: redactGuards.revision + 1,
    updatedAt: new Date().toISOString(), stepId: initialId, url: 'capture',
  })).toEqual({ ok: true });
  reviewing = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value;
  const imageId = reviewing.draft.steps[0].image.imageId;
  expect(reviewing.draft.images[imageId].captureUrl).toBe('[redacted]');
  expect(reviewing.draft.images[imageId].dataUrl).toMatch(/^data:image\/png;base64,/);
  expect(await dispatch(page, {
    type: 'ANMERKO_JOURNEY_EDIT_VALUE', ...redactGuards, stepId: initialId, value: { kind: 'text', value: 'x', truncated: false },
  })).toEqual({ ok: false, error: 'Journey command unavailable.', code: 'stale-review' });
  reviewing = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value;
  expect(reviewing.draft.steps[0].sourceUrl).toBe('[redacted]');
  expect(reviewing.draft.revision).toBe(redactGuards.revision + 2);

  expect(await dispatch(page, {
    type: 'ANMERKO_JOURNEY_UPDATE_SUMMARY',
    epoch: reviewing.epoch, journeyId: reviewing.journeyId, revision: reviewing.draft.revision,
    updatedAt: new Date().toISOString(), expected: 'The cart keeps its item.', actual: 'Checkout is empty.',
  })).toEqual({ ok: true });
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_SAVE', acknowledged: false }))
    .toEqual({ ok: false, error: 'Journey command unavailable.' });
  const saved = await dispatch(page, { type: 'ANMERKO_JOURNEY_SAVE', acknowledged: true });
  expect(saved).toMatchObject({ ok: true });
  expect(typeof (saved as any).value?.journeyId).toBe('string');
  const done = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value;
  expect(done.phase).toBe('saved');
  expect(done.epoch).toBe(reviewing.epoch + 1);

  const opened = await dispatch(page, { type: 'ANMERKO_JOURNEY_OPEN_SNAPSHOT', journeyId: done.journeyId });
  expect(opened.ok).toBe(true);
  expect((opened as any).value.draft.expected).toBe('The cart keeps its item.');
  expect((opened as any).value.images[imageId].dataUrl).toMatch(/^data:image\/png;base64,/);
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_OPEN_SNAPSHOT', journeyId: 'journey-missing' }))
    .toEqual({ ok: false, error: 'Journey command unavailable.' });

  await page.evaluate(() => {
    (globalThis as HarnessWindow).harness.tabs[80] = {
      id: 80, windowId: 7, active: false, url: 'chrome-extension://test-extension/journey.html',
    };
  });
  const reviewSender = {
    id: 'test-extension', url: 'chrome-extension://test-extension/journey.html', frameId: 0,
    tab: { id: 80, windowId: 7, active: false, url: 'chrome-extension://test-extension/journey.html' },
  };
  const reopened = await dispatch(page, { type: 'ANMERKO_JOURNEY_REOPEN', journeyId: done.journeyId }, reviewSender);
  expect(reopened.ok).toBe(true);
  const again = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value;
  expect(again.phase).toBe('reviewing');
  expect(again.journeyId).toBe(done.journeyId);
  expect(again.epoch).toBe(1);
  expect(again.ownerTabId).toBe(80);
  expect(again.draft.expected).toBe('The cart keeps its item.');
  expect(again.draft.steps).toHaveLength(1);
  expect(await dispatch(page, {
    type: 'ANMERKO_JOURNEY_UPDATE_SUMMARY',
    epoch: 1, journeyId: again.journeyId, revision: again.draft.revision,
    updatedAt: new Date().toISOString(), expected: 'Edited after reopen.', actual: 'Checkout is empty.',
  })).toEqual({ ok: true });
  expect((await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value.draft.expected).toBe('Edited after reopen.');

  const resaved = await dispatch(page, { type: 'ANMERKO_JOURNEY_SAVE', acknowledged: true });
  expect(resaved).toMatchObject({ ok: true });
  const savedRevision = (resaved as any).value.revision;
  expect(await dispatch(page, {
    type: 'ANMERKO_JOURNEY_DELETE_SNAPSHOT', journeyId: again.journeyId, revision: savedRevision + 1,
  })).toEqual({ ok: false, error: 'Journey command unavailable.', code: 'stale-review' });
  expect(await dispatch(page, {
    type: 'ANMERKO_JOURNEY_DELETE_SNAPSHOT', journeyId: again.journeyId, revision: savedRevision,
  })).toEqual({ ok: true });
  expect((await dispatch(page, { type: 'ANMERKO_JOURNEY_LIST' })).value).toEqual([]);
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_DELETE_SNAPSHOT', journeyId: again.journeyId }))
    .toEqual({ ok: true });
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_DELETE_SNAPSHOT', journeyId: 42 }))
    .toEqual({ ok: false, error: 'Journey command unavailable.' });
});

test('screenshot review authenticates its sender and rejects malformed, mismatched, and stale changes', async ({ page }) => {
  const reviewing = await reviewWithClickScreenshot(page);
  const imageId = reviewing.draft.steps[0].image.imageId;
  const original = reviewing.draft.images[imageId].dataUrl;
  const rect = { x: 0, y: 0, width: 3, height: 2 };
  const replace = {
    type: 'ANMERKO_JOURNEY_REVIEW_IMAGE', operation: 'replace',
    epoch: reviewing.epoch, journeyId: reviewing.journeyId, revision: reviewing.draft.revision, imageId,
    dataUrl: await maskedPng(page, original, rect),
  };

  // Website pages, subframes, lookalike review URLs, and other extensions are never answered.
  expect(await dispatch(page, replace, ownerPage)).toBeUndefined();
  expect(await dispatch(page, replace, { ...reviewPage, frameId: 2 })).toBeUndefined();
  expect(await dispatch(page, replace, { ...reviewPage, url: `${reviewPage.url}?source=page` })).toBeUndefined();
  expect(await dispatch(page, replace, { ...sidebar, id: 'other-extension' })).toBeUndefined();
  expect(await dispatch(page, { ...replace, intent: 'forged_intent_1234567890' }, reviewPage))
    .toEqual({ ...unavailable, code: 'launch-expired' });

  const wrongSize = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 5; canvas.height = 5;
    return canvas.toDataURL('image/png');
  });
  const withoutImage = Object.fromEntries(Object.entries(replace).filter(([key]) => key !== 'dataUrl'));
  expect(await dispatch(page, withoutImage)).toEqual(unavailable);
  expect(await dispatch(page, { ...replace, operation: 'mask' })).toEqual(unavailable);
  expect(await dispatch(page, { ...replace, imageId: 'image-missing' })).toEqual(unavailable);
  expect(await dispatch(page, { ...replace, dataUrl: 'data:image/png;base64,AAAA' })).toEqual(unavailable);
  expect(await dispatch(page, { ...replace, dataUrl: 'https://example.test/mask.png' })).toEqual(unavailable);
  expect(await dispatch(page, { ...replace, dataUrl: wrongSize })).toEqual(unavailable);
  expect(await dispatch(page, { ...replace, revision: reviewing.draft.revision - 1 })).toEqual(staleReview);
  expect(await dispatch(page, { ...replace, revision: reviewing.draft.revision + 1 })).toEqual(staleReview);
  expect(await dispatch(page, { ...replace, epoch: reviewing.epoch + 1 })).toEqual(staleReview);
  expect(await dispatch(page, { ...replace, operation: 'remove', journeyId: 'journey-other' })).toEqual(staleReview);
  let state = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value;
  expect(state.draft.revision).toBe(reviewing.draft.revision);
  expect(state.draft.images[imageId]).toEqual(reviewing.draft.images[imageId]);

  // The review tab's metadata and timestamp are ignored: the background derives both.
  const broadcasts = await page.evaluate(() => (globalThis as HarnessWindow).harness.broadcasts.length);
  const startedAt = Date.now();
  expect(await dispatch(page, {
    ...replace, width: 1, height: 1, byteLength: 1, updatedAt: '2000-01-01T00:00:00.000Z',
  }, reviewPage)).toEqual({ ok: true });
  state = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value;
  const record = state.draft.images[imageId];
  expect(state.draft.revision).toBe(reviewing.draft.revision + 1);
  expect(Date.parse(state.draft.updatedAt)).toBeGreaterThanOrEqual(startedAt);
  expect(record).toMatchObject({ width: 8, height: 4, redacted: true, captureUrl: reviewing.draft.images[imageId].captureUrl });
  expect(record.byteLength).toBe(Buffer.from(record.dataUrl.split(',')[1], 'base64').length);
  expect(await dataUrlPixels(page, record.dataUrl)).toEqual(patternedPixels([rect]));
  expect(await page.evaluate(count => (globalThis as HarnessWindow).harness.broadcasts.slice(count), broadcasts))
    .toContainEqual({ type: 'ANMERKO_JOURNEY_CHANGED' });

  // The edit went through the session store, so a restarted background keeps it.
  await page.evaluate(() => (globalThis as HarnessWindow).harness.reboot());
  state = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value;
  expect(state.draft.images[imageId]).toEqual(record);
  expect(await dispatch(page, replace)).toEqual(staleReview);
});

test('masked and removed screenshots persist through save, reopen, and export', async ({ page }) => {
  let state = await reviewWithClickScreenshot(page);
  const initialId = state.draft.steps[0].image.imageId;
  const clickId = state.draft.steps[1].image.imageId;
  expect(clickId).not.toBe(initialId);
  const first = { x: 0, y: 0, width: 3, height: 2 };
  const guards = (current: any) => ({
    epoch: current.epoch, journeyId: current.journeyId, revision: current.draft.revision,
  });
  expect(await dispatch(page, {
    type: 'ANMERKO_JOURNEY_REVIEW_IMAGE', operation: 'replace', ...guards(state), imageId: initialId,
    dataUrl: await maskedPng(page, state.draft.images[initialId].dataUrl, first),
  })).toEqual({ ok: true });
  state = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value;
  expect(await dispatch(page, {
    type: 'ANMERKO_JOURNEY_UPDATE_SUMMARY', ...guards(state), updatedAt: new Date().toISOString(),
    expected: 'Card details stay private.', actual: 'The card number was visible.',
  })).toEqual({ ok: true });
  const saved = await dispatch(page, { type: 'ANMERKO_JOURNEY_SAVE', acknowledged: true });
  expect(saved).toMatchObject({ ok: true });
  let snapshot = (await dispatch(page, { type: 'ANMERKO_JOURNEY_OPEN_SNAPSHOT', journeyId: saved.value.journeyId })).value;
  expect(snapshot.images[initialId].redacted).toBe(true);
  expect(await dataUrlPixels(page, snapshot.images[initialId].dataUrl)).toEqual(patternedPixels([first]));

  // A reopened saved journey accepts the same screenshot review.
  await page.evaluate(() => {
    (globalThis as HarnessWindow).harness.tabs[80] = {
      id: 80, windowId: 7, active: true, url: 'chrome-extension://test-extension/journey.html',
    };
  });
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_REOPEN', journeyId: saved.value.journeyId }, reviewPage))
    .toMatchObject({ ok: true });
  state = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' }, reviewPage)).value;
  expect(state.draft.images[initialId].redacted).toBe(true);
  const second = { x: 5, y: 2, width: 3, height: 2 };
  expect(await dispatch(page, {
    type: 'ANMERKO_JOURNEY_REVIEW_IMAGE', operation: 'replace', ...guards(state), imageId: initialId,
    dataUrl: await maskedPng(page, state.draft.images[initialId].dataUrl, second),
  }, reviewPage)).toEqual({ ok: true });
  state = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' }, reviewPage)).value;
  expect(await dispatch(page, {
    type: 'ANMERKO_JOURNEY_REVIEW_IMAGE', operation: 'remove', ...guards(state), imageId: clickId,
  }, reviewPage)).toEqual({ ok: true });
  state = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' }, reviewPage)).value;
  expect(state.draft.steps[1].image).toEqual({ status: 'removed' });
  expect(Object.keys(state.draft.images)).toEqual([initialId]);
  const resaved = await dispatch(page, { type: 'ANMERKO_JOURNEY_SAVE', acknowledged: true }, reviewPage);
  expect(resaved.value.revision).toBeGreaterThan(saved.value.revision);

  snapshot = (await dispatch(page, { type: 'ANMERKO_JOURNEY_OPEN_SNAPSHOT', journeyId: saved.value.journeyId })).value;
  expect(Object.keys(snapshot.images)).toEqual([initialId]);
  expect(snapshot.draft.steps[1].image).toEqual({ status: 'removed' });
  expect(await dataUrlPixels(page, snapshot.images[initialId].dataUrl)).toEqual(patternedPixels([first, second]));
  const blobKeys = await page.evaluate(() => new Promise<string[]>((resolve, reject) => {
    const opening = indexedDB.open('anmerko:journey-store:v1');
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const keys = opening.result.transaction('blobs').objectStore('blobs').getAllKeys();
      keys.onsuccess = () => { opening.result.close(); resolve(keys.result.map(String)); };
      keys.onerror = () => reject(keys.error);
    };
  }));
  expect(blobKeys).toEqual([`${saved.value.journeyId}\u0000${initialId}`]);

  await page.addScriptTag({ content: archiveBundle });
  const archive = await page.evaluate(async draft => {
    const bytes = (globalThis as ArchiveWindow).journeyArchive.journeyArchive(draft);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const files: Record<string, Uint8Array<ArrayBuffer>> = {};
    for (let offset = 0; view.getUint32(offset, true) === 0x04034b50;) {
      const size = view.getUint32(offset + 18, true);
      const nameLength = view.getUint16(offset + 26, true);
      const start = offset + 30 + nameLength + view.getUint16(offset + 28, true);
      files[new TextDecoder().decode(bytes.subarray(offset + 30, offset + 30 + nameLength))] = bytes.subarray(start, start + size);
      offset = start + size;
    }
    const pngs = Object.keys(files).filter(name => name.endsWith('.png'));
    const bitmap = await createImageBitmap(new Blob([files[pngs[0]]], { type: 'image/png' }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d')!;
    context.drawImage(bitmap, 0, 0);
    const data = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    const pixels: number[][] = [];
    for (let index = 0; index < data.length; index += 4) pixels.push(Array.from(data.slice(index, index + 4)));
    return { pngs, markdown: new TextDecoder().decode(files['journeys.md']), pixels };
  }, snapshot.draft);
  // Screenshots are named for their step: only the initial capture remains.
  expect(archive.pngs).toEqual([expect.stringMatching(/^journey-[0-9a-f]{8}-step-01\.png$/)]);
  expect(archive.markdown).toContain('Screenshot: removed during review');
  expect(archive.markdown).toContain('Image redacted: Yes');
  expect(archive.pixels).toEqual(patternedPixels([first, second]));
});

test('a save and a screenshot review never overlap, so a racing save cannot drop a mask', async ({ page }) => {
  let state = await reviewWithClickScreenshot(page);
  const imageId = state.draft.steps[0].image.imageId;
  const original = state.draft.images[imageId].dataUrl;
  const rect = { x: 0, y: 0, width: 3, height: 2 };
  const guards = (current: any) => ({
    epoch: current.epoch, journeyId: current.journeyId, revision: current.draft.revision,
  });
  const race = (first: unknown, second: unknown, sender: Sender) => page.evaluate(({ first, second, sender }) => {
    const harness = (globalThis as HarnessWindow).harness;
    return Promise.all([harness.dispatch(first, sender), harness.dispatch(second, sender)]);
  }, { first, second, sender });
  const save = { type: 'ANMERKO_JOURNEY_SAVE', acknowledged: true };
  expect(await dispatch(page, {
    type: 'ANMERKO_JOURNEY_UPDATE_SUMMARY', ...guards(state), updatedAt: new Date().toISOString(),
    expected: 'Card details stay private.', actual: 'The card number was visible.',
  })).toEqual({ ok: true });
  state = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value;

  // A save already in flight turns away a screenshot change instead of saving over it.
  const [saved, refusedMask] = await race(save, {
    type: 'ANMERKO_JOURNEY_REVIEW_IMAGE', operation: 'replace', ...guards(state), imageId,
    dataUrl: await maskedPng(page, original, rect),
  }, sidebar);
  expect(saved).toMatchObject({ ok: true });
  expect(refusedMask).toEqual(staleReview);
  let snapshot = (await dispatch(page, { type: 'ANMERKO_JOURNEY_OPEN_SNAPSHOT', journeyId: saved.value.journeyId })).value;
  expect(snapshot.images[imageId].redacted).toBeUndefined();
  expect(await dataUrlPixels(page, snapshot.images[imageId].dataUrl)).toEqual(patternedPixels([]));

  await page.evaluate(() => {
    (globalThis as HarnessWindow).harness.tabs[80] = {
      id: 80, windowId: 7, active: true, url: 'chrome-extension://test-extension/journey.html',
    };
  });
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_REOPEN', journeyId: saved.value.journeyId }, reviewPage))
    .toMatchObject({ ok: true });
  state = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' }, reviewPage)).value;

  // A screenshot change in flight turns away the save until its pixels land.
  const [masked, refusedSave] = await race({
    type: 'ANMERKO_JOURNEY_REVIEW_IMAGE', operation: 'replace', ...guards(state), imageId,
    dataUrl: await maskedPng(page, state.draft.images[imageId].dataUrl, rect),
  }, save, reviewPage);
  expect(masked).toEqual({ ok: true });
  expect(refusedSave).toEqual(staleReview);
  state = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' }, reviewPage)).value;
  expect(state.phase).toBe('reviewing');
  expect(state.draft.images[imageId].redacted).toBe(true);
  snapshot = (await dispatch(page, { type: 'ANMERKO_JOURNEY_OPEN_SNAPSHOT', journeyId: saved.value.journeyId })).value;
  expect(snapshot.draft.revision).toBe(saved.value.revision);
  expect(snapshot.images[imageId].redacted).toBeUndefined();

  const resaved = await dispatch(page, save, reviewPage);
  expect(resaved.value.revision).toBeGreaterThan(saved.value.revision);
  snapshot = (await dispatch(page, { type: 'ANMERKO_JOURNEY_OPEN_SNAPSHOT', journeyId: saved.value.journeyId })).value;
  expect(snapshot.images[imageId].redacted).toBe(true);
  expect(await dataUrlPixels(page, snapshot.images[imageId].dataUrl)).toEqual(patternedPixels([rect]));
});

test('a review edit racing a save is refused as stale and the snapshot is exactly the saved review', async ({ page }) => {
  let state = await reviewWithClickScreenshot(page);
  const guards = (current: any) => ({
    epoch: current.epoch, journeyId: current.journeyId, revision: current.draft.revision,
    updatedAt: new Date().toISOString(),
  });
  expect(await dispatch(page, {
    type: 'ANMERKO_JOURNEY_UPDATE_SUMMARY', ...guards(state),
    expected: 'The receipt lists the order.', actual: 'The receipt is blank.',
  })).toEqual({ ok: true });
  state = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value;

  // A second review tab edits with the revision it last read while this tab saves.
  const late = guards(state);
  const [saved, ...refused] = await page.evaluate(({ edits, reviewSender }) => {
    const harness = (globalThis as HarnessWindow).harness;
    return Promise.all([
      harness.dispatch({ type: 'ANMERKO_JOURNEY_SAVE', acknowledged: true }, reviewSender),
      ...edits.map(edit => harness.dispatch(edit, reviewSender)),
    ]);
  }, { reviewSender: reviewPage, edits: [
    { type: 'ANMERKO_JOURNEY_UPDATE_SUMMARY', ...late, expected: 'Edited during save.', actual: 'Edited during save.' },
    { type: 'ANMERKO_JOURNEY_REDACT_URL', ...late, stepId: state.draft.steps[1].id, url: 'source' },
    { type: 'ANMERKO_JOURNEY_REMOVE_STEP', ...late, stepId: state.draft.steps[1].id },
  ] });
  expect(saved).toEqual({ ok: true, value: { journeyId: state.journeyId, revision: state.draft.revision } });
  expect(refused).toEqual([staleReview, staleReview, staleReview]);
  expect((await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value).toEqual({
    phase: 'saved', epoch: state.epoch + 1, journeyId: state.journeyId, revision: state.draft.revision,
  });
  const snapshot = (await dispatch(page, { type: 'ANMERKO_JOURNEY_OPEN_SNAPSHOT', journeyId: state.journeyId })).value;
  expect(snapshot.draft).toMatchObject({ revision: state.draft.revision, expected: 'The receipt lists the order.' });
  expect(snapshot.draft.steps.map((step: any) => [step.id, step.sourceUrl]))
    .toEqual(state.draft.steps.map((step: any) => [step.id, step.sourceUrl]));
});

test('saving never copies the reviewed screenshots into session storage again', async ({ page }) => {
  const state = await reviewWithClickScreenshot(page);
  expect(await dispatch(page, {
    type: 'ANMERKO_JOURNEY_UPDATE_SUMMARY', epoch: state.epoch, journeyId: state.journeyId,
    revision: state.draft.revision, updatedAt: new Date().toISOString(),
    expected: 'The receipt lists the order.', actual: 'The receipt is blank.',
  })).toEqual({ ok: true });
  await page.evaluate(() => {
    const session = (globalThis as any).chrome.storage.session;
    const set = session.set;
    (globalThis as any).__sessionWrites = [];
    session.set = (items: Record<string, any>) => {
      (globalThis as any).__sessionWrites.push(Object.entries(items).map(([key, value]) => ({
        key, phase: value?.state?.phase ?? value?.phase ?? value?.status, bytes: JSON.stringify(value).length,
      })));
      return set(items);
    };
  });
  const saved = await dispatch(page, { type: 'ANMERKO_JOURNEY_SAVE', acknowledged: true });
  expect(saved).toMatchObject({ ok: true });
  const writes = (await page.evaluate(() => (globalThis as any).__sessionWrites)).flat();
  // Only the small saved confirmation is written: the review already holds
  // the draft a restart would resume, so the saving phase adds no copy.
  expect(writes.filter((write: any) => write.key.endsWith(':payload')).map((write: any) => write.phase)).toEqual(['saved']);
  expect(Math.max(...writes.map((write: any) => write.bytes))).toBeLessThan(1_000);
  expect((await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value).toMatchObject({ phase: 'saved' });
});

test('a controller replaced by a storage failure during its save cannot publish the late saved state', async ({ page }) => {
  let state = await reviewWithClickScreenshot(page);
  const summary = (current: any, actual: string) => ({
    type: 'ANMERKO_JOURNEY_UPDATE_SUMMARY', epoch: current.epoch, journeyId: current.journeyId,
    revision: current.draft.revision, updatedAt: new Date().toISOString(), expected: 'The receipt lists the order.', actual,
  });
  expect(await dispatch(page, summary(state, 'The receipt is blank.'))).toEqual({ ok: true });
  state = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value;
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_LIST' })).toEqual({ ok: true, value: [] });
  // Hold the snapshot store so the save stays in flight, and hold the next
  // review alarm so its failure lands while the controller is saving.
  await page.evaluate(async () => {
    const test = globalThis as any;
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const opening = indexedDB.open('anmerko:journey-store:v1');
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error);
    });
    const snapshots = db.transaction('snapshots', 'readwrite').objectStore('snapshots');
    test.__holdSnapshots = true;
    const hold = () => { snapshots.get('held').onsuccess = () => { if (test.__holdSnapshots) hold(); else db.close(); }; };
    hold();
    const alarms = test.chrome.alarms;
    test.__createAlarm = alarms.create;
    alarms.create = () => new Promise((_resolve, reject) => { test.__failAlarm = () => reject(new Error('alarm create failed')); });
  });
  const pending = page.evaluate(({ edit }) => {
    const harness = (globalThis as HarnessWindow).harness;
    const edited = harness.dispatch(edit, { id: 'test-extension', url: 'chrome-extension://test-extension/sidebar.html' });
    return new Promise(resolve => {
      const saveWhenHeld = () => {
        if (!(globalThis as any).__failAlarm) { setTimeout(saveWhenHeld, 5); return; }
        const saving = harness.dispatch({ type: 'ANMERKO_JOURNEY_SAVE', acknowledged: true },
          { id: 'test-extension', url: 'chrome-extension://test-extension/sidebar.html' });
        resolve(Promise.all([edited, saving]));
      };
      saveWhenHeld();
    });
  }, { edit: summary(state, 'The receipt is blank after the edit.') });
  await expect.poll(async () => (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value.phase).toBe('saving');

  await page.evaluate(() => (globalThis as any).__failAlarm());
  await expect.poll(async () => (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value.draft?.stopReason)
    .toBe('session-storage-limit');
  await page.evaluate(() => {
    const test = globalThis as any;
    test.chrome.alarms.create = test.__createAlarm;
    test.__holdSnapshots = false;
  });
  const [edited, saved] = await pending as any[];
  expect(edited).toEqual({ ok: false, error: 'Journey command unavailable.', code: 'session-storage-failed' });
  expect(saved).toEqual({ ok: false, error: 'Journey command unavailable.', code: 'session-storage-failed' });
  // The replacement review stays the journey everywhere: in memory, in
  // session storage, and after a restart.
  const current = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value;
  expect(current).toMatchObject({ phase: 'reviewing', journeyId: state.journeyId, draft: { actual: 'The receipt is blank after the edit.' } });
  expect(await page.evaluate(() => (globalThis as HarnessWindow).harness.sessionStorage['anmerko:journey-session:v1:control']))
    .toMatchObject({ status: 'committed', phase: 'reviewing' });
  await page.evaluate(() => (globalThis as HarnessWindow).harness.reboot());
  await page.evaluate(() => (globalThis as HarnessWindow).harness.control.ready);
  expect((await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value)
    .toMatchObject({ phase: 'reviewing', journeyId: state.journeyId });
});

test('a saved journey never blocks Record journey from the floating panel or a new sidebar start', async ({ page }) => {
  const saveInJourneyTab = async () => {
    const state = await reviewWithClickScreenshot(page);
    await page.evaluate(() => {
      (globalThis as HarnessWindow).harness.tabs[80] = {
        id: 80, windowId: 7, active: true, url: 'chrome-extension://test-extension/journey.html',
      };
    });
    expect(await dispatch(page, {
      type: 'ANMERKO_JOURNEY_UPDATE_SUMMARY', epoch: state.epoch, journeyId: state.journeyId,
      revision: state.draft.revision, updatedAt: new Date().toISOString(),
      expected: 'The order is confirmed.', actual: 'The confirmation never appears.',
    }, reviewPage)).toEqual({ ok: true });
    expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_SAVE', acknowledged: true }, reviewPage)).toMatchObject({ ok: true });
    // The reporter closes the journey tab on its saved confirmation.
    await page.evaluate(() => {
      const harness = (globalThis as HarnessWindow).harness;
      delete harness.tabs[80];
      harness.events.removed.emit(80, { windowId: 7 });
    });
    const saved = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value;
    expect(saved).toMatchObject({ phase: 'saved', journeyId: state.journeyId });
    return saved;
  };

  const saved = await saveInJourneyTab();
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_OPEN' }, ownerPage)).toEqual({ ok: true });
  // The launch tab opens on Record, and the snapshot stays in Saved journeys.
  expect((await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value).toEqual({ phase: 'idle', epoch: saved.epoch + 1 });
  expect((await dispatch(page, { type: 'ANMERKO_JOURNEY_LIST' })).value.map((item: any) => item.journeyId))
    .toEqual([saved.journeyId]);
  const launch = await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).harness;
    const url = harness.createdTabs.at(-1).url as string;
    const tab = Object.values(harness.tabs).find(item => item.url === url)!;
    return { intent: url.slice(url.indexOf('#launch=') + 8), sender: { id: 'test-extension', url, frameId: 0, tab } };
  });
  expect(launch.intent).toMatch(/^[A-Za-z0-9._~-]+$/);
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_START', intent: launch.intent }, launch.sender)).toEqual({ ok: true });
  expect((await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value.phase).toBe('recording');
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_DISCARD' })).toEqual({ ok: true });

  // A sidebar showing the saved confirmation can start again directly too.
  await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).harness;
    for (const tab of Object.values(harness.tabs)) tab.active = tab.id === 1;
  });
  const again = await saveInJourneyTab();
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_START', ownerTabId: 1, ownerWindowId: 7 })).toEqual({ ok: true });
  expect((await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value).toMatchObject({ phase: 'recording' });
  expect((await dispatch(page, { type: 'ANMERKO_JOURNEY_LIST' })).value.map((item: any) => item.journeyId).sort())
    .toEqual([saved.journeyId, again.journeyId].sort());
});

test('removing a screenshot or step whose URLs were redacted succeeds through the command channel', async ({ page }) => {
  let state = await reviewWithClickScreenshot(page);
  const guards = (current: any) => ({
    epoch: current.epoch, journeyId: current.journeyId, revision: current.draft.revision,
    updatedAt: new Date().toISOString(),
  });
  const click = state.draft.steps[1];
  for (const url of ['capture', 'source']) {
    expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_REDACT_URL', ...guards(state), stepId: click.id, url }))
      .toEqual({ ok: true });
    state = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value;
  }
  expect(state.draft.redactions).toEqual({ steps: { [click.id]: { captureUrl: true, sourceUrl: true } } });

  expect(await dispatch(page, {
    type: 'ANMERKO_JOURNEY_REVIEW_IMAGE', operation: 'remove',
    epoch: state.epoch, journeyId: state.journeyId, revision: state.draft.revision, imageId: click.image.imageId,
  })).toEqual({ ok: true });
  state = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value;
  expect(state.draft.steps[1].image).toEqual({ status: 'removed' });
  expect(state.draft.redactions).toEqual({ steps: { [click.id]: { sourceUrl: true } } });

  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_REMOVE_STEP', ...guards(state), stepId: click.id }))
    .toEqual({ ok: true });
  state = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value;
  expect(state.draft.steps.map((step: any) => step.kind)).toEqual(['initial']);
  expect(state.draft).not.toHaveProperty('redactions');

  // The last step cannot be removed, and the refusal is reported rather than ignored.
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_REMOVE_STEP', ...guards(state), stepId: state.draft.steps[0].id }))
    .toEqual(unavailable);
  expect((await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value.draft.revision).toBe(state.draft.revision);
});

test('review commands and discards name their review, so one sent after another view reopened the journey is refused', async ({ page }) => {
  const state = async () => (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value;
  const guards = (current: any, sessionId = current.sessionId) => ({
    epoch: current.epoch, journeyId: current.journeyId, sessionId, revision: current.draft.revision,
    updatedAt: new Date().toISOString(),
  });
  let first = await reviewWithClickScreenshot(page);
  expect(await dispatch(page, {
    type: 'ANMERKO_JOURNEY_UPDATE_SUMMARY', ...guards(first), expected: 'Paying opens checkout.', actual: 'Nothing happens.',
  })).toEqual({ ok: true });
  first = await state();
  const firstReview = { journeyId: first.journeyId, sessionId: first.sessionId };
  // A Save names its review; another review is never saved from it.
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_SAVE', acknowledged: true, journeyId: first.journeyId, sessionId: 'session-other' }))
    .toEqual(staleReview);
  expect((await state()).phase).toBe('reviewing');
  expect((await dispatch(page, { type: 'ANMERKO_JOURNEY_SAVE', acknowledged: true, ...firstReview })).ok).toBe(true);
  const saved = await state();
  expect(saved.phase).toBe('saved');
  // The saved confirmation is closed only by a discard that names it.
  for (const message of [
    { phase: 'reviewing', ...firstReview },
    { phase: 'saved', journeyId: 'journey-other' },
    { phase: 'saved', journeyId: saved.journeyId, revision: saved.revision + 1 },
  ]) {
    expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_DISCARD', ...message }), JSON.stringify(message)).toEqual(staleReview);
    expect(await state()).toEqual(saved);
  }

  // Another view reopens the saved journey: the same journey, in a new review session.
  await page.evaluate(() => {
    (globalThis as HarnessWindow).harness.tabs[80] = {
      id: 80, windowId: 7, active: true, url: 'chrome-extension://test-extension/journey.html',
    };
  });
  expect((await dispatch(page, { type: 'ANMERKO_JOURNEY_REOPEN', journeyId: saved.journeyId }, reviewPage)).ok).toBe(true);
  const reopened = await state();
  expect(reopened).toMatchObject({ phase: 'reviewing', journeyId: first.journeyId });
  expect(reopened.sessionId).not.toBe(first.sessionId);

  // Controls still showing the first review name it. Every command is
  // refused, even with the reopened review's own epoch and revision.
  const late = guards(reopened, first.sessionId);
  const [initial, click] = reopened.draft.steps;
  const imageId = click.image.imageId;
  const masked = await maskedPng(page, reopened.draft.images[imageId].dataUrl, { x: 0, y: 0, width: 2, height: 2 });
  const commands: Array<Record<string, unknown>> = [
    { type: 'ANMERKO_JOURNEY_UPDATE_SUMMARY', ...late, expected: 'Stale.', actual: 'Stale.' },
    { type: 'ANMERKO_JOURNEY_REMOVE_STEP', ...late, stepId: click.id },
    { type: 'ANMERKO_JOURNEY_EDIT_VALUE', ...late, stepId: click.id, value: { kind: 'text', value: 'x', truncated: false } },
    { type: 'ANMERKO_JOURNEY_REDACT_URL', ...late, stepId: initial.id, url: 'source' },
    { type: 'ANMERKO_JOURNEY_REDACT_LABEL', ...late, stepId: click.id },
    { type: 'ANMERKO_JOURNEY_REVIEW_IMAGE', epoch: late.epoch, journeyId: late.journeyId, sessionId: late.sessionId,
      revision: late.revision, imageId, operation: 'remove' },
    { type: 'ANMERKO_JOURNEY_REVIEW_IMAGE', epoch: late.epoch, journeyId: late.journeyId, sessionId: late.sessionId,
      revision: late.revision, imageId, operation: 'replace', dataUrl: masked },
    { type: 'ANMERKO_JOURNEY_SAVE', acknowledged: true, journeyId: late.journeyId, sessionId: late.sessionId },
    { type: 'ANMERKO_JOURNEY_DISCARD', phase: 'reviewing', journeyId: late.journeyId, sessionId: late.sessionId },
    // The saved confirmation it replaced, too.
    { type: 'ANMERKO_JOURNEY_DISCARD', phase: 'saved', journeyId: saved.journeyId },
    // A one-step discard offered for a revision that has since changed.
    { type: 'ANMERKO_JOURNEY_DISCARD', phase: 'reviewing', journeyId: reopened.journeyId, sessionId: reopened.sessionId,
      revision: reopened.draft.revision - 1 },
  ];
  for (const command of commands) {
    expect(await dispatch(page, command), `${command.type} ${command.operation ?? command.phase ?? ''}`).toEqual(staleReview);
    expect(await state()).toEqual(reopened);
  }
  // Malformed targets are refused outright.
  for (const command of [
    { type: 'ANMERKO_JOURNEY_DISCARD', phase: 'recording' },
    { type: 'ANMERKO_JOURNEY_DISCARD', phase: 'reviewing', journeyId: reopened.journeyId },
    { type: 'ANMERKO_JOURNEY_DISCARD', phase: 'saved', revision: 'one' },
    { type: 'ANMERKO_JOURNEY_REMOVE_STEP', ...guards(reopened), sessionId: 7, stepId: click.id },
    { type: 'ANMERKO_JOURNEY_SAVE', acknowledged: true, journeyId: reopened.journeyId },
  ]) {
    expect(await dispatch(page, command), JSON.stringify(command)).toEqual(unavailable);
    expect(await state()).toEqual(reopened);
  }

  // The reopened review's own controls act on it.
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_REDACT_LABEL', ...guards(reopened), stepId: click.id })).toEqual({ ok: true });
  const redacted = await state();
  expect(redacted.draft.steps[1].target.label).toBe('[redacted]');
  expect(await dispatch(page, {
    type: 'ANMERKO_JOURNEY_DISCARD', phase: 'reviewing', journeyId: redacted.journeyId, sessionId: redacted.sessionId,
    revision: redacted.draft.revision,
  })).toEqual({ ok: true });
  expect((await state()).phase).toBe('idle');
  // A journey already closed leaves nothing to refuse.
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_DISCARD', phase: 'reviewing', ...firstReview })).toEqual({ ok: true });
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_DISCARD', phase: 'saved' })).toEqual({ ok: true });
  expect((await state()).phase).toBe('idle');
});

test('a click label redacted through the command channel stays redacted in the saved journey', async ({ page }) => {
  let state = await reviewWithClickScreenshot(page);
  const guards = (current: any) => ({
    epoch: current.epoch, journeyId: current.journeyId, revision: current.draft.revision,
    updatedAt: new Date().toISOString(),
  });
  const [initial, click] = state.draft.steps;
  expect(click.target.label).toBe('Pay');
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_REDACT_LABEL', ...guards(state), stepId: click.id }))
    .toEqual({ ok: true });
  state = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value;
  expect(state.draft.steps[1].target.label).toBe('[redacted]');
  expect(state.draft.redactions).toEqual({ steps: { [click.id]: { label: true } } });
  // Repeating it, or naming a step without a click label, changes nothing.
  for (const stepId of [click.id, initial.id]) {
    expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_REDACT_LABEL', ...guards(state), stepId })).toEqual({ ok: true });
    expect((await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value.draft.revision).toBe(state.draft.revision);
  }
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_REDACT_LABEL', ...guards(state) })).toEqual(unavailable);

  expect(await dispatch(page, {
    type: 'ANMERKO_JOURNEY_UPDATE_SUMMARY', ...guards(state), expected: 'Paying opens checkout.', actual: 'Nothing happens.',
  })).toEqual({ ok: true });
  const saved = await dispatch(page, { type: 'ANMERKO_JOURNEY_SAVE', acknowledged: true });
  expect(saved.ok).toBe(true);
  const snapshot = (await dispatch(page, { type: 'ANMERKO_JOURNEY_OPEN_SNAPSHOT', journeyId: saved.value.journeyId })).value;
  expect(snapshot.draft.steps[1].target.label).toBe('[redacted]');
  expect(snapshot.draft.redactions).toEqual({ steps: { [click.id]: { label: true } } });
  expect(JSON.stringify(snapshot.draft)).not.toContain('"Pay"');
});

test('freezes an unexplained same-URL document replacement instead of reattaching collection', async ({ page }) => {
  await dispatch(page, { type: 'ANMERKO_JOURNEY_START', ownerTabId: 1, ownerWindowId: 7 });
  const startsBefore = await page.evaluate(() => (globalThis as HarnessWindow).harness.pageCommands
    .filter(command => command.message.type === 'ANMERKO_JOURNEY_PAGE_START').length);
  await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).harness;
    harness.identity.documentToken = 'same-url-reloaded-document';
    delete harness.identity.recording;
    harness.reboot();
  });

  await page.evaluate(() => (globalThis as HarnessWindow).harness.control.ready);
  const recovered = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value;
  expect(recovered).toMatchObject({ phase: 'reviewing', draft: { stopReason: 'capture-failed' } });
  expect(await page.evaluate(() => (globalThis as HarnessWindow).harness.pageCommands
    .filter(command => command.message.type === 'ANMERKO_JOURNEY_PAGE_START').length)).toBe(startsBefore);
});

test('processes a committed owner navigation that wakes the background before validating the new document', async ({ page }) => {
  await dispatch(page, { type: 'ANMERKO_JOURNEY_START', ownerTabId: 1, ownerWindowId: 7 });
  const nextUrl = 'https://example.test/wake-navigation';
  await page.evaluate(url => {
    const harness = (globalThis as HarnessWindow).harness;
    harness.tabs[1].url = url;
    harness.identity = { ...harness.identity, documentToken: 'wake-document', url, generation: 0 };
    delete harness.identity.recording;
    harness.reboot();
    harness.events.committed.emit({ tabId: 1, frameId: 0, url, documentLifecycle: 'active' });
  }, nextUrl);

  await page.evaluate(() => (globalThis as HarnessWindow).harness.control.ready);
  await expect.poll(async () => (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value.documentToken)
    .toBe('wake-document');
  const recovered = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value;
  expect(recovered.phase).toBe('recording');
  expect(recovered.draft.steps.at(-1)).toMatchObject({ kind: 'navigation', navigation: { toUrl: nextUrl } });
});

test('processes a committed owner navigation that arrives during recovery validation', async ({ page }) => {
  await dispatch(page, { type: 'ANMERKO_JOURNEY_START', ownerTabId: 1, ownerWindowId: 7 });
  await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).harness;
    harness.deferIdentify = true;
    harness.reboot();
  });
  await expect.poll(() => page.evaluate(() => Boolean((globalThis as HarnessWindow).harness.releaseIdentify))).toBe(true);

  const nextUrl = 'https://example.test/late-wake-navigation';
  await page.evaluate(url => {
    const harness = (globalThis as HarnessWindow).harness;
    harness.tabs[1].url = url;
    harness.identity = { ...harness.identity, documentToken: 'late-wake-document', url, generation: 0 };
    delete harness.identity.recording;
    harness.events.committed.emit({ tabId: 1, frameId: 0, url, documentLifecycle: 'active' });
    harness.deferIdentify = false;
    harness.releaseIdentify?.();
  }, nextUrl);

  await page.evaluate(() => (globalThis as HarnessWindow).harness.control.ready);
  await expect.poll(async () => (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value.documentToken)
    .toBe('late-wake-document');
  const recovered = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value;
  expect(recovered.phase).toBe('recording');
  expect(recovered.draft.steps.at(-1)).toMatchObject({ kind: 'navigation', navigation: { toUrl: nextUrl } });
});

test('reports session write failure and stops before collection can continue', async ({ page }) => {
  await page.evaluate(() => { (globalThis as HarnessWindow).harness.failStorageSet = true; });
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_START', ownerTabId: 1, ownerWindowId: 7 }))
    .toEqual({ ok: false, error: 'Journey command unavailable.', code: 'session-storage-failed' });
  const state = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value;
  expect(state.phase).not.toBe('recording');
  expect(await page.evaluate(() => (globalThis as HarnessWindow).harness.identity.recording)).toBeUndefined();
});

test('fails closed when a lifecycle alarm cannot be scheduled', async ({ page }) => {
  await page.evaluate(() => { (globalThis as HarnessWindow).harness.failAlarmCreate = true; });
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_START', ownerTabId: 1, ownerWindowId: 7 }))
    .toEqual({ ok: false, error: 'Journey command unavailable.', code: 'session-storage-failed' });
  await expect.poll(async () => (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value.phase).toBe('reviewing');
  expect((await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value.draft.stopReason).toBe('session-storage-limit');
  expect(await page.evaluate(() => (globalThis as HarnessWindow).harness.identity.recording)).toBeUndefined();
});

test('allows a trusted explicit reset after session initialization fails without resuming recording', async ({ page }) => {
  await dispatch(page, { type: 'ANMERKO_JOURNEY_START', ownerTabId: 1, ownerWindowId: 7 });
  const startsBefore = await page.evaluate(() => (globalThis as HarnessWindow).harness.pageCommands
    .filter(command => command.message.type === 'ANMERKO_JOURNEY_PAGE_START').length);
  const stalePort = await page.evaluate(owner => {
    const harness = (globalThis as HarnessWindow).harness;
    harness.failStorageGet = true;
    harness.reboot();
    return harness.connectPort('anmerko-journey-events-v1', owner);
  }, ownerPage);
  await page.evaluate(() => (globalThis as HarnessWindow).harness.control.ready);
  await expect.poll(() => page.evaluate(() => (globalThis as HarnessWindow).harness.identity.recording)).toBeUndefined();
  expect(await page.evaluate(index => (globalThis as HarnessWindow).harness.ports[index].disconnected, stalePort)).toBe(true);
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' }))
    .toEqual({ ok: false, error: 'Journey command unavailable.', code: 'session-storage-failed' });
  await page.evaluate(() => { (globalThis as HarnessWindow).harness.failStorageGet = false; });
  // Only the explicit reset clears failed storage, never a discard that names a journey.
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_DISCARD', phase: 'saved' }))
    .toEqual({ ok: false, error: 'Journey command unavailable.', code: 'session-storage-failed' });
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_DISCARD' })).toEqual({ ok: true });
  expect((await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value).toEqual({ phase: 'idle', epoch: 0 });
  expect(await page.evaluate(() => (globalThis as HarnessWindow).harness.pageCommands
    .filter(command => command.message.type === 'ANMERKO_JOURNEY_PAGE_START').length)).toBe(startsBefore);
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_START', ownerTabId: 1, ownerWindowId: 7 }))
    .toEqual({ ok: true });
  expect((await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value.phase).toBe('recording');
});

test('Record journey from a page after journey storage fails opens the journey tab that resets it', async ({ page }) => {
  await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).harness;
    harness.failStorageGet = true;
    harness.reboot();
  });
  await page.evaluate(() => (globalThis as HarnessWindow).harness.control.ready);
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_PENDING' }, ownerPage)).toEqual({ ok: true, value: false });
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_OPEN' }, ownerPage)).toEqual({ ok: true });
  expect(await page.evaluate(() => (globalThis as HarnessWindow).harness.createdTabs.map(tab => tab.url)))
    .toEqual(['chrome-extension://test-extension/journey.html']);
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' }, reviewPage))
    .toEqual({ ok: false, error: 'Journey command unavailable.', code: 'session-storage-failed' });
  await page.evaluate(() => { (globalThis as HarnessWindow).harness.failStorageGet = false; });
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_DISCARD' }, reviewPage)).toEqual({ ok: true });
  expect((await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' }, reviewPage)).value).toEqual({ phase: 'idle', epoch: 0 });
});

test('reconciles a restored review recorder and retries a transient page stop failure on reconnect', async ({ page }) => {
  await dispatch(page, { type: 'ANMERKO_JOURNEY_START', ownerTabId: 1, ownerWindowId: 7 });
  const recording = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value;
  await page.evaluate(() => { (globalThis as HarnessWindow).harness.failPageStopCount = 1; });
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_STOP' })).toEqual({ ok: true });
  expect(await page.evaluate(() => (globalThis as HarnessWindow).harness.identity.recording)).toEqual({
    sessionId: recording.sessionId, epoch: recording.epoch,
  });

  const port = await page.evaluate(owner => (globalThis as HarnessWindow).harness
    .connectPort('anmerko-journey-events-v1', owner), ownerPage);
  await expect.poll(() => page.evaluate(() => (globalThis as HarnessWindow).harness.identity.recording)).toBeUndefined();
  expect(await page.evaluate(index => (globalThis as HarnessWindow).harness.ports[index].disconnected, port)).toBe(true);

  await page.evaluate(({ sessionId, epoch }) => {
    const harness = (globalThis as HarnessWindow).harness;
    harness.identity.recording = { sessionId, epoch };
    harness.reboot();
  }, { sessionId: recording.sessionId, epoch: recording.epoch });
  await page.evaluate(() => (globalThis as HarnessWindow).harness.control.ready);
  expect((await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value.phase).toBe('reviewing');
  expect(await page.evaluate(() => (globalThis as HarnessWindow).harness.identity.recording)).toBeUndefined();
});

test('does not report recovery ready before a fail-closed stop is durably written', async ({ page }) => {
  await dispatch(page, { type: 'ANMERKO_JOURNEY_START', ownerTabId: 1, ownerWindowId: 7 });
  await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).harness;
    harness.identity.documentToken = 'unexplained-recovery-document';
    delete harness.identity.recording;
    harness.deferStorageSet = true;
    harness.reboot();
  });
  await expect.poll(() => page.evaluate(() => Boolean((globalThis as HarnessWindow).harness.releaseStorageSet))).toBe(true);
  expect(await page.evaluate(async () => Promise.race([
    (globalThis as HarnessWindow).harness.control.ready.then(() => true),
    new Promise<false>(resolve => setTimeout(() => resolve(false), 25)),
  ]))).toBe(false);
  await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).harness;
    harness.deferStorageSet = false;
    harness.releaseStorageSet?.();
  });
  await page.evaluate(() => (globalThis as HarnessWindow).harness.control.ready);
  expect((await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value)
    .toMatchObject({ phase: 'reviewing', draft: { stopReason: 'capture-failed' } });
});

test('keeps toolbar Stop synchronous and opens a warned review when persistence fails', async ({ page }) => {
  await dispatch(page, { type: 'ANMERKO_JOURNEY_START', ownerTabId: 1, ownerWindowId: 7 });
  const immediate = await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).harness;
    harness.failStorageSet = true;
    const handled = harness.control.stopIfRecording();
    return { handled };
  });
  expect(immediate).toEqual({ handled: true });
  expect((await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value.phase).toBe('reviewing');
  await expect.poll(async () => (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value.draft.stopReason)
    .toBe('session-storage-limit');
  await expect.poll(() => page.evaluate(() => (globalThis as HarnessWindow).harness.createdTabs
    .filter(tab => tab.url === 'chrome-extension://test-extension/journey.html').length)).toBe(1);
  expect(await page.evaluate(() => (globalThis as HarnessWindow).harness.actions)).toEqual(expect.arrayContaining([
    { method: 'badge', details: { tabId: 1, text: '!' } },
    { method: 'title', details: { tabId: 1, title: 'Journey storage failed — review draft now' } },
  ]));
});

test('stops a stale page recorder when its event port reconnects to an idle background', async ({ page }) => {
  const port = await page.evaluate(owner => {
    const harness = (globalThis as HarnessWindow).harness;
    harness.identity.recording = { sessionId: 'stale-session', epoch: 4 };
    return harness.connectPort('anmerko-journey-events-v1', owner);
  }, ownerPage);
  await expect.poll(() => page.evaluate(() => (globalThis as HarnessWindow).harness.identity.recording)).toBeUndefined();
  expect(await page.evaluate(index => (globalThis as HarnessWindow).harness.ports[index].disconnected, port)).toBe(true);
  expect((await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value).toEqual({ phase: 'idle', epoch: 0 });
});

test('does not resurrect stale committed recording bytes after write and cleanup both fail', async ({ page }) => {
  await dispatch(page, { type: 'ANMERKO_JOURNEY_START', ownerTabId: 1, ownerWindowId: 7 });
  const before = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value;
  const batch = {
    schemaVersion: 1, sessionId: before.sessionId, epoch: before.epoch,
    documentToken: before.documentToken, localCounter: 1,
    events: [{
      kind: 'click', id: 'failed-write-event', observedAt: new Date().toISOString(), elapsedMs: 10,
      sourceUrl: 'https://example.test/path?item=1#top',
      target: { tag: 'button', selectorPath: ['button'], label: 'Continue', editable: false,
        viewport: { width: 1280, height: 720 }, scroll: { x: 0, y: 10 }, point: { x: 20, y: 20 } },
      image: { status: 'pending', captureId: 'failed-write-capture' },
    }],
  };
  await page.evaluate(({ owner, batch }) => {
    const harness = (globalThis as HarnessWindow).harness;
    harness.failStorageSet = true;
    harness.failStorageRemove = true;
    const port = harness.connectPort('anmerko-journey-events-v1', owner);
    harness.postPort(port, { type: 'ANMERKO_JOURNEY_EVENTS', batch });
  }, { owner: ownerPage, batch });
  await expect.poll(async () => (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value.phase).toBe('reviewing');
  expect((await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value.draft.stopReason).toBe('session-storage-limit');
  expect(await page.evaluate(() => (globalThis as HarnessWindow).harness.identity.recording)).toBeUndefined();

  const startsBefore = await page.evaluate(() => (globalThis as HarnessWindow).harness.pageCommands
    .filter(command => command.message.type === 'ANMERKO_JOURNEY_PAGE_START').length);
  await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).harness;
    harness.failStorageSet = false;
    harness.failStorageRemove = false;
    harness.reboot();
  });
  await page.evaluate(() => (globalThis as HarnessWindow).harness.control.ready);
  const recovered = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value;
  expect(recovered).toMatchObject({ phase: 'reviewing', draft: { stopReason: 'capture-failed' } });
  expect(await page.evaluate(() => (globalThis as HarnessWindow).harness.pageCommands
    .filter(command => command.message.type === 'ANMERKO_JOURNEY_PAGE_START').length)).toBe(startsBefore);
});

test('fails closed without webNavigation and installs navigation listeners once the API is available', async ({ page }) => {
  await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).harness;
    harness.navigationAvailable = false;
    harness.reboot();
  });
  await page.evaluate(() => (globalThis as HarnessWindow).harness.control.ready);
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_START', ownerTabId: 1, ownerWindowId: 7 }))
    .toEqual({ ok: false, error: 'Journey command unavailable.' });
  let facts = await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).harness;
    return {
      listeners: [harness.events.committed.count(), harness.events.history.count(), harness.events.fragment.count()],
      scriptingCalls: harness.scriptingCalls,
      sequence: harness.sequence,
    };
  });
  expect(facts.listeners).toEqual([0, 0, 0]);
  expect(facts.scriptingCalls).toEqual([]);
  expect(facts.sequence).not.toContain('capture');

  await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).harness;
    harness.navigationAvailable = true;
    harness.sequence.length = 0;
  });
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_START', ownerTabId: 1, ownerWindowId: 7 }))
    .toEqual({ ok: true });
  facts = await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).harness;
    return {
      listeners: [harness.events.committed.count(), harness.events.history.count(), harness.events.fragment.count()],
      scriptingCalls: harness.scriptingCalls,
      sequence: harness.sequence,
    };
  });
  expect(facts.listeners).toEqual([1, 1, 1]);
  expect(facts.sequence).toContain('capture');
});

// navigation (commit, history, fragment), owner (activated, updated, replaced, focus), removal, alarm
function journeyListeners(page: Page) {
  return page.evaluate(() => {
    const { events } = (globalThis as HarnessWindow).harness;
    return {
      navigation: [events.committed.count(), events.history.count(), events.fragment.count()],
      owner: [events.activated.count(), events.updated.count(), events.replaced.count(), events.focused.count()],
      removal: events.removed.count(),
      alarm: events.alarm.count(),
    };
  });
}

// Reads the listeners a background registered in its startup turn, before
// its state is restored: the ones a browser would wake it for.
function rebootSynchronously(page: Page) {
  return page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).harness;
    // The unloaded background's timers end with it.
    const keepAwake = (globalThis as any).__keepAwake as Map<number, unknown> | undefined;
    for (const id of keepAwake?.keys() ?? []) clearInterval(id);
    harness.reboot();
    const { events } = harness;
    return {
      navigation: [events.committed.count(), events.history.count(), events.fragment.count()],
      owner: [events.activated.count(), events.updated.count(), events.replaced.count(), events.focused.count()],
      removal: events.removed.count(),
      alarm: events.alarm.count(),
      filters: [events.committed.filters(), events.history.filters(), events.fragment.filters()],
    };
  });
}

// Records the keep-awake intervals a background sets and clears.
function trackKeepAwake(page: Page) {
  return page.evaluate(() => {
    const test = globalThis as any;
    const set = setInterval, clear = clearInterval;
    const keepAwake = new Map<number, () => void>();
    test.__keepAwake = keepAwake;
    test.setInterval = (callback: () => void, ms?: number) => {
      const id = set(callback, ms);
      if (ms === 10_000) keepAwake.set(id as unknown as number, callback);
      return id;
    };
    test.clearInterval = (id: number) => { keepAwake.delete(id); clear(id); };
  });
}

const IDLE_LISTENERS = { navigation: [0, 0, 0], owner: [0, 0, 0, 0], removal: 0, alarm: 1 };
const LIVE_LISTENERS = { navigation: [1, 1, 1], owner: [1, 1, 1, 1], removal: 1, alarm: 1 };

test('journey listeners register at startup and stay only while a journey phase needs them', async ({ page }) => {
  const listeners = () => journeyListeners(page);
  const ready = () => page.evaluate(() => (globalThis as HarnessWindow).harness.control.ready);
  await trackKeepAwake(page);

  // An idle background wakes for none of the navigation and tab events. The
  // alarm listener fires only for alarms a journey scheduled.
  await ready();
  expect(await listeners()).toEqual(IDLE_LISTENERS);

  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_START', ownerTabId: 1, ownerWindowId: 7 })).toEqual({ ok: true });
  expect(await listeners()).toEqual(LIVE_LISTENERS);
  // Chromium wakes a worker for listeners it added after starting too.
  expect(await page.evaluate(() => (globalThis as any).__keepAwake.size)).toBe(0);
  // Every event is registered in the startup turn, so a waking event reaches
  // a journey that has not been restored yet.
  const woken = await rebootSynchronously(page);
  expect(woken).toMatchObject(LIVE_LISTENERS);
  expect(woken.filters).toEqual([
    [undefined],
    [{ url: [{ schemes: ['http', 'https'] }] }],
    [{ url: [{ schemes: ['http', 'https'] }] }],
  ]);
  await ready();
  expect((await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value.phase).toBe('recording');
  expect(await listeners()).toEqual(LIVE_LISTENERS);

  // A review only waits for its warning and expiry alarms.
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_STOP' })).toEqual({ ok: true });
  expect(await listeners()).toEqual(IDLE_LISTENERS);
  expect(await rebootSynchronously(page)).toMatchObject(LIVE_LISTENERS);
  await ready();
  expect((await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value.phase).toBe('reviewing');
  expect(await listeners()).toEqual(IDLE_LISTENERS);

  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_DISCARD' })).toEqual({ ok: true });
  expect(await listeners()).toEqual(IDLE_LISTENERS);
  expect(await rebootSynchronously(page)).toMatchObject(LIVE_LISTENERS);
  await ready();
  expect(await listeners()).toEqual(IDLE_LISTENERS);

  // A pending launch tab is watched for closing, which releases its intent.
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_OPEN' }, ownerPage)).toEqual({ ok: true });
  expect(await listeners()).toEqual({ ...IDLE_LISTENERS, removal: 1 });
  await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).harness;
    const launchTab = Object.values(harness.tabs).find(tab => tab.url.includes('#launch='))!;
    delete harness.tabs[launchTab.id];
    harness.tabs[1].active = true;
    harness.events.removed.emit(launchTab.id, { windowId: 7 });
  });
  expect(await listeners()).toEqual(IDLE_LISTENERS);
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_OPEN' }, ownerPage)).toEqual({ ok: true });

  // A start whose first screenshot fails leaves nothing registered.
  await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).harness;
    const launchTab = Object.values(harness.tabs).find(tab => tab.url.includes('#launch='))!;
    delete harness.tabs[launchTab.id];
    harness.tabs[1].active = true;
    harness.events.removed.emit(launchTab.id, { windowId: 7 });
    harness.captureMode = 'throw';
  });
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_START', ownerTabId: 1, ownerWindowId: 7 }))
    .toEqual({ ok: false, error: 'Journey command unavailable.', code: 'initial-capture-failed' });
  expect(await listeners()).toEqual(IDLE_LISTENERS);
});

test('a Firefox event page registers journey listeners at startup only after a live phase and otherwise stays awake while live', async ({ page }) => {
  const listeners = () => journeyListeners(page);
  const ready = () => page.evaluate(() => (globalThis as HarnessWindow).harness.control.ready);
  const hint = () => page.evaluate(() => localStorage.getItem('anmerko:journey-listeners:v1'));
  const keepAwake = () => page.evaluate(() => (globalThis as any).__keepAwake.size);
  await trackKeepAwake(page);
  await page.evaluate(() => {
    const test = globalThis as any;
    // Only Firefox has runtime.getBrowserInfo.
    test.chrome.runtime.getBrowserInfo = async () => ({ name: 'Firefox' });
    test.__platformInfoCalls = 0;
    test.chrome.runtime.getPlatformInfo = async () => { test.__platformInfoCalls += 1; return { os: 'mac' }; };
  });

  // A first start has no hint, so it registers every listener and removes them once idle.
  expect(await hint()).toBeNull();
  expect(await rebootSynchronously(page)).toMatchObject(LIVE_LISTENERS);
  await ready();
  expect(await listeners()).toEqual(IDLE_LISTENERS);
  expect(await hint()).toBe('idle');
  // Firefox wakes an event page only for listeners registered while it
  // started, so the next start leaves out every navigation and tab event.
  expect(await rebootSynchronously(page)).toMatchObject(IDLE_LISTENERS);
  await ready();
  expect(await listeners()).toEqual(IDLE_LISTENERS);
  expect(await keepAwake()).toBe(0);

  // Listeners added now would not wake the unloaded page, so the journey
  // keeps it from idling with a periodic API call.
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_START', ownerTabId: 1, ownerWindowId: 7 })).toEqual({ ok: true });
  expect(await listeners()).toEqual(LIVE_LISTENERS);
  expect(await hint()).toBe('live');
  expect(await keepAwake()).toBe(1);
  expect(await page.evaluate(() => {
    const test = globalThis as any;
    for (const callback of test.__keepAwake.values()) callback();
    return test.__platformInfoCalls;
  })).toBe(1);

  // A start during the journey registers them all and needs no keep-awake.
  const woken = await rebootSynchronously(page);
  expect(woken).toMatchObject(LIVE_LISTENERS);
  expect(woken.filters[1]).toEqual([{ url: [{ schemes: ['http', 'https'] }] }]);
  await ready();
  expect((await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value.phase).toBe('recording');
  expect(await listeners()).toEqual(LIVE_LISTENERS);
  expect(await keepAwake()).toBe(0);

  // A journey restored by a start that left them out (a lost hint) is kept awake too.
  await page.evaluate(() => localStorage.setItem('anmerko:journey-listeners:v1', 'idle'));
  expect(await rebootSynchronously(page)).toMatchObject(IDLE_LISTENERS);
  await ready();
  expect((await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value.phase).toBe('recording');
  expect(await listeners()).toEqual(LIVE_LISTENERS);
  expect(await hint()).toBe('live');
  expect(await keepAwake()).toBe(1);

  // Ending the journey releases the page and tells the next start to leave them out.
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_STOP' })).toEqual({ ok: true });
  expect(await listeners()).toEqual(IDLE_LISTENERS);
  expect(await hint()).toBe('idle');
  expect(await keepAwake()).toBe(0);
  expect(await rebootSynchronously(page)).toMatchObject(IDLE_LISTENERS);
  await ready();
  expect((await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value.phase).toBe('reviewing');
  expect(await listeners()).toEqual(IDLE_LISTENERS);
});

test('observes ordered top-frame owner navigations and injects the idle observer only for new documents', async ({ page }) => {
  await dispatch(page, { type: 'ANMERKO_JOURNEY_START', ownerTabId: 1, ownerWindowId: 7 });
  await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).harness;
    harness.events.committed.emit({ tabId: 2, frameId: 0, url: 'https://other.test/new', documentLifecycle: 'active' });
    harness.events.committed.emit({ tabId: 1, frameId: 4, url: 'https://example.test/frame', documentLifecycle: 'active' });
    harness.events.committed.emit({ tabId: 1, frameId: 0, url: 'https://example.test/cached', documentLifecycle: 'cached' });
  });
  expect(await page.evaluate(() => (globalThis as HarnessWindow).harness.scriptingCalls)).toEqual([]);

  await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).harness;
    const url = 'https://example.test/next?item=2#section';
    harness.tabs[1].url = url;
    harness.identity = {
      ...harness.identity,
      documentToken: 'document-2',
      url,
      generation: 0,
    };
    harness.events.committed.emit({ tabId: 1, frameId: 0, url, documentLifecycle: 'active' });
  });
  await expect.poll(() => page.evaluate(() => (globalThis as HarnessWindow).harness.scriptingCalls.length)).toBe(1);
  await expect.poll(async () => (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value.documentToken).toBe('document-2');

  await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).harness;
    const url = 'https://example.test/next?item=3#section';
    harness.tabs[1].url = url;
    harness.identity.url = url;
    harness.events.history.emit({ tabId: 1, frameId: 0, url });
    const fragmentUrl = 'https://example.test/next?item=3#details';
    harness.tabs[1].url = fragmentUrl;
    harness.identity.url = fragmentUrl;
    harness.events.fragment.emit({ tabId: 1, frameId: 0, url: fragmentUrl });
  });
  const state = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value;
  expect(state.draft.steps.filter((step: any) => step.kind === 'navigation').map((step: any) => step.navigation.toUrl))
    .toEqual([
      'https://example.test/next?item=2#section',
      'https://example.test/next?item=3#section',
      'https://example.test/next?item=3#details',
    ]);
  expect(await page.evaluate(() => (globalThis as HarnessWindow).harness.scriptingCalls)).toEqual([{
    target: { tabId: 1, frameIds: [0] }, files: ['journey-observer.js'], injectImmediately: true,
  }]);
});

test('injects again for a same-URL new document and cancels a pending connection on Stop', async ({ page }) => {
  await dispatch(page, { type: 'ANMERKO_JOURNEY_START', ownerTabId: 1, ownerWindowId: 7 });
  await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).harness;
    harness.identity.documentToken = 'document-reload';
    harness.deferInjection = true;
    harness.events.committed.emit({
      tabId: 1, frameId: 0, url: 'https://example.test/path?item=1#top',
    });
  });
  await expect.poll(() => page.evaluate(() => (globalThis as HarnessWindow).harness.scriptingCalls.length)).toBe(1);
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_STOP' }, sidebar)).toEqual({ ok: true });
  await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).harness;
    harness.deferInjection = false;
    harness.releaseInjection?.();
  });
  await expect.poll(async () => (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value.phase).toBe('reviewing');
  const facts = await page.evaluate(() => ({
    commands: (globalThis as HarnessWindow).harness.pageCommands,
    scriptingCalls: (globalThis as HarnessWindow).harness.scriptingCalls,
  }));
  expect(facts.scriptingCalls).toHaveLength(1);
  expect(facts.commands.filter(command => command.message.type === 'ANMERKO_JOURNEY_PAGE_START'
    && command.message.documentToken === 'document-reload')).toEqual([]);
});

test('does not begin the new document when Stop arrives during navigation injection', async ({ page }) => {
  await dispatch(page, { type: 'ANMERKO_JOURNEY_START', ownerTabId: 1, ownerWindowId: 7 });
  await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).harness;
    const url = 'https://example.test/deferred-grant';
    harness.tabs[1].url = url;
    harness.identity = { ...harness.identity, documentToken: 'document-deferred', url, generation: 0 };
    harness.deferInjection = true;
    harness.events.committed.emit({ tabId: 1, frameId: 0, url });
  });
  await expect.poll(() => page.evaluate(() => Boolean((globalThis as HarnessWindow).harness.releaseInjection))).toBe(true);
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_STOP' }, sidebar)).toEqual({ ok: true });
  await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).harness;
    harness.deferInjection = false;
    harness.releaseInjection?.();
  });
  await expect.poll(async () => (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value.phase).toBe('reviewing');
  expect(await page.evaluate(() => (globalThis as HarnessWindow).harness.pageCommands
    .filter(command => command.message.type === 'ANMERKO_JOURNEY_PAGE_START'
      && command.message.documentToken === 'document-deferred'))).toEqual([]);
});

test('stops on protected owner destinations and tab replacement without following a new tab', async ({ page }) => {
  await dispatch(page, { type: 'ANMERKO_JOURNEY_START', ownerTabId: 1, ownerWindowId: 7 });
  await page.evaluate(() => (globalThis as HarnessWindow).harness.events.committed.emit({
    tabId: 1, frameId: 0, url: 'chrome://settings/', documentLifecycle: 'active',
  }));
  expect((await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value)
    .toMatchObject({ phase: 'reviewing', draft: { stopReason: 'protected-page' } });
  const navigationListeners = () => page.evaluate(() => [
    (globalThis as HarnessWindow).harness.events.committed.count(),
    (globalThis as HarnessWindow).harness.events.history.count(),
    (globalThis as HarnessWindow).harness.events.fragment.count(),
  ]);
  // The review needs no navigation events; the next journey registers them again.
  expect(await navigationListeners()).toEqual([0, 0, 0]);

  await dispatch(page, { type: 'ANMERKO_JOURNEY_DISCARD' });
  await dispatch(page, { type: 'ANMERKO_JOURNEY_START', ownerTabId: 1, ownerWindowId: 7 });
  expect(await navigationListeners()).toEqual([1, 1, 1]);
  await page.evaluate(() => (globalThis as HarnessWindow).harness.events.replaced.emit(9, 1));
  expect((await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value)
    .toMatchObject({ phase: 'reviewing', draft: { stopReason: 'tab-lost' } });
  expect(await page.evaluate(() => (globalThis as HarnessWindow).harness.scriptingCalls
    .some((call: any) => call.target.tabId === 9))).toBe(false);
});

test('stops with left-site when an owner navigation leaves the starting origin', async ({ page }) => {
  await dispatch(page, { type: 'ANMERKO_JOURNEY_START', ownerTabId: 1, ownerWindowId: 7 });
  await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).harness;
    harness.events.committed.emit({
      tabId: 1, frameId: 0, url: 'https://other.test/next', documentLifecycle: 'active',
    });
  });
  await expect.poll(async () => (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value.draft.stopReason)
    .toBe('left-site');
  const stopped = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value;
  expect(stopped.phase).toBe('reviewing');
  // The off-site destination never becomes a navigation step or an injection.
  expect(stopped.draft.steps.every((step: any) => step.kind !== 'navigation')).toBe(true);
  expect(await page.evaluate(() => (globalThis as HarnessWindow).harness.scriptingCalls)).toEqual([]);
});

test('keeps recording across same-origin path changes and same-URL reloads', async ({ page }) => {
  await dispatch(page, { type: 'ANMERKO_JOURNEY_START', ownerTabId: 1, ownerWindowId: 7 });
  const before = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value;
  const pathUrl = 'https://example.test/next?item=2#section';
  await page.evaluate(url => {
    const harness = (globalThis as HarnessWindow).harness;
    harness.tabs[1].url = url;
    harness.identity = { ...harness.identity, documentToken: 'same-origin-document', url, generation: 0 };
    harness.events.committed.emit({ tabId: 1, frameId: 0, url, documentLifecycle: 'active' });
  }, pathUrl);
  await expect.poll(async () => (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value.draft.steps.at(-1)?.navigation?.toUrl)
    .toBe(pathUrl);

  await page.evaluate(url => {
    const harness = (globalThis as HarnessWindow).harness;
    harness.identity = { ...harness.identity, documentToken: 'same-origin-reload', url, generation: 0 };
    harness.events.committed.emit({ tabId: 1, frameId: 0, url, documentLifecycle: 'active' });
  }, pathUrl);
  await expect.poll(async () => (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value.draft.steps.length)
    .toBe(before.draft.steps.length + 2);

  const state = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value;
  expect(state.phase).toBe('recording');
  expect(state.draft.stopReason).toBeUndefined();
  expect(state.documentToken).toBe('same-origin-reload');
  expect(state.draft.steps.slice(-2).map((step: any) => step.kind)).toEqual(['navigation', 'navigation']);
  expect(state.draft.steps.at(-2)).toMatchObject({ navigation: { toUrl: pathUrl } });
  expect(state.draft.steps.at(-1)).toMatchObject({ navigation: { toUrl: pathUrl } });
});

test('review redacts a navigation destination through the command channel', async ({ page }) => {
  await dispatch(page, { type: 'ANMERKO_JOURNEY_START', ownerTabId: 1, ownerWindowId: 7 });
  const nextUrl = 'https://example.test/reset?token=private-token-9q';
  await page.evaluate(url => {
    const harness = (globalThis as HarnessWindow).harness;
    harness.tabs[1].url = url;
    harness.identity = { ...harness.identity, documentToken: 'reset-document', url, generation: 0 };
    harness.events.committed.emit({ tabId: 1, frameId: 0, url, documentLifecycle: 'active' });
  }, nextUrl);
  await expect.poll(async () => (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value.draft.steps.at(-1)?.navigation?.toUrl)
    .toBe(nextUrl);
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_STOP' })).toEqual({ ok: true });
  let reviewing = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value;
  expect(reviewing.phase).toBe('reviewing');
  const navigation = reviewing.draft.steps.at(-1);
  const guards = {
    epoch: reviewing.epoch, journeyId: reviewing.journeyId, revision: reviewing.draft.revision,
    updatedAt: new Date().toISOString(),
  };

  expect(await dispatch(page, {
    type: 'ANMERKO_JOURNEY_REDACT_URL', ...guards, stepId: navigation.id, url: 'location',
  })).toEqual({ ok: false, error: 'Journey command unavailable.' });
  expect(await dispatch(page, {
    type: 'ANMERKO_JOURNEY_REDACT_URL', ...guards, stepId: navigation.id, url: 'destination',
  })).toEqual({ ok: true });
  reviewing = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value;
  expect(reviewing.draft.revision).toBe(guards.revision + 1);
  expect(reviewing.draft.steps.at(-1)).toMatchObject({
    id: navigation.id, sourceUrl: navigation.sourceUrl, navigation: { toUrl: '[redacted]' },
  });
  expect(reviewing.draft.redactions).toEqual({ steps: { [navigation.id]: { toUrl: true } } });
  expect(JSON.stringify(reviewing.draft.steps)).not.toContain('private-token-9q');
});

test('stops with page-access-lost when a same-origin document load hides the owner tab URL', async ({ page }) => {
  await dispatch(page, { type: 'ANMERKO_JOURNEY_START', ownerTabId: 1, ownerWindowId: 7 });
  const url = 'https://example.test/path?item=1#top';
  await page.evaluate(url => {
    const harness = (globalThis as HarnessWindow).harness;
    // Firefox withdraws activeTab with the old document: tabs.get hides the URL.
    delete (harness.tabs[1] as { url?: string }).url;
    harness.identity = { ...harness.identity, documentToken: 'reloaded-document', url, generation: 0 };
    delete harness.identity.recording;
    harness.events.committed.emit({ tabId: 1, frameId: 0, url, documentLifecycle: 'active' });
  }, url);
  await expect.poll(async () => (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value.draft.stopReason)
    .toBe('page-access-lost');
  const stopped = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value;
  expect(stopped.phase).toBe('reviewing');
  expect(stopped.draft.steps.map((step: any) => step.kind)).toEqual(['initial', 'navigation']);
  expect(stopped.draft.steps[0].image.status).toBe('retained');
  expect(stopped.draft.steps[1]).toMatchObject({
    navigation: { toUrl: url }, image: { status: 'unavailable', reason: 'capture-denied' },
  });
  expect(await page.evaluate(() => (globalThis as HarnessWindow).harness.scriptingCalls)).toEqual([]);
});

test('names withdrawn page access when injection into a reloaded document is refused', async ({ page }) => {
  await dispatch(page, { type: 'ANMERKO_JOURNEY_START', ownerTabId: 1, ownerWindowId: 7 });
  const url = 'https://example.test/path?item=1#top';
  await page.evaluate(url => {
    const harness = (globalThis as HarnessWindow).harness;
    (globalThis as any).chrome.scripting.executeScript = async (details: unknown) => {
      harness.scriptingCalls.push(structuredClone(details));
      delete (harness.tabs[1] as { url?: string }).url;
      throw new Error('Missing host permission for the tab');
    };
    harness.events.committed.emit({ tabId: 1, frameId: 0, url, documentLifecycle: 'active' });
  }, url);
  await expect.poll(async () => (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value.draft.stopReason)
    .toBe('page-access-lost');
  expect(await page.evaluate(() => (globalThis as HarnessWindow).harness.scriptingCalls)).toHaveLength(1);
});

test('stops waiting for a new document observer as soon as page access is withdrawn', async ({ page }) => {
  await dispatch(page, { type: 'ANMERKO_JOURNEY_START', ownerTabId: 1, ownerWindowId: 7 });
  const url = 'https://example.test/path?item=1#top';
  const started = Date.now();
  await page.evaluate(url => {
    const harness = (globalThis as HarnessWindow).harness;
    const tabs = (globalThis as any).chrome.tabs;
    const sendMessage = tabs.sendMessage;
    let injected = false;
    (globalThis as any).chrome.scripting.executeScript = async (details: unknown) => {
      harness.scriptingCalls.push(structuredClone(details));
      injected = true;
      return [{ frameId: 0, result: undefined }];
    };
    // The observer never answers in the new document, and the grant is gone.
    tabs.sendMessage = async (tabId: number, message: any, options?: unknown) => {
      if (injected && message.type === 'ANMERKO_JOURNEY_PAGE_IDENTIFY') {
        delete (harness.tabs[1] as { url?: string }).url;
        throw new Error('Could not establish connection. Receiving end does not exist.');
      }
      return sendMessage(tabId, message, options);
    };
    harness.events.committed.emit({ tabId: 1, frameId: 0, url, documentLifecycle: 'active' });
  }, url);
  await expect.poll(async () => (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value.draft.stopReason)
    .toBe('page-access-lost');
  // Well inside the five-second observer connection timeout.
  expect(Date.now() - started).toBeLessThan(3_000);
});

for (const platform of [
  { name: 'Chromium', firefox: false, reason: 'left-site' },
  { name: 'Firefox', firefox: true, reason: 'page-access-lost' },
]) {
  test(`recovery names a hidden owner tab URL after a wake as ${platform.reason} on ${platform.name}`, async ({ page }) => {
    await dispatch(page, { type: 'ANMERKO_JOURNEY_START', ownerTabId: 1, ownerWindowId: 7 });
    await page.evaluate(firefox => {
      const harness = (globalThis as HarnessWindow).harness;
      // Only Firefox has runtime.getBrowserInfo; its grant ends with every document.
      if (firefox) (globalThis as any).chrome.runtime.getBrowserInfo = async () => ({ name: 'Firefox' });
      delete (harness.tabs[1] as { url?: string }).url;
      harness.reboot();
    }, platform.firefox);
    await page.evaluate(() => (globalThis as HarnessWindow).harness.control.ready);
    expect((await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value)
      .toMatchObject({ phase: 'reviewing', draft: { stopReason: platform.reason } });
  });
}

test('a queued cross-origin commit explains a hidden owner URL after a wake as left-site in Firefox too', async ({ page }) => {
  await dispatch(page, { type: 'ANMERKO_JOURNEY_START', ownerTabId: 1, ownerWindowId: 7 });
  await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).harness;
    (globalThis as any).chrome.runtime.getBrowserInfo = async () => ({ name: 'Firefox' });
    delete (harness.tabs[1] as { url?: string }).url;
    harness.reboot();
    harness.events.committed.emit({ tabId: 1, frameId: 0, url: 'https://other.test/away', documentLifecycle: 'active' });
  });
  await page.evaluate(() => (globalThis as HarnessWindow).harness.control.ready);
  const stopped = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value;
  expect(stopped).toMatchObject({ phase: 'reviewing', draft: { stopReason: 'left-site' } });
  expect(stopped.draft.steps.map((step: any) => step.kind)).toEqual(['initial']);
});

test('routes matching event ports and stop commands without exposing state or raw replies to pages', async ({ page }) => {
  await dispatch(page, { type: 'ANMERKO_JOURNEY_START', ownerTabId: 1, ownerWindowId: 7 });
  const recording = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value;
  const batch = {
    schemaVersion: 1, sessionId: recording.sessionId, epoch: recording.epoch, documentToken: recording.documentToken, localCounter: 1,
    events: [{
      kind: 'click', id: 'event-1', observedAt: new Date().toISOString(), elapsedMs: 10,
      sourceUrl: 'https://example.test/path?item=1#top',
      target: { tag: 'button', role: 'button', selectorPath: ['html', 'body', 'button'], label: 'Continue', editable: false,
        viewport: { width: 1280, height: 720 }, scroll: { x: 0, y: 10 }, point: { x: 40, y: 40 } },
      image: { status: 'pending', captureId: 'capture-event-1' },
    }],
  };
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_EVENTS', batch }, { ...ownerPage, frameId: 2 })).toBeUndefined();
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_EVENTS', batch: { ...batch, sessionId: 'other-session' } }, ownerPage)).toBeUndefined();
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_EVENTS', batch }, ownerPage)).toBeUndefined();
  expect((await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value.draft.steps).toHaveLength(1);

  const portIndex = await page.evaluate(sender => (globalThis as HarnessWindow).harness
    .connectPort('anmerko-journey-events-v1', sender), ownerPage);
  await page.evaluate(({ portIndex, batch }) => (globalThis as HarnessWindow).harness
    .postPort(portIndex, { type: 'ANMERKO_JOURNEY_EVENTS', batch }), { portIndex, batch });
  const updated = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value;
  expect(updated.draft.steps).toHaveLength(2);
  expect(await page.evaluate(index => (globalThis as HarnessWindow).harness.ports[index].replies, portIndex)).toEqual([]);
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' }, ownerPage)).toBeUndefined();
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_STOP', sessionId: 'other', epoch: updated.epoch }, ownerPage)).toBeUndefined();
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_STOP', sessionId: updated.sessionId, epoch: updated.epoch }, ownerPage)).toEqual({ ok: true });
  expect((await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value)
    .toMatchObject({ phase: 'reviewing', draft: { stopReason: 'user' } });
  const facts = await page.evaluate(() => ({
    commands: (globalThis as HarnessWindow).harness.pageCommands,
    actions: (globalThis as HarnessWindow).harness.actions,
  }));
  expect(facts.commands).toEqual(expect.arrayContaining([
    expect.objectContaining({ message: expect.objectContaining({ type: 'ANMERKO_JOURNEY_PAGE_STATUS', count: 2 }) }),
    expect.objectContaining({ message: expect.objectContaining({ type: 'ANMERKO_JOURNEY_PAGE_STOP' }) }),
  ]));
  expect(facts.actions.slice(-2)).toEqual([
    { method: 'badge', details: { tabId: 1, text: '' } },
    { method: 'title', details: { tabId: 1, title: 'Annotate with anmerko' } },
  ]);
});

test('keeps an authenticated document port across a same-document URL change', async ({ page }) => {
  await dispatch(page, { type: 'ANMERKO_JOURNEY_START', ownerTabId: 1, ownerWindowId: 7 });
  const before = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value;
  const port = await page.evaluate(owner => (globalThis as HarnessWindow).harness
    .connectPort('anmerko-journey-events-v1', owner), ownerPage);
  const nextUrl = 'https://example.test/path?item=2#details';
  await page.evaluate(url => {
    const harness = (globalThis as HarnessWindow).harness;
    harness.tabs[1].url = url;
    harness.identity.url = url;
    harness.events.history.emit({ tabId: 1, frameId: 0, url, documentLifecycle: 'active' });
  }, nextUrl);
  await expect.poll(async () => (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value.draft.steps.at(-1)?.navigation?.toUrl)
    .toBe(nextUrl);
  const navigated = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value;
  const stepsBefore = navigated.draft.steps.length;
  await page.evaluate(({ port, state, url }) => {
    const harness = (globalThis as HarnessWindow).harness;
    harness.postPort(port, { type: 'ANMERKO_JOURNEY_EVENTS', batch: {
      schemaVersion: 1, sessionId: state.sessionId, epoch: state.epoch,
      documentToken: state.documentToken, localCounter: 1,
      events: [{
        kind: 'click', id: 'same-document-event', observedAt: new Date().toISOString(), elapsedMs: 30,
        sourceUrl: url,
        target: { tag: 'button', selectorPath: ['button'], label: 'Details', editable: false,
          viewport: { width: 1280, height: 720 }, scroll: { x: 0, y: 10 }, point: { x: 20, y: 20 } },
        image: { status: 'pending', captureId: 'same-document-capture' },
      }],
    } });
  }, { port, state: { sessionId: before.sessionId, epoch: before.epoch, documentToken: before.documentToken }, url: nextUrl });
  await expect.poll(async () => (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value.draft.steps.length)
    .toBe(stepsBefore + 1);
});

test('a click on a new route made before the background processed the route change still follows it', async ({ page }) => {
  await dispatch(page, { type: 'ANMERKO_JOURNEY_START', ownerTabId: 1, ownerWindowId: 7 });
  const before = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value;
  const port = await page.evaluate(owner => (globalThis as HarnessWindow).harness
    .connectPort('anmerko-journey-events-v1', owner), ownerPage);
  await page.waitForTimeout(400);
  const routeUrl = 'https://example.test/path?item=5#route';
  await page.evaluate(({ port, state, url }) => {
    const harness = (globalThis as HarnessWindow).harness;
    // The route changed 300 ms ago and the reader clicked on it 100 ms later;
    // the background only now processes the route change.
    const navigatedAt = Date.now() - 300;
    const clickedAt = navigatedAt + 100;
    harness.tabs[1].url = url;
    harness.identity.url = url;
    harness.events.history.emit({ tabId: 1, frameId: 0, url, documentLifecycle: 'active', timeStamp: navigatedAt });
    harness.postPort(port, { type: 'ANMERKO_JOURNEY_EVENTS', batch: {
      schemaVersion: 1, sessionId: state.sessionId, epoch: state.epoch,
      documentToken: state.documentToken, localCounter: 1,
      events: [{
        kind: 'click', id: 'route-click', observedAt: new Date(clickedAt).toISOString(),
        elapsedMs: clickedAt - Date.parse(state.draft.startedAt), sourceUrl: url,
        target: { tag: 'button', selectorPath: ['button'], label: 'Details', editable: false,
          viewport: { width: 1280, height: 720 }, scroll: { x: 0, y: 10 }, point: { x: 20, y: 20 } },
        image: { status: 'pending', captureId: 'route-click-capture' },
      }],
    } });
  }, { port, state: before, url: routeUrl });
  await expect.poll(async () => (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value.draft.steps
    .slice(1).map((step: any) => step.kind === 'navigation' ? step.navigation.toUrl : step.id))
    .toEqual([routeUrl, 'route-click']);
});

test('authenticates event ports, allows the initial starting connection, and rejects stale or unrelated messages', async ({ page }) => {
  await page.evaluate(() => { (globalThis as HarnessWindow).harness.deferPageStart = true; });
  const pendingStart = dispatch(page, { type: 'ANMERKO_JOURNEY_START', ownerTabId: 1, ownerWindowId: 7 });
  await expect.poll(() => page.evaluate(() => Boolean((globalThis as HarnessWindow).harness.releasePageStart))).toBe(true);
  const starting = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value;
  expect(starting.phase).toBe('starting');

  const ports = await page.evaluate(owner => {
    const harness = (globalThis as HarnessWindow).harness;
    return {
      valid: harness.connectPort('anmerko-journey-events-v1', owner),
      sidebar: harness.connectPort('anmerko-sidebar', owner),
      credentials: harness.connectPort('anmerko-journey-events-v1', { ...owner, url: 'https://user:secret@example.test/path?item=1#top' }),
      wrongId: harness.connectPort('anmerko-journey-events-v1', { ...owner, id: 'other-extension' }),
      wrongFrame: harness.connectPort('anmerko-journey-events-v1', { ...owner, frameId: 2 }),
      wrongTab: harness.connectPort('anmerko-journey-events-v1', { ...owner, tab: { ...owner.tab, id: 2 } }),
      wrongWindow: harness.connectPort('anmerko-journey-events-v1', { ...owner, tab: { ...owner.tab, windowId: 8 } }),
      wrongUrl: harness.connectPort('anmerko-journey-events-v1', { ...owner, url: 'chrome://settings/' }),
    };
  }, ownerPage);
  expect(await page.evaluate(indices => Object.entries(indices).map(([name, index]) => ({
    name, disconnected: (globalThis as HarnessWindow).harness.ports[index].disconnected,
  })), ports)).toEqual([
    { name: 'valid', disconnected: false },
    { name: 'sidebar', disconnected: false },
    { name: 'credentials', disconnected: false },
    { name: 'wrongId', disconnected: true },
    { name: 'wrongFrame', disconnected: true },
    { name: 'wrongTab', disconnected: true },
    { name: 'wrongWindow', disconnected: true },
    { name: 'wrongUrl', disconnected: true },
  ]);

  const batch = {
    schemaVersion: 1, sessionId: starting.sessionId, epoch: starting.epoch,
    documentToken: starting.documentToken, localCounter: 1,
    events: [{
      kind: 'click', id: 'starting-event', observedAt: new Date().toISOString(), elapsedMs: 10,
      sourceUrl: 'https://example.test/path?item=1#top',
      target: { tag: 'button', selectorPath: ['button'], label: 'Continue', editable: false,
        viewport: { width: 1280, height: 720 }, scroll: { x: 0, y: 10 }, point: { x: 10, y: 10 } },
      image: { status: 'pending', captureId: 'starting-capture' },
    }],
  };
  await page.evaluate(({ index, batch }) => {
    const harness = (globalThis as HarnessWindow).harness;
    harness.postPort(index, { type: 'OTHER', batch });
    harness.postPort(index, { type: 'ANMERKO_JOURNEY_EVENTS', batch });
  }, { index: ports.valid, batch });
  expect((await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value.phase).toBe('starting');

  await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).harness;
    harness.deferPageStart = false;
    harness.releasePageStart?.();
  });
  expect(await pendingStart).toEqual({ ok: true });
  await page.evaluate(({ index, batch }) => {
    const harness = (globalThis as HarnessWindow).harness;
    harness.postPort(index, { type: 'ANMERKO_JOURNEY_EVENTS', batch: { ...batch, sessionId: 'stale-session' } });
    harness.postPort(index, { type: 'ANMERKO_JOURNEY_EVENTS', batch });
  }, { index: ports.valid, batch });
  let state = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value;
  expect(state.draft.steps).toHaveLength(2);

  await dispatch(page, { type: 'ANMERKO_JOURNEY_STOP' }, sidebar);
  await page.evaluate(({ index, batch }) => (globalThis as HarnessWindow).harness
    .postPort(index, { type: 'ANMERKO_JOURNEY_EVENTS', batch: { ...batch, localCounter: 2 } }), {
    index: ports.valid, batch,
  });
  state = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value;
  expect(state.phase).toBe('reviewing');
  expect(state.draft.steps).toHaveLength(2);
  expect(await page.evaluate(index => (globalThis as HarnessWindow).harness.ports[index].replies, ports.valid)).toEqual([]);
});

test('rejects an old document port batch after navigation and accepts the current document port', async ({ page }) => {
  await dispatch(page, { type: 'ANMERKO_JOURNEY_START', ownerTabId: 1, ownerWindowId: 7 });
  const before = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value;
  const oldPort = await page.evaluate(owner => (globalThis as HarnessWindow).harness
    .connectPort('anmerko-journey-events-v1', owner), ownerPage);

  await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).harness;
    const url = 'https://example.test/next';
    harness.tabs[1].url = url;
    harness.identity = { ...harness.identity, documentToken: 'document-next', url, generation: 0 };
    harness.events.committed.emit({ tabId: 1, frameId: 0, url });
  });
  await expect.poll(async () => (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value.documentToken)
    .toBe('document-next');
  const current = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value;
  const stepsBeforeBatch = current.draft.steps.length;
  const event = {
    kind: 'click', id: 'navigation-event', observedAt: new Date().toISOString(), elapsedMs: 20,
    sourceUrl: 'https://example.test/next',
    target: { tag: 'button', selectorPath: ['button'], label: 'Continue', editable: false,
      viewport: { width: 1280, height: 720 }, scroll: { x: 0, y: 10 }, point: { x: 10, y: 10 } },
    image: { status: 'pending', captureId: 'navigation-capture' },
  };
  await page.evaluate(({ oldPort, before, current, event }) => {
    const harness = (globalThis as HarnessWindow).harness;
    harness.postPort(oldPort, { type: 'ANMERKO_JOURNEY_EVENTS', batch: {
      schemaVersion: 1, sessionId: before.sessionId, epoch: before.epoch,
      documentToken: before.documentToken, localCounter: 1, events: [event],
    } });
    const currentPort = harness.connectPort('anmerko-journey-events-v1', {
      id: 'test-extension', frameId: 0, url: 'https://example.test/next',
      tab: { id: 1, windowId: 7, active: true, url: 'https://example.test/next' },
    });
    harness.postPort(currentPort, { type: 'ANMERKO_JOURNEY_EVENTS', batch: {
      schemaVersion: 1, sessionId: current.sessionId, epoch: current.epoch,
      documentToken: current.documentToken, localCounter: 1, events: [event],
    } });
  }, { oldPort, before, current, event });
  expect((await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value.draft.steps).toHaveLength(stepsBeforeBatch + 1);
});

test('restores the page and rejects captures changed during prepare or switched away and back', async ({ page }) => {
  await page.evaluate(() => { (globalThis as HarnessWindow).harness.prepareMismatch = true; });
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_START', ownerTabId: 1, ownerWindowId: 7 }))
    .toEqual({ ok: false, error: 'Journey command unavailable.', code: 'initial-capture-failed' });
  expect((await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value.phase).toBe('idle');
  let sequence = await page.evaluate(() => (globalThis as HarnessWindow).harness.sequence);
  expect(sequence).toContain('ANMERKO_JOURNEY_PAGE_FINISH');
  expect(sequence).not.toContain('capture');

  await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).harness;
    harness.prepareMismatch = false; harness.captureMode = 'away-and-back'; harness.sequence.length = 0;
  });
  await dispatch(page, { type: 'ANMERKO_JOURNEY_START', ownerTabId: 1, ownerWindowId: 7 });
  const state = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value;
  expect(state).toMatchObject({ phase: 'idle' });
  sequence = await page.evaluate(() => (globalThis as HarnessWindow).harness.sequence);
  expect(sequence).toContain('capture');
  expect(sequence).toContain('ANMERKO_JOURNEY_PAGE_FINISH');
  expect(sequence).not.toContain('ANMERKO_JOURNEY_PAGE_START');
});

test('stops synchronously from toolbar interception and owner loss without treating tab loading as navigation', async ({ page }) => {
  await dispatch(page, { type: 'ANMERKO_JOURNEY_START', ownerTabId: 1, ownerWindowId: 7 });
  expect(await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).harness;
    const handled = harness.control.stopIfRecording();
    return { handled, phase: undefined as string | undefined };
  }).then(async result => ({ ...result, phase: (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value.phase })))
    .toEqual({ handled: true, phase: 'reviewing' });
  expect(await page.evaluate(() => (globalThis as HarnessWindow).harness.control.stopIfRecording())).toBe(false);

  await dispatch(page, { type: 'ANMERKO_JOURNEY_DISCARD' });
  await dispatch(page, { type: 'ANMERKO_JOURNEY_START', ownerTabId: 1, ownerWindowId: 7 });
  await page.evaluate(() => (globalThis as HarnessWindow).harness.events.updated.emit(1, { status: 'loading' }, {}));
  expect((await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value)
    .toMatchObject({ phase: 'recording' });
  await page.evaluate(() => (globalThis as HarnessWindow).harness.events.updated.emit(1, {
    status: 'loading', url: 'https://example.test/next',
  }, {}));
  expect((await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value)
    .toMatchObject({ phase: 'recording' });
  await page.evaluate(() => (globalThis as HarnessWindow).harness.events.updated.emit(1, {
    status: 'loading', url: 'chrome://settings/',
  }, {}));
  expect((await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value)
    .toMatchObject({ phase: 'reviewing', draft: { stopReason: 'protected-page' } });

  await dispatch(page, { type: 'ANMERKO_JOURNEY_DISCARD' });
  await dispatch(page, { type: 'ANMERKO_JOURNEY_START', ownerTabId: 1, ownerWindowId: 7 });
  await page.evaluate(() => (globalThis as HarnessWindow).harness.events.removed.emit(1, { windowId: 7 }));
  expect((await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value)
    .toMatchObject({ phase: 'reviewing', draft: { stopReason: 'tab-lost' } });
});

test('binds when tabs.onReplaced is unavailable', async ({ page }) => {
  expect(await page.evaluate(() => {
    const api = (globalThis as any).chrome;
    delete api.tabs.onReplaced;
    try {
      (globalThis as HarnessWindow).journeyExtension.bindJourneyExtension({
        waitMs: () => 0,
        capture: async () => (globalThis as any).__journeyPng,
      });
      return true;
    } catch {
      return false;
    }
  })).toBe(true);
});

test('cancellation during rate waiting or page preparation never reaches the capture API', async ({ page }) => {
  const launch = async () => page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).harness;
    harness.pendingStart = harness.dispatch(
      { type: 'ANMERKO_JOURNEY_START', ownerTabId: 1, ownerWindowId: 7 },
      { id: 'test-extension', url: 'chrome-extension://test-extension/sidebar.html' },
    );
  });
  const finishLaunch = async () => page.evaluate(() => (globalThis as HarnessWindow).harness.pendingStart);

  await page.evaluate(() => { (globalThis as HarnessWindow).harness.wait = 75; });
  await launch();
  await expect.poll(() => page.evaluate(() => (globalThis as HarnessWindow).harness.sequence.includes('wait'))).toBe(true);
  expect(await page.evaluate(() => (globalThis as HarnessWindow).harness.control.stopIfRecording())).toBe(true);
  await finishLaunch();
  let sequence = await page.evaluate(() => (globalThis as HarnessWindow).harness.sequence);
  expect(sequence).not.toContain('capture');
  expect(sequence).toContain('ANMERKO_JOURNEY_PAGE_FINISH');

  await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).harness;
    harness.sequence.length = 0; harness.wait = 0; harness.deferPrepare = true;
  });
  await launch();
  await expect.poll(() => page.evaluate(() => (globalThis as HarnessWindow).harness.sequence.includes('ANMERKO_JOURNEY_PAGE_PREPARE'))).toBe(true);
  expect(await page.evaluate(() => (globalThis as HarnessWindow).harness.control.stopIfRecording())).toBe(true);
  await page.evaluate(() => (globalThis as HarnessWindow).harness.releasePrepare?.());
  await finishLaunch();
  sequence = await page.evaluate(() => (globalThis as HarnessWindow).harness.sequence);
  expect(sequence).not.toContain('capture');
  expect(sequence).toContain('ANMERKO_JOURNEY_PAGE_FINISH');
});

test('authorizes exact trusted journey surfaces and consumes a fallback launch once', async ({ page }) => {
  expect((await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' }, reviewPage)).value)
    .toEqual({ phase: 'idle', epoch: 0 });
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' }, {
    ...reviewPage, url: `${reviewPage.url}?source=page`,
  })).toBeUndefined();
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' }, {
    ...reviewPage, url: `${reviewPage.url}#launch=bad/value`,
  })).toBeUndefined();
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' }, {
    ...reviewPage, frameId: 2,
  })).toBeUndefined();
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' }, {
    id: 'test-extension', url: reviewPage.url,
  })).toBeUndefined();

  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_OPEN' }, { ...ownerPage, frameId: 2 })).toBeUndefined();
  const opened = await dispatch(page, { type: 'ANMERKO_JOURNEY_OPEN' }, ownerPage);
  expect(opened).toEqual({ ok: true });
  expect(JSON.stringify(opened)).not.toContain('document-1');
  const launch = await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).harness;
    return { created: harness.createdTabs[0], state: harness.control.stopIfRecording() };
  });
  expect(launch.created.url).toMatch(/^chrome-extension:\/\/test-extension\/journey\.html#launch=[A-Za-z0-9._~-]+$/);
  expect(launch.state).toBe(false);
  // Back on the website tab, Record journey again brings the pending launch
  // tab forward instead of failing or opening a second one.
  const pendingTabId = await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).harness;
    for (const tab of Object.values(harness.tabs)) tab.active = tab.id === 1;
    harness.tabUpdates.length = 0;
    return Object.values(harness.tabs).find(item => item.url === harness.createdTabs[0].url)!.id;
  });
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_OPEN' }, ownerPage)).toEqual({ ok: true });
  expect(await page.evaluate(() => (globalThis as HarnessWindow).harness.createdTabs)).toHaveLength(1);
  expect(await page.evaluate(() => (globalThis as HarnessWindow).harness.tabUpdates))
    .toEqual([{ tabId: pendingTabId, details: { active: true } }]);
  const launchTab = await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).harness;
    const url = harness.createdTabs[0].url as string;
    const tab = Object.values(harness.tabs).find(item => item.url === url)!;
    return { intent: url.slice(url.indexOf('#launch=') + 8), sender: { id: 'test-extension', url, frameId: 0, tab } };
  });

  expect((await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' }, launchTab.sender)).value.phase).toBe('idle');
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_START', intent: launchTab.intent }, launchTab.sender))
    .toEqual({ ok: true });
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_START', intent: launchTab.intent }, launchTab.sender))
    .toEqual({ ok: false, error: 'Journey command unavailable.', code: 'launch-expired' });
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_STOP', intent: launchTab.intent }, launchTab.sender))
    .toEqual({ ok: true });
  expect((await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' }, launchTab.sender)).value.phase).toBe('reviewing');

  const facts = await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).harness;
    return {
      tabUpdates: harness.tabUpdates,
      windowUpdates: harness.windowUpdates, sequence: harness.sequence,
    };
  });
  expect(facts.tabUpdates).toContainEqual({ tabId: 1, details: { active: true } });
  expect(facts.windowUpdates).toContainEqual({ windowId: 7, details: { focused: true } });
  expect(facts.sequence).toContain('capture');
});

test('expires an unconsumed launch intent when the background restarts', async ({ page }) => {
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_OPEN' }, ownerPage)).toEqual({ ok: true });
  const launch = await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).harness;
    const url = harness.createdTabs[0].url as string;
    const tab = Object.values(harness.tabs).find(item => item.url === url)!;
    harness.reboot();
    return { intent: url.slice(url.indexOf('#launch=') + 8), sender: { id: 'test-extension', url, frameId: 0, tab } };
  });
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_START', intent: launch.intent }, launch.sender))
    .toEqual({ ok: false, error: 'Journey command unavailable.', code: 'launch-expired' });
  expect(await page.evaluate(() => (globalThis as HarnessWindow).harness.sequence.filter(item => item === 'capture')))
    .toHaveLength(0);
});

test('rejects forged, changed-owner, missing-owner, and expired fallback intents', async ({ page }) => {
  const openLaunch = async () => {
    const response = await dispatch(page, { type: 'ANMERKO_JOURNEY_OPEN' }, ownerPage);
    expect(response).toEqual({ ok: true });
    return page.evaluate(() => {
      const harness = (globalThis as HarnessWindow).harness;
      const url = harness.createdTabs.at(-1)!.url as string;
      const tab = Object.values(harness.tabs).find(item => item.url === url)!;
      return { intent: url.slice(url.indexOf('#launch=') + 8), sender: { id: 'test-extension', url, frameId: 0, tab } };
    });
  };
  const resetOwner = async () => page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).harness;
    harness.tabs[1] = { id: 1, windowId: 7, active: true, url: 'https://private:secret@example.test/path?item=1#top' };
    harness.identity.documentToken = 'document-1';
    harness.identity.url = harness.tabs[1].url;
    for (const tab of Object.values(harness.tabs)) if (tab.id !== 1) tab.active = false;
  });

  let launch = await openLaunch();
  const forgedSender = { ...launch.sender, url: `${reviewPage.url}#launch=forged-intent` };
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_START', intent: launch.intent }, forgedSender))
    .toEqual({ ok: false, error: 'Journey command unavailable.', code: 'launch-expired' });
  await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).harness;
    harness.tabs[1].url = 'https://example.test/changed?item=2#new';
    harness.identity.documentToken = 'document-2';
    harness.identity.url = harness.tabs[1].url;
  });
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_START', intent: launch.intent }, launch.sender))
    .toEqual({ ok: false, error: 'Journey command unavailable.', code: 'owner-unavailable' });
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_START', intent: launch.intent }, launch.sender))
    .toEqual({ ok: false, error: 'Journey command unavailable.', code: 'launch-expired' });

  await resetOwner();
  launch = await openLaunch();
  await page.evaluate(() => { delete (globalThis as HarnessWindow).harness.tabs[1]; });
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_START', intent: launch.intent }, launch.sender))
    .toEqual({ ok: false, error: 'Journey command unavailable.', code: 'owner-unavailable' });

  await resetOwner();
  await page.evaluate(() => { Date.now = () => 1_000_000; });
  launch = await openLaunch();
  await page.evaluate(() => { Date.now = () => 1_300_001; });
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_START', intent: launch.intent }, launch.sender))
    .toEqual({ ok: false, error: 'Journey command unavailable.', code: 'launch-expired' });
  expect(await page.evaluate(() => (globalThis as HarnessWindow).harness.sequence.filter(item => item === 'capture')))
    .toHaveLength(0);
});

test('fails a fallback launch closed without webNavigation and consumes the intent', async ({ page }) => {
  await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).harness;
    harness.navigationAvailable = false;
    harness.reboot();
  });
  await page.evaluate(() => (globalThis as HarnessWindow).harness.control.ready);
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_OPEN' }, ownerPage)).toEqual({ ok: true });
  const launch = await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).harness;
    const url = harness.createdTabs[0].url as string;
    const tab = Object.values(harness.tabs).find(item => item.url === url)!;
    return { intent: url.slice(url.indexOf('#launch=') + 8), sender: { id: 'test-extension', url, frameId: 0, tab } };
  });

  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_START', intent: launch.intent }, launch.sender))
    .toEqual({ ok: false, error: 'Journey command unavailable.' });
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_START', intent: launch.intent }, launch.sender))
    .toEqual({ ok: false, error: 'Journey command unavailable.', code: 'launch-expired' });
  const facts = await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).harness;
    return { tabUpdates: harness.tabUpdates, sequence: harness.sequence };
  });
  expect(facts.tabUpdates).toEqual([]);
  expect(facts.sequence).not.toContain('capture');
});

test('cancels a launch while tab creation is pending and closes the late tab', async ({ page }) => {
  await page.evaluate(() => { (globalThis as HarnessWindow).harness.deferTabCreate = true; });
  const pendingOpen = dispatch(page, { type: 'ANMERKO_JOURNEY_OPEN' }, ownerPage);
  await expect.poll(() => page.evaluate(() => (globalThis as HarnessWindow).harness.createdTabs.length)).toBe(1);
  const launch = await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).harness;
    const url = harness.createdTabs[0].url as string;
    const tab = Object.values(harness.tabs).find(item => item.url === url)!;
    return { intent: url.slice(url.indexOf('#launch=') + 8), sender: { id: 'test-extension', url, frameId: 0, tab } };
  });

  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_STOP', intent: launch.intent }, launch.sender))
    .toEqual({ ok: true });
  await page.evaluate(() => (globalThis as HarnessWindow).harness.releaseTabCreate?.());
  expect(await pendingOpen).toEqual({ ok: false, error: 'Journey command unavailable.' });
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_START', intent: launch.intent }, launch.sender))
    .toEqual({ ok: false, error: 'Journey command unavailable.', code: 'launch-expired' });
  expect(await page.evaluate(() => (globalThis as HarnessWindow).harness.removedTabs)).toEqual([launch.sender.tab.id]);
});

test('trusted Stop cancels fallback and native starts before controller capture begins', async ({ page }) => {
  const openLaunch = async () => {
    await page.evaluate(() => {
      const harness = (globalThis as HarnessWindow).harness;
      harness.tabs[1].active = true;
      for (const tab of Object.values(harness.tabs)) if (tab.id !== 1) tab.active = false;
    });
    expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_OPEN' }, ownerPage)).toEqual({ ok: true });
    return page.evaluate(() => {
      const harness = (globalThis as HarnessWindow).harness;
      const url = harness.createdTabs.at(-1)!.url as string;
      const tab = Object.values(harness.tabs).find(item => item.url === url)!;
      return { intent: url.slice(url.indexOf('#launch=') + 8), sender: { id: 'test-extension', url, frameId: 0, tab } };
    });
  };
  const defer = async (stage: 'tabUpdate' | 'identify') => page.evaluate(value => {
    const harness = (globalThis as HarnessWindow).harness;
    if (value === 'tabUpdate') harness.deferTabUpdate = true;
    else harness.deferIdentify = true;
  }, stage);
  const release = async (stage: 'tabUpdate' | 'identify') => page.evaluate(value => {
    const harness = (globalThis as HarnessWindow).harness;
    if (value === 'tabUpdate') { harness.deferTabUpdate = false; harness.releaseTabUpdate?.(); }
    else { harness.deferIdentify = false; harness.releaseIdentify?.(); }
  }, stage);
  const isWaiting = async (stage: 'tabUpdate' | 'identify') => page.evaluate(value => {
    const harness = (globalThis as HarnessWindow).harness;
    if (value === 'tabUpdate') return Boolean(harness.releaseTabUpdate);
    return Boolean(harness.releaseIdentify);
  }, stage);

  for (const stage of ['tabUpdate', 'identify'] as const) {
    const launch = await openLaunch();
    await defer(stage);
    const pendingStart = dispatch(page, { type: 'ANMERKO_JOURNEY_START', intent: launch.intent }, launch.sender);
    await expect.poll(() => isWaiting(stage)).toBe(true);
    expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_STOP', intent: launch.intent }, launch.sender))
      .toEqual({ ok: true });
    await release(stage);
    expect(await pendingStart).toEqual({ ok: true });
    expect((await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' }, launch.sender)).value.phase).toBe('idle');
  }

  await page.evaluate(() => { (globalThis as HarnessWindow).harness.deferOwnerCheck = true; });
  const pendingNative = dispatch(page, { type: 'ANMERKO_JOURNEY_START', ownerTabId: 1, ownerWindowId: 7 });
  await expect.poll(() => page.evaluate(() => Boolean((globalThis as HarnessWindow).harness.releaseOwnerCheck))).toBe(true);
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_STOP' }, sidebar)).toEqual({ ok: true });
  await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).harness;
    harness.deferOwnerCheck = false;
    harness.releaseOwnerCheck?.();
  });
  expect(await pendingNative).toEqual({ ok: true });
  expect((await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value.phase).toBe('idle');
  expect(await page.evaluate(() => (globalThis as HarnessWindow).harness.sequence)).not.toContain('capture');
});

test('reopens a disconnected review in one reusable trusted fallback tab', async ({ page }) => {
  expect(await page.evaluate(() => (globalThis as HarnessWindow).harness.control.openReviewIfAvailable())).toBe(false);
  await dispatch(page, { type: 'ANMERKO_JOURNEY_START', ownerTabId: 1, ownerWindowId: 7 });
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_OPEN' }, {
    id: 'test-extension', url: 'https://other.test/', frameId: 0,
    tab: { id: 2, windowId: 7, active: false, url: 'https://other.test/' },
  })).toEqual({ ok: false, error: 'Journey command unavailable.', code: 'busy' });
  const opened = await dispatch(page, { type: 'ANMERKO_JOURNEY_OPEN' }, ownerPage);
  expect(opened).toEqual({ ok: true });
  expect(JSON.stringify(opened)).not.toContain('draft');
  await expect.poll(async () => (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value.phase).toBe('reviewing');
  expect(await page.evaluate(() => (globalThis as HarnessWindow).harness.createdTabs[0].url))
    .toBe('chrome-extension://test-extension/journey.html');
  await page.evaluate(() => { delete (globalThis as HarnessWindow).harness.tabs[1]; });

  expect(await page.evaluate(() => (globalThis as HarnessWindow).harness.control.openReviewIfAvailable())).toBe(true);
  await expect.poll(() => page.evaluate(() => (globalThis as HarnessWindow).harness.tabUpdates.length)).toBeGreaterThan(0);
  expect(await page.evaluate(() => (globalThis as HarnessWindow).harness.createdTabs)).toHaveLength(1);
});

// Chromium hides the URL of the extension's own pages from tabs.get and
// tabs.query without the tabs permission and reports them through
// runtime.getContexts instead.
async function hideExtensionTabUrls(page: Page) {
  await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).harness;
    const api = (globalThis as any).chrome;
    const scrub = (tab: any) => {
      if (!tab) return tab;
      const copy = structuredClone(tab);
      if (copy.url.startsWith('chrome-extension://')) delete copy.url;
      return copy;
    };
    api.tabs.get = async (tabId: number) => scrub(harness.tabs[tabId]);
    api.tabs.query = async (filter: { active?: boolean; windowId?: number } = {}) => Object.values(harness.tabs)
      .filter(tab => (filter.active === undefined || tab.active === filter.active)
        && (filter.windowId === undefined || tab.windowId === filter.windowId)).map(scrub);
    api.runtime.getContexts = async (filter: { contextTypes?: string[]; tabIds?: number[] }) => Object.values(harness.tabs)
      .filter(tab => tab.url.startsWith('chrome-extension://') && (!filter.tabIds || filter.tabIds.includes(tab.id)))
      .map(tab => ({ contextType: 'TAB', contextId: `context-${tab.id}`, tabId: tab.id, windowId: tab.windowId, frameId: 0,
        documentUrl: tab.url, incognito: false }));
  });
}

// The floating panel's path: Record journey opens a launch tab, and its Start
// records the website tab.
async function recordFromLaunchTab(page: Page) {
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_OPEN' }, ownerPage)).toEqual({ ok: true });
  const launch = await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).harness;
    const url = harness.createdTabs.at(-1)!.url as string;
    const tab = structuredClone(Object.values(harness.tabs).find(item => item.url === url)!);
    return { intent: url.slice(url.indexOf('#launch=') + 8), sender: { id: 'test-extension', url, frameId: 0, tab } };
  });
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_START', intent: launch.intent }, launch.sender)).toEqual({ ok: true });
  const recording = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value;
  expect(recording.phase).toBe('recording');
  await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).harness;
    harness.tabUpdates.length = 0;
  });
  return { launch, launchTabId: launch.sender.tab.id as number, recording };
}

const tabReviewRecord = (page: Page) => page.evaluate(() =>
  (globalThis as HarnessWindow).harness.sessionStorage['anmerko:journey-tab-review:v1']);

const tabActivations = (page: Page) => page.evaluate(() => (globalThis as HarnessWindow).harness.tabUpdates
  .filter(update => update.details.active).map(update => update.tabId));

test('a journey started from a launch tab brings that tab forward as its review whenever it ends, except on focus loss', async ({ page }) => {
  await hideExtensionTabUrls(page);
  const stopFromStrip = async (recording: any) => {
    expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_STOP', sessionId: recording.sessionId, epoch: recording.epoch }, ownerPage))
      .toEqual({ ok: true });
  };
  const leaveSite = async () => page.evaluate(() => (globalThis as HarnessWindow).harness.events.committed.emit({
    tabId: 1, frameId: 0, url: 'https://other.test/next', documentLifecycle: 'active',
  }));
  const reachDeadline = async (recording: any) => page.evaluate(deadlineAt => {
    (globalThis as any).realNow = Date.now;
    Date.now = () => Date.parse(deadlineAt);
    (globalThis as HarnessWindow).harness.events.alarm.emit({ name: 'anmerko-journey-recording-deadline' });
  }, recording.deadlineAt);
  const cases: Array<[string, (recording: any) => Promise<unknown>]> = [
    ['user', stopFromStrip], ['left-site', leaveSite], ['duration-limit', reachDeadline],
  ];
  for (const [reason, stop] of cases) {
    const { launchTabId, recording } = await recordFromLaunchTab(page);
    await stop(recording);
    await expect.poll(async () => (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value.draft?.stopReason).toBe(reason);
    // The launch tab is the review surface: it comes forward and no second tab opens.
    await expect.poll(() => tabActivations(page), reason).toEqual([launchTabId]);
    expect(await page.evaluate(() => (globalThis as HarnessWindow).harness.createdTabs.length), reason)
      .toBe(cases.findIndex(([name]) => name === reason) + 1);
    // Which review belongs in a tab is remembered only while that review lasts.
    expect(await tabReviewRecord(page), reason).toBe(recording.sessionId);
    expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_DISCARD' })).toEqual({ ok: true });
    expect(await tabReviewRecord(page), reason).toBeUndefined();
    await page.evaluate(() => {
      const harness = (globalThis as HarnessWindow).harness;
      if ((globalThis as any).realNow) Date.now = (globalThis as any).realNow;
      for (const tab of Object.values(harness.tabs)) tab.active = tab.id === 1;
      harness.tabs[1].url = 'https://private:secret@example.test/path?item=1#top';
      harness.identity.url = harness.tabs[1].url;
      harness.focusedWindowId = 7;
    });
  }

  // A reader who switches to another website tab left deliberately: the
  // review waits for them instead of pulling focus.
  await recordFromLaunchTab(page);
  await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).harness;
    harness.tabs[1].active = false; harness.tabs[2].active = true;
    harness.events.activated.emit({ tabId: 2, windowId: 7 });
  });
  await expect.poll(async () => (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value.draft?.stopReason).toBe('focus-lost');
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(await tabActivations(page)).toEqual([]);
});

test('switching to the journey tab stops the recording as the reader\'s own stop, not as lost focus', async ({ page }) => {
  await hideExtensionTabUrls(page);
  const { launchTabId } = await recordFromLaunchTab(page);
  await page.evaluate(tabId => {
    const harness = (globalThis as HarnessWindow).harness;
    harness.tabs[1].active = false; harness.tabs[tabId].active = true;
    harness.events.activated.emit({ tabId, windowId: 7 });
  }, launchTabId);
  await expect.poll(async () => (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value.draft?.stopReason).toBe('user');
  expect(await page.evaluate(() => (globalThis as HarnessWindow).harness.createdTabs)).toHaveLength(1);

  // The same holds for a journey tab in another window, while another window
  // or app taking focus is still focus-lost.
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_DISCARD' })).toEqual({ ok: true });
  await page.evaluate(tabId => {
    const harness = (globalThis as HarnessWindow).harness;
    for (const tab of Object.values(harness.tabs)) tab.active = tab.id === 1;
    harness.tabs[tabId].windowId = 9;
    harness.tabs[tabId].active = true;
  }, launchTabId);
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_START', ownerTabId: 1, ownerWindowId: 7 })).toEqual({ ok: true });
  await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).harness;
    harness.focusedWindowId = 9;
    harness.events.focused.emit(9);
  });
  await expect.poll(async () => (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value.draft?.stopReason).toBe('user');
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_DISCARD' })).toEqual({ ok: true });
  await page.evaluate(() => { (globalThis as HarnessWindow).harness.focusedWindowId = 7; });
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_START', ownerTabId: 1, ownerWindowId: 7 })).toEqual({ ok: true });
  await page.evaluate(() => (globalThis as HarnessWindow).harness.events.focused.emit(-1));
  await expect.poll(async () => (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value.draft?.stopReason).toBe('focus-lost');
});

test('Record journey during a review reuses the launch tab where Chromium hides extension tab URLs', async ({ page }) => {
  await hideExtensionTabUrls(page);
  const { launchTabId } = await recordFromLaunchTab(page);
  await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).harness;
    harness.tabs[1].active = false; harness.tabs[2].active = true;
    harness.events.activated.emit({ tabId: 2, windowId: 7 });
  });
  await expect.poll(async () => (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value.phase).toBe('reviewing');
  await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).harness;
    for (const tab of Object.values(harness.tabs)) tab.active = tab.id === 1;
    harness.tabUpdates.length = 0;
  });
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_OPEN' }, ownerPage)).toEqual({ ok: true });
  expect(await tabActivations(page)).toEqual([launchTabId]);
  expect(await page.evaluate(() => (globalThis as HarnessWindow).harness.createdTabs)).toHaveLength(1);

  // A background that restarted has forgotten which tab it opened, and still
  // finds the journey tab instead of opening another.
  await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).harness;
    for (const tab of Object.values(harness.tabs)) tab.active = tab.id === 1;
    harness.tabUpdates.length = 0;
    harness.reboot();
  });
  await hideExtensionTabUrls(page);
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_OPEN' }, ownerPage)).toEqual({ ok: true });
  expect(await tabActivations(page)).toEqual([launchTabId]);
  expect(await page.evaluate(() => (globalThis as HarnessWindow).harness.createdTabs)).toHaveLength(1);
});

test('a recording that outlives a background restart still brings its launch tab forward when it ends', async ({ page }) => {
  await hideExtensionTabUrls(page);
  const { launchTabId, recording } = await recordFromLaunchTab(page);
  await page.evaluate(() => (globalThis as HarnessWindow).harness.reboot());
  await hideExtensionTabUrls(page);
  await page.evaluate(() => (globalThis as HarnessWindow).harness.control.ready);
  expect((await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value.phase).toBe('recording');
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_STOP', sessionId: recording.sessionId, epoch: recording.epoch }, ownerPage))
    .toEqual({ ok: true });
  await expect.poll(() => tabActivations(page)).toEqual([launchTabId]);
  expect(await page.evaluate(() => (globalThis as HarnessWindow).harness.createdTabs)).toHaveLength(1);

  // A record left behind by a review that ended is dropped on the next start.
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_DISCARD' })).toEqual({ ok: true });
  await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).harness;
    harness.sessionStorage['anmerko:journey-tab-review:v1'] = 'session-ended';
    harness.reboot();
  });
  await page.evaluate(() => (globalThis as HarnessWindow).harness.control.ready);
  expect(await tabReviewRecord(page)).toBeUndefined();
});

test('a journey started in the native side panel reviews there without opening a journey tab', async ({ page }) => {
  await hideExtensionTabUrls(page);
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_START', ownerTabId: 1, ownerWindowId: 7 })).toEqual({ ok: true });
  const recording = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value;
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_STOP', sessionId: recording.sessionId, epoch: recording.epoch }, ownerPage))
    .toEqual({ ok: true });
  expect((await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value.phase).toBe('reviewing');
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(await page.evaluate(() => (globalThis as HarnessWindow).harness.createdTabs)).toEqual([]);
  expect(await tabActivations(page)).toEqual([]);
});

test('a second Record journey from another page replaces the pending launch tab', async ({ page }) => {
  await hideExtensionTabUrls(page);
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_OPEN' }, ownerPage)).toEqual({ ok: true });
  const first = await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).harness;
    return Object.values(harness.tabs).find(item => item.url === harness.createdTabs[0].url)!.id;
  });
  // The reader reloads the website: its new document has a new identity.
  await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).harness;
    for (const tab of Object.values(harness.tabs)) tab.active = tab.id === 1;
    harness.identity.documentToken = 'document-2';
  });
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_OPEN' }, ownerPage)).toEqual({ ok: true });
  const facts = await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).harness;
    return { created: harness.createdTabs.map(tab => tab.url), removed: harness.removedTabs };
  });
  expect(facts.created).toHaveLength(2);
  expect(facts.created[1]).not.toBe(facts.created[0]);
  expect(facts.removed).toEqual([first]);
  const launch = await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).harness;
    const url = harness.createdTabs[1].url as string;
    const tab = structuredClone(Object.values(harness.tabs).find(item => item.url === url)!);
    return { intent: url.slice(url.indexOf('#launch=') + 8), sender: { id: 'test-extension', url, frameId: 0, tab } };
  });
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_START', intent: launch.intent }, launch.sender)).toEqual({ ok: true });
  expect((await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value.phase).toBe('recording');
});

test('a page panel learns only whether a review is pending, and any focused website tab can bring it forward', async ({ page }) => {
  const otherPage = { id: 'test-extension', url: 'https://other.test/', frameId: 0,
    tab: { id: 2, windowId: 7, active: true, url: 'https://other.test/' } };
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_PENDING' }, ownerPage)).toEqual({ ok: true, value: false });
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_PENDING' }, { ...ownerPage, frameId: 3 })).toBeUndefined();
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_START', ownerTabId: 1, ownerWindowId: 7 })).toEqual({ ok: true });
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_PENDING' }, ownerPage)).toEqual({ ok: true, value: false });
  // Recording in another tab refuses a new journey there.
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_OPEN' }, otherPage))
    .toEqual({ ok: false, error: 'Journey command unavailable.', code: 'busy' });
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_STOP' })).toEqual({ ok: true });
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_PENDING' }, otherPage)).toEqual({ ok: true, value: true });
  await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).harness;
    for (const tab of Object.values(harness.tabs)) tab.active = tab.id === 2;
  });
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_OPEN' }, otherPage)).toEqual({ ok: true });
  expect(await page.evaluate(() => (globalThis as HarnessWindow).harness.createdTabs.map(tab => tab.url)))
    .toEqual(['chrome-extension://test-extension/journey.html']);
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_DISCARD' })).toEqual({ ok: true });
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_PENDING' }, otherPage)).toEqual({ ok: true, value: false });
});

test('a trusted journey surface can follow the phase alone, without the draft; pages cannot ask', async ({ page }) => {
  const phase = async () => (await dispatch(page, { type: 'ANMERKO_JOURNEY_PHASE' })).value;
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_PHASE' }, ownerPage)).toBeUndefined();
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_PHASE' }, { ...sidebar, id: 'other-extension' })).toBeUndefined();
  expect(await phase()).toBe('idle');
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_START', ownerTabId: 1, ownerWindowId: 7 })).toEqual({ ok: true });
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_PHASE' })).toEqual({ ok: true, value: 'recording' });
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_STOP' })).toEqual({ ok: true });
  expect(await phase()).toBe('reviewing');
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_DISCARD' })).toEqual({ ok: true });
  expect(await phase()).toBe('idle');
});

test.describe('T07 slice 2 shared capture scheduling and bounded normalization', () => {
  const clickEvent = (id: string, captureId: string, elapsedMs: number) => ({
    kind: 'click', id, observedAt: new Date().toISOString(), elapsedMs,
    sourceUrl: 'https://example.test/path?item=1#top',
    target: {
      tag: 'button', selectorPath: ['button'], label: 'Continue', editable: false,
      viewport: { width: 1280, height: 720 }, scroll: { x: 0, y: 10 }, point: { x: 20, y: 20 },
    },
    image: { status: 'pending', captureId },
  });

  const postBatch = (page: Page, port: number, batch: unknown) => page.evaluate(({ port, batch }) => (globalThis as HarnessWindow)
    .harness.postPort(port, { type: 'ANMERKO_JOURNEY_EVENTS', batch }), { port, batch });

  const batchFor = (recording: any, localCounter: number, event: unknown) => ({
    schemaVersion: 1, sessionId: recording.sessionId, epoch: recording.epoch,
    documentToken: recording.documentToken, localCounter, events: [event],
  });

  test('a capture superseded while waiting never consumes the shared screenshot API slot', async ({ page }) => {
    await dispatch(page, { type: 'ANMERKO_JOURNEY_START', ownerTabId: 1, ownerWindowId: 7 });
    const recording = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value;
    await page.evaluate(() => {
      const harness = (globalThis as HarnessWindow).harness;
      harness.wait = 1_500;
      harness.sequence.length = 0;
    });
    const port = await page.evaluate(owner => (globalThis as HarnessWindow).harness
      .connectPort('anmerko-journey-events-v1', owner), ownerPage);
    await postBatch(page, port, batchFor(recording, 1, clickEvent('event-a', 'capture-a', 5_000)));
    // The first action capture has entered the adapter and is waiting on spacing.
    await expect.poll(() => page.evaluate(() => (globalThis as HarnessWindow).harness.sequence.includes('wait'))).toBe(true);
    await postBatch(page, port, batchFor(recording, 2, clickEvent('event-b', 'capture-b', 10_000)));

    await expect.poll(async () => (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value.draft.steps.length).toBe(3);
    await expect.poll(async () => (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value.draft.steps
      .every((step: any) => step.image.status !== 'pending')).toBe(true);
    const state = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value;
    const captures = await page.evaluate(() => (globalThis as HarnessWindow).harness.sequence
      .filter(item => item === 'capture'));
    expect(captures).toHaveLength(1);
    expect(state.draft.steps.map((step: any) => step.id))
      .toEqual([state.draft.steps[0].id, 'event-a', 'event-b']);
    expect(state.draft.steps[1].image).toEqual({ status: 'unavailable', reason: 'superseded' });
    expect(state.draft.steps[1]).not.toHaveProperty('dataUrl');
    expect(state.draft.steps[2].image.status).toBe('retained');
    expect(state.draft.images[state.draft.steps[2].image.imageId].dataUrl).toMatch(/^data:image\/png;base64,/);
  });

  test('a burst of rapid actions keeps every step with an explicit image outcome', async ({ page }) => {
    await dispatch(page, { type: 'ANMERKO_JOURNEY_START', ownerTabId: 1, ownerWindowId: 7 });
    const recording = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value;
    await page.evaluate(() => { (globalThis as HarnessWindow).harness.sequence.length = 0; });
    await page.evaluate(({ owner, batches }) => {
      const harness = (globalThis as HarnessWindow).harness;
      const port = harness.connectPort('anmerko-journey-events-v1', owner);
      for (const batch of batches) harness.postPort(port, { type: 'ANMERKO_JOURNEY_EVENTS', batch });
    }, {
      owner: ownerPage,
      batches: [
        batchFor(recording, 1, clickEvent('event-a', 'capture-a', 5_000)),
        batchFor(recording, 2, clickEvent('event-b', 'capture-b', 6_000)),
        batchFor(recording, 3, clickEvent('event-c', 'capture-c', 7_000)),
      ],
    });

    await expect.poll(async () => (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value.draft.steps.length).toBe(4);
    await expect.poll(async () => (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value.draft.steps
      .every((step: any) => step.image.status !== 'pending')).toBe(true);
    const state = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value;
    expect(state.draft.steps.map((step: any) => step.id))
      .toEqual([state.draft.steps[0].id, 'event-a', 'event-b', 'event-c']);
    expect(state.draft.steps[1].image).toEqual({ status: 'unavailable', reason: 'superseded' });
    expect(state.draft.steps[2].image).toEqual({ status: 'unavailable', reason: 'superseded' });
    expect(state.draft.steps[3].image.status).toBe('retained');
    expect(state.draft.images[state.draft.steps[3].image.imageId].dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(await page.evaluate(() => (globalThis as HarnessWindow).harness.sequence
      .filter(item => item === 'capture'))).toHaveLength(1);
  });
});
