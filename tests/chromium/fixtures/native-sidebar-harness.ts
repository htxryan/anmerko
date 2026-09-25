import { mount } from '../../../src/content';
import { extensionRuntime } from '../../../src/extension-runtime';
import { bindSidebarConnection } from '../../../src/sidebar-connection';
import type { ViewState } from '../../../src/runtime';

type Listener = (...args: any[]) => void;
const event = () => {
  const listeners = new Set<Listener>();
  return { addListener(value: Listener) { listeners.add(value); }, removeListener(value: Listener) { listeners.delete(value); },
    emit(...args: any[]) { listeners.forEach(listener => listener(...args)); } };
};
const updated = event(), panelOpened = event(), runtimeMessages = event();
const ports: {
  onMessage: ReturnType<typeof event>;
  onDisconnect: ReturnType<typeof event>;
  serverMessages?: ReturnType<typeof event>;
  serverDisconnect?: ReturnType<typeof event>;
  closed: boolean;
}[] = [];
const requests: any[] = [];
const pageMessages: unknown[] = [], pageTargets: number[] = [], layoutMessages: unknown[] = [];
const layoutSequence: string[] = [];
const backgroundModes: string[] = [];
const backgroundOwners = new Map<number, object>();
let delayQuery = false;
let releaseQuery: (() => void) | undefined;
let activeTabId = 1;
Object.assign(globalThis, { chrome: {
  sidebarAction: {
    open: async () => {},
    close: async () => { layoutSequence.push('close'); },
  },
  sidePanel: { onOpened: panelOpened },
  runtime: {
    id: 'test-extension', getURL: (path: string) => `${location.origin}/${path}`,
    getManifest: () => ({ sidebar_action: {}, side_panel: { default_path: 'sidebar.html' } }),
    onMessage: runtimeMessages,
    async sendMessage(message: unknown) { layoutMessages.push(message); return { ok: true }; },
    connect: () => {
      const port: (typeof ports)[number] = { onMessage: event(), onDisconnect: event(), closed: false };
      ports.push(port);
      return { ...port, postMessage(request: any) {
        if (port.closed) throw new Error('Disconnected port');
        if (request.type === 'ANMERKO_SIDEBAR_LAYOUT') layoutSequence.push('port-post');
        requests.push(request);
        port.serverMessages?.emit(request);
      }, disconnect() { port.closed = true; } };
    },
  },
  tabs: {
    query: async () => {
      if (delayQuery) {
        delayQuery = false;
        await new Promise<void>(resolve => { releaseQuery = resolve; });
      }
      return [{ id: activeTabId }];
    },
    onActivated: event(), onUpdated: updated,
    async sendMessage(tabId: number, message: unknown) { pageMessages.push(message); pageTargets.push(tabId); },
  },
  windows: { getCurrent: async () => ({ id: 1 }) },
  storage: { local: { async get() { return {}; } }, onChanged: event() },
} });
const runtime = extensionRuntime(() => {});
const controller = mount(runtime);
const state: ViewState = { url: `${location.origin}/page`, draft: null, scope: 'page', picking: false, settings: false };
Object.assign(globalThis, { nativeHarness: {
  requests, pageMessages, pageTargets, layoutMessages, layoutSequence, backgroundModes,
  get startupRequests() { return requests.filter(request => !request.type); },
  get connections() { return ports.length; },
  reply(overrides: Partial<ViewState> = {}) { ports.at(-1)!.onMessage.emit({ ...requests.at(-1), ok: true, value: { ...state, ...overrides } }); },
  snapshot() { return controller.viewState(); },
  fail() { ports.at(-1)!.onMessage.emit({ ...requests.at(-1), ok: false, error: 'Connection failed' }); },
  disconnect() {
    const port = ports.at(-1)!;
    port.closed = true;
    port.onDisconnect.emit();
    port.serverDisconnect?.emit();
  },
  staleReply() { ports[0].onMessage.emit({ ...requests.at(-1), ok: false, error: 'Old port response' }); },
  broadcast(overrides: Partial<ViewState> = {}) {
    runtimeMessages.emit({ type: 'ANMERKO_VIEW_CHANGED', state: { ...state, ...overrides } }, { id: 'test-extension', tab: { id: activeTabId } }, () => {});
  },
  reopened(version?: number) { ports.at(-1)!.onMessage.emit({ type: 'ANMERKO_SIDEBAR_REOPENED', version }); },
  reconnect() { updated.emit(1, { status: 'complete' }); },
  reopen(windowId = 1, path = '/sidebar.html') { panelOpened.emit({ windowId, path }); },
  reopenFallback() { window.dispatchEvent(new PageTransitionEvent('pageshow')); },
  setActiveTab(tabId: number) { activeTabId = tabId; },
  async pageCommand() { await runtime.presentation!.startCapture().catch(() => {}); },
  delayNextQuery() { delayQuery = true; },
  queryPending() { return !!releaseQuery; },
  releaseQuery() { const release = releaseQuery; releaseQuery = undefined; release?.(); },
  bindBackground() {
    const port = ports.at(-1)!;
    const serverMessages = event(), serverDisconnect = event();
    port.serverMessages = serverMessages;
    port.serverDisconnect = serverDisconnect;
    bindSidebarConnection({
      name: 'anmerko-sidebar', onMessage: serverMessages, onDisconnect: serverDisconnect,
      postMessage: (value: unknown) => port.onMessage.emit(value),
    } as unknown as chrome.runtime.Port, {
      activate: async () => { backgroundModes.push('remote'); },
      view: async () => state,
      closed: async () => { backgroundModes.push('minimized'); },
      layout: async (_tabId, _windowId, mode) => { backgroundModes.push(mode); },
    }, backgroundOwners);
    for (const request of requests) serverMessages.emit(request);
  },
  resetLayoutSequence() { layoutSequence.length = 0; },
  failLayout() {
    const start = requests.slice().reverse().find((request: any) => !request.type);
    ports.at(-1)!.onMessage.emit({
      type: 'ANMERKO_SIDEBAR_LAYOUT_ERROR', version: start.version,
      code: 'layout-failed', error: 'Could not change layout.',
    });
  },
} });
