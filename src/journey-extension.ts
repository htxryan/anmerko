import {
  createJourneyController,
  type JourneyController,
  type JourneyPageIdentity,
} from './journey-controller';
import type { JourneyDraftImage, JourneySession } from './journey-core';
import { stripUrlCredentials } from './journey-events';
import { normalizeJourneyPng } from './journey-image';
import { extensionApi } from './platform';

export interface JourneyScreenshotService {
  capture(windowId: number): Promise<string>;
  waitMs(): number;
}

export interface JourneyExtensionBinding {
  stopIfRecording(): boolean;
}

type Message = Record<string, unknown> & { type?: unknown };
type ActiveState = Extract<JourneySession, { phase: 'starting' | 'recording' }>;

const GENERIC_ERROR = 'Journey command unavailable.';
const DEFAULT_ACTION_TITLE = 'Annotate with anmerko';
const RECORDING_ACTION_TITLE = 'Stop journey recording';
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/;

function success<T>(value?: T): { ok: true; value?: T } {
  return value === undefined ? { ok: true } : { ok: true, value };
}

function failure() {
  return { ok: false as const, error: GENERIC_ERROR };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validInteger(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}

function validNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function activeState(state: JourneySession): state is ActiveState {
  return state.phase === 'starting' || state.phase === 'recording';
}

function normalizedUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error(GENERIC_ERROR);
  return stripUrlCredentials(value);
}

function pageIdentity(value: unknown): JourneyPageIdentity {
  if (!isRecord(value) || typeof value.documentToken !== 'string' || !SAFE_ID.test(value.documentToken)
    || !isRecord(value.viewport) || !validInteger(value.viewport.width, 1) || !validInteger(value.viewport.height, 1)
    || !isRecord(value.scroll) || !validNumber(value.scroll.x) || !validNumber(value.scroll.y)
    || !validInteger(value.generation) || typeof value.visible !== 'boolean') throw new Error(GENERIC_ERROR);
  return {
    documentToken: value.documentToken,
    url: normalizedUrl(value.url),
    viewport: { width: value.viewport.width, height: value.viewport.height },
    scroll: { x: value.scroll.x, y: value.scroll.y },
    generation: value.generation,
    visible: value.visible,
  };
}

function sameIdentity(first: JourneyPageIdentity, second: JourneyPageIdentity): boolean {
  return first.documentToken === second.documentToken && first.url === second.url
    && first.viewport.width === second.viewport.width && first.viewport.height === second.viewport.height
    && first.scroll.x === second.scroll.x && first.scroll.y === second.scroll.y
    && first.generation === second.generation && first.visible === second.visible;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
}

