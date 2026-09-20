import {
  createJourneyController,
  JourneyControllerError,
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
  openReviewIfAvailable(): boolean;
}

type Message = Record<string, unknown> & { type?: unknown };
type ActiveState = Extract<JourneySession, { phase: 'starting' | 'recording' }>;
type JourneyCommandErrorCode = 'busy' | 'owner-unavailable' | 'initial-capture-failed'
  | 'launch-expired' | 'permission-required';
type TrustedSurface =
  | { kind: 'sidebar' }
  | { kind: 'review'; tabId: number }
  | { kind: 'launch'; tabId: number; intent: string };

interface LaunchIntent {
  ownerTabId: number;
  ownerWindowId: number;
  documentToken: string;
  url: string;
  expiresAt: number;
  launchTabId?: number;
}

const GENERIC_ERROR = 'Journey command unavailable.';
const DEFAULT_ACTION_TITLE = 'Annotate with anmerko';
const RECORDING_ACTION_TITLE = 'Stop journey recording';
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/;
const LAUNCH_TTL_MS = 5 * 60 * 1_000;
const OBSERVER_CONNECT_TIMEOUT_MS = 5_000;
const OBSERVER_RETRY_MS = 50;
const REQUIRED_JOURNEY_PERMISSIONS: chrome.permissions.Permissions = {
  origins: ['<all_urls>'], permissions: ['webNavigation'],
};

function success<T>(value?: T): { ok: true; value?: T } {
  return value === undefined ? { ok: true } : { ok: true, value };
}

class JourneyCommandError extends Error {
  constructor(readonly code: JourneyCommandErrorCode) {
    super(GENERIC_ERROR);
    this.name = 'JourneyCommandError';
  }
}

