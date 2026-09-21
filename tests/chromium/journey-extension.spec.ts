import { expect, test, type Page } from '@playwright/test';
import { buildSync } from 'esbuild';

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
  permissionChecks: any[];
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
  permissionsGranted: boolean;
  deferPermission: boolean;
  releasePermission?: () => void;
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
    activated: { emit(value: unknown): void };
    updated: { emit(...values: unknown[]): void };
    removed: { emit(...values: unknown[]): void };
    replaced: { emit(...values: unknown[]): void };
    focused: { emit(value: unknown): void };
    permissionRemoved: { emit(value: unknown): void };
    alarm: { emit(value: unknown): void };
    committed: { emit(value: unknown): void; count(): number };
    history: { emit(value: unknown): void; count(): number };
    fragment: { emit(value: unknown): void; count(): number };
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

test.beforeEach(async ({ page }) => {
  await page.goto('http://127.0.0.1:4173/journey');
  await page.evaluate(() => {
    function extensionEvent() {
      const listeners: Array<(...values: any[]) => void> = [];
      return {
        addListener(listener: (...values: any[]) => void) { listeners.push(listener); },
        removeListener(listener: (...values: any[]) => void) {
          const index = listeners.indexOf(listener);
          if (index >= 0) listeners.splice(index, 1);
        },
        emit(...values: any[]) { for (const listener of listeners) listener(...values); },
        count() { return listeners.length; },
        clear() { listeners.length = 0; },
      };
    }
    const runtimeMessage = extensionEvent();
    const runtimeConnect = extensionEvent();
    const activated = extensionEvent();
    const updated = extensionEvent();
    const removed = extensionEvent();
    const replaced = extensionEvent();
    const focused = extensionEvent();
    const permissionRemoved = extensionEvent();
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
      tabUpdates: [], windowUpdates: [], permissionChecks: [], scriptingCalls: [], sequence: [],
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
      permissionsGranted: true, deferPermission: false, deferTabUpdate: false,
      deferIdentify: false, deferPageStart: false, deferInjection: false, deferOwnerCheck: false, deferTabCreate: false, captureMode: 'normal',
      events: { activated, updated, removed, replaced, focused, permissionRemoved, alarm, committed, history, fragment },
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
      permissions: {
        contains: async (details: unknown) => {
          harness.permissionChecks.push(structuredClone(details));
          harness.sequence.push('permissions.contains');
          if (harness.deferPermission) await new Promise<void>(resolve => { harness.releasePermission = resolve; });
          return harness.permissionsGranted;
        },
        onRemoved: permissionRemoved,
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
        if (!harness.permissionsGranted) return undefined;
        return { onCommitted: committed, onHistoryStateUpdated: history, onReferenceFragmentUpdated: fragment };
      },
    });
    (globalThis as HarnessWindow).harness = harness;
    (harness as any).eventBuses = [runtimeMessage, runtimeConnect, activated, updated, removed, replaced,
      focused, permissionRemoved, alarm, committed, history, fragment];
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
      harness.deferPermission = true;
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
    await expect.poll(() => page.evaluate(() => Boolean((globalThis as HarnessWindow).harness.releasePermission))).toBe(true);
    await page.evaluate(() => {
      const harness = (globalThis as HarnessWindow).harness;
      harness.deferPermission = false;
      harness.releasePermission?.();
    });

    await expect.poll(async () => (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value.draft.steps.length)
      .toBe(before.draft.steps.length + 2);
    const recovered = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value;
    expect(recovered.phase).toBe('recording');
    expect(recovered.draft.steps.slice(-2).map((step: any) => step.kind)).toEqual(['click', 'navigation']);
    expect(recovered.draft.steps.at(-2)).toMatchObject({ id: `cold-${wake.name}-click`, sourceUrl: batch.events[0].sourceUrl });
    expect(recovered.draft.steps.at(-1)).toMatchObject({ navigation: { toUrl: wake.url } });
  });
}

