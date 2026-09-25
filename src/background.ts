import { activateTab } from './activate';
import {
  COMPONENT_CONTEXT_KEY,
  COMPONENT_CONTEXT_MESSAGE_TYPE,
  createComponentContextBroker,
  createExtensionComponentContextProbeRunner,
} from './component-context-bridge';
import { COMPONENT_CONTEXT_PROBES } from './component-context-dispatch';
import { extensionApi, firefoxExtension } from './platform';
import { openDock, supportsDocking } from './docking';
import { bindSidebarConnection } from './sidebar-connection';
import { createCaptureService } from './capture-service';
import { bindJourneyExtension } from './journey-extension';
export { activateTab } from './activate';

declare const __ANMERKO_JOURNEYS__: boolean;

const api = extensionApi();
const sidebarUrl = api.runtime.getURL('sidebar.html');
const CAPTURE_SPACING_KEY = 'anmerko:capture-spacing:v1';
const sidebarOwners = new Map<number, object>();
const sidebarPorts = new Map<number, { port: chrome.runtime.Port; version: number }>();
const screenshotService = createCaptureService(
  windowId => api.tabs.captureVisibleTab(windowId, { format: 'png' }),
  () => Date.now(),
  {
    // Session-only API-start spacing: a worker wake restores the shared
    // 600 ms budget without persisting image bytes or ordering steps.
    loadLastStart: async () => {
      try {
        const stored = await api.storage.session.get([CAPTURE_SPACING_KEY]);
        const value = stored[CAPTURE_SPACING_KEY];
        return typeof value === 'number' ? value : undefined;
      } catch {
        return undefined;
      }
    },
    saveLastStart: async lastStart => {
      try {
        await api.storage.session.set({ [CAPTURE_SPACING_KEY]: lastStart });
      } catch {
        // Spacing persistence is best-effort; the in-memory budget still applies.
      }
    },
  },
);
// Read the build define here rather than journeysEnabled: esbuild folds it only
// within this module, which drops the journey runtime from Orion's bundle.
const journeys = typeof __ANMERKO_JOURNEYS__ !== 'undefined' && __ANMERKO_JOURNEYS__
  ? bindJourneyExtension(screenshotService) : undefined;
type LayoutMode = 'dock' | 'overlay' | 'minimized' | 'closed';
const layoutModes = new Set<LayoutMode>(['dock', 'overlay', 'minimized', 'closed']);

function sidebarReopened(windowId: number) {
  const target = sidebarPorts.get(windowId);
  return () => {
    if (!target || sidebarPorts.get(windowId) !== target) return;
    sidebarPorts.delete(windowId);
    try {
      target.port.postMessage({ type: 'ANMERKO_SIDEBAR_REOPENED', version: target.version });
    } catch { /* A disconnected sidebar reconnects through its normal startup path. */ }
  };
}

async function requireActiveTab(tabId: number, windowId: number) {
  try {
    const tab = await api.tabs.get(tabId);
    if (tab.active && tab.windowId === windowId) return;
  } catch { /* Use the same safe failure for missing and changed tabs. */ }
  throw new Error('Could not change layout.');
}

async function changeLayout(tabId: number, windowId: number, mode: LayoutMode, state: unknown, mobile: boolean, fromSidebar: boolean) {
  if (mode === 'dock' && (mobile || !supportsDocking())) throw new Error('Docking is unavailable on mobile.');
  const reopened = mode === 'dock' ? sidebarReopened(windowId) : undefined;
  try {
    if (mode === 'dock') await openDock(windowId);
    await activateTab(tabId, mode === 'dock' ? 'remote' : mode, state, supportsDocking());
    reopened?.();
  } catch {
    // A sidebar can still be dismissed when the active tab is protected.
    if (fromSidebar && ['closed', 'minimized'].includes(mode)) return;
    throw new Error('Could not change layout.');
  }
}

