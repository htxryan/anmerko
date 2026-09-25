import { closeDock } from './docking';
import { requestComponentContext } from './component-context-bridge';
import styles from './panel.css';
import type { DraftTargetIdentity, Presentation, Runtime } from './runtime';

import { extensionApi } from './platform';
import type { Store } from './runtime';
import { journeysEnabled } from './journey-feature';
import { createJourneyClient } from './journey-client';
import { journeySurfaceStyles } from './journey-styles';
import { watchJourneyPageRecording } from './journey-page-bridge';

function draftTargetIdentity(value: unknown): DraftTargetIdentity | undefined {
  if (!value || typeof value !== 'object' || Object.keys(value).length !== 5) return;
  const identity = value as Record<string, unknown>;
  if (!['viewToken', 'draftId', 'draftToken', 'targetToken'].every(key => typeof identity[key] === 'string'
    && (identity[key] as string).length > 0 && (identity[key] as string).length <= 128)
    || !Number.isSafeInteger(identity.revision) || (identity.revision as number) < 0) return;
  return identity as DraftTargetIdentity;
}

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
  let sidebarRequestVersion: number | undefined;
  let closingLayoutVersion: number | undefined;
  let sidebarReopenVersion: number | undefined;
  let sidebarClosing = false;
  let sidebarNeedsReconnect = false;
  let sidebarPort: chrome.runtime.Port | undefined;
  let sidebarHandedOff: ((version: number) => void) | undefined;
  let resumeSidebarPort: (() => void) | undefined;
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
      if (native && ['overlay', 'minimized', 'closed'].includes(mode)) {
        if (!sidebarPort) resumeSidebarPort?.();
        if (sidebarClosing || !sidebarPort || sidebarRequestVersion === undefined) throw new Error('Could not change layout.');
        const version = sidebarRequestVersion;
        sidebarPort.postMessage({
          type: 'ANMERKO_SIDEBAR_LAYOUT', version,
          mode, state: state.url ? state : undefined,
        });
        closingLayoutVersion = sidebarRequestVersion;
        sidebarReopenVersion = sidebarRequestVersion;
        sidebarClosing = true;
        sidebarNeedsReconnect = true;
        ++connectionVersion;
        // Firefox requires close() in the original click, before any await/message hop.
        const closed = () => sidebarHandedOff?.(version);
        void closeDock(windowId || 0).then(closed, closed);
        return;
      }
      const request = api.runtime.sendMessage({ type: 'ANMERKO_LAYOUT', mode, state: state.url ? state : undefined, tabId: targetTab, windowId, mobile });
      const result = await request;
      if (!result?.ok) throw new Error(result?.error || 'Could not change layout.');
    },
    locate: (note, parent, identity) => pageCommand(parent ? 'ANMERKO_PARENT' : 'ANMERKO_LOCATE', { note, identity }),
    hierarchy: note => pageCommand('ANMERKO_HIERARCHY', { note }),
    startCapture: () => pageCommand('ANMERKO_START_CAPTURE'),
    captureError: error => { void api.runtime.sendMessage({ type: 'ANMERKO_CAPTURE_ERROR', error }).catch(() => {}); },
    connect(controller, signal) {
      const messageListener = (message: any, sender: chrome.runtime.MessageSender, respond: (value?: unknown) => void) => {
        if (signal.aborted || sender.id !== api.runtime.id) return;
        if (native) {
          if (message?.type === 'ANMERKO_CONNECT_SIDEBAR' && !sender.tab && sender.url?.startsWith(api.runtime.getURL('')) && message.windowId === windowId) void connect();
          // A handed-off document waits for its fresh owner's snapshot instead.
          if (message?.type === 'ANMERKO_VIEW_CHANGED' && sender.tab?.id === targetTab && !sidebarNeedsReconnect) controller.applyState(message.state);
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
          respond(controller.locate(message.note, message.type === 'ANMERKO_PARENT', draftTargetIdentity(message.identity)));
        }
      };
      api.runtime.onMessage.addListener(messageListener);
      signal.addEventListener('abort', () => api.runtime.onMessage.removeListener(messageListener), { once: true });
      if (!native) return;
      function connectionPort() {
        if (sidebarPort) return sidebarPort;
        const current = api.runtime.connect({ name: 'anmerko-sidebar' });
        sidebarPort = current;
        current.onMessage.addListener(result => {
          if (signal.aborted || sidebarPort !== current) return;
          if (result.type === 'ANMERKO_SIDEBAR_REOPENED') {
            if (sidebarReopenVersion !== undefined && result.version === sidebarReopenVersion) reopen(true);
            return;
          }
          if (result.type === 'ANMERKO_SIDEBAR_LAYOUT_ERROR') {
            if (result.version !== closingLayoutVersion) return;
            closingLayoutVersion = undefined;
            sidebarRequestVersion = undefined;
            sidebarClosing = false;
            // The background restored the page, so this document no longer owns it.
            controller.connectionFailed();
            if (result.code === 'layout-failed' && result.error === 'Could not change layout.') controller.status(result.error, true);
            return;
          }
          if (result.version !== connectionVersion) return;
          if (!result.ok) { controller.connectionFailed(result.error); return; }
          controller.applyState(result.value);
        });
        current.onDisconnect.addListener(() => {
          if (signal.aborted || sidebarPort !== current) return;
          // Firefox can unload its idle event page while the sidebar stays open.
          // Recreate the port on the next activation, not in an idle keepalive loop.
          sidebarPort = undefined;
          sidebarRequestVersion = undefined;
          // An intentional close can deliver disconnect before page disposal.
          // Keep blocking late tab events so they cannot undo the accepted layout.
          if (!sidebarClosing) closingLayoutVersion = undefined;
          ++connectionVersion;
        });
        return current;
      }
      async function connect() {
        if (sidebarClosing) return;
        targetTab = undefined;
        sidebarReopenVersion = undefined;
        const version = ++connectionVersion;
        try {
          const tabs = await api.tabs.query({ active: true, windowId });
          if (signal.aborted || sidebarClosing || version !== connectionVersion) return;
          const tab = tabs[0];
          if (!tab?.id) throw new Error('No active tab');
          targetTab = tab.id;
          // Startup and its response share the lifetime of this sidebar port.
          const port = connectionPort();
          port.postMessage({ tabId: targetTab, windowId, version });
          sidebarRequestVersion = version;
          sidebarReopenVersion = version;
          sidebarNeedsReconnect = false;
        } catch (error) {
          if (!signal.aborted && version === connectionVersion) controller.connectionFailed(error);
        }
      }
      // An idle background drops this port while the sidebar still shows its
      // page. A layout reopens it for that tab within the same click, so the
      // woken background receives the startup request before the layout and
      // hands the page over exactly as for a sidebar that never idled.
      resumeSidebarPort = () => {
        if (signal.aborted || sidebarPort || sidebarClosing || targetTab === undefined || windowId === undefined) return;
        const version = ++connectionVersion;
        try { connectionPort().postMessage({ tabId: targetTab, windowId, version }); }
        catch { return; }
        sidebarRequestVersion = version;
        sidebarReopenVersion = version;
      };
      // Chrome can show a closed sidebar's document again. Once a closing layout
      // hands the page its view, that document keeps the connection prompt until
      // a fresh owner answers, so a stale panel never offers a refused Float.
      sidebarHandedOff = version => {
        if (!signal.aborted && closingLayoutVersion === version) controller.connectionFailed();
      };
      const reopen = (explicit = false) => {
        if (signal.aborted || (!explicit && ((!sidebarClosing && !sidebarNeedsReconnect) || document.hidden))) return;
        // A closing layout retired its request. A live owner keeps serving
        // layouts until its replacement posts, as with any other reconnect.
        if (sidebarClosing) sidebarRequestVersion = undefined;
        sidebarClosing = false;
        closingLayoutVersion = undefined;
        sidebarReopenVersion = undefined;
        void connect();
      };
      const configuredPanelPath = api.runtime.getManifest().side_panel?.default_path;
      let panelPath: string | undefined;
      try {
        if (configuredPanelPath) panelPath = new URL(api.runtime.getURL(configuredPanelPath)).pathname;
      } catch { /* Ignore an invalid optional manifest path. */ }
      const opened = (info: chrome.sidePanel.PanelOpenedInfo) => {
        if (panelPath && info.windowId === windowId && info.path === panelPath) reopen(false);
      };
      const lifecycleReopen = () => reopen(false);
      const activated = (info: { tabId: number; windowId: number }) => { if (info.windowId === windowId) void connect(); };
      const updated = (tabId: number, change: { status?: string }) => { if (tabId === targetTab && change.status === 'complete') void connect(); };
      api.tabs.onActivated.addListener(activated);
      api.tabs.onUpdated.addListener(updated);
      api.sidePanel?.onOpened?.addListener(opened);
      document.addEventListener('visibilitychange', lifecycleReopen);
      window.addEventListener('pageshow', lifecycleReopen);
      signal.addEventListener('abort', () => {
        ++connectionVersion;
        api.tabs.onActivated.removeListener(activated);
        api.tabs.onUpdated.removeListener(updated);
        api.sidePanel?.onOpened?.removeListener(opened);
        document.removeEventListener('visibilitychange', lifecycleReopen);
        window.removeEventListener('pageshow', lifecycleReopen);
        sidebarPort?.disconnect();
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
    ...(journeysEnabled && !native ? { openJourney: () => journeyCommand('ANMERKO_JOURNEY_OPEN') } : {}),
    ...(journeysEnabled && !native ? { watchJourneyRecording: watchJourneyPageRecording } : {}),
    ...(journeysEnabled && native ? { journeys: createJourneyClient(() => ({ ownerTabId: targetTab, ownerWindowId: windowId })) } : {}),
    settingsLabel: 'Extension settings',
    storageError: 'Could not save or load comments. Keep your draft and try again. If the extension was reloaded, refresh this page.',
    attachStyles(shadow) {
      const sheet = document.createElement('style');
      sheet.textContent = styles + (journeysEnabled ? journeySurfaceStyles : '');
      shadow.prepend(sheet);
    },
    async capture() {
      const result = await api.runtime.sendMessage({ type: 'ANMERKO_CAPTURE_VISIBLE' });
      if (!result?.ok) throw new Error(result?.error || 'Could not capture this page.');
      return result.value;
    },
    captureComponentContext: (element, selectorPath, signal) => requestComponentContext(api.runtime, element, selectorPath, signal),
  };
}
