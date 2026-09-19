import { extensionApi } from './platform';

export async function activateTab(tabId: number, mode = 'overlay', state?: unknown, canDock = false, notifySidebar = true): Promise<void> {
  await extensionApi().scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  await extensionApi().tabs.sendMessage(tabId, { type: 'ANMERKO_PRESENT', mode, state, canDock, notifySidebar });
}
