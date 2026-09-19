import { extensionApi } from './platform';

type SidebarApi = { open: () => Promise<void>; close: () => Promise<void> };
type PanelApi = { open: (options: { windowId: number }) => Promise<void>; close: (options: { windowId: number }) => Promise<void> };
const api = () => extensionApi() as unknown as { sidePanel?: PanelApi; sidebarAction?: SidebarApi };
export const supportsDocking = () => !/Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) && !!(api().sidePanel?.open || api().sidebarAction?.open);
// Keep open() in the original click handler: Firefox requires a user gesture.
export function openDock(windowId: number): Promise<void> {
  if (api().sidePanel?.open) return api().sidePanel!.open({ windowId });
  if (api().sidebarAction?.open) return api().sidebarAction!.open();
  return Promise.reject(new Error('Docking is unavailable on this browser.'));
}
export function closeDock(windowId: number): Promise<void> {
  if (api().sidePanel?.close) return api().sidePanel!.close({ windowId });
  if (api().sidebarAction?.close) return api().sidebarAction!.close();
  return Promise.resolve();
}
