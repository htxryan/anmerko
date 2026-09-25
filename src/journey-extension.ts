import {
  createJourneyController,
  JourneyControllerError,
  journeyStartable,
  type JourneyController,
  type JourneyControllerAdapter,
  type JourneyPageIdentity,
} from './journey-controller';
import { markJourneyReviewStorageFailure, type JourneyDraftImage, type JourneySession } from './journey-core';
import { stripUrlCredentials } from './journey-events';
import { inspectNormalizedJourneyPng, normalizeJourneyPng, type NormalizedJourneyPng } from './journey-image';
import type { StopReason } from './journey-limits';
import { JOURNEY_EVENTS_PORT_NAME } from './journey-messaging';
import { createJourneySessionStore, JourneySessionStorageError } from './journey-session';
import { deleteJourneySnapshot, JourneyStoreError, listJourneySnapshots, openJourneySnapshot, saveJourneySnapshot } from './journey-store';
import { extensionApi, firefoxExtension } from './platform';

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
  | 'launch-expired' | 'session-storage-failed' | 'stale-review' | 'saved-journeys-full';
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
const WEB_DOCUMENTS = { url: [{ schemes: ['http', 'https'] }] };
const LISTENER_HINT_KEY = 'anmerko:journey-listeners:v1';
// The session whose review belongs in a journey tab: one started from a launch
// tab, which is how a floating panel or Android starts a journey. A worker can
// restart while it records, so this outlives the background's memory.
const TAB_REVIEW_KEY = 'anmerko:journey-tab-review:v1';
// Firefox unloads an event page after 30 idle seconds; any API call restarts that count.
const KEEP_AWAKE_INTERVAL_MS = 10_000;
const MAX_CONCURRENT_NORMALIZATIONS = 1;
const MAX_QUEUED_NORMALIZATIONS = 1;
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
  else if (error instanceof JourneyStoreError && error.code === 'quota-exceeded') code = 'saved-journeys-full';
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

interface ListenerHint {
  // Whether the last journey phase needed the live-journey listeners, when known.
  live?: boolean;
  remember(live: boolean): void;
}