test('rejects a cold-wake click observed after its same-document navigation', async ({ page }) => {
  await dispatch(page, { type: 'ANMERKO_JOURNEY_START', ownerTabId: 1, ownerWindowId: 7 });
  const before = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value;
  const nextUrl = 'https://example.test/path?item=1#navigation-first';
  await page.evaluate(({ url }) => {
    const harness = (globalThis as HarnessWindow).harness;
    harness.deferPermission = true;
    harness.reboot();
    harness.tabs[1].url = url;
    harness.identity.url = url;
    harness.events.fragment.emit({ tabId: 1, frameId: 0, url, documentLifecycle: 'active' });
    harness.deferPermission = false;
    harness.releasePermission?.();
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
    harness.deferPermission = true;
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
  await expect.poll(() => page.evaluate(() => Boolean((globalThis as HarnessWindow).harness.releasePermission))).toBe(true);
  await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).harness;
    harness.deferPermission = false;
    harness.releasePermission?.();
  });
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
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_DISCARD' })).toEqual({ ok: true });
  expect((await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value).toEqual({ phase: 'idle', epoch: 0 });
  expect(await page.evaluate(() => (globalThis as HarnessWindow).harness.pageCommands
    .filter(command => command.message.type === 'ANMERKO_JOURNEY_PAGE_START').length)).toBe(startsBefore);
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_START', ownerTabId: 1, ownerWindowId: 7 }))
    .toEqual({ ok: true });
  expect((await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value.phase).toBe('recording');
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

test('gates native start on the optional grant and installs navigation listeners only after it is present', async ({ page }) => {
  await page.evaluate(() => { (globalThis as HarnessWindow).harness.permissionsGranted = false; });
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_START', ownerTabId: 1, ownerWindowId: 7 }))
    .toEqual({ ok: false, error: 'Journey command unavailable.', code: 'permission-required' });
  let facts = await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).harness;
    return {
      listeners: [harness.events.committed.count(), harness.events.history.count(), harness.events.fragment.count()],
      scriptingCalls: harness.scriptingCalls,
      sequence: harness.sequence,
    };
  });
  expect(facts.listeners).toEqual([1, 1, 1]);
  expect(facts.scriptingCalls).toEqual([]);
  expect(facts.sequence).not.toContain('capture');

  await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).harness;
    harness.permissionsGranted = true;
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
  expect(facts.sequence.indexOf('permissions.contains')).toBeLessThan(facts.sequence.indexOf('capture'));
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

test('does not inject when Stop arrives during the navigation grant recheck', async ({ page }) => {
  await dispatch(page, { type: 'ANMERKO_JOURNEY_START', ownerTabId: 1, ownerWindowId: 7 });
  await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).harness;
    const url = 'https://example.test/deferred-grant';
    harness.tabs[1].url = url;
    harness.identity = { ...harness.identity, documentToken: 'document-deferred', url, generation: 0 };
    harness.deferPermission = true;
    harness.events.committed.emit({ tabId: 1, frameId: 0, url });
  });
  await expect.poll(() => page.evaluate(() => Boolean((globalThis as HarnessWindow).harness.releasePermission))).toBe(true);
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_STOP' }, sidebar)).toEqual({ ok: true });
  await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).harness;
    harness.deferPermission = false;
    harness.releasePermission?.();
  });
  await expect.poll(async () => (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value.phase).toBe('reviewing');
  expect(await page.evaluate(() => (globalThis as HarnessWindow).harness.scriptingCalls)).toEqual([]);
});

