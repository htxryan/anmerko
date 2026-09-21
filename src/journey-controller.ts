import {
  adoptJourneyDocument,
  acceptInitialImage,
  acceptJourneyEventBatch,
  acceptLateJourneyEventBatch,
  commitJourneyNavigation,
  createJourneySession,
  editJourneyValue,
  failInitialImage,
  redactJourneyUrl,
  removeJourneyStep,
  resolveJourneyCapture,
  stopJourney,
  supersedeJourneyImagesAfter,
  updateJourneySummary,
  type JourneyDraftImage,
  type JourneyEditValueInput,
  type JourneyRedactUrlInput,
  type JourneyRemoveStepInput,
  type JourneySession,
  type JourneySummaryInput,
  type Point,
  type RecordingJourneySession,
  type ReviewingJourneySession,
  type Viewport,
} from './journey-core';
import { stripUrlCredentials, validateJourneyEventBatch } from './journey-events';
import { CAPTURE_FAILURES, JOURNEY_LIMITS, type CaptureFailure, type StopReason } from './journey-limits';

export interface JourneyPageIdentity {
  documentToken: string;
  url: string;
  viewport: Viewport;
  scroll: Point;
  generation: number;
  visible: boolean;
  recording?: { sessionId: string; epoch: number };
}

export interface JourneyControllerAdapter {
  identify(tabId: number): Promise<JourneyPageIdentity>;
  connect?(tabId: number, expectedUrl: string): Promise<JourneyPageIdentity>;
  capture(tabId: number, identity: JourneyPageIdentity, captureId: string): Promise<JourneyDraftImage>;
  begin(tabId: number, input: {
    sessionId: string;
    epoch: number;
    documentToken: string;
    startedAt: string;
    count: number;
    expectedUrl: string;
  }): Promise<void>;
  end(tabId: number, input: { sessionId: string; epoch: number; documentToken?: string }): Promise<void>;
  changed(state: JourneySession): void;
  now?(): number;
  delay?(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface JourneyController {
  getState(): JourneySession;
  start(input: { ownerTabId: number; ownerWindowId: number; includeEnteredValues?: boolean }): Promise<void>;
  observeNavigation(input: { ownerTabId: number; url: string; kind: 'document' | 'same-document' }): void;
  acceptBatch(batch: unknown, senderTabId: number): void;
  stop(reason?: StopReason): Promise<void>;
  discard(): Promise<void>;
  updateSummary(input: JourneySummaryInput): Promise<void>;
  removeStep(input: JourneyRemoveStepInput): Promise<void>;
  editValue(input: JourneyEditValueInput): Promise<void>;
  redactUrl(input: JourneyRedactUrlInput): Promise<void>;
}

export type JourneyControllerErrorCode = 'busy' | 'invalid-start' | 'owner-unavailable' | 'initial-capture-failed' | 'stale-review';

interface PendingDocumentHandshake {
  previousDocumentToken: string;
  documentToken: string;
  adopted: boolean;
}

export class JourneyControllerError extends Error {
  constructor(readonly code: JourneyControllerErrorCode, message: string) {
    super(message);
    this.name = 'JourneyControllerError';
  }
}

const POST_ACTION_DELAY_MS = 500;
const NAVIGATION_WINDOW_MS = 5_000;

export function createJourneyController(
  adapter: JourneyControllerAdapter,
  restoredState: JourneySession = { phase: 'idle', epoch: 0 },
): JourneyController {
  let state = prepareRestoredState(restoredState, adapter.now?.() ?? Date.now());
  let workGeneration = state.phase === 'idle' ? 0 : 1;
  let launching = false;
  let navigationAbort: AbortController | undefined;
  let pendingHandshake: PendingDocumentHandshake | undefined;
  const now = () => adapter.now?.() ?? Date.now();
  const delay = (ms: number, signal?: AbortSignal) => adapter.delay?.(ms, signal) ?? abortableDelay(ms, signal);
  const publish = (next: JourneySession) => {
    state = next;
    adapter.changed(state);
  };

  async function start(input: { ownerTabId: number; ownerWindowId: number; includeEnteredValues?: boolean }): Promise<void> {
    if (!Number.isInteger(input.ownerTabId) || input.ownerTabId < 0 || !Number.isInteger(input.ownerWindowId) || input.ownerWindowId < 0
      || (input.includeEnteredValues !== undefined && typeof input.includeEnteredValues !== 'boolean')) {
      throw new JourneyControllerError('invalid-start', 'Journey recording needs a valid owner tab and window.');
    }
    if (state.phase !== 'idle' || launching) {
      throw new JourneyControllerError('busy', 'Finish or discard the current journey before starting another.');
    }
    launching = true;
    const generation = ++workGeneration;
    try {
      const identity = await adapter.identify(input.ownerTabId);
      if (generation !== workGeneration || state.phase !== 'idle') return;
      if (!identity.visible) throw new JourneyControllerError('owner-unavailable', 'The page is not available for journey recording.');
      const startedMs = now();
      const starting = createJourneySession({
        sessionId: newId('session'), journeyId: newId('journey'),
        ownerTabId: input.ownerTabId, ownerWindowId: input.ownerWindowId,
        documentToken: identity.documentToken,
        startedAt: new Date(startedMs).toISOString(),
        deadlineAt: new Date(startedMs + JOURNEY_LIMITS.maxDurationMs).toISOString(),
        includeEnteredValues: input.includeEnteredValues,
      });
      publish(starting);
      const captureId = newId('capture');
      const image = await adapter.capture(input.ownerTabId, identity, captureId);
      if (!isCurrentStart(generation, starting)) return;
      const after = await adapter.identify(input.ownerTabId);
      if (!isCurrentStart(generation, starting)) return;
      if (!sameIdentity(identity, after) || !after.visible || !imageMatchesIdentity(image, after)
        || Date.parse(image.capturedAt) >= Date.parse(starting.deadlineAt)) {
        throw new JourneyControllerError('initial-capture-failed', 'The initial journey screenshot could not be captured. Try again.');
      }
      const accepted = acceptInitialImage(state, {
        id: newId('step'), imageId: newId('image'),
        observedAt: image.capturedAt,
        elapsedMs: elapsed(startedMs, image.capturedAt),
        sourceUrl: after.url,
        image,
      });
      if (accepted.phase !== 'recording') {
        throw new JourneyControllerError('initial-capture-failed', 'The initial journey screenshot could not be captured. Try again.');
      }
      await adapter.begin(input.ownerTabId, {
        sessionId: accepted.sessionId, epoch: accepted.epoch,
        documentToken: accepted.documentToken,
        startedAt: accepted.draft.startedAt, count: accepted.draft.steps.length,
        expectedUrl: stripUrlCredentials(after.url),
      });
      if (!isCurrentStart(generation, starting)) {
        await safeEnd(input.ownerTabId, accepted.sessionId, state.epoch);
        return;
      }
      const confirmed = await adapter.identify(input.ownerTabId);
      if (!isCurrentStart(generation, starting)) {
        await safeEnd(input.ownerTabId, accepted.sessionId, state.epoch);
        return;
      }
      if (!confirmed.visible || !sameIdentity(after, confirmed) || now() >= Date.parse(starting.deadlineAt)) {
        throw new JourneyControllerError('initial-capture-failed', 'The initial journey screenshot could not be captured. Try again.');
      }
      publish(accepted);
    } catch (error) {
      const current = state as JourneySession;
      if (generation !== workGeneration) return;
      if (current.phase === 'starting') {
        const failed = failInitialImage(current);
        publish(failed);
        await safeEnd(current.ownerTabId, current.sessionId, failed.epoch);
      }
      if (error instanceof JourneyControllerError) throw error;
      throw new JourneyControllerError('initial-capture-failed', 'The initial journey screenshot could not be captured. Try again.');
    } finally {
      if (generation === workGeneration) launching = false;
    }
  }

  function acceptBatch(input: unknown, senderTabId: number): void {
    if (state.phase !== 'recording' || senderTabId !== state.ownerTabId) return;
    if (now() >= Date.parse(state.deadlineAt)) {
      void stop('duration-limit');
      return;
    }
    const validated = validateJourneyEventBatch(input);
    if (!validated.ok) return;
    const expectedUrl = committedUrl(state);
    if (!expectedUrl) return;
    if (validated.value.events.some(event => !sameUrl(event.sourceUrl, expectedUrl))) {
      const late = acceptLateJourneyEventBatch(state, validated.value);
      if (late !== state) publish(late);
      return;
    }
    const previous = state;
    const candidate = acceptJourneyEventBatch(previous, validated.value);
    if (candidate === previous) return;
    const firstObservedAt = validated.value.events.reduce((earliest, event) => (
      Date.parse(event.observedAt) < Date.parse(earliest) ? event.observedAt : earliest
    ), validated.value.events[0].observedAt);
    const cleaned = supersedeJourneyImagesAfter(previous, {
      epoch: previous.epoch,
      observedAt: firstObservedAt,
    });
    let next = acceptJourneyEventBatch(cleaned, validated.value);
    const generation = invalidateWork();
    if (next.phase !== 'recording') {
      publish(next);
      void safeEnd(previous.ownerTabId, previous.sessionId, next.epoch);
      return;
    }
    const newSteps = next.draft.steps.slice(previous.draft.steps.length);
    const latestPending = [...newSteps].reverse().find(step => step.image.status === 'pending');
    const latestCaptureId = latestPending?.image.status === 'pending' ? latestPending.image.captureId : undefined;
    for (const step of next.draft.steps) {
      if (step.image.status !== 'pending' || step.image.captureId === latestCaptureId) continue;
      const recording = next as RecordingJourneySession;
      next = resolveJourneyCapture(recording, {
        epoch: recording.epoch, documentToken: recording.documentToken,
        captureId: step.image.captureId, status: 'unavailable', reason: 'superseded',
      });
    }
    publish(next);
    if (latestCaptureId) void captureAfterAction(generation, latestCaptureId);
  }

  function observeNavigation(input: { ownerTabId: number; url: string; kind: 'document' | 'same-document' }): void {
    if (state.phase !== 'recording' || input.ownerTabId !== state.ownerTabId) return;
    let toUrl: string;
    try {
      toUrl = stripUrlCredentials(input.url);
    } catch {
      void stop('protected-page');
      return;
    }
    if (new TextEncoder().encode(toUrl).byteLength > JOURNEY_LIMITS.maxUrlBytes) {
      void stop('capture-failed');
      return;
    }
    const sourceUrl = committedUrl(state);
    if (!sourceUrl) return;
    const previous = state;
    const receiptMs = Math.max(now(), Date.parse(previous.draft.steps.at(-1)?.observedAt ?? previous.draft.startedAt));
    const observedAt = new Date(receiptMs).toISOString();
    const lastElapsed = previous.draft.steps.at(-1)?.elapsedMs ?? 0;
    const elapsedMs = Math.max(lastElapsed, elapsed(Date.parse(previous.draft.startedAt), observedAt));
    const generation = invalidateWork();
    const captureId = newId('capture');
    let next: JourneySession = settlePendingCaptures(previous, 'superseded');
    if (next.phase !== 'recording') return;

    let handshake = pendingHandshake;
    let documentToken = next.documentToken;
    if (input.kind === 'document') {
      documentToken = uniqueProvisionalToken(next);
      handshake = {
        previousDocumentToken: pendingHandshake && !pendingHandshake.adopted
          ? pendingHandshake.previousDocumentToken
          : next.documentToken,
        documentToken,
        adopted: false,
      };
      const adopted = adoptJourneyDocument(next, {
        epoch: next.epoch,
        previousDocumentToken: next.documentToken,
        documentToken,
      });
      if (adopted.phase !== 'recording') return;
      next = adopted;
    }
    const beforeCommit = next;
    next = commitJourneyNavigation(beforeCommit, {
      epoch: next.epoch,
      id: newId('step'),
      observedAt,
      elapsedMs,
      sourceUrl,
      toUrl,
      previousDocumentToken: next.documentToken,
      documentToken,
      image: { status: 'pending', captureId },
    });
    if (next === beforeCommit) {
      if (beforeCommit !== previous) publish(beforeCommit);
      return;
    }
    if (next.phase !== 'recording') {
      pendingHandshake = undefined;
      publish(next);
      void safeEnd(previous.ownerTabId, previous.sessionId, next.epoch);
      return;
    }
    pendingHandshake = handshake;
    publish(next);
    const abort = new AbortController();
    navigationAbort = abort;
    void completeNavigation({
      generation, captureId, toUrl, observedMs: actionWindowStartMs(previous),
      handshake: handshake ? { ...handshake } : undefined,
      handshakeReady: !handshake,
      signal: abort.signal,
    });
  }

  async function completeNavigation(input: {
    generation: number;
    captureId: string;
    toUrl: string;
    observedMs: number;
    handshake?: PendingDocumentHandshake;
    handshakeReady: boolean;
    signal: AbortSignal;
  }): Promise<void> {
    const settledMs = now();
    const minimum = delay(Math.max(0, input.observedMs + POST_ACTION_DELAY_MS - settledMs), input.signal);
    const timeout = delay(Math.max(0, input.observedMs + NAVIGATION_WINDOW_MS - settledMs), input.signal).then(() => 'timeout' as const);
    const work = performNavigation(input, minimum).then(() => 'complete' as const, error => {
      if (isCurrentNavigation(input.generation, input.captureId, input.toUrl)) {
        settleCapture(input.captureId, captureFailureFromError(error));
        if (input.handshake && !input.handshakeReady) void stop('capture-failed');
      }
      return 'complete' as const;
    });
    const result = await Promise.race([work, timeout]);
    if (result === 'timeout' && isCurrentNavigation(input.generation, input.captureId, input.toUrl)) {
      settleCapture(input.captureId, 'navigation-timeout');
      if (input.handshake && !input.handshakeReady) void stop('capture-failed');
    }
    if (navigationAbort?.signal === input.signal) {
      navigationAbort.abort();
      navigationAbort = undefined;
    }
  }

  async function performNavigation(input: {
    generation: number;
    captureId: string;
    toUrl: string;
    observedMs: number;
    handshake?: PendingDocumentHandshake;
    handshakeReady: boolean;
  }, minimum: Promise<void>): Promise<void> {
    if (input.handshake) {
      const connect = adapter.connect ?? ((tabId: number) => adapter.identify(tabId));
      const identity = await connect(state.phase === 'recording' ? state.ownerTabId : -1, input.toUrl);
      if (!isCurrentNavigation(input.generation, input.captureId, input.toUrl) || state.phase !== 'recording') return;
      if (!identity.visible || !sameUrl(identity.url, input.toUrl)) {
        throw captureFailure('page-document-changed');
      }
      let adopted = state;
      if (input.handshake.adopted) {
        if (state.documentToken !== input.handshake.documentToken
          || identity.documentToken !== input.handshake.documentToken) {
          throw captureFailure('page-document-changed');
        }
      } else {
        if (identity.documentToken === input.handshake.previousDocumentToken) {
          throw captureFailure('page-document-changed');
        }
        const transitioned = adoptJourneyDocument(state, {
          epoch: state.epoch,
          previousDocumentToken: input.handshake.documentToken,
          documentToken: identity.documentToken,
        });
        if (transitioned === state || transitioned.phase !== 'recording') {
          throw captureFailure('page-document-changed');
        }
        adopted = transitioned;
        pendingHandshake = {
          previousDocumentToken: input.handshake.previousDocumentToken,
          documentToken: identity.documentToken,
          adopted: true,
        };
        publish(adopted);
      }
      await adapter.begin(adopted.ownerTabId, {
        sessionId: adopted.sessionId,
        epoch: adopted.epoch,
        documentToken: adopted.documentToken,
        startedAt: adopted.draft.startedAt,
        count: adopted.draft.steps.length,
        expectedUrl: input.toUrl,
      });
      if (!isCurrentNavigation(input.generation, input.captureId, input.toUrl)) {
        await cleanupStaleBegin(adopted.ownerTabId, adopted.sessionId, adopted.epoch, adopted.documentToken);
        return;
      }
      pendingHandshake = undefined;
      input.handshakeReady = true;
    }

    await minimum;
    if (!isCurrentNavigation(input.generation, input.captureId, input.toUrl) || state.phase !== 'recording') return;
    const current = state;
    const before = await adapter.identify(current.ownerTabId);
    if (!isCurrentNavigation(input.generation, input.captureId, input.toUrl)) return;
    if (!before.visible || before.documentToken !== current.documentToken || !sameUrl(before.url, input.toUrl)) {
      settleCapture(input.captureId, before.visible ? 'page-document-changed' : 'capture-denied');
      return;
    }
    const image = await adapter.capture(current.ownerTabId, before, input.captureId);
    if (!isCurrentNavigation(input.generation, input.captureId, input.toUrl)) return;
    const after = await adapter.identify(current.ownerTabId);
    if (!isCurrentNavigation(input.generation, input.captureId, input.toUrl)) return;
    if (now() >= Date.parse(current.deadlineAt)) {
      await stop('duration-limit');
      return;
    }
    const capturedMs = Date.parse(image.capturedAt);
    if (!Number.isFinite(capturedMs) || capturedMs < input.observedMs + POST_ACTION_DELAY_MS
      || capturedMs >= input.observedMs + NAVIGATION_WINDOW_MS
      || capturedMs >= Date.parse(current.deadlineAt)) {
      settleCapture(input.captureId, 'navigation-timeout');
      return;
    }
    if (!after.visible || !sameDocumentAndUrl(before, after) || !sameUrl(after.url, input.toUrl)
      || !sameUrl(image.captureUrl, input.toUrl)) {
      settleCapture(input.captureId, after.visible ? 'page-document-changed' : 'capture-denied');
      return;
    }
    if (!sameViewport(before, after) || !imageMatchesViewport(image, after)) {
      settleCapture(input.captureId, 'viewport-changed');
      return;
    }
    const resolved = resolveJourneyCapture(state, {
      epoch: current.epoch,
      documentToken: current.documentToken,
      captureId: input.captureId,
      status: 'retained',
      imageId: newId('image'),
      image,
    });
    publishCaptureResolution(current, resolved);
  }

  async function captureAfterAction(generation: number, captureId: string): Promise<void> {
    try {
      const started = state;
      if (started.phase !== 'recording') return;
      const actionStep = started.draft.steps.find(
        step => step.image.status === 'pending' && step.image.captureId === captureId);
      if (!actionStep) return;
      const actionMs = Date.parse(actionStep.observedAt);
      await delay(Math.max(0, actionMs + POST_ACTION_DELAY_MS - now()));
      if (!isCurrentRecording(generation, captureId)) return;
      if (now() >= actionMs + NAVIGATION_WINDOW_MS) {
        settleCapture(captureId, 'navigation-timeout');
        return;
      }
      const current = state as RecordingJourneySession;
      const before = await adapter.identify(current.ownerTabId);
      if (!isCurrentRecording(generation, captureId)) return;
      if (!before.visible) {
        settleCapture(captureId, 'capture-denied');
        await stop('focus-lost');
        return;
      }
      if (before.documentToken !== current.documentToken || !captureSourceMatches(current, captureId, before.url)) {
        settleCapture(captureId, 'page-document-changed');
        await stop('capture-failed');
        return;
      }
      const image = await adapter.capture(current.ownerTabId, before, captureId);
      if (!isCurrentRecording(generation, captureId)) return;
      const after = await adapter.identify(current.ownerTabId);
      if (!isCurrentRecording(generation, captureId)) return;
      if (now() >= Date.parse(current.deadlineAt)) {
        await stop('duration-limit');
        return;
      }
      const capturedMs = Date.parse(image.capturedAt);
      if (!Number.isFinite(capturedMs) || capturedMs < actionMs + POST_ACTION_DELAY_MS
        || capturedMs >= actionMs + NAVIGATION_WINDOW_MS) {
        settleCapture(captureId, 'navigation-timeout');
        return;
      }
      if (!after.visible) {
        settleCapture(captureId, 'capture-denied');
        await stop('focus-lost');
        return;
      }
      if (!sameDocumentAndUrl(before, after) || !sameUrl(image.captureUrl, after.url)) {
        settleCapture(captureId, 'page-document-changed');
        return;
      }
      if (!sameViewport(before, after) || !imageMatchesViewport(image, after)) {
        settleCapture(captureId, 'viewport-changed');
        return;
      }
      const resolved = resolveJourneyCapture(state, {
        epoch: current.epoch, documentToken: current.documentToken,
        captureId, status: 'retained', imageId: newId('image'), image,
      });
      publishCaptureResolution(current, resolved);
    } catch (error) {
      if (isCurrentRecording(generation, captureId)) settleCapture(captureId, captureFailureFromError(error));
    }
  }

  function settleCapture(captureId: string, reason: CaptureFailure): void {
    if (state.phase !== 'recording') return;
    const next = resolveJourneyCapture(state, {
      epoch: state.epoch, documentToken: state.documentToken,
      captureId, status: 'unavailable', reason,
    });
    if (next !== state) publish(next);
  }

  function publishCaptureResolution(previous: RecordingJourneySession, next: JourneySession): void {
    if (next === state) return;
    if (next.phase === 'recording') {
      publish(next);
      return;
    }
    invalidateWork();
    pendingHandshake = undefined;
    publish(next);
    void safeEnd(previous.ownerTabId, previous.sessionId, next.epoch);
  }

  function settlePendingCaptures(current: RecordingJourneySession, reason: CaptureFailure): RecordingJourneySession {
    let next = current;
    for (const step of current.draft.steps) {
      if (step.image.status !== 'pending') continue;
      const resolved = resolveJourneyCapture(next, {
        epoch: next.epoch,
        documentToken: next.documentToken,
        captureId: step.image.captureId,
        status: 'unavailable',
        reason,
      });
      if (resolved.phase === 'recording') next = resolved;
    }
    return next;
  }

  async function stop(reason: StopReason = 'user'): Promise<void> {
    const previous = state;
    invalidateWork();
    launching = false;
    pendingHandshake = undefined;
    if (previous.phase !== 'starting' && previous.phase !== 'recording') return;
    const stoppedAt = reason === 'duration-limit' && previous.phase === 'recording'
      ? previous.deadlineAt
      : new Date(Math.max(now(), Date.parse(previous.draft.startedAt))).toISOString();
    const stopped = stopJourney(previous, {
      epoch: previous.epoch,
      stoppedAt,
      reason,
    });
    if (stopped !== previous) publish(stopped);
    await safeEnd(previous.ownerTabId, previous.sessionId, stopped.epoch);
  }

  async function discard(): Promise<void> {
    const previous = state;
    invalidateWork();
    launching = false;
    pendingHandshake = undefined;
    if (previous.phase === 'idle') return;
    const next: JourneySession = { phase: 'idle', epoch: previous.epoch + 1 };
    publish(next);
    if ('ownerTabId' in previous && 'sessionId' in previous) await safeEnd(previous.ownerTabId, previous.sessionId, next.epoch);
  }

  function currentReview(previous: JourneySession, input: { epoch: unknown; journeyId: unknown; revision: unknown }): ReviewingJourneySession {
    if (previous.phase !== 'reviewing' || input.epoch !== previous.epoch
      || input.journeyId !== previous.journeyId || input.revision !== previous.draft.revision) {
      throw new JourneyControllerError('stale-review', 'The review changed since this edit began. Reload and try again.');
    }
    return previous;
  }

  async function updateSummary(input: JourneySummaryInput): Promise<void> {
    const previous = currentReview(state, input);
    const next = updateJourneySummary(previous, input);
    if (next !== previous) publish(next);
  }

  async function removeStep(input: JourneyRemoveStepInput): Promise<void> {
    const previous = currentReview(state, input);
    const next = removeJourneyStep(previous, input);
    if (next !== previous) publish(next);
  }

  async function editValue(input: JourneyEditValueInput): Promise<void> {
    const previous = currentReview(state, input);
    const next = editJourneyValue(previous, input);
    if (next !== previous) publish(next);
  }

  async function redactUrl(input: JourneyRedactUrlInput): Promise<void> {
    const previous = currentReview(state, input);
    const next = redactJourneyUrl(previous, input);
    if (next !== previous) publish(next);
  }

  async function safeEnd(tabId: number, sessionId: string, epoch: number, documentToken?: string): Promise<void> {
    try { await adapter.end(tabId, { sessionId, epoch, ...(documentToken ? { documentToken } : {}) }); }
    catch { /* State is already inactive; teardown is best effort. */ }
  }

  function isCurrentStart(generation: number, starting: JourneySession): boolean {
    return generation === workGeneration && state === starting && state.phase === 'starting';
  }

  function isCurrentRecording(generation: number, captureId: string): boolean {
    return generation === workGeneration && state.phase === 'recording'
      && state.draft.steps.some(step => step.image.status === 'pending' && step.image.captureId === captureId);
  }

  function isCurrentNavigation(generation: number, captureId: string, expectedUrl: string): boolean {
    return isCurrentRecording(generation, captureId) && state.phase === 'recording'
      && sameUrl(committedUrl(state) ?? '', expectedUrl);
  }

  function invalidateWork(): number {
    navigationAbort?.abort();
    navigationAbort = undefined;
    return ++workGeneration;
  }

  async function cleanupStaleBegin(tabId: number, sessionId: string, epoch: number, documentToken: string): Promise<void> {
    if (state.phase === 'recording' && state.sessionId === sessionId && state.epoch === epoch
      && state.documentToken === documentToken) return;
    await safeEnd(tabId, sessionId, epoch, documentToken);
  }

  return { getState: () => state, start, observeNavigation, acceptBatch, stop, discard, updateSummary, removeStep, editValue, redactUrl };
}

function newId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function uniqueProvisionalToken(state: RecordingJourneySession): string {
  let token = newId('document-pending');
  while (token === state.documentToken || Object.hasOwn(state.documentCounters, token)) token = newId('document-pending');
  return token;
}

function committedUrl(state: RecordingJourneySession): string | undefined {
  const step = state.draft.steps.at(-1);
  if (!step) return;
  return step.kind === 'navigation' ? step.navigation.toUrl : step.sourceUrl;
}

function actionWindowStartMs(state: RecordingJourneySession): number {
  const steps = state.draft.steps;
  let index = steps.length - 1;
  while (index >= 0 && steps[index].kind === 'navigation') index -= 1;
  const anchor = index >= 0 ? steps[index].observedAt : state.draft.startedAt;
  return Date.parse(anchor);
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted) { resolve(); return; }
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    }
  });
}