function failure(error?: unknown) {
  let code: JourneyCommandErrorCode | undefined;
  if (error instanceof JourneyCommandError) code = error.code;
  else if (error instanceof JourneyControllerError) {
    code = error.code === 'invalid-start' ? 'owner-unavailable' : error.code;
  }
  return code
    ? { ok: false as const, error: GENERIC_ERROR, code }
    : { ok: false as const, error: GENERIC_ERROR };
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
  const journeyUrl = api.runtime.getURL('journey.html');
  const windowsApi = api.windows as typeof chrome.windows | undefined;
  const launchIntents = new Map<string, LaunchIntent>();
  let decoratedTabId: number | undefined;
  let launchGeneration = 0;
  let launchOpening = false;
  let reviewTabId: number | undefined;
  let reviewOpening: Promise<void> | undefined;
  let navigationApi: typeof chrome.webNavigation | undefined;
  let navigationListenersInstalled = false;
  let controller: JourneyController;

  const journeyLocation = (url: unknown): { kind: 'review' } | { kind: 'launch'; intent: string } | undefined => {
    if (url === journeyUrl) return { kind: 'review' };
    if (typeof url !== 'string') return;
    const prefix = `${journeyUrl}#launch=`;
    if (!url.startsWith(prefix)) return;
    const intent = url.slice(prefix.length);
    return SAFE_ID.test(intent) ? { kind: 'launch', intent } : undefined;
  };

  const trustedSurface = (sender: chrome.runtime.MessageSender): TrustedSurface | undefined => {
    if (!sender.tab && sender.url === sidebarUrl) return { kind: 'sidebar' };
    const tabId = sender.tab?.id;
    if (!validInteger(tabId) || sender.frameId !== 0) return;
    const location = journeyLocation(sender.url);
    if (!location) return;
    return location.kind === 'review'
      ? { kind: 'review', tabId }
      : { kind: 'launch', tabId, intent: location.intent };
  };

  const clearExpiredIntents = () => {
    const now = Date.now();
    for (const [id, intent] of launchIntents) if (intent.expiresAt <= now) launchIntents.delete(id);
  };

  const focusTab = async (tabId: number): Promise<void> => {
    const tab = await api.tabs.update(tabId, { active: true });
    if (!tab || !validInteger(tab.windowId)) throw new Error(GENERIC_ERROR);
    if (windowsApi?.update) await windowsApi.update(tab.windowId, { focused: true });
  };

  const openReview = async (): Promise<void> => {
    if (reviewOpening) return reviewOpening;
    reviewOpening = (async () => {
      if (reviewTabId !== undefined) {
        try {
          const existing = await api.tabs.get(reviewTabId);
          if (!journeyLocation(existing.url)) throw new Error(GENERIC_ERROR);
          await focusTab(reviewTabId);
          return;
        } catch {
          reviewTabId = undefined;
        }
      }
      const created = await api.tabs.create({ url: journeyUrl });
      if (!validInteger(created.id)) throw new Error(GENERIC_ERROR);
      reviewTabId = created.id;
    })();
    try { await reviewOpening; }
    finally { reviewOpening = undefined; }
  };

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

  const connect = async (tabId: number, expectedUrl: string): Promise<JourneyPageIdentity> => {
    const sanitizedUrl = normalizedUrl(expectedUrl);
    if (sanitizedUrl !== expectedUrl) throw new Error(GENERIC_ERROR);
    const snapshot = controller.getState();
    if (snapshot.phase !== 'recording' || snapshot.ownerTabId !== tabId) throw new Error(GENERIC_ERROR);
    const stillCurrent = () => {
      const current = controller.getState();
      return current.phase === 'recording' && current.sessionId === snapshot.sessionId
        && current.epoch === snapshot.epoch && current.ownerTabId === snapshot.ownerTabId
        && current.ownerWindowId === snapshot.ownerWindowId && current.documentToken === snapshot.documentToken;
    };
    const hasGrant = async () => Boolean(api.permissions?.contains
      && await api.permissions.contains(REQUIRED_JOURNEY_PERMISSIONS));

    await focusedOwnerTab(tabId, snapshot.ownerWindowId, sanitizedUrl);
    if (!stillCurrent()) throw new Error(GENERIC_ERROR);
    const grantedBeforeInjection = await hasGrant();
    if (!stillCurrent() || !grantedBeforeInjection || !api.scripting?.executeScript) throw new Error(GENERIC_ERROR);
    await api.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      files: ['journey-observer.js'],
      injectImmediately: true,
    });
    if (!stillCurrent()) throw new Error(GENERIC_ERROR);
    const grantedAfterInjection = await hasGrant();
    if (!stillCurrent() || !grantedAfterInjection) throw new Error(GENERIC_ERROR);
    await focusedOwnerTab(tabId, snapshot.ownerWindowId, sanitizedUrl);

    const expiresAt = Date.now() + OBSERVER_CONNECT_TIMEOUT_MS;
    while (stillCurrent() && Date.now() < expiresAt) {
      let response: unknown;
      try {
        response = await pageCommand(tabId, { type: 'ANMERKO_JOURNEY_PAGE_IDENTIFY' });
      } catch {
        await delay(OBSERVER_RETRY_MS);
        continue;
      }
      const identity = pageIdentity(response);
      await focusedOwnerTab(tabId, snapshot.ownerWindowId, sanitizedUrl);
      if (!stillCurrent()) throw new Error(GENERIC_ERROR);
      const grantStillPresent = await hasGrant();
      if (!stillCurrent() || !grantStillPresent || identity.url !== sanitizedUrl) throw new Error(GENERIC_ERROR);
      return identity;
    }
    throw new Error(GENERIC_ERROR);
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
    connect,
    capture,
    async begin(tabId, input) {
      await pageCommand(tabId, { type: 'ANMERKO_JOURNEY_PAGE_START', ...input });
    },
    async end(tabId, input) {
      await pageCommand(tabId, { type: 'ANMERKO_JOURNEY_PAGE_STOP', ...input });
    },
    changed,
  });

  const routeNavigation = (
    details: { tabId: number; frameId: number; url: string; documentLifecycle?: string },
    kind: 'document' | 'same-document',
  ) => {
    const state = controller.getState();
    if (!activeState(state) || details.tabId !== state.ownerTabId || details.frameId !== 0
      || (details.documentLifecycle !== undefined && details.documentLifecycle !== 'active')) return;
    let url: string;
    try { url = normalizedUrl(details.url); }
    catch {
      void controller.stop('protected-page');
      return;
    }
    controller.observeNavigation({ ownerTabId: details.tabId, url, kind });
  };
  const committed = (details: chrome.webNavigation.WebNavigationTransitionCallbackDetails) => {
    routeNavigation(details, 'document');
  };
  const historyUpdated = (details: chrome.webNavigation.WebNavigationTransitionCallbackDetails) => {
    routeNavigation(details, 'same-document');
  };
  const fragmentUpdated = (details: chrome.webNavigation.WebNavigationTransitionCallbackDetails) => {
    routeNavigation(details, 'same-document');
  };
  const installNavigationListeners = (): boolean => {
    if (navigationListenersInstalled) return true;
    const available = api.webNavigation;
    if (!available?.onCommitted || !available.onHistoryStateUpdated || !available.onReferenceFragmentUpdated) return false;
    available.onCommitted.addListener(committed);
    available.onHistoryStateUpdated.addListener(historyUpdated);
    available.onReferenceFragmentUpdated.addListener(fragmentUpdated);
    navigationApi = available;
    navigationListenersInstalled = true;
    return true;
  };
  const removeNavigationListeners = () => {
    if (!navigationListenersInstalled || !navigationApi) return;
    const installedApi = navigationApi;
    navigationApi = undefined;
    navigationListenersInstalled = false;
    try { installedApi.onCommitted.removeListener(committed); } catch { /* Permission removal can invalidate the API object. */ }
    try { installedApi.onHistoryStateUpdated.removeListener(historyUpdated); } catch { /* Best-effort listener cleanup. */ }
    try { installedApi.onReferenceFragmentUpdated.removeListener(fragmentUpdated); } catch { /* Best-effort listener cleanup. */ }
  };
  const ensureJourneyGrant = async (): Promise<void> => {
    if (!api.permissions?.contains
      || !await api.permissions.contains(REQUIRED_JOURNEY_PERMISSIONS)
      || !installNavigationListeners()) throw new JourneyCommandError('permission-required');
  };
  const journeyPermissionRemoved = (removed: chrome.permissions.Permissions) => {
    const affected = removed.permissions?.includes('webNavigation') || Boolean(removed.origins?.length);
    if (!affected) return;
    launchGeneration += 1;
    const stopping = activeState(controller.getState()) ? controller.stop('permission-revoked') : undefined;
    removeNavigationListeners();
    void stopping?.catch(() => {});
  };
  api.permissions?.onRemoved?.addListener(journeyPermissionRemoved);

  const stopForOwner = (reason: 'focus-lost' | 'tab-lost' | 'capture-failed') => {
    if (activeState(controller.getState())) void controller.stop(reason);
  };
  const ownerActivated = (info: { tabId: number; windowId: number }) => {
    const state = controller.getState();
    if (activeState(state) && info.windowId === state.ownerWindowId && info.tabId !== state.ownerTabId) stopForOwner('focus-lost');
  };
  const ownerUpdated = (tabId: number, change: { status?: string; url?: string }) => {
    const state = controller.getState();
    if (state.phase === 'starting' && tabId === state.ownerTabId && (change.status === 'loading' || typeof change.url === 'string')) {
      stopForOwner('capture-failed');
    } else if (state.phase === 'recording' && tabId === state.ownerTabId && typeof change.url === 'string') {
      try { normalizedUrl(change.url); }
      catch { void controller.stop('protected-page'); }
    }
  };
  const ownerReplaced = (_addedTabId: number, removedTabId: number) => {
    const state = controller.getState();
    if (activeState(state) && removedTabId === state.ownerTabId) stopForOwner('tab-lost');
  };
  const ownerRemoved = (tabId: number) => {
    if (tabId === reviewTabId) reviewTabId = undefined;
    for (const [id, intent] of launchIntents) if (intent.launchTabId === tabId) launchIntents.delete(id);
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
  api.tabs.onReplaced?.addListener(ownerReplaced);
  windowsApi?.onFocusChanged?.addListener(ownerFocusChanged);

  const reply = (
    operation: Promise<unknown>,
    respond: (response: unknown) => void,
  ) => {
    operation.then(value => respond(success(value)), error => respond(failure(error)));
    return true;
  };

  const openLaunch = async (senderTabId: number, senderWindowId: number, senderUrl: string): Promise<void> => {
    const state = controller.getState();
    if (state.phase !== 'idle') {
      if (!('ownerTabId' in state) || state.ownerTabId !== senderTabId || state.ownerWindowId !== senderWindowId) {
        throw new JourneyCommandError('owner-unavailable');
      }
      await openReview();
      return;
    }
    clearExpiredIntents();
    if (launchOpening || launchIntents.size > 0) throw new JourneyCommandError('busy');
    launchOpening = true;
    let intent: LaunchIntent | undefined;
    try {
      let identity: JourneyPageIdentity;
      try {
        await focusedOwnerTab(senderTabId, senderWindowId, senderUrl);
        identity = await identify(senderTabId);
      } catch {
        throw new JourneyCommandError('owner-unavailable');
      }
      if (!identity.visible || identity.url !== senderUrl || controller.getState().phase !== 'idle') {
        throw new JourneyCommandError('owner-unavailable');
      }
      const id = crypto.randomUUID();
      intent = {
        ownerTabId: senderTabId, ownerWindowId: senderWindowId,
        documentToken: identity.documentToken, url: identity.url,
        expiresAt: Date.now() + LAUNCH_TTL_MS,
      };
      launchIntents.set(id, intent);
      let created: chrome.tabs.Tab;
      try {
        created = await api.tabs.create({ url: `${journeyUrl}#launch=${id}` });
      } catch (error) {
        if (launchIntents.get(id) === intent) launchIntents.delete(id);
        throw error;
      }
      if (!validInteger(created.id) || launchIntents.get(id) !== intent) {
        if (validInteger(created.id)) await api.tabs.remove(created.id).catch(() => {});
        throw new Error(GENERIC_ERROR);
      }
      intent.launchTabId = created.id;
      reviewTabId = created.id;
    } finally {
      launchOpening = false;
    }
  };

  const consumeLaunchIntent = (surface: TrustedSurface, value: unknown): LaunchIntent | undefined => {
    clearExpiredIntents();
    if (surface.kind !== 'launch' || typeof value !== 'string'
      || value !== surface.intent || !SAFE_ID.test(value)) return;
    const intent = launchIntents.get(value);
    if (!intent || intent.launchTabId !== surface.tabId) return;
    launchIntents.delete(value);
    return intent;
  };

  const cancelLaunchIntent = (surface: TrustedSurface, value: unknown): boolean => {
    clearExpiredIntents();
    if (value === undefined) return true;
    if (surface.kind !== 'launch' || typeof value !== 'string'
      || value !== surface.intent || !SAFE_ID.test(value)) return false;
    const intent = launchIntents.get(value);
    if (intent) {
      if (intent.launchTabId !== undefined && intent.launchTabId !== surface.tabId) return false;
      launchIntents.delete(value);
    }
    return true;
  };

  const startFallback = async (intent: LaunchIntent, generation: number): Promise<void> => {
    await ensureJourneyGrant();
    if (generation !== launchGeneration) return;
    let identity: JourneyPageIdentity;
    try {
      const ownerTab = await api.tabs.update(intent.ownerTabId, { active: true });
      if (generation !== launchGeneration) return;
      if (!ownerTab || !validInteger(ownerTab.windowId)) throw new Error(GENERIC_ERROR);
      if (windowsApi?.update) await windowsApi.update(ownerTab.windowId, { focused: true });
      if (generation !== launchGeneration) return;
      const owner = await focusedOwnerTab(intent.ownerTabId, intent.ownerWindowId, intent.url);
      if (generation !== launchGeneration) return;
      identity = await identify(intent.ownerTabId);
      if (generation !== launchGeneration) return;
      if (!identity.visible || identity.documentToken !== intent.documentToken
        || identity.url !== intent.url || owner.url !== intent.url) throw new Error(GENERIC_ERROR);
    } catch {
      throw new JourneyCommandError('owner-unavailable');
    }
    await controller.start({ ownerTabId: intent.ownerTabId, ownerWindowId: intent.ownerWindowId, includeEnteredValues: false });
  };

  const trustedCommand = (
    message: Message,
    surface: TrustedSurface,
    respond: (response: unknown) => void,
  ): boolean | void => {
    if (message.type === 'ANMERKO_JOURNEY_STATE') {
      respond(success(controller.getState()));
      return;
    }
    if (message.type === 'ANMERKO_JOURNEY_START') {
      if (surface.kind === 'launch') {
        const generation = launchGeneration;
        const intent = consumeLaunchIntent(surface, message.intent);
        if (!intent) {
          respond(failure(new JourneyCommandError('launch-expired')));
          return;
        }
        return reply(startFallback(intent, generation), respond);
      }
      if (surface.kind !== 'sidebar' || !validInteger(message.ownerTabId) || !validInteger(message.ownerWindowId)) {
        respond(failure(new JourneyCommandError('owner-unavailable')));
        return;
      }
      const ownerTabId = message.ownerTabId;
      const ownerWindowId = message.ownerWindowId;
      const generation = launchGeneration;
      return reply((async () => {
        try { await focusedOwnerTab(ownerTabId, ownerWindowId); }
        catch { throw new JourneyCommandError('owner-unavailable'); }
        if (generation !== launchGeneration) return;
        await ensureJourneyGrant();
        if (generation !== launchGeneration) return;
        await controller.start({ ownerTabId, ownerWindowId, includeEnteredValues: false });
      })(), respond);
    }
    if (message.type === 'ANMERKO_JOURNEY_STOP') {
      launchGeneration += 1;
      if (!cancelLaunchIntent(surface, message.intent)) {
        respond(failure(new JourneyCommandError('launch-expired')));
        return;
      }
      return reply(controller.stop('user'), respond);
    }
    if (message.type === 'ANMERKO_JOURNEY_DISCARD') {
      launchGeneration += 1;
      return reply(controller.discard(), respond);
    }
  };

  api.runtime.onMessage.addListener((rawMessage, sender, respond) => {
    if (sender.id !== api.runtime.id || !isRecord(rawMessage)) return;
    const message = rawMessage as Message;
    const surface = trustedSurface(sender);
    if (surface) return trustedCommand(message, surface, respond);
    const senderTabId = sender.tab?.id;
    const senderWindowId = sender.tab?.windowId;
    if (!validInteger(senderTabId) || !validInteger(senderWindowId) || sender.frameId !== 0 || typeof sender.url !== 'string') return;
    let senderUrl: string;
    try { senderUrl = normalizedUrl(sender.url); } catch { return; }
    if (message.type === 'ANMERKO_JOURNEY_OPEN') {
      return reply(openLaunch(senderTabId, senderWindowId, senderUrl), respond);
    }
    const state = controller.getState();
    if (!activeState(state) || senderTabId !== state.ownerTabId || sender.tab?.windowId !== state.ownerWindowId) return;
    if (message.type === 'ANMERKO_JOURNEY_EVENTS' && isRecord(message.batch)
      && message.batch.sessionId === state.sessionId && message.batch.epoch === state.epoch) {
      controller.acceptBatch(message.batch, senderTabId);
      respond(success());
    } else if (message.type === 'ANMERKO_JOURNEY_STOP'
      && message.sessionId === state.sessionId && message.epoch === state.epoch) {
      launchGeneration += 1;
      const operation = controller.stop('user');
      return reply(operation, respond);
    }
  });

  return {
    stopIfRecording() {
      if (!activeState(controller.getState())) return false;
      void controller.stop('user');
      return true;
    },
    openReviewIfAvailable() {
      const state = controller.getState();
      if (state.phase !== 'reviewing' && state.phase !== 'saving') return false;
      void openReview().catch(() => {});
      return true;
    },
  };
}
