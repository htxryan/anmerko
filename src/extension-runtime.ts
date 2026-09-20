import { closeDock } from './docking';
import styles from './panel.css';
import journeyStyles from './journey.css';
import type { Presentation, Runtime } from './runtime';

import { extensionApi } from './platform';
import type { Store } from './runtime';
import { journeysEnabled } from './journey-feature';

export function extensionStore(): Store {
  const api = extensionApi();
  return {
    read: async key => (await api.storage.local.get(key))[key],
    readAll: () => api.storage.local.get(null),
    write: (key, value) => api.storage.local.set({ [key]: value }),
    remove: key => api.storage.local.remove(key),
    subscribe(listener) {
      const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
        if (area === 'local') listener(changes);
      };
      api.storage.onChanged.addListener(changed);
      return () => api.storage.onChanged.removeListener(changed);
    },
  };
}


export function extensionRuntime(onDispose: () => void): Runtime {
  const api = extensionApi();
  const native = location.href === api.runtime.getURL('sidebar.html');
  let targetTab: number | undefined;
  let windowId: number | undefined;
  let connectionVersion = 0;
  async function pageCommand(type: string, extra: Record<string, unknown> = {}) {
    if (!targetTab) throw new Error('Click anmerko in the toolbar to connect this page.');
    return api.tabs.sendMessage(targetTab, { type, ...extra });
  }
  async function journeyCommand(type: string, extra: Record<string, unknown> = {}) {
    const result = await api.runtime.sendMessage({ type, ...extra });
    if (!result?.ok) throw new Error(result?.error || 'Could not update the journey.');
    return result.value;
  }
  const presentation: Presentation = {
    native,
    dockViaToolbar: 'sidebar_action' in api.runtime.getManifest(),
    async sync(state, remote) {
      if (native) {
        // Settings remain usable while disconnected, but an empty page identity
        // must never overwrite the page controller's current URL or draft.
        if (state.url) await pageCommand('ANMERKO_SET_VIEW', { state });
      } else if (remote) await api.runtime.sendMessage({ type: 'ANMERKO_VIEW_CHANGED', state }).catch(() => {});
    },
    async changeLayout(mode, state, mobile) {
      const request = api.runtime.sendMessage({ type: 'ANMERKO_LAYOUT', mode, state: state.url ? state : undefined, tabId: targetTab, windowId, mobile });
      // Firefox requires close() in the original click, before any await/message hop.
      if (native && mode !== 'dock') void closeDock(windowId || 0).catch(() => {});
      const result = await request;
      if (!result?.ok) throw new Error(result?.error || 'Could not change layout.');
    },
    locate: (note, parent) => pageCommand(parent ? 'ANMERKO_PARENT' : 'ANMERKO_LOCATE', { note }),
    hierarchy: note => pageCommand('ANMERKO_HIERARCHY', { note }),
    startCapture: () => pageCommand('ANMERKO_START_CAPTURE'),
    captureError: error => { void api.runtime.sendMessage({ type: 'ANMERKO_CAPTURE_ERROR', error }).catch(() => {}); },
    connect(controller, signal) {
      const messageListener = (message: any, sender: chrome.runtime.MessageSender, respond: (value?: unknown) => void) => {
        if (signal.aborted || sender.id !== api.runtime.id) return;
        if (native) {
          if (message?.type === 'ANMERKO_CONNECT_SIDEBAR' && !sender.tab && sender.url?.startsWith(api.runtime.getURL('')) && message.windowId === windowId) void connect();
          if (message?.type === 'ANMERKO_VIEW_CHANGED' && sender.tab?.id === targetTab) controller.applyState(message.state);
          if (message?.type === 'ANMERKO_CAPTURE_ERROR' && sender.tab?.id === targetTab) controller.status(message.error, true);
          return;
        }
        if (sender.url && !sender.url.startsWith(api.runtime.getURL(''))) return;
        if (message?.type === 'ANMERKO_PRESENT') { controller.present(message.mode, !!message.canDock, message.state, message.notifySidebar); respond(true); }
        else if (message?.type === 'ANMERKO_START_CAPTURE') { void controller.startCapture(); respond(true); }
        else if (message?.type === 'ANMERKO_GET_VIEW') respond(controller.viewState());
        else if (message?.type === 'ANMERKO_SET_VIEW') { controller.applyState(message.state); respond(true); }
        else if (message?.type === 'ANMERKO_SIDEBAR_CLOSED') { controller.sidebarClosed(); respond(true); }
        else if (message?.type === 'ANMERKO_HIERARCHY') respond(controller.hierarchy(message.note));
        else if (message?.type === 'ANMERKO_LOCATE' || message?.type === 'ANMERKO_PARENT') {
          respond(controller.locate(message.note, message.type === 'ANMERKO_PARENT'));
        }
      };
      api.runtime.onMessage.addListener(messageListener);
      signal.addEventListener('abort', () => api.runtime.onMessage.removeListener(messageListener), { once: true });
      if (!native) return;
      let port: chrome.runtime.Port | undefined;
      function connectionPort() {
        if (port) return port;
        const current = api.runtime.connect({ name: 'anmerko-sidebar' });
        port = current;
        current.onMessage.addListener(result => {
          if (signal.aborted || port !== current || result.version !== connectionVersion) return;
          if (!result.ok) { controller.connectionFailed(result.error); return; }
          controller.applyState(result.value);
        });
        current.onDisconnect.addListener(() => {
          if (signal.aborted || port !== current) return;
          // Firefox can unload its idle event page while the sidebar stays open.
          // Recreate the port on the next activation, not in an idle keepalive loop.
          port = undefined;
          ++connectionVersion;
        });
        return current;
      }
      async function connect() {
        const version = ++connectionVersion;
        try {
          const tabs = await api.tabs.query({ active: true, windowId });
          if (signal.aborted || version !== connectionVersion) return;
          const tab = tabs[0];
          if (!tab?.id) throw new Error('No active tab');
          targetTab = tab.id;
          // Startup and its response share the lifetime of this sidebar port.
          connectionPort().postMessage({ tabId: targetTab, version });
        } catch (error) {
          if (!signal.aborted && version === connectionVersion) controller.connectionFailed(error);
        }
      }
      const activated = (info: { tabId: number; windowId: number }) => { if (info.windowId === windowId) void connect(); };
      const updated = (tabId: number, change: { status?: string }) => { if (tabId === targetTab && change.status === 'complete') void connect(); };
      api.tabs.onActivated.addListener(activated);
      api.tabs.onUpdated.addListener(updated);
      signal.addEventListener('abort', () => {
        ++connectionVersion;
        api.tabs.onActivated.removeListener(activated);
        api.tabs.onUpdated.removeListener(updated);
        port?.disconnect();
      }, { once: true });
      // Chrome can reuse the sidebar document after pagehide. Its mounted
      // controller stays connected until disposal or actual context destruction.
      void api.windows.getCurrent().then(window => {
        if (!signal.aborted) { windowId = window.id; void connect(); }
      }).catch(error => { if (!signal.aborted) controller.connectionFailed(error); });
    },
  };
  return {
    store: extensionStore(), presentation, onDispose,
    ...(journeysEnabled && native ? { journeys: {
      read: () => journeyCommand('ANMERKO_JOURNEY_STATE'),
      start: (includeEnteredValues: boolean) => journeyCommand('ANMERKO_JOURNEY_START', { ownerTabId: targetTab, ownerWindowId: windowId, includeEnteredValues }),
      stop: () => journeyCommand('ANMERKO_JOURNEY_STOP'),
      discard: () => journeyCommand('ANMERKO_JOURNEY_DISCARD'),
      subscribe(changed: () => void) {
        const listener = (message: any, sender: chrome.runtime.MessageSender) => {
          if (sender.id === api.runtime.id && !sender.tab && message?.type === 'ANMERKO_JOURNEY_CHANGED') changed();
        };
        api.runtime.onMessage.addListener(listener);
        return () => api.runtime.onMessage.removeListener(listener);
      },
    } } : {}),
    settingsLabel: 'Extension settings',
    storageError: 'Could not save or load comments. Keep your draft and try again. If the extension was reloaded, refresh this page.',
    attachStyles(shadow) {
      const sheet = document.createElement('style');
      sheet.textContent = styles + (journeysEnabled ? journeyStyles : '');
      shadow.prepend(sheet);
    },
    async capture() {
      const result = await api.runtime.sendMessage({ type: 'ANMERKO_CAPTURE_VISIBLE' });
      if (!result?.ok) throw new Error(result?.error || 'Could not capture this page.');
      return result.value;
    },
  };
}