// Firefox wakes an unloaded event page only for the listeners it registered
// while starting, and keeps waking it for them until a later start omits
// them: removing a listener afterwards does not stop the wakes, and adding one
// afterwards does not start them. Only Firefox has runtime.getBrowserInfo, and
// its event page has synchronous localStorage, so every journey phase leaves a
// hint there for the next start. A Chromium worker needs none.
function firefoxListenerHint(runtime: typeof chrome.runtime): ListenerHint | undefined {
  if (typeof (runtime as { getBrowserInfo?: unknown }).getBrowserInfo !== 'function') return;
  let storage: Storage | undefined;
  try { storage = globalThis.localStorage; } catch { /* Treated as unavailable below. */ }
  if (!storage) return;
  const hints = storage;
  let stored: string | null = null;
  try { stored = hints.getItem(LISTENER_HINT_KEY); } catch { /* An unknown hint registers every listener. */ }
  const hint: ListenerHint = {
    live: stored === 'live' ? true : stored === 'idle' ? false : undefined,
    remember(live) {
      if (live === hint.live) return;
      hint.live = live;
      try { hints.setItem(LISTENER_HINT_KEY, live ? 'live' : 'idle'); }
      catch {
        hint.live = undefined;
        try { hints.removeItem(LISTENER_HINT_KEY); } catch { /* The next start reads the stale hint. */ }
      }
    },
  };
  return hint;
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
  let reviewWarningTabId: number | undefined;
  let launchGeneration = 0;
  let launchOpening: Promise<void> | undefined;
  let reviewTabId: number | undefined;
  let tabReviewSession: string | undefined;
  let startingFromLaunch = false;
  let publishedState: JourneySession = { phase: 'idle', epoch: 0 };
  let reviewOpening: Promise<void> | undefined;
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
  // A save never starts while a screenshot review is still decoding its
  // mask: it would store the pixels the mask is about to cover and report
  // success. The reverse needs no count: a save holds the review in its
  // saving phase, which refuses every review edit as stale.
  let imageReviewsInFlight = 0;
  let normalizationTurn: Promise<void> = Promise.resolve();
  let releaseNormalizationTurn: () => void = () => {};
  type NavigationDetails = { tabId: number; frameId: number; url: string; documentLifecycle?: string; timeStamp?: number };
  type PendingWakeEvent = {
    type: 'navigation';
    details: NavigationDetails;
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
  // Only events routing could act on wait for initialization: top-frame
  // navigations and batches of any tab until the persisted journey is read,
  // then only its owner's. Subframe commits alone would otherwise fill the
  // buffer and stop a journey that nothing had disturbed.
  let persistedStateRead = false;
  const wakeEventRelevant = (tabId: number, frameId = 0, documentLifecycle?: string): boolean => {
    if (frameId !== 0 || (documentLifecycle !== undefined && documentLifecycle !== 'active')) return false;
    if (!persistedStateRead) return true;
    const state = controller.getState();
    return activeState(state) && tabId === state.ownerTabId;
  };

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

  // Open journey tabs, or the one in tabId. Chromium hides the URL of the
  // extension's own pages from tabs.get and tabs.query without the tabs
  // permission and reports them through runtime.getContexts; Firefox shows it.
  const journeyTabs = async (tabId?: number): Promise<Array<{ tabId: number; windowId: number; url: string }>> => {
    const runtime = api.runtime as typeof chrome.runtime & { getContexts?: typeof chrome.runtime.getContexts };
    if (typeof runtime.getContexts === 'function') {
      try {
        const contexts = await runtime.getContexts({ contextTypes: ['TAB'], ...(tabId === undefined ? {} : { tabIds: [tabId] }) });
        const found = contexts.flatMap(context => validInteger(context.tabId) && validInteger(context.windowId)
          && context.frameId === 0 && journeyLocation(context.documentUrl)
          ? [{ tabId: context.tabId, windowId: context.windowId, url: context.documentUrl as string }] : []);
        if (found.length > 0) return found;
      } catch { /* The tabs below still show Firefox's URLs. */ }
    }
    try {
      const tabs = tabId === undefined ? await api.tabs.query({}) : [await api.tabs.get(tabId)];
      return tabs.flatMap(tab => validInteger(tab.id) && validInteger(tab.windowId) && journeyLocation(tab.url)
        ? [{ tabId: tab.id, windowId: tab.windowId, url: tab.url as string }] : []);
    } catch {
      return [];
    }
  };

  // A launch tab stays open while its journey records and becomes that
  // journey's review, so an open journey tab comes forward before a new one
  // opens: the one this background opened, then one in the owner's window.
  const openReview = async (): Promise<void> => {
    if (reviewOpening) return reviewOpening;
    reviewOpening = (async () => {
      const known = reviewTabId === undefined ? [] : await journeyTabs(reviewTabId);
      const candidates = known.length > 0 ? known : await journeyTabs();
      const state = controller.getState();
      const ownerWindowId = 'ownerWindowId' in state ? state.ownerWindowId : undefined;
      candidates.sort((first, second) => Number(second.windowId === ownerWindowId) - Number(first.windowId === ownerWindowId));
      for (const candidate of candidates) {
        try {
          await focusTab(candidate.tabId);
          reviewTabId = candidate.tabId;
          return;
        } catch { /* Try the next journey tab, then open one. */ }
      }
      reviewTabId = undefined;
      const created = await api.tabs.create({ url: journeyUrl });
      if (!validInteger(created.id)) throw new Error(GENERIC_ERROR);
      reviewTabId = created.id;
    })();
    try { await reviewOpening; }
    finally { reviewOpening = undefined; }
  };

  const rememberTabReview = (sessionId: string | undefined) => {
    if (sessionId === tabReviewSession) return;
    tabReviewSession = sessionId;
    void (sessionId === undefined ? api.storage.session.remove([TAB_REVIEW_KEY])
      : api.storage.session.set({ [TAB_REVIEW_KEY]: sessionId })).catch(() => {});
  };

  // Switching to anmerko's own journey tab is how a floating-panel reader
  // reaches its Stop journey, so that stop is theirs. Any other tab, window,
  // or app is focus-lost.
  const focusLossReason = async (tabId: number | undefined): Promise<StopReason> => (
    validInteger(tabId) && (await journeyTabs(tabId)).length > 0 ? 'user' : 'focus-lost'
  );
  const activeTabIn = async (windowId: number): Promise<number | undefined> => {
    if (!validInteger(windowId) || typeof api.tabs.query !== 'function') return;
    try { return (await api.tabs.query({ active: true, windowId })).find(tab => validInteger(tab.id))?.id; }
    catch { return; }
  };
  const windowFocused = async (windowId: number): Promise<boolean> => {
    if (!windowsApi?.get) return true;
    try { return Boolean((await windowsApi.get(windowId)).focused); }
    catch { return false; }
  };
  // Where focus went once the owner tab lost it, read from the browser rather
  // than from an event that may still be queued: the tab now shown in the
  // owner's window, as ownerActivated would see it, or else, with that window
  // unfocused, whether a journey tab is active in the window that has focus.
  // Undefined while the owner tab is still shown in a focused window.
  const ownerFocusLoss = async (ownerTabId: number): Promise<'user' | 'focus-lost' | undefined> => {
    const state = controller.getState();
    if (!activeState(state) || state.ownerTabId !== ownerTabId) return;
    const shown = await activeTabIn(state.ownerWindowId);
    if (validInteger(shown) && shown !== ownerTabId) return await focusLossReason(shown) === 'user' ? 'user' : 'focus-lost';
    if (await windowFocused(state.ownerWindowId)) return;
    for (const candidate of await journeyTabs()) {
      if (candidate.windowId === state.ownerWindowId) continue;
      try {
        const tab = await api.tabs.get(candidate.tabId);
        if (tab.active && tab.windowId === candidate.windowId && await windowFocused(candidate.windowId)) return 'user';
      } catch { /* A journey tab that closed holds no focus. */ }
    }
    return 'focus-lost';
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

  // Firefox ties activeTab to the document it was granted on: after any
  // document load in the owner tab, even on the same origin, the tab URL is
  // hidden and injection is refused. Chrome and Edge keep same-origin access.
  const pageAccessLost = async (tabId: number): Promise<boolean> => {
    const state = controller.getState();
    if (!activeState(state) || state.ownerTabId !== tabId) return false;
    try {
      const tab = await api.tabs.get(tabId);
      return tab.id === tabId && tab.windowId === state.ownerWindowId && tab.url === undefined;
    } catch {
      return false;
    }
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
    // activeTab covers the journey's origin; injection failing here means the
    // page became protected or, in Firefox, the grant ended with the previous
    // document. The controller stops the journey with an explicit reason.
    if (!api.scripting?.executeScript) throw new Error(GENERIC_ERROR);
    await api.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      files: ['journey-observer.js'],
      injectImmediately: true,
    });
    if (!stillCurrent()) throw new Error(GENERIC_ERROR);
    await focusedOwnerTab(tabId, snapshot.ownerWindowId, sanitizedUrl);

    const expiresAt = Date.now() + OBSERVER_CONNECT_TIMEOUT_MS;
    while (stillCurrent() && Date.now() < expiresAt) {
      let response: unknown;
      try {
        response = await pageCommand(tabId, { type: 'ANMERKO_JOURNEY_PAGE_IDENTIFY' });
      } catch {
        // A withdrawn grant never returns; fail now rather than at the timeout.
        if (await pageAccessLost(tabId)) throw new Error(GENERIC_ERROR);
        await delay(OBSERVER_RETRY_MS);
        continue;
      }
      const identity = pageIdentity(response);
      await focusedOwnerTab(tabId, snapshot.ownerWindowId, sanitizedUrl);
      if (!stillCurrent()) throw new Error(GENERIC_ERROR);
      if (identity.url !== sanitizedUrl) throw new Error(GENERIC_ERROR);
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

  // Review surfaces are trusted, but their replacement PNG is not: every
  // dimension comes from its bytes, and the capture normalizer re-encodes it.
  const reviewedReplacement = async (dataUrl: string, isCurrent: () => boolean): Promise<NormalizedJourneyPng> => {
    let inspected: Pick<NormalizedJourneyPng, 'width' | 'height'>;
    try { inspected = inspectNormalizedJourneyPng(dataUrl); }
    catch { throw new Error(GENERIC_ERROR); }
    const image = await normalizeBounded(dataUrl, isCurrent);
    if (image.width !== inspected.width || image.height !== inspected.height) throw new Error(GENERIC_ERROR);
    return image;
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
      // Recording had already finished, and the draft in memory still holds
      // every step and edit; only the stored copy is behind. The storage stop
      // reason makes review urge an immediate save, and its limitation says
      // the original reason was replaced while no recorded step was lost. A
      // draft with no room for that limitation keeps its reason; the toolbar
      // still warns.
      const marked = markJourneyReviewStorageFailure(current);
      controller = makeController(marked);
      publishedState = marked;
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
    const previous = publishedState;
    publishedState = state;
    decorateForState(state);
    // A review edit restarts the idle window, so an expiry warning no longer
    // applies; nor does it once the review is saved or discarded.
    if (reviewWarningTabId !== undefined && (state.phase === 'idle' || state.phase === 'saved'
      || (state.phase === 'reviewing' && Date.now() < Date.parse(state.warningAt)))) {
      if (reviewWarningTabId !== decoratedTabId) resetAction(reviewWarningTabId);
      reviewWarningTabId = undefined;
    }
    if (state.phase === 'starting') rememberTabReview(startingFromLaunch ? state.sessionId : undefined);
    // Once the review ends, no tab holds it.
    else if (state.phase === 'idle' || state.phase === 'saved') rememberTabReview(undefined);
    // A journey started from a launch tab has no native side panel showing
    // it, so its end brings that tab forward as the review, unless the reader
    // deliberately went elsewhere.
    if (state.phase === 'reviewing' && activeState(previous) && previous.sessionId === state.sessionId
      && state.sessionId === tabReviewSession && state.draft.stopReason !== 'focus-lost') {
      void openReview().catch(() => {});
    }
    if (state.phase === 'recording') {
      void pageCommand(state.ownerTabId, {
        type: 'ANMERKO_JOURNEY_PAGE_STATUS', sessionId: state.sessionId,
        epoch: state.epoch, count: state.draft.steps.length,
      }).catch(() => {});
    }
    void persistState(state).catch(() => {});
    syncListeners();
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

  const makeController = (restored?: JourneySession): JourneyController => {
    const created = createJourneyController({
      identify,
      connect,
      capture,
      async begin(tabId, input) {
        await beginPageRecording(tabId, input);
      },
      async end(tabId, input) {
        await pageCommand(tabId, { type: 'ANMERKO_JOURNEY_PAGE_STOP', ...input });
      },
      pageAccessLost,
      focusLost: ownerFocusLoss,
      // A controller replaced after a storage failure may still finish work it
      // began, such as a save. Its late state must not overwrite the
      // replacement in storage, alarms, the toolbar, or open surfaces.
      changed: state => { if (controller === created) changed(state); },
      async saveSnapshot(input) {
        return saveJourneySnapshot(input);
      },
    }, restored);
    return created;
  };

  controller = makeController();

  const routeNavigationNow = (details: NavigationDetails, kind: 'document' | 'same-document') => {
    const state = controller.getState();
    if (!activeState(state) || details.tabId !== state.ownerTabId || details.frameId !== 0
      || (details.documentLifecycle !== undefined && details.documentLifecycle !== 'active')) return;
    let url: string;
    try { url = normalizedUrl(details.url); }
    catch {
      void controller.stop('protected-page');
      return;
    }
    controller.observeNavigation({ ownerTabId: details.tabId, url, kind, timeStamp: details.timeStamp });
  };
  const routeNavigation = (details: NavigationDetails, kind: 'document' | 'same-document') => {
    if (!initialized) {
      if (wakeEventRelevant(details.tabId, details.frameId, details.documentLifecycle)) {
        bufferWakeEvent({ type: 'navigation', details: { ...details }, kind });
      }
      return;
    }
    enqueueRoutedEvent(async () => { routeNavigationNow(details, kind); });
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
  const navigationApi = () => {
    const available = api.webNavigation;
    return available?.onCommitted && available.onHistoryStateUpdated && available.onReferenceFragmentUpdated
      ? available : undefined;
  };
  const ensureJourneySupport = (): void => {
    if (!navigationApi()) throw new Error(GENERIC_ERROR);
  };

  const stillActive = (state: ActiveState) => {
    const current = controller.getState();
    return activeState(current) && current.sessionId === state.sessionId;
  };
  const ownerActivated = (info: { tabId: number; windowId: number }) => {
    enqueueRoutedEvent(async () => {
      const state = controller.getState();
      if (activeState(state) && info.windowId === state.ownerWindowId && info.tabId !== state.ownerTabId) {
        const reason = await focusLossReason(info.tabId);
        if (stillActive(state)) await controller.stop(reason);
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
    syncListeners();
    enqueueRoutedEvent(async () => {
      const state = controller.getState();
      if (activeState(state) && tabId === state.ownerTabId) await controller.stop('tab-lost');
    });
  };
  const ownerFocusChanged = (windowId: number) => {
    enqueueRoutedEvent(async () => {
      const state = controller.getState();
      if (!activeState(state) || windowId === state.ownerWindowId) return;
      const reason = await focusLossReason(await activeTabIn(windowId));
      if (stillActive(state)) await controller.stop(reason);
    });
  };
  const alarmFired = (alarm: chrome.alarms.Alarm) => {
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
  };

  // Each navigation and tab listener wakes an idle service worker or event
  // page for its event in every tab, so each stays registered only while a
  // journey phase needs it. A Chromium worker registers all of them
  // synchronously at startup, so the event that woke it for a live journey
  // still reaches it, and removes each once the restored state shows nothing
  // needs it. A Firefox start registers them only when its hint says the last
  // phase was live, or is unknown; the next start after a journey drops them.
  const listenerHint = firefoxListenerHint(api.runtime);
  const liveListenersAtStartup = listenerHint?.live ?? true;
  let navigationEvents: typeof chrome.webNavigation | undefined;
  let watchingOwner = false;
  let watchingRemovals = false;
  let keepAwakeTimer: ReturnType<typeof setInterval> | undefined;
  const watchNavigation = (wanted: boolean) => {
    if (wanted && !navigationEvents) {
      const available = navigationApi();
      if (!available) return;
      // Same-document updates only matter on the journey's HTTP(S) document.
      // Commits stay unfiltered: an owner tab that opens a browser page must
      // still stop the journey as protected-page.
      available.onCommitted.addListener(committed);
      available.onHistoryStateUpdated.addListener(historyUpdated, WEB_DOCUMENTS);
      available.onReferenceFragmentUpdated.addListener(fragmentUpdated, WEB_DOCUMENTS);
      navigationEvents = available;
    } else if (!wanted && navigationEvents) {
      navigationEvents.onCommitted.removeListener(committed);
      navigationEvents.onHistoryStateUpdated.removeListener(historyUpdated);
      navigationEvents.onReferenceFragmentUpdated.removeListener(fragmentUpdated);
      navigationEvents = undefined;
    }
  };
  const watchOwner = (wanted: boolean) => {
    if (wanted === watchingOwner) return;
    watchingOwner = wanted;
    if (wanted) {
      api.tabs.onActivated.addListener(ownerActivated);
      api.tabs.onUpdated.addListener(ownerUpdated);
      api.tabs.onReplaced?.addListener(ownerReplaced);
      windowsApi?.onFocusChanged?.addListener(ownerFocusChanged);
    } else {
      api.tabs.onActivated.removeListener(ownerActivated);
      api.tabs.onUpdated.removeListener(ownerUpdated);
      api.tabs.onReplaced?.removeListener(ownerReplaced);
      windowsApi?.onFocusChanged?.removeListener(ownerFocusChanged);
    }
  };
  const watchRemovals = (wanted: boolean) => {
    if (wanted === watchingRemovals) return;
    watchingRemovals = wanted;
    if (wanted) api.tabs.onRemoved.addListener(ownerRemoved);
    else api.tabs.onRemoved.removeListener(ownerRemoved);
  };
  // Listeners a Firefox event page adds after starting never wake it once
  // unloaded, so a journey that went live after a start without them keeps
  // the page from idling until it ends. Recording lasts five minutes at most.
  const keepAwake = (wanted: boolean) => {
    if (wanted && keepAwakeTimer === undefined) {
      keepAwakeTimer = setInterval(() => { void api.runtime.getPlatformInfo().catch(() => {}); }, KEEP_AWAKE_INTERVAL_MS);
    } else if (!wanted && keepAwakeTimer !== undefined) {
      clearInterval(keepAwakeTimer);
      keepAwakeTimer = undefined;
    }
  };
  // Owner and navigation events matter only while a journey starts or
  // records. A pending launch tab also needs its closing seen, or the unused
  // intent would refuse Record journey until it expires; the intent lives
  // only in memory, so that listener never needs to wake the background. A
  // review tab that closes unseen is replaced on demand.
  const syncListeners = () => {
    if (!initialized) return;
    const live = !initializationError && activeState(controller.getState());
    watchNavigation(live);
    watchOwner(live);
    watchRemovals(live || launchIntents.size > 0);
    listenerHint?.remember(live);
    keepAwake(live && !!listenerHint && !liveListenersAtStartup);
  };
  watchNavigation(liveListenersAtStartup);
  watchOwner(liveListenersAtStartup);
  watchRemovals(liveListenersAtStartup);
  // Alarms fire only for the recording deadline and review expiry, which
  // journeys schedule and clear themselves, so this listener never wakes an
  // idle background. It stays registered from startup for every phase, which
  // also lets a Firefox review started after a start expire on time.
  api.alarms.onAlarm.addListener(alarmFired);

  const recordingUrl = (state: Extract<JourneySession, { phase: 'recording' }>): string | undefined => {
    const step = state.draft.steps.at(-1);
    return step?.kind === 'navigation' ? step.navigation.toUrl : step?.sourceUrl;
  };

  const showReviewWarning = (state: Extract<JourneySession, { phase: 'reviewing' }>) => {
    reviewWarningTabId = state.ownerTabId;
    void api.action.setBadgeText({ tabId: state.ownerTabId, text: '!' }).catch(() => {});
    void api.action.setTitle({ tabId: state.ownerTabId, title: 'Journey review expires soon' }).catch(() => {});
    void api.runtime.sendMessage({ type: 'ANMERKO_JOURNEY_CHANGED' }).catch(() => {});
  };

  // The owner tab URL is hidden once activeTab no longer covers the tab. A
  // queued navigation that explains it has already stopped the journey with
  // its exact reason (left-site for another origin, or page-access-lost from
  // the failed new-document handshake), so this answers only for a document
  // change that no queued event describes. Chromium keeps the grant across
  // same-origin documents, so the tab left the starting origin: that is
  // left-site, although a browser-protected page hides its URL the same way.
  // Firefox withdraws the grant on every document load, so page-access-lost
  // is true either way; whether that load also left the site is unknowable
  // without the URL.
  const hiddenOwnerUrlReason = (): StopReason => (firefoxExtension(api) ? 'page-access-lost' : 'left-site');

  const recoverRecordingOwner = async (): Promise<void> => {
    let state = controller.getState();
    if (state.phase !== 'recording') return;

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
      // Focus may have moved while the background was asleep. A switch to
      // the journey's own tab is the reader's stop here too, whichever
      // window it is in; the event saying so may still be queued.
      if (!tab.active) {
        await controller.stop(await ownerFocusLoss(state.ownerTabId) ?? 'focus-lost');
        return;
      }
      let tabUrl: string;
      try { tabUrl = normalizedUrl(tab.url); }
      catch {
        await controller.stop(tab.url === undefined ? hiddenOwnerUrlReason() : 'protected-page');
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
          await controller.stop(await ownerFocusLoss(state.ownerTabId) ?? 'focus-lost');
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
        await controller.stop(identity.visible ? 'capture-failed' : await ownerFocusLoss(current.ownerTabId) ?? 'focus-lost');
        return;
      }
      try {
        await pageCommand(current.ownerTabId, {
          type: 'ANMERKO_JOURNEY_PAGE_START', sessionId: current.sessionId, epoch: current.epoch,
          documentToken: current.documentToken, startedAt: current.draft.startedAt,
          count: current.draft.steps.length, expectedUrl,
          includeEnteredValues: current.draft.includeEnteredValues,
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
    try {
      const stored = (await api.storage.session.get([TAB_REVIEW_KEY]))[TAB_REVIEW_KEY];
      if ('sessionId' in restored && stored === restored.sessionId) tabReviewSession = stored;
      else if (stored !== undefined) await api.storage.session.remove([TAB_REVIEW_KEY]);
    } catch { /* The review then stays where the reader opens it. */ }
    controller = makeController(restored);
    persistedStateRead = true;
    const state = controller.getState();
    publishedState = state;
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
    syncListeners();
    void api.runtime.sendMessage({ type: 'ANMERKO_JOURNEY_CHANGED' }).catch(() => {});
  };

  const resetFailedInitialization = async (): Promise<void> => {
    if (activeState(controller.getState())) await controller.stop('session-storage-limit').catch(() => {});
    const idle = { phase: 'idle', epoch: controller.getState().epoch } as const;
    await sessionStore.write(idle);
    await syncJourneyAlarms(idle);
    controller = makeController(idle);
    publishedState = idle;
    initializationError = undefined;
    discardPendingWakeEvents();
    decorateForState(idle);
    syncListeners();
    await Promise.all(Array.from(connectedEventPorts.values(), candidate => (
      stopStalePageRecorder(candidate.tabId, candidate.windowId)
    )));
    void api.runtime.sendMessage({ type: 'ANMERKO_JOURNEY_CHANGED' }).catch(() => {});
  };

  const reply = (
    operation: Promise<unknown>,
    respond: (response: unknown) => void,
  ) => {
    operation.then(value => respond(success(value)), error => respond(failure(error)))
      .finally(syncListeners);
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
    // A second Record journey waits for the tab the first one is opening.
    while (launchOpening) await launchOpening.catch(() => {});
    const state = controller.getState();
    if (!journeyStartable(state)) {
      const owner = 'ownerTabId' in state && state.ownerTabId === senderTabId && state.ownerWindowId === senderWindowId;
      if (!owner && activeState(state)) throw new JourneyCommandError('busy');
      // A pending review comes forward for its owner or for the website tab
      // the reader is looking at.
      if (!owner) {
        try { await focusedOwnerTab(senderTabId, senderWindowId, senderUrl); }
        catch { throw new JourneyCommandError('owner-unavailable'); }
      }
      await openReview();
      return;
    }
    clearExpiredIntents();
    const opening = openLaunchTab(senderTabId, senderWindowId, senderUrl);
    launchOpening = opening;
    try { await opening; }
    finally { if (launchOpening === opening) launchOpening = undefined; }
  };

  const openLaunchTab = async (senderTabId: number, senderWindowId: number, senderUrl: string): Promise<void> => {
    let identity: JourneyPageIdentity;
    try {
      await focusedOwnerTab(senderTabId, senderWindowId, senderUrl);
      identity = await identify(senderTabId);
    } catch {
      throw new JourneyCommandError('owner-unavailable');
    }
    if (!identity.visible || identity.url !== senderUrl || !journeyStartable(controller.getState())) {
      throw new JourneyCommandError('owner-unavailable');
    }
    // The launch tab opens on Record, not on the finished journey's
    // confirmation; the snapshot itself stays in Saved journeys.
    if (controller.getState().phase === 'saved') await controller.discard();
    // One launch tab waits at a time. A pending one for this same page comes
    // forward; one for another page or document is replaced: its tab takes the
    // new link when it is in this window, and closes otherwise.
    const reusable: number[] = [];
    for (const [id, pending] of Array.from(launchIntents)) {
      const tabId = pending.launchTabId;
      const tab = tabId === undefined ? undefined
        : (await journeyTabs(tabId)).find(candidate => candidate.url === `${journeyUrl}#launch=${id}`);
      if (launchIntents.get(id) !== pending) continue;
      if (tab && pending.ownerTabId === senderTabId && pending.ownerWindowId === senderWindowId
        && pending.documentToken === identity.documentToken && pending.url === identity.url) {
        try {
          await focusTab(tab.tabId);
          pending.expiresAt = Date.now() + LAUNCH_TTL_MS;
          return;
        } catch { /* Replaced below. */ }
      }
      launchIntents.delete(id);
      if (tab?.windowId === senderWindowId) reusable.push(tab.tabId);
      else if (tab) await api.tabs.remove(tab.tabId).catch(() => {});
    }
    syncListeners();
    if (!journeyStartable(controller.getState())) throw new JourneyCommandError('owner-unavailable');
    const id = crypto.randomUUID();
    const url = `${journeyUrl}#launch=${id}`;
    const intent: LaunchIntent = {
      ownerTabId: senderTabId, ownerWindowId: senderWindowId,
      documentToken: identity.documentToken, url: identity.url,
      expiresAt: Date.now() + LAUNCH_TTL_MS,
    };
    launchIntents.set(id, intent);
    syncListeners();
    // No journey is under way, so every journey tab in this window is spent: a
    // replaced launch, or a saved or discarded journey's review. The first
    // that can takes the new launch link and comes forward, so journeys never
    // leave a trail of tabs. The one this background last used goes first.
    // journey.html loads afresh for its new link.
    const known = reviewTabId === undefined ? [] : await journeyTabs(reviewTabId);
    for (const tab of [...known, ...await journeyTabs()]) {
      if (tab.windowId === senderWindowId && !reusable.includes(tab.tabId)) reusable.push(tab.tabId);
    }
    for (const tabId of reusable) {
      if (launchIntents.get(id) !== intent) throw new Error(GENERIC_ERROR);
      // Set first, so the start the new link sends finds its tab.
      intent.launchTabId = tabId;
      let reused: chrome.tabs.Tab | undefined;
      try { reused = await api.tabs.update(tabId, { url, active: true }); }
      catch { /* Try the next journey tab, then open one. */ }
      if (!reused) {
        if (launchIntents.get(id) === intent) intent.launchTabId = undefined;
        continue;
      }
      if (launchIntents.get(id) !== intent) throw new Error(GENERIC_ERROR);
      reviewTabId = tabId;
      if (windowsApi?.update && validInteger(reused.windowId)) await windowsApi.update(reused.windowId, { focused: true }).catch(() => {});
      return;
    }
    let created: chrome.tabs.Tab;
    try {
      created = await api.tabs.create({ url });
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

  const startFallback = async (intent: LaunchIntent, generation: number, includeEnteredValues: boolean): Promise<void> => {
    ensureJourneySupport();
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
    startingFromLaunch = true;
    try { await controller.start({ ownerTabId: intent.ownerTabId, ownerWindowId: intent.ownerWindowId, includeEnteredValues }); }
    finally { startingFromLaunch = false; }
  };

  // A review command names the review it was made in: its journey and the
  // session that recorded or reopened it. A click can reach here after another
  // surface switched journeys or reopened one, so a command for any review but
  // the current one is refused as stale. The controller then checks the
  // journey, epoch and revision as it applies the edit, with no wait between.
  const requireReview = (message: Message): void => {
    if (message.sessionId === undefined) return;
    if (typeof message.sessionId !== 'string') throw new Error(GENERIC_ERROR);
    const current = controller.getState();
    if (!('sessionId' in current) || current.sessionId !== message.sessionId) throw new JourneyCommandError('stale-review');
  };

  // A discard pressed in a review or on a saved confirmation names that view
  // and ends only that journey. One already closed has nothing left to end;
  // anything else now current refuses it as stale: another journey, another
  // review of the same one, or a revision changed since a review offered to
  // close it without confirmation. Only the storage reset names nothing.
  const targetedDiscard = (message: Message): 'discard' | 'closed' => {
    const { phase, journeyId, sessionId, revision } = message;
    if ((phase !== 'reviewing' && phase !== 'saved')
      || (journeyId !== undefined && typeof journeyId !== 'string')
      || (sessionId !== undefined && typeof sessionId !== 'string')
      || (revision !== undefined && !validInteger(revision))
      || (phase === 'reviewing' && (journeyId === undefined || sessionId === undefined))) throw new Error(GENERIC_ERROR);
    const current = controller.getState();
    if (current.phase === 'idle') return 'closed';
    const matches = phase === 'saved'
      ? current.phase === 'saved' && (journeyId === undefined || current.journeyId === journeyId)
        && (revision === undefined || current.revision === revision)
      : current.phase === 'reviewing' && current.journeyId === journeyId && current.sessionId === sessionId
        && (revision === undefined || current.draft.revision === revision);
    if (!matches) throw new JourneyCommandError('stale-review');
    return 'discard';
  };

  const trustedCommand = async (message: Message, surface: TrustedSurface): Promise<unknown> => {
    if (message.type === 'ANMERKO_JOURNEY_STATE') {
      const state = controller.getState();
      // Screenshots are most of a session, and every recorded step changes
      // it. A surface can ask for them only in review, where it shows them,
      // or not at all.
      const screenshots = message.screenshots === false ? false
        : message.screenshots !== 'review' || state.phase === 'reviewing' || state.phase === 'saving';
      return screenshots || !('draft' in state) ? state : { ...state, draft: { ...state.draft, images: {} } };
    }
    // A surface that follows only the phase skips the draft and its screenshots.
    if (message.type === 'ANMERKO_JOURNEY_PHASE') {
      return controller.getState().phase;
    }
    if (message.type === 'ANMERKO_JOURNEY_START') {
      if (surface.kind === 'launch') {
        const generation = launchGeneration;
        const intent = consumeLaunchIntent(surface, message.intent);
        if (!intent) throw new JourneyCommandError('launch-expired');
        if (message.includeEnteredValues !== undefined && typeof message.includeEnteredValues !== 'boolean') {
          throw new JourneyCommandError('owner-unavailable');
        }
        await withPersistedState(startFallback(intent, generation, message.includeEnteredValues === true));
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
        ensureJourneySupport();
        if (generation !== launchGeneration) return;
        if (message.includeEnteredValues !== undefined && typeof message.includeEnteredValues !== 'boolean') {
          throw new JourneyCommandError('owner-unavailable');
        }
        await controller.start({ ownerTabId, ownerWindowId, includeEnteredValues: message.includeEnteredValues === true });
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
      // A refused or needless discard leaves any start in flight alone.
      if (message.phase !== undefined && targetedDiscard(message) === 'closed') return;
      launchGeneration += 1;
      await withPersistedState(controller.discard());
      return;
    }
    if (message.type === 'ANMERKO_JOURNEY_UPDATE_SUMMARY') {
      if (!cancelLaunchIntent(surface, message.intent)) throw new JourneyCommandError('launch-expired');
      if (typeof message.epoch !== 'number' || typeof message.journeyId !== 'string'
        || typeof message.revision !== 'number' || typeof message.updatedAt !== 'string'
        || typeof message.expected !== 'string' || typeof message.actual !== 'string') {
        throw new Error(GENERIC_ERROR);
      }
      requireReview(message);
      await withPersistedState(controller.updateSummary({
        epoch: message.epoch, journeyId: message.journeyId, revision: message.revision,
        updatedAt: message.updatedAt, expected: message.expected, actual: message.actual,
      }));
      return;
    }
    if (message.type === 'ANMERKO_JOURNEY_REMOVE_STEP') {
      if (!cancelLaunchIntent(surface, message.intent)) throw new JourneyCommandError('launch-expired');
      if (typeof message.epoch !== 'number' || typeof message.journeyId !== 'string'
        || typeof message.revision !== 'number' || typeof message.updatedAt !== 'string'
        || typeof message.stepId !== 'string') {
        throw new Error(GENERIC_ERROR);
      }
      requireReview(message);
      await withPersistedState(controller.removeStep({
        epoch: message.epoch, journeyId: message.journeyId, revision: message.revision,
        updatedAt: message.updatedAt, stepId: message.stepId,
      }));
      return;
    }
    if (message.type === 'ANMERKO_JOURNEY_EDIT_VALUE') {
      if (!cancelLaunchIntent(surface, message.intent)) throw new JourneyCommandError('launch-expired');
      if (typeof message.epoch !== 'number' || typeof message.journeyId !== 'string'
        || typeof message.revision !== 'number' || typeof message.updatedAt !== 'string'
        || typeof message.stepId !== 'string' || !isRecord(message.value)) {
        throw new Error(GENERIC_ERROR);
      }
      requireReview(message);
      await withPersistedState(controller.editValue({
        epoch: message.epoch, journeyId: message.journeyId, revision: message.revision,
        updatedAt: message.updatedAt, stepId: message.stepId, value: message.value,
      }));
      return;
    }
    if (message.type === 'ANMERKO_JOURNEY_REDACT_URL') {
      if (!cancelLaunchIntent(surface, message.intent)) throw new JourneyCommandError('launch-expired');
      if (typeof message.epoch !== 'number' || typeof message.journeyId !== 'string'
        || typeof message.revision !== 'number' || typeof message.updatedAt !== 'string'
        || typeof message.stepId !== 'string'
        || (message.url !== 'source' && message.url !== 'capture' && message.url !== 'destination')) {
        throw new Error(GENERIC_ERROR);
      }
      requireReview(message);
      await withPersistedState(controller.redactUrl({
        epoch: message.epoch, journeyId: message.journeyId, revision: message.revision,
        updatedAt: message.updatedAt, stepId: message.stepId, url: message.url,
      }));
      return;
    }
    if (message.type === 'ANMERKO_JOURNEY_REDACT_LABEL') {
      if (!cancelLaunchIntent(surface, message.intent)) throw new JourneyCommandError('launch-expired');
      if (typeof message.epoch !== 'number' || typeof message.journeyId !== 'string'
        || typeof message.revision !== 'number' || typeof message.updatedAt !== 'string'
        || typeof message.stepId !== 'string') {
        throw new Error(GENERIC_ERROR);
      }
      requireReview(message);
      await withPersistedState(controller.redactLabel({
        epoch: message.epoch, journeyId: message.journeyId, revision: message.revision,
        updatedAt: message.updatedAt, stepId: message.stepId,
      }));
      return;
    }
    if (message.type === 'ANMERKO_JOURNEY_REVIEW_IMAGE') {
      if (!cancelLaunchIntent(surface, message.intent)) throw new JourneyCommandError('launch-expired');
      if (typeof message.epoch !== 'number' || typeof message.journeyId !== 'string'
        || typeof message.revision !== 'number' || typeof message.imageId !== 'string'
        || (message.operation !== 'remove' && (message.operation !== 'replace' || typeof message.dataUrl !== 'string'))) {
        throw new Error(GENERIC_ERROR);
      }
      const guard = { epoch: message.epoch, journeyId: message.journeyId, revision: message.revision, imageId: message.imageId };
      requireReview(message);
      const reviewSession = controller.getState();
      imageReviewsInFlight += 1;
      try {
        if (message.operation === 'remove') {
          await withPersistedState(controller.reviewImage({ operation: 'remove', ...guard }));
          return;
        }
        const stillCurrent = () => {
          const current = controller.getState();
          return current.phase === 'reviewing' && current.epoch === guard.epoch
            && current.journeyId === guard.journeyId && current.draft.revision === guard.revision
            && 'sessionId' in reviewSession && current.sessionId === reviewSession.sessionId;
        };
        // Fail fast before decoding; the controller re-checks the guards when it applies the image.
        if (!stillCurrent()) throw new JourneyCommandError('stale-review');
        let image: NormalizedJourneyPng;
        try { image = await reviewedReplacement(message.dataUrl as string, stillCurrent); }
        catch (error) {
          if (!stillCurrent()) throw new JourneyCommandError('stale-review');
          throw error;
        }
        if (!stillCurrent()) throw new JourneyCommandError('stale-review');
        await withPersistedState(controller.reviewImage({ operation: 'replace', ...guard, image }));
        return;
      } finally {
        imageReviewsInFlight -= 1;
      }
    }
    if (message.type === 'ANMERKO_JOURNEY_LIST') {
      if (!cancelLaunchIntent(surface, message.intent)) throw new JourneyCommandError('launch-expired');
      return listJourneySnapshots();
    }
    if (message.type === 'ANMERKO_JOURNEY_OPEN_SNAPSHOT') {
      if (!cancelLaunchIntent(surface, message.intent)) throw new JourneyCommandError('launch-expired');
      if (typeof message.journeyId !== 'string') throw new Error(GENERIC_ERROR);
      const snapshot = await openJourneySnapshot(message.journeyId);
      if (!snapshot) throw new Error(GENERIC_ERROR);
      return snapshot;
    }
    if (message.type === 'ANMERKO_JOURNEY_DELETE_SNAPSHOT') {
      if (!cancelLaunchIntent(surface, message.intent)) throw new JourneyCommandError('launch-expired');
      if (typeof message.journeyId !== 'string'
        || (message.revision !== undefined && typeof message.revision !== 'number')) {
        throw new Error(GENERIC_ERROR);
      }
      if (typeof message.revision === 'number') {
        const current = await openJourneySnapshot(message.journeyId).catch(() => undefined);
        if (current && current.draft.revision !== message.revision) {
          throw new JourneyCommandError('stale-review');
        }
      }
      await deleteJourneySnapshot(message.journeyId);
      return;
    }
    if (message.type === 'ANMERKO_JOURNEY_REOPEN') {
      if (!cancelLaunchIntent(surface, message.intent)) throw new JourneyCommandError('launch-expired');
      if (typeof message.journeyId !== 'string') throw new Error(GENERIC_ERROR);
      const snapshot = await openJourneySnapshot(message.journeyId);
      if (!snapshot) throw new Error(GENERIC_ERROR);
      let ownerTabId: number | undefined;
      let ownerWindowId: number | undefined;
      if (surface.kind === 'review' || surface.kind === 'launch') {
        ownerTabId = surface.tabId;
        const tab = await api.tabs.get(surface.tabId).catch(() => undefined);
        ownerWindowId = tab?.windowId;
      } else {
        const tabs = await api.tabs.query({ active: true, currentWindow: true }).catch(() => []);
        const tab = tabs.find(candidate => validInteger(candidate.id) && validInteger(candidate.windowId));
        ownerTabId = tab?.id;
        ownerWindowId = tab?.windowId;
      }
      if (!validInteger(ownerTabId) || !validInteger(ownerWindowId)) {
        throw new Error('Reopening needs an available website tab.');
      }
      await withPersistedState(controller.reopen({
        ownerTabId, ownerWindowId, draft: snapshot.draft, images: snapshot.images,
      }).then(() => {}));
      return controller.getState();
    }
    if (message.type === 'ANMERKO_JOURNEY_SAVE') {
      if (!cancelLaunchIntent(surface, message.intent)) throw new JourneyCommandError('launch-expired');
      // Another review surface is still masking or removing a screenshot.
      if (imageReviewsInFlight > 0) throw new JourneyCommandError('stale-review');
      // A Save names the review it was pressed in; another review is never saved from it.
      if (message.journeyId !== undefined || message.sessionId !== undefined) {
        if (typeof message.journeyId !== 'string' || typeof message.sessionId !== 'string') throw new Error(GENERIC_ERROR);
        const current = controller.getState();
        if (!('sessionId' in current) || current.journeyId !== message.journeyId || current.sessionId !== message.sessionId) {
          throw new JourneyCommandError('stale-review');
        }
      }
      let saved: { journeyId: string; revision: number } | undefined;
      await withPersistedState(controller.save(message.acknowledged).then(result => {
        saved = result;
      }));
      return saved;
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
          controller.acceptBatch(rawMessage.batch, senderTabId);
          await latestStateWrite;
        } catch { /* Malformed or stale page batches fail closed. */ }
        finally { discard(); }
      };
      if (!initialized) {
        if (!wakeEventRelevant(senderTabId)) discard();
        else if (!bufferWakeEvent({ type: 'batch', tabId: senderTabId, run, discard })) disconnectPort(port);
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
    if (surface && ['ANMERKO_JOURNEY_STATE', 'ANMERKO_JOURNEY_PHASE', 'ANMERKO_JOURNEY_START', 'ANMERKO_JOURNEY_STOP', 'ANMERKO_JOURNEY_DISCARD', 'ANMERKO_JOURNEY_UPDATE_SUMMARY', 'ANMERKO_JOURNEY_REMOVE_STEP', 'ANMERKO_JOURNEY_EDIT_VALUE', 'ANMERKO_JOURNEY_REDACT_URL', 'ANMERKO_JOURNEY_REDACT_LABEL', 'ANMERKO_JOURNEY_REVIEW_IMAGE', 'ANMERKO_JOURNEY_SAVE', 'ANMERKO_JOURNEY_LIST', 'ANMERKO_JOURNEY_OPEN_SNAPSHOT', 'ANMERKO_JOURNEY_DELETE_SNAPSHOT', 'ANMERKO_JOURNEY_REOPEN'].includes(String(message.type))) {
      return reply((async () => {
        await ready;
        if (initializationError) {
          // Only the explicit reset, which names no journey, clears failed storage.
          if (message.type !== 'ANMERKO_JOURNEY_DISCARD' || message.phase !== undefined) throw initializationError;
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
        // Failed journey storage is reset from a journey tab.
        if (initializationError) return openReview();
        return openLaunch(senderTabId, senderWindowId, senderUrl);
      })(), respond);
    }
    // Lets a page's panel offer the pending review. Only the phase is shared.
    if (message.type === 'ANMERKO_JOURNEY_PENDING') {
      return reply((async () => {
        await ready;
        if (initializationError) return false;
        const state = controller.getState();
        return state.phase === 'reviewing' || state.phase === 'saving';
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

  ready = initialize().catch(async error => {
    initializationError = error;
    initialized = true;
    discardPendingWakeEvents();
    if (activeState(controller.getState())) await controller.stop('session-storage-limit');
    await clearJourneyAlarms();
    syncListeners();
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