function elapsed(startedMs: number, observedAt: string): number {
  return Math.max(0, Math.min(JOURNEY_LIMITS.maxDurationMs, Date.parse(observedAt) - startedMs));
}

function sameUrl(first: string, second: string): boolean {
  try { return stripUrlCredentials(first) === stripUrlCredentials(second); }
  catch { return false; }
}

function sameDocumentAndUrl(first: JourneyPageIdentity, second: JourneyPageIdentity): boolean {
  return first.documentToken === second.documentToken && first.generation === second.generation && sameUrl(first.url, second.url);
}

function sameViewport(first: JourneyPageIdentity, second: JourneyPageIdentity): boolean {
  return first.viewport.width === second.viewport.width && first.viewport.height === second.viewport.height
    && first.scroll.x === second.scroll.x && first.scroll.y === second.scroll.y;
}

function sameIdentity(first: JourneyPageIdentity, second: JourneyPageIdentity): boolean {
  return sameDocumentAndUrl(first, second) && sameViewport(first, second);
}

function imageMatchesViewport(image: JourneyDraftImage, identity: JourneyPageIdentity): boolean {
  return image.viewport.width === identity.viewport.width && image.viewport.height === identity.viewport.height
    && image.scroll.x === identity.scroll.x && image.scroll.y === identity.scroll.y;
}