const componentContextBroker = createComponentContextBroker({
    extensionId: api.runtime.id,
    probes: COMPONENT_CONTEXT_PROBES,
    runProbe: createExtensionComponentContextProbeRunner(api),
    readPreference: async () => (await api.storage.local.get(COMPONENT_CONTEXT_KEY))[COMPONENT_CONTEXT_KEY],
});
api.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[COMPONENT_CONTEXT_KEY]) {
    componentContextBroker.preferenceChanged(changes[COMPONENT_CONTEXT_KEY].newValue);
  }
});
api.action.onClicked.addListener(tab => {
  if (journeys?.stopIfRecording()) return;
  if (journeys?.openReviewIfAvailable()) return;
  if (!tab.id) return;
  const openRequestedPage = (preservedDock?: Promise<void>) => {
    if (!tab.url || !/^https?:/.test(tab.url)) {
      void api.tabs.create({ url: api.runtime.getURL('unavailable.html') });
      return;
    }
    const reopened = sidebarReopened(tab.windowId);
    const opening = supportsDocking() ? (preservedDock ?? openDock(tab.windowId)).then(() => {
      // Firefox can keep an existing sidebar open after navigation. A fresh
      // toolbar grant must retry its port-owned connection in that window.
      if (firefoxExtension(api)) {
        return api.runtime.sendMessage({ type: 'ANMERKO_CONNECT_SIDEBAR', windowId: tab.windowId }).catch(() => {});
      }
      return activateTab(tab.id!, 'remote', undefined, true);
    }).then(reopened) : activateTab(tab.id!);
    void opening.catch(() => activateTab(tab.id!)).catch(() => api.tabs.create({ url: api.runtime.getURL('unavailable.html') }));
  };
  if (!journeys) {
    openRequestedPage();
    return;
  }
  // Native sidebar APIs must be entered from the toolbar gesture. Start that
  // request while lifecycle restoration decides whether this click is Stop.
  const preservedDock = supportsDocking() ? openDock(tab.windowId) : undefined;
  // Toolbar Stop handles the click without awaiting the native dock request.
  // Observe its rejection while retaining the original promise so an idle
  // click can fall back to the overlay when docking fails.
  void preservedDock?.catch(() => {});
  void journeys.handleToolbarClick().then(handled => {
    if (!handled) openRequestedPage(preservedDock);
  }).catch(() => {});
});
api.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== api.runtime.id) return;
  if (message?.type === COMPONENT_CONTEXT_MESSAGE_TYPE) {
    const operation = componentContextBroker.handle(message, sender);
    if (!operation) return;
    operation.then(value => respond({ ok: true, value }), () => respond({ ok: true, value: null }));
    return true;
  }
  const fromPage = !!sender.tab?.id && /^https?:/.test(sender.url || '');
  const reply = (operation: Promise<unknown>) => {
    operation.then(value => respond({ ok: true, value }), error => respond({ ok: false, error: String(error.message || error) }));
    return true;
  };
  if (message?.type === 'ANMERKO_CAPTURE_VISIBLE' && fromPage && sender.frameId === 0) {
    return reply((async () => {
      const tabId = sender.tab!.id!;
      const windowId = sender.tab!.windowId;
      let changed = false;
      const activated = (info: { windowId: number; tabId: number }) => { if (info.windowId === windowId && info.tabId !== tabId) changed = true; };
      const updated = (id: number, info: { status?: string; url?: string }) => { if (id === tabId && (info.status === 'loading' || info.url)) changed = true; };
      api.tabs.onActivated.addListener(activated); api.tabs.onUpdated.addListener(updated);
      try {
        const before = await api.tabs.get(tabId);
        if (!before.active || before.url !== sender.url || !/^https?:/.test(before.url || '')) throw new Error('Return to the original page and try again.');
        const dataUrl = await screenshotService.capture(windowId);
        const after = await api.tabs.get(tabId);
        if (changed || !after.active || after.url !== before.url) throw new Error('The page changed during capture. Try again.');
        return dataUrl;
      } finally {
        api.tabs.onActivated.removeListener(activated); api.tabs.onUpdated.removeListener(updated);
      }
    })());
  }
  if (message?.type === 'OPEN_ANMERKO' && sender.url === api.runtime.getURL('popup.html') && Number.isInteger(message.tabId)) {
    return reply(activateTab(message.tabId, 'overlay', undefined, supportsDocking()));
  }
  if (message?.type === 'ANMERKO_LAYOUT' && fromPage) {
    if (!layoutModes.has(message.mode)) return;
    return reply(changeLayout(sender.tab!.id!, sender.tab!.windowId, message.mode, message.state, !!message.mobile, false));
  }
});
api.runtime.onConnect.addListener(port => {
  if (port.name !== 'anmerko-sidebar' || port.sender?.id !== api.runtime.id || port.sender.url !== sidebarUrl || port.sender.tab) return;
  bindSidebarConnection(port, {
    // The port sends the startup snapshot. Broadcasting here would apply it
    // twice and could replace the editor during the user's first click.
    activate: async (tabId, windowId) => {
      await requireActiveTab(tabId, windowId);
      await activateTab(tabId, 'remote', undefined, true, false);
    },
    view: tabId => api.tabs.sendMessage(tabId, { type: 'ANMERKO_GET_VIEW' }),
    closed: tabId => api.tabs.sendMessage(tabId, { type: 'ANMERKO_SIDEBAR_CLOSED' }),
    layout: async (tabId, windowId, mode, state) => {
      await requireActiveTab(tabId, windowId);
      await changeLayout(tabId, windowId, mode, state, false, true);
    },
    register: (windowId, version) => {
      const target = { port, version };
      sidebarPorts.set(windowId, target);
      return () => {
        if (sidebarPorts.get(windowId) === target) sidebarPorts.delete(windowId);
      };
    },
  }, sidebarOwners);
});