export function bindJourneyExtension(screenshotService: JourneyScreenshotService): JourneyExtensionBinding {
  const api = extensionApi();
  const sidebarUrl = api.runtime.getURL('sidebar.html');
  const windowsApi = api.windows as typeof chrome.windows | undefined;
  let decoratedTabId: number | undefined;
  let controller: JourneyController;

  const pageCommand = async (tabId: number, message: Message): Promise<unknown> => {
    const response = await api.tabs.sendMessage(tabId, message, { frameId: 0 });
    if (!isRecord(response) || response.ok !== true) throw new Error(GENERIC_ERROR);
    return response.value;
  };

  const focusedOwnerTab = async (tabId: number, expectedWindowId?: number, expectedUrl?: string) => {
    const tab = await api.tabs.get(tabId);
    if (tab.id !== tabId || !validInteger(tab.windowId) || !tab.active || !tab.url) throw new Error(GENERIC_ERROR);
    const url = normalizedUrl(tab.url);
    if ((expectedWindowId !== undefined && tab.windowId !== expectedWindowId)
      || (expectedUrl !== undefined && url !== expectedUrl)) throw new Error(GENERIC_ERROR);
    if (windowsApi?.get) {
      const ownerWindow = await windowsApi.get(tab.windowId);
      if (!ownerWindow.focused) throw new Error(GENERIC_ERROR);
    }
    return { tab, url, windowId: tab.windowId };
  };

  const identify = async (tabId: number): Promise<JourneyPageIdentity> => {
    const before = await focusedOwnerTab(tabId);
    const identity = pageIdentity(await pageCommand(tabId, { type: 'ANMERKO_JOURNEY_PAGE_IDENTIFY' }));
    const after = await focusedOwnerTab(tabId, before.windowId, before.url);
    if (identity.url !== after.url) throw new Error(GENERIC_ERROR);
    return identity;
  };

  const capture = async (
    tabId: number,
    expected: JourneyPageIdentity,
    captureId: string,
  ): Promise<JourneyDraftImage> => {
    const snapshot = controller.getState();
    if (!activeState(snapshot) || snapshot.ownerTabId !== tabId || snapshot.documentToken !== expected.documentToken) {
      throw new Error(GENERIC_ERROR);
    }
    const stillCurrent = () => {
      const current = controller.getState();
      return activeState(current) && current.sessionId === snapshot.sessionId && current.epoch === snapshot.epoch
        && current.ownerTabId === snapshot.ownerTabId && current.ownerWindowId === snapshot.ownerWindowId
        && current.documentToken === snapshot.documentToken;
    };
    const waitMs = screenshotService.waitMs();
    if (!validNumber(waitMs) || waitMs < 0) throw new Error(GENERIC_ERROR);
    const windowId = snapshot.ownerWindowId;
    let dirty = false;
    const activated = (info: { tabId: number; windowId: number }) => {
      if (info.windowId === windowId) dirty = true;
    };
    const updated = (changedTabId: number, change: { status?: string; url?: string }) => {
      if (changedTabId === tabId && (change.status === 'loading' || typeof change.url === 'string')) dirty = true;
    };
    const focusChanged = (_windowId: number) => { dirty = true; };
    api.tabs.onActivated.addListener(activated);
    api.tabs.onUpdated.addListener(updated);
    windowsApi?.onFocusChanged?.addListener(focusChanged);

    let rawPng: string | undefined;
    let capturedAt: string | undefined;
    let capturedUrl: string | undefined;
    let finishedIdentity: JourneyPageIdentity | undefined;
    let operationError: unknown;
    try {
      await delay(waitMs);
      if (!stillCurrent()) throw new Error(GENERIC_ERROR);
      await focusedOwnerTab(tabId, windowId, expected.url);
      const prepared = pageIdentity(await pageCommand(tabId, {
        type: 'ANMERKO_JOURNEY_PAGE_PREPARE', captureId, documentToken: expected.documentToken,
      }));
      if (!prepared.visible || !sameIdentity(expected, prepared) || dirty || !stillCurrent()) throw new Error(GENERIC_ERROR);
      rawPng = await screenshotService.capture(windowId);
      capturedAt = new Date().toISOString();
      capturedUrl = prepared.url;
      if (!stillCurrent()) throw new Error(GENERIC_ERROR);
    } catch (error) {
      operationError = error;
    } finally {
      try {
        finishedIdentity = pageIdentity(await pageCommand(tabId, { type: 'ANMERKO_JOURNEY_PAGE_FINISH', captureId }));
        await focusedOwnerTab(tabId, windowId, expected.url);
      } catch (error) {
        operationError ??= error;
      } finally {
        api.tabs.onActivated.removeListener(activated);
        api.tabs.onUpdated.removeListener(updated);
        windowsApi?.onFocusChanged?.removeListener(focusChanged);
      }
    }
    if (operationError) throw operationError;
    if (dirty || !stillCurrent() || !rawPng || !capturedAt || !capturedUrl || !finishedIdentity
      || !finishedIdentity.visible || !sameIdentity(expected, finishedIdentity)) throw new Error(GENERIC_ERROR);
    const image = await normalizeJourneyPng(rawPng);
    return {
      ...image,
      capturedAt,
      captureUrl: capturedUrl,
      viewport: { ...finishedIdentity.viewport },
      scroll: { ...finishedIdentity.scroll },
    };
  };

  const resetAction = (tabId: number) => {
    void api.action.setBadgeText({ tabId, text: '' }).catch(() => {});
    void api.action.setTitle({ tabId, title: DEFAULT_ACTION_TITLE }).catch(() => {});
  };

  const showRecordingAction = (tabId: number) => {
    void api.action.setBadgeText({ tabId, text: 'REC' }).catch(() => {});
    void api.action.setTitle({ tabId, title: RECORDING_ACTION_TITLE }).catch(() => {});
  };

  const changed = (state: JourneySession) => {
    const nextDecoratedTabId = activeState(state) ? state.ownerTabId : undefined;
    if (decoratedTabId !== nextDecoratedTabId) {
      if (decoratedTabId !== undefined) resetAction(decoratedTabId);
      if (nextDecoratedTabId !== undefined) showRecordingAction(nextDecoratedTabId);
      decoratedTabId = nextDecoratedTabId;
    }
    if (state.phase === 'recording') {
      void pageCommand(state.ownerTabId, {
        type: 'ANMERKO_JOURNEY_PAGE_STATUS', sessionId: state.sessionId,
        epoch: state.epoch, count: state.draft.steps.length,
      }).catch(() => {});
    }
    void api.runtime.sendMessage({ type: 'ANMERKO_JOURNEY_CHANGED' }).catch(() => {});
  };

  controller = createJourneyController({
    identify,
    capture,
    async begin(tabId, input) {
      await pageCommand(tabId, { type: 'ANMERKO_JOURNEY_PAGE_START', ...input });
    },
    async end(tabId, input) {
      await pageCommand(tabId, { type: 'ANMERKO_JOURNEY_PAGE_STOP', ...input });
    },
    changed,
  });

  const stopForOwner = (reason: 'focus-lost' | 'tab-lost' | 'capture-failed') => {
    if (activeState(controller.getState())) void controller.stop(reason);
  };
  const ownerActivated = (info: { tabId: number; windowId: number }) => {
    const state = controller.getState();
    if (activeState(state) && info.windowId === state.ownerWindowId && info.tabId !== state.ownerTabId) stopForOwner('focus-lost');
  };
  const ownerUpdated = (tabId: number, change: { status?: string; url?: string }) => {
    const state = controller.getState();
    if (activeState(state) && tabId === state.ownerTabId && (change.status === 'loading' || typeof change.url === 'string')) {
      stopForOwner('capture-failed');
    }
  };
  const ownerRemoved = (tabId: number) => {
    const state = controller.getState();
    if (activeState(state) && tabId === state.ownerTabId) stopForOwner('tab-lost');
  };
  const ownerFocusChanged = (windowId: number) => {
    const state = controller.getState();
    if (activeState(state) && windowId !== state.ownerWindowId) stopForOwner('focus-lost');
  };
  api.tabs.onActivated.addListener(ownerActivated);
  api.tabs.onUpdated.addListener(ownerUpdated);
  api.tabs.onRemoved.addListener(ownerRemoved);
  windowsApi?.onFocusChanged?.addListener(ownerFocusChanged);

  const sidebarCommand = (
    message: Message,
    respond: (response: unknown) => void,
  ): boolean | void => {
    if (message.type === 'ANMERKO_JOURNEY_STATE') {
      respond(success(controller.getState()));
      return;
    }
    const reply = (operation: Promise<unknown>) => {
      operation.then(value => respond(success(value)), () => respond(failure()));
      return true;
    };
    if (message.type === 'ANMERKO_JOURNEY_START') {
      if (!validInteger(message.ownerTabId) || !validInteger(message.ownerWindowId)) {
        respond(failure());
        return;
      }
      const ownerTabId = message.ownerTabId;
      const ownerWindowId = message.ownerWindowId;
      return reply((async () => {
        await focusedOwnerTab(ownerTabId, ownerWindowId);
        await controller.start({ ownerTabId, ownerWindowId });
      })());
    }
    if (message.type === 'ANMERKO_JOURNEY_STOP') return reply(controller.stop('user'));
    if (message.type === 'ANMERKO_JOURNEY_DISCARD') return reply(controller.discard());
  };

  api.runtime.onMessage.addListener((rawMessage, sender, respond) => {
    if (sender.id !== api.runtime.id || !isRecord(rawMessage)) return;
    const message = rawMessage as Message;
    const fromSidebar = !sender.tab && sender.url === sidebarUrl;
    if (fromSidebar) return sidebarCommand(message, respond);
    const senderTabId = sender.tab?.id;
    if (!validInteger(senderTabId) || sender.frameId !== 0 || typeof sender.url !== 'string') return;
    try { normalizedUrl(sender.url); } catch { return; }
    const state = controller.getState();
    if (!activeState(state) || senderTabId !== state.ownerTabId || sender.tab?.windowId !== state.ownerWindowId) return;
    if (message.type === 'ANMERKO_JOURNEY_EVENTS' && isRecord(message.batch)
      && message.batch.sessionId === state.sessionId && message.batch.epoch === state.epoch) {
      controller.acceptBatch(message.batch, senderTabId);
      respond(success());
    } else if (message.type === 'ANMERKO_JOURNEY_STOP'
      && message.sessionId === state.sessionId && message.epoch === state.epoch) {
      const operation = controller.stop('user');
      operation.then(() => respond(success()), () => respond(failure()));
      return true;
    }
  });

  return {
    stopIfRecording() {
      if (!activeState(controller.getState())) return false;
      void controller.stop('user');
      return true;
    },
  };
}
