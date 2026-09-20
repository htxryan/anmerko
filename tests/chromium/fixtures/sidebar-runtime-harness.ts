import { mount } from '../../../src/content';
import { extensionRuntime } from '../../../src/extension-runtime';
import { activateTab } from '../../../src/activate';

type Listener = (...args: any[]) => void;
const event = () => {
  const listeners = new Set<Listener>();
  return { addListener(value: Listener) { listeners.add(value); }, removeListener(value: Listener) { listeners.delete(value); },
    emit(...args: any[]) { listeners.forEach(listener => listener(...args)); } };
};
const messages = event(), connections = event(), requests = event();
const disconnects = event();
const broadcasts: unknown[] = [], replies: unknown[] = [], pageCommands: any[] = [], executions: unknown[] = [];
let snapshot: (() => void) | undefined;
let tabState = { windowId: 1, active: true };
const extensionUrl = (path: string) => `${location.origin}/extension/${path}`;
Object.assign(globalThis, { chrome: {
  action: { onClicked: event() },
  runtime: {
    id: 'test-extension', getURL: extensionUrl, getManifest: () => ({}),
    onMessage: messages, onConnect: connections,
    async sendMessage(message: unknown) { broadcasts.push(message); },
  },
  scripting: { async executeScript(details: unknown) { executions.push(details); } },
  tabs: {
    async get(tabId: number) { return { id: tabId, ...tabState }; },
    async sendMessage(_tabId: number, message: { type: string }) {
      pageCommands.push(message);
      const value = await new Promise(resolve => {
        messages.emit(message, { id: 'test-extension', url: extensionUrl('sidebar.html') }, resolve);
      });
      if (message.type === 'ANMERKO_GET_VIEW') await new Promise<void>(resolve => { snapshot = resolve; });
      return value;
    },
  },
  storage: { local: { async get() { return {}; } }, onChanged: event() },
} });
const controller = mount(extensionRuntime(() => {}));
void import('../../../src/background').then(() => {
  connections.emit({ name: 'anmerko-sidebar', sender: { id: 'test-extension', url: extensionUrl('sidebar.html') },
    onMessage: requests, onDisconnect: disconnects, postMessage: (value: unknown) => replies.push(value),
  });
  Object.assign(globalThis, { sidebarHarness: {
    broadcasts, replies, pageCommands,
    start(version = 1) { requests.emit({ tabId: 1, windowId: 1, version }); },
    layout(version = 1) { requests.emit({ type: 'ANMERKO_SIDEBAR_LAYOUT', version, mode: 'overlay', state: { url: `${location.origin}/page` } }); },
    disconnect() { disconnects.emit(); },
    clearPageCommands() { pageCommands.length = 0; },
    setTabState(windowId: number, active: boolean) { tabState = { windowId, active }; },
    async probeUntrustedConnections() {
      const before = executions.length;
      const send = (sender: unknown) => {
        const input = event();
        connections.emit({ name: 'anmerko-sidebar', sender, onMessage: input, onDisconnect: event(), postMessage() {} });
        input.emit({ tabId: 1, windowId: 1, version: 90 });
      };
      send({ id: 'other-extension', url: extensionUrl('sidebar.html') });
      send({ id: 'test-extension', url: `${extensionUrl('sidebar.html')}?forged=1` });
      send({ id: 'test-extension', url: extensionUrl('sidebar.html'), tab: { id: 1 } });
      await new Promise(resolve => setTimeout(resolve));
      return executions.length - before;
    },
    snapshotPending() { return !!snapshot; },
    releaseSnapshot() { const release = snapshot; snapshot = undefined; release?.(); },
    toolbar() { return activateTab(1, 'remote', undefined, true); },
    state() { return controller.viewState(); },
  } });
});
