import { activateTab } from './activate';
import { extensionApi } from './platform';
import { openDock, supportsDocking } from './docking';
import { bindSidebarConnection } from './sidebar-connection';
import { createCaptureService } from './capture-service';
import { journeysEnabled } from './journey-feature';
import { bindJourneyExtension } from './journey-extension';
export { activateTab } from './activate';

const api = extensionApi();
const sidebarUrl = api.runtime.getURL('sidebar.html');
const sidebarOwners = new Map<number, object>();
const screenshotService = createCaptureService(windowId => api.tabs.captureVisibleTab(windowId, { format: 'png' }));
const journeys = journeysEnabled ? bindJourneyExtension(screenshotService) : undefined;
type LayoutMode = 'dock' | 'overlay' | 'minimized' | 'closed';
const layoutModes = new Set<LayoutMode>(['dock', 'overlay', 'minimized', 'closed']);

async function requireActiveTab(tabId: number, windowId: number) {
  try {
    const tab = await api.tabs.get(tabId);
    if (tab.active && tab.windowId === windowId) return;
  } catch { /* Use the same safe failure for missing and changed tabs. */ }
  throw new Error('Could not change layout.');
}

async function changeLayout(tabId: number, windowId: number, mode: LayoutMode, state: unknown, mobile: boolean, fromSidebar: boolean) {
  if (mode === 'dock' && (mobile || !supportsDocking())) throw new Error('Docking is unavailable on mobile.');
  try {
    if (mode === 'dock') await openDock(windowId);
    await activateTab(tabId, mode === 'dock' ? 'remote' : mode, state, supportsDocking());
  } catch {
    // A sidebar can still be dismissed when the active tab is protected.
    if (fromSidebar && ['closed', 'minimized'].includes(mode)) return;
    throw new Error('Could not change layout.');
  }
}

api.action.onClicked.addListener(tab => {
  if (journeys?.stopIfRecording()) return;
  if (journeys?.openReviewIfAvailable()) return;
  if (!tab.id) return;
  if (!tab.url || !/^https?:/.test(tab.url)) {
    void api.tabs.create({ url: api.runtime.getURL('unavailable.html') });
    return;
  }
  const opening = supportsDocking() ? openDock(tab.windowId).then(() => {
    // Firefox can keep an existing sidebar open after navigation. A fresh
    // toolbar grant must retry its port-owned connection in that window.
    if ('sidebar_action' in api.runtime.getManifest()) {
      return api.runtime.sendMessage({ type: 'ANMERKO_CONNECT_SIDEBAR', windowId: tab.windowId }).catch(() => {});
    }
    return activateTab(tab.id!, 'remote', undefined, true);
  }) : activateTab(tab.id);
  void opening.catch(() => activateTab(tab.id!)).catch(() => api.tabs.create({ url: api.runtime.getURL('unavailable.html') }));
});
api.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== api.runtime.id) return;
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
  }, sidebarOwners);
});