function imageMatchesIdentity(image: JourneyDraftImage, identity: JourneyPageIdentity): boolean {
  return sameUrl(image.captureUrl, identity.url) && imageMatchesViewport(image, identity);
}

function captureSourceMatches(state: RecordingJourneySession, captureId: string, url: string): boolean {
  const step = state.draft.steps.find(item => item.image.status === 'pending' && item.image.captureId === captureId);
  return Boolean(step && sameUrl(step.sourceUrl, url));
}

function captureFailureFromError(error: unknown): CaptureFailure {
  if (error && typeof error === 'object' && 'reason' in error) {
    const reason = (error as { reason?: unknown }).reason;
    if (typeof reason === 'string' && CAPTURE_FAILURES.includes(reason as CaptureFailure)) return reason as CaptureFailure;
  }
  return 'capture-error';
}

function captureFailure(reason: CaptureFailure): Error & { reason: CaptureFailure } {
  return Object.assign(new Error('Journey capture failed.'), { reason });
}

function prepareRestoredState(restoredState: JourneySession, nowMs: number): JourneySession {
  if (restoredState.phase === 'starting') return failInitialImage(restoredState);
  if (restoredState.phase === 'reviewing' && nowMs >= Date.parse(restoredState.expiresAt)) {
    return { phase: 'idle', epoch: restoredState.epoch + 1 };
  }
  if (restoredState.phase !== 'recording') return restoredState;
  if (nowMs >= Date.parse(restoredState.deadlineAt)) {
    return stopJourney(restoredState, {
      epoch: restoredState.epoch,
      stoppedAt: restoredState.deadlineAt,
      reason: 'duration-limit',
    });
  }
  let recovered = restoredState;
  for (const step of restoredState.draft.steps) {
    if (step.image.status !== 'pending') continue;
    const resolved = resolveJourneyCapture(recovered, {
      epoch: recovered.epoch,
      documentToken: recovered.documentToken,
      captureId: step.image.captureId,
      status: 'unavailable',
      reason: 'capture-error',
    });
    if (resolved.phase === 'recording') recovered = resolved;
  }
  return recovered;
}
