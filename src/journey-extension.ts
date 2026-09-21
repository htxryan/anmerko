import {
  createJourneyController,
  JourneyControllerError,
  type JourneyController,
  type JourneyControllerAdapter,
  type JourneyPageIdentity,
} from './journey-controller';
import type { JourneyDraftImage, JourneySession } from './journey-core';
import { stripUrlCredentials } from './journey-events';
import { normalizeJourneyPng, type NormalizedJourneyPng } from './journey-image';
import { JOURNEY_EVENTS_PORT_NAME } from './journey-messaging';
import { createJourneySessionStore, JourneySessionStorageError } from './journey-session';
import { extensionApi } from './platform';

export interface JourneyScreenshotService {
  capture(windowId: number): Promise<string>;
  waitMs(): number;
}

export interface JourneyExtensionBinding {
  ready: Promise<void>;
  handleToolbarClick(): Promise<boolean>;
  stopIfRecording(): boolean;
  openReviewIfAvailable(): boolean;
}

type Message = Record<string, unknown> & { type?: unknown };
type ActiveState = Extract<JourneySession, { phase: 'starting' | 'recording' }>;
type JourneyCommandErrorCode = 'busy' | 'owner-unavailable' | 'initial-capture-failed'
  | 'launch-expired' | 'permission-required' | 'session-storage-failed';
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
const RECORDING_DEADLINE_ALARM = 'anmerko-journey-recording-deadline';
const REVIEW_WARNING_ALARM = 'anmerko-journey-review-warning';
const REVIEW_EXPIRY_ALARM = 'anmerko-journey-review-expiry';
const JOURNEY_ALARMS = [RECORDING_DEADLINE_ALARM, REVIEW_WARNING_ALARM, REVIEW_EXPIRY_ALARM] as const;
const MAX_PENDING_WAKE_EVENTS = 16;
const MAX_CONCURRENT_NORMALIZATIONS = 1;
const MAX_QUEUED_NORMALIZATIONS = 1;
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
  else if (error instanceof JourneySessionStorageError) code = 'session-storage-failed';
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
  let recording: JourneyPageIdentity['recording'];
  if (value.recording !== undefined) {
    if (!isRecord(value.recording) || typeof value.recording.sessionId !== 'string'
      || !SAFE_ID.test(value.recording.sessionId) || !validInteger(value.recording.epoch, 1)) throw new Error(GENERIC_ERROR);
    recording = { sessionId: value.recording.sessionId, epoch: value.recording.epoch };
  }
  return {
    documentToken: value.documentToken,
    url: normalizedUrl(value.url),
    viewport: { width: value.viewport.width, height: value.viewport.height },
    scroll: { x: value.scroll.x, y: value.scroll.y },
    generation: value.generation,
    visible: value.visible,
    ...(recording ? { recording } : {}),
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
  const sessionStore = createJourneySessionStore({
    get: keys => api.storage.session.get(keys),
    set: items => api.storage.session.set(items),
    remove: keys => api.storage.session.remove(keys),
  });
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
  let ready: Promise<void>;
  let initializationError: unknown;
  let initialized = false;
  let routedEvents: Promise<void> = Promise.resolve();
  let stateWriteTail: Promise<void> = Promise.resolve();
  let latestStateWrite: Promise<void> = Promise.resolve();
  let stateWriteFailureVersion = 0;
  let lastStateWriteError: unknown;
  let handlingStorageFailure = false;
  const wakeQueueOverflowedTabs = new Set<number>();
  const connectedEventPorts = new Map<chrome.runtime.Port, { tabId: number; windowId: number }>();
  let latestCaptureId: string | undefined;
  let activeNormalizations = 0;
  let queuedNormalizations = 0;
  let normalizationTurn: Promise<void> = Promise.resolve();
  let releaseNormalizationTurn: () => void = () => {};
  type PendingWakeEvent = {
    type: 'navigation';
    details: { tabId: number; frameId: number; url: string; documentLifecycle?: string };
    kind: 'document' | 'same-document';
  } | {
    type: 'batch';
    tabId: number;
    run(): Promise<void>;
    discard(): void;
  };
  const pendingWakeEvents: PendingWakeEvent[] = [];

  const discardPendingWakeEvents = () => {
    wakeQueueOverflowedTabs.clear();
    for (const event of pendingWakeEvents.splice(0)) if (event.type === 'batch') event.discard();
  };

  const bufferWakeEvent = (event: PendingWakeEvent): boolean => {
    if (pendingWakeEvents.length >= MAX_PENDING_WAKE_EVENTS) {
      wakeQueueOverflowedTabs.add(event.type === 'navigation' ? event.details.tabId : event.tabId);
      if (event.type === 'batch') event.discard();
      return false;
    }
    pendingWakeEvents.push(event);
    return true;
  };
  const wakeEventsWaiting = () => wakeQueueOverflowedTabs.size > 0 || pendingWakeEvents.length > 0;

  const enqueueRoutedEvent = (operation: () => Promise<void> | void, runAfterInitializationError = false) => {
    routedEvents = routedEvents.then(async () => {
      await ready;
      if (!initializationError || runAfterInitializationError) {
        await operation();
        await latestStateWrite;
      }
    }).catch(() => {});
  };

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

  const hasJourneyGrant = async () => Boolean(api.permissions?.contains
    && await api.permissions.contains(REQUIRED_JOURNEY_PERMISSIONS));

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
    await focusedOwnerTab(tabId, snapshot.ownerWindowId, sanitizedUrl);
    if (!stillCurrent()) throw new Error(GENERIC_ERROR);
    const grantedBeforeInjection = await hasJourneyGrant();
    if (!stillCurrent() || !grantedBeforeInjection || !api.scripting?.executeScript) throw new Error(GENERIC_ERROR);
    await api.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      files: ['journey-observer.js'],
      injectImmediately: true,
    });
    if (!stillCurrent()) throw new Error(GENERIC_ERROR);
    const grantedAfterInjection = await hasJourneyGrant();
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
      const grantStillPresent = await hasJourneyGrant();
      if (!stillCurrent() || !grantStillPresent || identity.url !== sanitizedUrl) throw new Error(GENERIC_ERROR);
      return identity;
    }
    throw new Error(GENERIC_ERROR);
  };

  const normalizeBounded = async (rawPng: string, isCurrent: () => boolean): Promise<NormalizedJourneyPng> => {
    if (activeNormalizations >= MAX_CONCURRENT_NORMALIZATIONS) {
      if (queuedNormalizations >= MAX_QUEUED_NORMALIZATIONS) throw new Error(GENERIC_ERROR);
      queuedNormalizations += 1;
      try {
        while (activeNormalizations >= MAX_CONCURRENT_NORMALIZATIONS) {
          await normalizationTurn;
        }
      } finally {
        queuedNormalizations -= 1;
      }
    }
    activeNormalizations += 1;
    try {
      if (!isCurrent()) throw new Error(GENERIC_ERROR);
      return await normalizeJourneyPng(rawPng);
    } finally {
      activeNormalizations -= 1;
      const release = releaseNormalizationTurn;
      normalizationTurn = new Promise<void>(resolve => { releaseNormalizationTurn = resolve; });
      release();
    }
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
    latestCaptureId = captureId;
    const isLatest = () => latestCaptureId === captureId;
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
      if (!stillCurrent() || !isLatest()) throw new Error(GENERIC_ERROR);
      await focusedOwnerTab(tabId, windowId, expected.url);
      const prepared = pageIdentity(await pageCommand(tabId, {
        type: 'ANMERKO_JOURNEY_PAGE_PREPARE', captureId, documentToken: expected.documentToken,
      }));
      if (!prepared.visible || !sameIdentity(expected, prepared) || dirty || !stillCurrent() || !isLatest()) throw new Error(GENERIC_ERROR);
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
    if (dirty || !stillCurrent() || !isLatest() || !rawPng || !capturedAt || !capturedUrl || !finishedIdentity
      || !finishedIdentity.visible || !sameIdentity(expected, finishedIdentity)) throw new Error(GENERIC_ERROR);
    const image = await normalizeBounded(rawPng, () => stillCurrent() && isLatest());
    if (!stillCurrent() || !isLatest()) throw new Error(GENERIC_ERROR);
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

  const clearJourneyAlarms = async () => {
    await Promise.all(JOURNEY_ALARMS.map(name => api.alarms.clear(name).catch(() => false)));
  };

  const syncJourneyAlarms = async (state: JourneySession) => {
    await clearJourneyAlarms();
    try {
      if (state.phase === 'recording') {
        await api.alarms.create(RECORDING_DEADLINE_ALARM, { when: Date.parse(state.deadlineAt) });
      } else if (state.phase === 'reviewing') {
        await api.alarms.create(REVIEW_WARNING_ALARM, { when: Date.parse(state.warningAt) });
        await api.alarms.create(REVIEW_EXPIRY_ALARM, { when: Date.parse(state.expiresAt) });
      }
    } catch {
      throw new JourneySessionStorageError('storage-unavailable');
    }
  };

  const failClosedAfterStorageError = (failedState: JourneySession) => {
    if (!controller) return;
    const current = controller.getState();
    if ('sessionId' in failedState && (current.phase === 'reviewing' || current.phase === 'saving')
      && current.sessionId === failedState.sessionId && current.epoch === failedState.epoch) {
      const marked = {
        ...current,
        draft: { ...current.draft, stopReason: 'session-storage-limit' as const },
      };
      controller = makeController(marked);
      void api.action.setBadgeText({ tabId: marked.ownerTabId, text: '!' }).catch(() => {});
      void api.action.setTitle({ tabId: marked.ownerTabId, title: 'Journey storage failed — review draft now' }).catch(() => {});
      void api.runtime.sendMessage({ type: 'ANMERKO_JOURNEY_CHANGED' }).catch(() => {});
      return;
    }
    if (handlingStorageFailure || !activeState(failedState) || !activeState(current)
      || current.sessionId !== failedState.sessionId || current.epoch !== failedState.epoch) return;
    handlingStorageFailure = true;
    void controller.stop('session-storage-limit').finally(() => { handlingStorageFailure = false; });
  };

  const persistState = (state: JourneySession): Promise<void> => {
    const operation = stateWriteTail.then(async () => {
      await sessionStore.write(state);
      await syncJourneyAlarms(state);
    });
    stateWriteTail = operation.catch(error => {
      stateWriteFailureVersion += 1;
      lastStateWriteError = error;
      failClosedAfterStorageError(state);
    });
    latestStateWrite = operation;
    return operation;
  };

  const decorateForState = (state: JourneySession) => {
    const nextDecoratedTabId = activeState(state) ? state.ownerTabId : undefined;
    if (decoratedTabId !== nextDecoratedTabId) {
      if (decoratedTabId !== undefined) resetAction(decoratedTabId);
      if (nextDecoratedTabId !== undefined) showRecordingAction(nextDecoratedTabId);
      decoratedTabId = nextDecoratedTabId;
    }
  };

  const changed = (state: JourneySession) => {
    decorateForState(state);
    if (state.phase === 'recording') {
      void pageCommand(state.ownerTabId, {
        type: 'ANMERKO_JOURNEY_PAGE_STATUS', sessionId: state.sessionId,
        epoch: state.epoch, count: state.draft.steps.length,
      }).catch(() => {});
    }
    void persistState(state).catch(() => {});
    void api.runtime.sendMessage({ type: 'ANMERKO_JOURNEY_CHANGED' }).catch(() => {});
  };

  const stopStalePageRecorder = async (tabId: number, windowId: number): Promise<void> => {
    const state = controller.getState();
    if (activeState(state)) return;
    try {
      const tab = await api.tabs.get(tabId);
      if (tab.id !== tabId || tab.windowId !== windowId || !tab.url) return;
      const tabUrl = normalizedUrl(tab.url);
      const identity = pageIdentity(await pageCommand(tabId, { type: 'ANMERKO_JOURNEY_PAGE_IDENTIFY' }));
      if (identity.url !== tabUrl || !identity.recording) return;
      await pageCommand(tabId, {
        type: 'ANMERKO_JOURNEY_PAGE_STOP', sessionId: identity.recording.sessionId,
        epoch: identity.recording.epoch, documentToken: identity.documentToken,
      });
    } catch { /* An absent or replaced owner page has no recorder to reconcile. */ }
  };

  const beginPageRecording = async (tabId: number, input: Parameters<JourneyControllerAdapter['begin']>[1]) => {
    try {
      await pageCommand(tabId, { type: 'ANMERKO_JOURNEY_PAGE_START', ...input });
      return;
    } catch (startError) {
      try {
        const identity = pageIdentity(await pageCommand(tabId, { type: 'ANMERKO_JOURNEY_PAGE_IDENTIFY' }));
        if (!identity.recording || identity.documentToken !== input.documentToken || identity.url !== input.expectedUrl) throw startError;
        await pageCommand(tabId, {
          type: 'ANMERKO_JOURNEY_PAGE_STOP', sessionId: identity.recording.sessionId,
          epoch: identity.recording.epoch, documentToken: identity.documentToken,
        });
        await pageCommand(tabId, { type: 'ANMERKO_JOURNEY_PAGE_START', ...input });
      } catch {
        throw startError;
      }
    }
  };

  const makeController = (restored?: JourneySession) => createJourneyController({
      identify,
      connect,
      capture,
      async begin(tabId, input) {
        await beginPageRecording(tabId, input);
      },
      async end(tabId, input) {
        await pageCommand(tabId, { type: 'ANMERKO_JOURNEY_PAGE_STOP', ...input });
      },
      changed,
    }, restored);

  controller = makeController();

  const routeNavigationNow = (
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
  const routeNavigation = (
    details: { tabId: number; frameId: number; url: string; documentLifecycle?: string },
    kind: 'document' | 'same-document',
  ) => {
    if (!initialized) {
      const state = controller.getState();
      if (activeState(state) && (details.tabId !== state.ownerTabId || details.frameId !== 0)) return;
      bufferWakeEvent({ type: 'navigation', details: { ...details }, kind });
      return;
    }
    enqueueRoutedEvent(async () => {
      let granted = false;
      try { granted = await hasJourneyGrant(); } catch { /* Treat an unavailable permission check as revoked. */ }
      if (granted) routeNavigationNow(details, kind);
      else if (activeState(controller.getState())) await controller.stop('permission-revoked');
    });
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
    if (!await hasJourneyGrant() || !installNavigationListeners()) throw new JourneyCommandError('permission-required');
  };
  const journeyPermissionRemoved = (removed: chrome.permissions.Permissions) => {
    const affected = removed.permissions?.includes('webNavigation') || Boolean(removed.origins?.length);
    if (!affected) return;
    launchGeneration += 1;
    removeNavigationListeners();
    enqueueRoutedEvent(async () => {
      if (activeState(controller.getState())) await controller.stop('permission-revoked');
    });
  };
  api.permissions?.onRemoved?.addListener(journeyPermissionRemoved);

  const ownerActivated = (info: { tabId: number; windowId: number }) => {
    enqueueRoutedEvent(async () => {
      const state = controller.getState();
      if (activeState(state) && info.windowId === state.ownerWindowId && info.tabId !== state.ownerTabId) {
        await controller.stop('focus-lost');
      }
    });
  };
  const ownerUpdated = (tabId: number, change: { status?: string; url?: string }) => {
    enqueueRoutedEvent(async () => {
      const state = controller.getState();
      if (state.phase === 'starting' && tabId === state.ownerTabId && (change.status === 'loading' || typeof change.url === 'string')) {
        await controller.stop('capture-failed');
      } else if (state.phase === 'recording' && tabId === state.ownerTabId && typeof change.url === 'string') {
        try { normalizedUrl(change.url); }
        catch { await controller.stop('protected-page'); }
      }
    });
  };
  const ownerReplaced = (_addedTabId: number, removedTabId: number) => {
    enqueueRoutedEvent(async () => {
      const state = controller.getState();
      if (activeState(state) && removedTabId === state.ownerTabId) await controller.stop('tab-lost');
    });
  };
  const ownerRemoved = (tabId: number) => {
    if (tabId === reviewTabId) reviewTabId = undefined;
    for (const [id, intent] of launchIntents) if (intent.launchTabId === tabId) launchIntents.delete(id);
    enqueueRoutedEvent(async () => {
      const state = controller.getState();
      if (activeState(state) && tabId === state.ownerTabId) await controller.stop('tab-lost');
    });
  };
  const ownerFocusChanged = (windowId: number) => {
    enqueueRoutedEvent(async () => {
      const state = controller.getState();
      if (activeState(state) && windowId !== state.ownerWindowId) await controller.stop('focus-lost');
    });
  };
  api.tabs.onActivated.addListener(ownerActivated);
  api.tabs.onUpdated.addListener(ownerUpdated);
  api.tabs.onRemoved.addListener(ownerRemoved);
  api.tabs.onReplaced?.addListener(ownerReplaced);
  windowsApi?.onFocusChanged?.addListener(ownerFocusChanged);

  api.alarms.onAlarm.addListener(alarm => {
    if (!JOURNEY_ALARMS.includes(alarm.name as typeof JOURNEY_ALARMS[number])) return;
    enqueueRoutedEvent(async () => {
      const state = controller.getState();
      if (alarm.name === RECORDING_DEADLINE_ALARM && state.phase === 'recording'
        && Date.now() >= Date.parse(state.deadlineAt)) {
        await controller.stop('duration-limit');
      } else if (alarm.name === REVIEW_WARNING_ALARM && state.phase === 'reviewing'
        && Date.now() >= Date.parse(state.warningAt) && Date.now() < Date.parse(state.expiresAt)) {
        showReviewWarning(state);
      } else if (alarm.name === REVIEW_EXPIRY_ALARM && state.phase === 'reviewing'
        && Date.now() >= Date.parse(state.expiresAt)) {
        await controller.discard();
      }
    });
  });

  const recordingUrl = (state: Extract<JourneySession, { phase: 'recording' }>): string | undefined => {
    const step = state.draft.steps.at(-1);
    return step?.kind === 'navigation' ? step.navigation.toUrl : step?.sourceUrl;
  };

  const showReviewWarning = (state: Extract<JourneySession, { phase: 'reviewing' }>) => {
    void api.action.setBadgeText({ tabId: state.ownerTabId, text: '!' }).catch(() => {});
    void api.action.setTitle({ tabId: state.ownerTabId, title: 'Journey review expires soon' }).catch(() => {});
    void api.runtime.sendMessage({ type: 'ANMERKO_JOURNEY_CHANGED' }).catch(() => {});
  };

  const recoverRecordingOwner = async (): Promise<void> => {
    let state = controller.getState();
    if (state.phase !== 'recording') return;
    let granted = false;
    try { granted = await hasJourneyGrant(); } catch { /* Fail closed below. */ }
    if (!granted) {
      await controller.stop('permission-revoked');
      return;
    }

    const drainOwnerWakeEvents = async (): Promise<'document' | 'same-document' | undefined> => {
      let navigation: 'document' | 'same-document' | undefined;
      const pending = pendingWakeEvents.splice(0);
      for (const [index, event] of pending.entries()) {
        const current = controller.getState();
        if (current.phase !== 'recording') {
          for (const remaining of pending.slice(index)) if (remaining.type === 'batch') remaining.discard();
          return navigation;
        }
        if (event.type === 'batch') {
          await event.run();
          continue;
        }
        if (event.details.tabId !== current.ownerTabId || event.details.frameId !== 0
          || (event.details.documentLifecycle !== undefined && event.details.documentLifecycle !== 'active')) continue;
        routeNavigationNow(event.details, event.kind);
        if (event.kind === 'document') navigation = 'document';
        else navigation ??= 'same-document';
      }
      return navigation;
    };

    for (let attempt = 0; attempt <= MAX_PENDING_WAKE_EVENTS; attempt += 1) {
      if (wakeQueueOverflowedTabs.has(state.ownerTabId)) {
        discardPendingWakeEvents();
        await controller.stop('capture-failed');
        return;
      }
      wakeQueueOverflowedTabs.clear();
      const wakeNavigation = await drainOwnerWakeEvents();
      if (wakeQueueOverflowedTabs.has(state.ownerTabId)) continue;
      if (wakeNavigation === 'document') return;
      state = controller.getState();
      if (state.phase !== 'recording') return;

      let tab: chrome.tabs.Tab;
      try { tab = await api.tabs.get(state.ownerTabId); }
      catch {
        if (wakeEventsWaiting()) continue;
        await controller.stop('tab-lost');
        return;
      }
      if (wakeEventsWaiting()) continue;
      if (!validInteger(tab.windowId) || tab.windowId !== state.ownerWindowId) {
        await controller.stop('tab-lost');
        return;
      }
      if (!tab.active) {
        await controller.stop('focus-lost');
        return;
      }
      let tabUrl: string;
      try { tabUrl = normalizedUrl(tab.url); }
      catch {
        await controller.stop('protected-page');
        return;
      }
      const expectedUrl = recordingUrl(state);
      if (!expectedUrl || tabUrl !== expectedUrl) {
        if (wakeEventsWaiting()) continue;
        await controller.stop('capture-failed');
        return;
      }
      if (windowsApi?.get) {
        let focused = false;
        try { focused = Boolean((await windowsApi.get(state.ownerWindowId)).focused); } catch { /* Fail closed below. */ }
        if (wakeEventsWaiting()) continue;
        if (!focused) {
          await controller.stop('focus-lost');
          return;
        }
      }
      let identity: JourneyPageIdentity;
      try { identity = pageIdentity(await pageCommand(state.ownerTabId, { type: 'ANMERKO_JOURNEY_PAGE_IDENTIFY' })); }
      catch {
        if (wakeEventsWaiting()) continue;
        await controller.stop('capture-failed');
        return;
      }
      if (wakeEventsWaiting()) continue;
      const current = controller.getState();
      if (current.phase !== 'recording') return;
      if (!identity.visible || identity.documentToken !== current.documentToken || identity.url !== expectedUrl
        || identity.recording?.sessionId !== current.sessionId || identity.recording.epoch !== current.epoch) {
        await controller.stop(identity.visible ? 'capture-failed' : 'focus-lost');
        return;
      }
      try {
        await pageCommand(current.ownerTabId, {
          type: 'ANMERKO_JOURNEY_PAGE_START', sessionId: current.sessionId, epoch: current.epoch,
          documentToken: current.documentToken, startedAt: current.draft.startedAt,
          count: current.draft.steps.length, expectedUrl,
        });
      } catch {
        if (wakeEventsWaiting()) continue;
        await controller.stop('capture-failed');
        return;
      }
      if (wakeEventsWaiting()) continue;
      return;
    }
    await controller.stop('capture-failed');
  };

  const initialize = async () => {
    const restored = await sessionStore.read(Date.now());
    controller = makeController(restored);
    const state = controller.getState();
    decorateForState(state);
    if (JSON.stringify(state) !== JSON.stringify(restored)) await persistState(state);
    else await syncJourneyAlarms(state);
    if (state.phase === 'recording') {
      do { await recoverRecordingOwner(); }
      while (controller.getState().phase === 'recording' && wakeEventsWaiting());
    } else {
      discardPendingWakeEvents();
      if ('ownerTabId' in state) await stopStalePageRecorder(state.ownerTabId, state.ownerWindowId);
    }
    await latestStateWrite;
    const current = controller.getState();
    if (current.phase === 'reviewing' && Date.now() >= Date.parse(current.warningAt)) showReviewWarning(current);
    initialized = true;
    void api.runtime.sendMessage({ type: 'ANMERKO_JOURNEY_CHANGED' }).catch(() => {});
  };

  const resetFailedInitialization = async (): Promise<void> => {
    if (activeState(controller.getState())) await controller.stop('session-storage-limit').catch(() => {});
    const idle = { phase: 'idle', epoch: controller.getState().epoch } as const;
    await sessionStore.write(idle);
    await syncJourneyAlarms(idle);
    controller = makeController(idle);
    initializationError = undefined;
    discardPendingWakeEvents();
    decorateForState(idle);
    await Promise.all(Array.from(connectedEventPorts.values(), candidate => (
      stopStalePageRecorder(candidate.tabId, candidate.windowId)
    )));
    void api.runtime.sendMessage({ type: 'ANMERKO_JOURNEY_CHANGED' }).catch(() => {});
  };

  const reply = (
    operation: Promise<unknown>,
    respond: (response: unknown) => void,
  ) => {
    operation.then(value => respond(success(value)), error => respond(failure(error)));
    return true;
  };

  const withPersistedState = async (operation: Promise<void>): Promise<void> => {
    const failureVersion = stateWriteFailureVersion;
    await operation;
    let writeError: unknown;
    try { await latestStateWrite; } catch (error) { writeError = error; }
    if (stateWriteFailureVersion !== failureVersion) throw lastStateWriteError;
    if (writeError) throw writeError;
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

  const trustedCommand = async (message: Message, surface: TrustedSurface): Promise<unknown> => {
    if (message.type === 'ANMERKO_JOURNEY_STATE') {
      return controller.getState();
    }
    if (message.type === 'ANMERKO_JOURNEY_START') {
      if (surface.kind === 'launch') {
        const generation = launchGeneration;
        const intent = consumeLaunchIntent(surface, message.intent);
        if (!intent) throw new JourneyCommandError('launch-expired');
        await withPersistedState(startFallback(intent, generation));
        return;
      }
      if (surface.kind !== 'sidebar' || !validInteger(message.ownerTabId) || !validInteger(message.ownerWindowId)) {
        throw new JourneyCommandError('owner-unavailable');
      }
      const ownerTabId = message.ownerTabId;
      const ownerWindowId = message.ownerWindowId;
      const generation = launchGeneration;
      await withPersistedState((async () => {
        try { await focusedOwnerTab(ownerTabId, ownerWindowId); }
        catch { throw new JourneyCommandError('owner-unavailable'); }
        if (generation !== launchGeneration) return;
        await ensureJourneyGrant();
        if (generation !== launchGeneration) return;
        await controller.start({ ownerTabId, ownerWindowId, includeEnteredValues: false });
      })());
      return;
    }
    if (message.type === 'ANMERKO_JOURNEY_STOP') {
      launchGeneration += 1;
      if (!cancelLaunchIntent(surface, message.intent)) throw new JourneyCommandError('launch-expired');
      await withPersistedState(controller.stop('user'));
      return;
    }
    if (message.type === 'ANMERKO_JOURNEY_DISCARD') {
      launchGeneration += 1;
      await withPersistedState(controller.discard());
      return;
    }
    throw new Error(GENERIC_ERROR);
  };

  const disconnectPort = (port: chrome.runtime.Port) => {
    try { port.disconnect(); } catch { /* The sender may already have unloaded. */ }
  };

  api.runtime.onConnect.addListener(port => {
    if (port.name !== JOURNEY_EVENTS_PORT_NAME) return;
    const sender = port.sender;
    const senderTabId = sender?.tab?.id;
    const senderWindowId = sender?.tab?.windowId;
    let senderUrl: string | undefined;
    try { senderUrl = normalizedUrl(sender?.url); }
    catch { /* Invalid sender URLs are rejected below. */ }
    if (sender?.id !== api.runtime.id || sender.frameId !== 0 || !validInteger(senderTabId)
      || !validInteger(senderWindowId) || !senderUrl) {
      disconnectPort(port);
      return;
    }
    if (connectedEventPorts.size >= MAX_PENDING_WAKE_EVENTS) {
      disconnectPort(port);
      return;
    }
    connectedEventPorts.set(port, { tabId: senderTabId, windowId: senderWindowId });
    let queued = 0;
    const receive = (rawMessage: unknown) => {
      if (queued >= MAX_PENDING_WAKE_EVENTS) {
        disconnectPort(port);
        return;
      }
      queued += 1;
      let settled = false;
      const discard = () => {
        if (settled) return;
        settled = true;
        queued -= 1;
      };
      const run = async () => {
        try {
          const current = controller.getState();
          if (current.phase !== 'recording' || current.ownerTabId !== senderTabId
            || current.ownerWindowId !== senderWindowId) return;
          if (!isRecord(rawMessage) || rawMessage.type !== 'ANMERKO_JOURNEY_EVENTS' || !isRecord(rawMessage.batch)
            || rawMessage.batch.sessionId !== current.sessionId || rawMessage.batch.epoch !== current.epoch
            || rawMessage.batch.documentToken !== current.documentToken) return;
          let granted = false;
          try { granted = await hasJourneyGrant(); } catch { /* Fail closed below. */ }
          if (!granted) {
            await controller.stop('permission-revoked');
            return;
          }
          controller.acceptBatch(rawMessage.batch, senderTabId);
          await latestStateWrite;
        } catch { /* Malformed or stale page batches fail closed. */ }
        finally { discard(); }
      };
      if (!initialized) {
        if (!bufferWakeEvent({ type: 'batch', tabId: senderTabId, run, discard })) disconnectPort(port);
        return;
      }
      enqueueRoutedEvent(run);
    };
    const disconnected = () => {
      connectedEventPorts.delete(port);
      port.onMessage.removeListener(receive);
      port.onDisconnect.removeListener(disconnected);
    };
    port.onMessage.addListener(receive);
    port.onDisconnect.addListener(disconnected);
    enqueueRoutedEvent(async () => {
      const current = controller.getState();
      if (!activeState(current)) {
        await stopStalePageRecorder(senderTabId, senderWindowId);
        disconnectPort(port);
      } else if (current.ownerTabId !== senderTabId || current.ownerWindowId !== senderWindowId) {
        disconnectPort(port);
      }
    }, true);
  });

  api.runtime.onMessage.addListener((rawMessage, sender, respond) => {
    if (sender.id !== api.runtime.id || !isRecord(rawMessage)) return;
    const message = rawMessage as Message;
    const surface = trustedSurface(sender);
    if (surface && ['ANMERKO_JOURNEY_STATE', 'ANMERKO_JOURNEY_START', 'ANMERKO_JOURNEY_STOP', 'ANMERKO_JOURNEY_DISCARD'].includes(String(message.type))) {
      return reply((async () => {
        await ready;
        if (initializationError) {
          if (message.type !== 'ANMERKO_JOURNEY_DISCARD') throw initializationError;
          await resetFailedInitialization();
          return;
        }
        return trustedCommand(message, surface);
      })(), respond);
    }
    const senderTabId = sender.tab?.id;
    const senderWindowId = sender.tab?.windowId;
    if (!validInteger(senderTabId) || !validInteger(senderWindowId) || sender.frameId !== 0 || typeof sender.url !== 'string') return;
    let senderUrl: string;
    try { senderUrl = normalizedUrl(sender.url); } catch { return; }
    if (message.type === 'ANMERKO_JOURNEY_OPEN') {
      return reply((async () => {
        await ready;
        if (initializationError) throw initializationError;
        return openLaunch(senderTabId, senderWindowId, senderUrl);
      })(), respond);
    }
    if (message.type === 'ANMERKO_JOURNEY_STOP') {
      void (async () => {
        await ready;
        if (initializationError) {
          respond(failure(initializationError));
          return;
        }
        const state = controller.getState();
        if (!activeState(state) || senderTabId !== state.ownerTabId || senderWindowId !== state.ownerWindowId
          || message.sessionId !== state.sessionId || message.epoch !== state.epoch) {
          respond(undefined);
          return;
        }
        launchGeneration += 1;
        try {
          await withPersistedState(controller.stop('user'));
          respond(success());
        } catch (error) { respond(failure(error)); }
      })();
      return true;
    }
  });

  installNavigationListeners();
  ready = initialize().catch(async error => {
    initializationError = error;
    initialized = true;
    discardPendingWakeEvents();
    if (activeState(controller.getState())) await controller.stop('session-storage-limit');
    await clearJourneyAlarms();
  });

  return {
    ready,
    async handleToolbarClick() {
      await ready;
      if (initializationError) return false;
      if (activeState(controller.getState())) {
        const stopping = controller.stop('user');
        try { await withPersistedState(stopping); }
        catch { await openReview(); }
        return true;
      }
      const state = controller.getState();
      if (state.phase === 'reviewing' || state.phase === 'saving') {
        await openReview();
        return true;
      }
      return false;
    },
    stopIfRecording() {
      if (!initialized || initializationError) return false;
      if (!activeState(controller.getState())) return false;
      const stopping = controller.stop('user');
      void withPersistedState(stopping).catch(() => openReview().catch(() => {}));
      return true;
    },
    openReviewIfAvailable() {
      if (!initialized || initializationError) return false;
      const state = controller.getState();
      if (state.phase !== 'reviewing' && state.phase !== 'saving') return false;
      void openReview().catch(() => {});
      return true;
    },
  };
}
