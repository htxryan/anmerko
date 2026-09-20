import { expect, test, type Page } from '@playwright/test';
import { buildSync } from 'esbuild';

type Sender = { id?: string; url?: string; frameId?: number; tab?: { id?: number; windowId: number; active?: boolean; url?: string } };
type Harness = {
  dispatch(message: unknown, sender: Sender): Promise<any>;
  pageCommands: any[];
  broadcasts: any[];
  actions: any[];
  createdTabs: any[];
  removedTabs: number[];
  tabUpdates: any[];
  windowUpdates: any[];
  permissionChecks: any[];
  sequence: string[];
  tabs: Record<number, { id: number; windowId: number; active: boolean; url: string }>;
  identity: { documentToken: string; url: string; viewport: { width: number; height: number }; scroll: { x: number; y: number }; generation: number; visible: boolean };
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
  deferOwnerCheck: boolean;
  releaseOwnerCheck?: () => void;
  deferTabCreate: boolean;
  releaseTabCreate?: () => void;
  captureMode: 'normal' | 'away-and-back' | 'throw';
  events: { activated: { emit(value: unknown): void }; updated: { emit(...values: unknown[]): void }; removed: { emit(...values: unknown[]): void }; focused: { emit(value: unknown): void } };
  control: { stopIfRecording(): boolean; openReviewIfAvailable(): boolean };
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
      };
    }
    const runtimeMessage = extensionEvent();
    const activated = extensionEvent();
    const updated = extensionEvent();
    const removed = extensionEvent();
    const focused = extensionEvent();
    const canvas = document.createElement('canvas');
    canvas.width = 3; canvas.height = 2;
    canvas.getContext('2d')!.fillRect(0, 0, 3, 2);
    const png = canvas.toDataURL('image/png');
    const harness: Harness = {
      pageCommands: [], broadcasts: [], actions: [], createdTabs: [], removedTabs: [],
      tabUpdates: [], windowUpdates: [], permissionChecks: [], sequence: [],
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
      deferIdentify: false, deferOwnerCheck: false, deferTabCreate: false, captureMode: 'normal',
      events: { activated, updated, removed, focused },
      control: undefined as unknown as Harness['control'],
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
        onActivated: activated, onUpdated: updated, onRemoved: removed,
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
          if (harness.deferPermission) await new Promise<void>(resolve => { harness.releasePermission = resolve; });
          return harness.permissionsGranted;
        },
      },
      action: {
        setBadgeText: async (details: unknown) => { harness.actions.push({ method: 'badge', details: structuredClone(details) }); },
        setTitle: async (details: unknown) => { harness.actions.push({ method: 'title', details: structuredClone(details) }); },
      },
    };
    (globalThis as HarnessWindow).harness = harness;
    (globalThis as any).__journeyPng = png;
  });
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).harness;
    harness.control = (globalThis as HarnessWindow).journeyExtension.bindJourneyExtension({
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
      expect.objectContaining({ message: expect.objectContaining({ type: 'ANMERKO_JOURNEY_PAGE_START', documentToken: 'document-1' }) }),
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

test('routes matching top-frame events and stop commands without exposing state to pages', async ({ page }) => {
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
  expect((await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value.draft.steps).toHaveLength(1);

  expect(await dispatch(page, { type: 'ANMERKO_JOURNEY_EVENTS', batch }, ownerPage)).toEqual({ ok: true });
  const updated = (await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value;
  expect(updated.draft.steps).toHaveLength(2);
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

test('stops synchronously from toolbar interception and on owner lifecycle loss', async ({ page }) => {
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
    .toMatchObject({ phase: 'reviewing', draft: { stopReason: 'capture-failed' } });

  await dispatch(page, { type: 'ANMERKO_JOURNEY_DISCARD' });
  await dispatch(page, { type: 'ANMERKO_JOURNEY_START', ownerTabId: 1, ownerWindowId: 7 });
  await page.evaluate(() => (globalThis as HarnessWindow).harness.events.removed.emit(1, { windowId: 7 }));
  expect((await dispatch(page, { type: 'ANMERKO_JOURNEY_STATE' })).value)
    .toMatchObject({ phase: 'reviewing', draft: { stopReason: 'tab-lost' } });
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
