import { mount } from '../../../src/content';
import { extensionRuntime } from '../../../src/extension-runtime';
import { activateTab } from '../../../src/activate';
import { addJourneyApis } from './journey-apis';

type Listener = (...args: any[]) => void;
const event = () => {
  const listeners = new Set<Listener>();
  return { addListener(value: Listener) { listeners.add(value); }, removeListener(value: Listener) { listeners.delete(value); },
    emit(...args: any[]) { listeners.forEach(listener => listener(...args)); } };
};
const messages = event(), connections = event(), requests = event(), actions = event();
const disconnects = event();
const broadcasts: unknown[] = [], replies: unknown[] = [], pageCommands: any[] = [], executions: unknown[] = [];
const journeyMessages: unknown[] = [];
let snapshot: (() => void) | undefined;
let delayDock = false;
let releaseDock: (() => void) | undefined;
let tabState = { windowId: 1, active: true };
const sequence: string[] = [];
const createdTabs: string[] = [];
// Set before this bundle loads: holds the journey background's restore, which
// decides whether a toolbar click is Stop, until released.
let releaseRestore: (() => void) | undefined;
const restoreHeld = (globalThis as { holdJourneyRestore?: boolean }).holdJourneyRestore === true;
const extensionUrl = (path: string) => `${location.origin}/extension/${path}`;
Object.assign(globalThis, { chrome: {
  action: { onClicked: actions },
  sidePanel: { async open() {
    sequence.push('dock');
    if (delayDock) {
      delayDock = false;
      await new Promise<void>(resolve => { releaseDock = resolve; });
    }
  } },
  runtime: {
    id: 'test-extension', getURL: extensionUrl, getManifest: () => ({}),
    onMessage: messages, onConnect: connections,
    // Journey traffic is kept apart from the sidebar broadcasts under test.
    async sendMessage(message: unknown) {
      if (String((message as { type?: unknown } | null)?.type).startsWith('ANMERKO_JOURNEY_')) journeyMessages.push(message);
      else broadcasts.push(message);
    },
  },
  scripting: { async executeScript(details: unknown) { executions.push(details); } },
  tabs: {
    async get(tabId: number) { return { id: tabId, ...tabState }; },
    async create(details: { url: string }) { createdTabs.push(details.url); return { id: 99, windowId: 1, ...details }; },
    async sendMessage(_tabId: number, message: { type: string }) {
      pageCommands.push(message);
      const value = await new Promise(resolve => {
        messages.emit(message, { id: 'test-extension', url: extensionUrl('sidebar.html') }, resolve);
      });
      if (message.type === 'ANMERKO_GET_VIEW') await new Promise<void>(resolve => { snapshot = resolve; });
      return value;
    },
  },
  storage: {
    local: { async get() { return {}; } }, onChanged: event(),
    session: {
      async get(keys: string[]) {
        if (!keys.some(key => key.startsWith('anmerko:journey-session:'))) return {};
        sequence.push('restore');
        if (restoreHeld && sequence.filter(item => item === 'restore').length === 1) {
          await new Promise<void>(resolve => { releaseRestore = resolve; });
        }
        return {};
      },
    },
  },
} });
// A build that ships journeys binds them only where the browser has every API.
addJourneyApis();
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
    dock() { return new Promise(resolve => messages.emit(
      { type: 'ANMERKO_LAYOUT', mode: 'dock' },
      { id: 'test-extension', url: `${location.origin}/page`, tab: { id: 1, windowId: 1 } }, resolve,
    )); },
    // Reports the calls the click made before its listener returned.
    toolbarAction(url = `${location.origin}/page`) {
      const before = sequence.length;
      actions.emit({ id: 1, windowId: 1, url });
      return sequence.slice(before);
    },
    sequence, createdTabs,
    restorePending() { return !!releaseRestore; },
    releaseRestore() { const release = releaseRestore; releaseRestore = undefined; release?.(); },
    delayDock() { delayDock = true; },
    dockPending() { return !!releaseDock; },
    releaseDock() { const release = releaseDock; releaseDock = undefined; release?.(); },
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
