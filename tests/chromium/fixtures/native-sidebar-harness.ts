import { mount } from '../../../src/content';
import { extensionRuntime } from '../../../src/extension-runtime';
import type { ViewState } from '../../../src/runtime';

type Listener = (...args: any[]) => void;
const event = () => {
  const listeners = new Set<Listener>();
  return { addListener(value: Listener) { listeners.add(value); }, removeListener(value: Listener) { listeners.delete(value); },
    emit(...args: any[]) { listeners.forEach(listener => listener(...args)); } };
};
const updated = event();
const ports: { onMessage: ReturnType<typeof event>; onDisconnect: ReturnType<typeof event>; closed: boolean }[] = [];
const requests: any[] = [];
const pageMessages: unknown[] = [], layoutMessages: unknown[] = [];
const layoutSequence: string[] = [];
let delayQuery = false;
let releaseQuery: (() => void) | undefined;
Object.assign(globalThis, { chrome: {
  sidebarAction: {
    open: async () => {},
    close: async () => { layoutSequence.push('close'); },
  },
  runtime: {
    id: 'test-extension', getURL: (path: string) => `${location.origin}/${path}`, getManifest: () => ({ sidebar_action: {} }),
    onMessage: event(),
    async sendMessage(message: unknown) { layoutMessages.push(message); return { ok: true }; },
    connect: () => {
      const port = { onMessage: event(), onDisconnect: event(), closed: false };
      ports.push(port);
      return { ...port, postMessage(request: any) {
        if (port.closed) throw new Error('Disconnected port');
        if (request.type === 'ANMERKO_SIDEBAR_LAYOUT') layoutSequence.push('port-post');
        requests.push(request);
      }, disconnect() { port.closed = true; } };
    },
  },
  tabs: {
    query: async () => {
      if (delayQuery) {
        delayQuery = false;
        await new Promise<void>(resolve => { releaseQuery = resolve; });
      }
      return [{ id: 1 }];
    },
    onActivated: event(), onUpdated: updated,
    async sendMessage(_tabId: number, message: unknown) { pageMessages.push(message); },
  },
  windows: { getCurrent: async () => ({ id: 1 }) },
  storage: { local: { async get() { return {}; } }, onChanged: event() },
} });
const controller = mount(extensionRuntime(() => {}));
const state: ViewState = { url: `${location.origin}/page`, draft: null, scope: 'page', picking: false, settings: false };
Object.assign(globalThis, { nativeHarness: {
  requests, pageMessages, layoutMessages, layoutSequence,
  get startupRequests() { return requests.filter(request => !request.type); },
  get connections() { return ports.length; },
  reply(overrides: Partial<ViewState> = {}) { ports.at(-1)!.onMessage.emit({ ...requests.at(-1), ok: true, value: { ...state, ...overrides } }); },
  snapshot() { return controller.viewState(); },
  fail() { ports.at(-1)!.onMessage.emit({ ...requests.at(-1), ok: false, error: 'Connection failed' }); },
  disconnect() { const port = ports.at(-1)!; port.closed = true; port.onDisconnect.emit(); },
  staleReply() { ports[0].onMessage.emit({ ...requests.at(-1), ok: false, error: 'Old port response' }); },
  reconnect() { updated.emit(1, { status: 'complete' }); },
  delayNextQuery() { delayQuery = true; },
  queryPending() { return !!releaseQuery; },
  releaseQuery() { const release = releaseQuery; releaseQuery = undefined; release?.(); },
  resetLayoutSequence() { layoutSequence.length = 0; },
  failLayout() {
    const start = requests.slice().reverse().find((request: any) => !request.type);
    ports.at(-1)!.onMessage.emit({
      type: 'ANMERKO_SIDEBAR_LAYOUT_ERROR', version: start.version,
      code: 'layout-failed', error: 'Could not change layout.',
    });
  },
} });
