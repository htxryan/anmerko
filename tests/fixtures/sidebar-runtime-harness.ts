import { mount } from '../../src/content';
import { extensionRuntime } from '../../src/extension-runtime';
import { activateTab } from '../../src/activate';

type Listener = (...args: any[]) => void;
const event = () => {
  const listeners = new Set<Listener>();
  return { addListener(value: Listener) { listeners.add(value); }, removeListener(value: Listener) { listeners.delete(value); },
    emit(...args: any[]) { listeners.forEach(listener => listener(...args)); } };
};
const messages = event(), connections = event(), requests = event();
const broadcasts: unknown[] = [], replies: unknown[] = [];
let snapshot: (() => void) | undefined;
const extensionUrl = (path: string) => `${location.origin}/extension/${path}`;
Object.assign(globalThis, { chrome: {
  action: { onClicked: event() },
  runtime: {
    id: 'test-extension', getURL: extensionUrl, getManifest: () => ({}),
    onMessage: messages, onConnect: connections,
    async sendMessage(message: unknown) { broadcasts.push(message); },
  },
  scripting: { async executeScript() {} },
  tabs: {
    async sendMessage(_tabId: number, message: { type: string }) {
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
void import('../../src/background').then(() => {
  connections.emit({ name: 'anmerko-sidebar', sender: { url: extensionUrl('sidebar.html') },
    onMessage: requests, onDisconnect: event(), postMessage: (value: unknown) => replies.push(value),
  });
  Object.assign(globalThis, { sidebarHarness: {
    broadcasts, replies,
    start(version = 1) { requests.emit({ tabId: 1, version }); },
    snapshotPending() { return !!snapshot; },
    releaseSnapshot() { const release = snapshot; snapshot = undefined; release?.(); },
    toolbar() { return activateTab(1, 'remote', undefined, true); },
    state() { return controller.viewState(); },
  } });
});