test('stops on protected owner destinations, permission removal, and tab replacement without following a new tab', async ({ page }) => {
  await dispatch(page, { type: 'ANMERKO_JOURNEY_START', ownerTabId: 1, ownerWindowId: 7 });
  await page.evaluate(() => (globalThis as HarnessWindow).harness.events.committed.emit({
    tabId: 1, frameId: 0, url: 'chrome://settings/', documentLifecycle: 'active',
  }));
  expect((await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value)
    .toMatchObject({ phase: 'reviewing', draft: { stopReason: 'protected-page' } });

  await dispatch(page, { type: 'ANMERKO_JOURNEY_DISCARD' });
  await dispatch(page, { type: 'ANMERKO_JOURNEY_START', ownerTabId: 1, ownerWindowId: 7 });
  await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).harness;
    harness.permissionsGranted = false;
    harness.events.permissionRemoved.emit({ origins: ['https://example.test/*'] });
  });
  expect((await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value)
    .toMatchObject({ phase: 'reviewing', draft: { stopReason: 'permission-revoked' } });
  expect(await page.evaluate(() => [
    (globalThis as HarnessWindow).harness.events.committed.count(),
    (globalThis as HarnessWindow).harness.events.history.count(),
    (globalThis as HarnessWindow).harness.events.fragment.count(),
  ])).toEqual([0, 0, 0]);

  await dispatch(page, { type: 'ANMERKO_JOURNEY_DISCARD' });
  await page.evaluate(() => { (globalThis as HarnessWindow).harness.permissionsGranted = true; });
  await dispatch(page, { type: 'ANMERKO_JOURNEY_START', ownerTabId: 1, ownerWindowId: 7 });
  await page.evaluate(() => (globalThis as HarnessWindow).harness.events.replaced.emit(9, 1));
  expect((await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value)
    .toMatchObject({ phase: 'reviewing', draft: { stopReason: 'tab-lost' } });
  expect(await page.evaluate(() => (globalThis as HarnessWindow).harness.scriptingCalls
    .some((call: any) => call.target.tabId === 9))).toBe(false);
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
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_OPEN' }, ownerPage))
    .toEqual({ ok: false, error: 'Journey command unavailable.', code: 'busy' });
  expect(await page.evaluate(() => (globalThis as HarnessWindow).harness.createdTabs)).toHaveLength(1);
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
      permissionChecks: harness.permissionChecks, tabUpdates: harness.tabUpdates,
      windowUpdates: harness.windowUpdates, sequence: harness.sequence,
    };
  });
  expect(facts.permissionChecks).toEqual([{ origins: ['<all_urls>'], permissions: ['webNavigation'] }]);
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

test('requires the direct cross-site grant and consumes a denied launch intent', async ({ page }) => {
  await page.evaluate(() => { (globalThis as HarnessWindow).harness.permissionsGranted = false; });
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_OPEN' }, ownerPage)).toEqual({ ok: true });
  const launch = await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).harness;
    const url = harness.createdTabs[0].url as string;
    const tab = Object.values(harness.tabs).find(item => item.url === url)!;
    return { intent: url.slice(url.indexOf('#launch=') + 8), sender: { id: 'test-extension', url, frameId: 0, tab } };
  });

  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_START', intent: launch.intent }, launch.sender))
    .toEqual({ ok: false, error: 'Journey command unavailable.', code: 'permission-required' });
  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_START', intent: launch.intent }, launch.sender))
    .toEqual({ ok: false, error: 'Journey command unavailable.', code: 'launch-expired' });
  const facts = await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).harness;
    return { permissionChecks: harness.permissionChecks, tabUpdates: harness.tabUpdates, sequence: harness.sequence };
  });
  expect(facts.permissionChecks).toEqual([{ origins: ['<all_urls>'], permissions: ['webNavigation'] }]);
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
  const defer = async (stage: 'permission' | 'tabUpdate' | 'identify') => page.evaluate(value => {
    const harness = (globalThis as HarnessWindow).harness;
    if (value === 'permission') harness.deferPermission = true;
    else if (value === 'tabUpdate') harness.deferTabUpdate = true;
    else harness.deferIdentify = true;
  }, stage);
  const release = async (stage: 'permission' | 'tabUpdate' | 'identify') => page.evaluate(value => {
    const harness = (globalThis as HarnessWindow).harness;
    if (value === 'permission') { harness.deferPermission = false; harness.releasePermission?.(); }
    else if (value === 'tabUpdate') { harness.deferTabUpdate = false; harness.releaseTabUpdate?.(); }
    else { harness.deferIdentify = false; harness.releaseIdentify?.(); }
  }, stage);
  const isWaiting = async (stage: 'permission' | 'tabUpdate' | 'identify') => page.evaluate(value => {
    const harness = (globalThis as HarnessWindow).harness;
    if (value === 'permission') return Boolean(harness.releasePermission);
    if (value === 'tabUpdate') return Boolean(harness.releaseTabUpdate);
    return Boolean(harness.releaseIdentify);
  }, stage);

  for (const stage of ['permission', 'tabUpdate', 'identify'] as const) {
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
  })).toEqual({ ok: false, error: 'Journey command unavailable.', code: 'owner-unavailable' });
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
