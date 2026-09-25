import {
  adoptJourneyDocument,
  acceptInitialImage,
  acceptJourneyEventBatch,
  acceptLateJourneyEventBatch,
  commitJourneyNavigation,
  createJourneySession,
  editJourneyValue,
  failInitialImage,
  redactJourneyLabel,
  redactJourneyUrl,
  removeJourneyStep,
  reopenJourneySnapshot,
  resolveJourneyCapture,
  resumeSavingReview,
  reviewSaveGating,
  stopJourney,
  supersedeJourneyImagesAfter,
  updateJourneySummary,
  type JourneyDraftImage,
  type JourneyDraftV1,
  type JourneyEditValueInput,
  type JourneyRedactLabelInput,
  type JourneyRedactUrlInput,
  type JourneyRemoveStepInput,
  type JourneySession,
  type JourneySummaryInput,
  type Point,
  type RecordingJourneySession,
  type ReviewingJourneySession,
  type SavingJourneySession,
  type Viewport,
} from './journey-core';
import { stripUrlCredentials, validateJourneyEventBatch } from './journey-events';
import type { NormalizedJourneyPng } from './journey-image';
import { CAPTURE_FAILURES, JOURNEY_LIMITS, type CaptureFailure, type StopReason } from './journey-limits';
import { applyJourneyImageReview } from './journey-review';

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
    includeEnteredValues: boolean;
  }): Promise<void>;
  end(tabId: number, input: { sessionId: string; epoch: number; documentToken?: string }): Promise<void>;
  // Whether the browser withdrew page access to the owner tab. Firefox ties
  // activeTab to one document, so any document load in the tab revokes it.
  pageAccessLost?(tabId: number): Promise<boolean>;
  changed(state: JourneySession): void;
  saveSnapshot?(input: { draft: JourneyDraftV1; images: Record<string, JourneyDraftImage> }): Promise<{ journeyId: string; revision: number }>;
  now?(): number;
  delay?(ms: number, signal?: AbortSignal): Promise<void>;
}

// The background validates the replacement pixels and stamps the edit time
// itself, so a review surface supplies only the revision guards and image.
export type JourneyImageReviewRequest =
  | { operation: 'replace'; epoch: number; journeyId: string; revision: number; imageId: string; image: NormalizedJourneyPng }
  | { operation: 'remove'; epoch: number; journeyId: string; revision: number; imageId: string };

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
  redactLabel(input: JourneyRedactLabelInput): Promise<void>;
  reviewImage(input: JourneyImageReviewRequest): Promise<void>;
  reopen(input: {
    ownerTabId: number; ownerWindowId: number;
    draft: JourneyDraftV1; images: Record<string, JourneyDraftImage>;
  }): Promise<ReviewingJourneySession>;
  save(acknowledged: unknown): Promise<{ journeyId: string; revision: number }>;
  reopen(input: {
    ownerTabId: number; ownerWindowId: number;
    draft: JourneyDraftV1; images: Record<string, JourneyDraftImage>;
  }): Promise<ReviewingJourneySession>;
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

// A saved journey is finished: its confirmation never holds the recorder.
export function journeyStartable(state: JourneySession): boolean {
  return state.phase === 'idle' || state.phase === 'saved';
}

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
    if (!journeyStartable(state) || launching) {
      throw new JourneyControllerError('busy', 'Finish or discard the current journey before starting another.');
    }
    launching = true;
    const generation = ++workGeneration;
    try {
      const identity = await adapter.identify(input.ownerTabId);
      if (generation !== workGeneration || !journeyStartable(state)) return;
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
        includeEnteredValues: accepted.draft.includeEnteredValues,
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
    // A journey records one origin: the one it started on. activeTab only
    // covers that origin, so leaving it ends the journey rather than silently
    // losing steps. Cross-origin capture would need host access to every site.
    if (!sameOrigin(toUrl, startingUrl(state))) {
      void stop('left-site');
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
      generation, captureId, toUrl, windowStartMs: captureWindowStartMs(previous, receiptMs),
      handshake: handshake ? { ...handshake } : undefined,
      handshakeReady: !handshake,
      signal: abort.signal,
    });
  }

  async function completeNavigation(input: {
    generation: number;
    captureId: string;
    toUrl: string;
    windowStartMs: number;
    handshake?: PendingDocumentHandshake;
    handshakeReady: boolean;
    signal: AbortSignal;
  }): Promise<void> {
    const settledMs = now();
    const minimum = delay(Math.max(0, input.windowStartMs + POST_ACTION_DELAY_MS - settledMs), input.signal);
    // The screenshot stays bound to its capture window, but a new document
    // always gets a full window to connect, even one that began late in the
    // window of the action that caused it.
    const windowEndMs = input.handshake
      ? Math.max(input.windowStartMs, settledMs) + NAVIGATION_WINDOW_MS
      : input.windowStartMs + NAVIGATION_WINDOW_MS;
    const timeout = delay(Math.max(0, windowEndMs - settledMs), input.signal).then(() => 'timeout' as const);
    const work = performNavigation(input, minimum).then(() => 'complete' as const, error => {
      if (isCurrentNavigation(input.generation, input.captureId, input.toUrl)) {
        if (input.handshake && !input.handshakeReady) void stopAfterFailedHandshake(input.captureId, captureFailureFromError(error));
        else settleCapture(input.captureId, captureFailureFromError(error));
      }
      return 'complete' as const;
    });
    const result = await Promise.race([work, timeout]);
    if (result === 'timeout' && isCurrentNavigation(input.generation, input.captureId, input.toUrl)) {
      if (input.handshake && !input.handshakeReady) void stopAfterFailedHandshake(input.captureId, 'navigation-timeout');
      else settleCapture(input.captureId, 'navigation-timeout');
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
    windowStartMs: number;
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
        includeEnteredValues: adopted.draft.includeEnteredValues,
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
    if (now() >= input.windowStartMs + NAVIGATION_WINDOW_MS) {
      settleCapture(input.captureId, 'navigation-timeout');
      return;
    }
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
    if (!Number.isFinite(capturedMs) || capturedMs < input.windowStartMs + POST_ACTION_DELAY_MS
      || capturedMs >= input.windowStartMs + NAVIGATION_WINDOW_MS
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

  // The new document never connected, so recording cannot continue. Name a
  // withdrawn page grant (Firefox, on every document load) instead of a
  // generic failure; the navigation step and earlier steps are kept.
  async function stopAfterFailedHandshake(captureId: string, failure: CaptureFailure): Promise<void> {
    if (state.phase !== 'recording') return;
    const ownerTabId = state.ownerTabId;
    const generation = invalidateWork();
    let accessLost = false;
    try { accessLost = await adapter.pageAccessLost?.(ownerTabId) ?? false; }
    catch { /* Keep the generic capture failure. */ }
    if (generation !== workGeneration) return;
    settleCapture(captureId, accessLost ? 'capture-denied' : failure);
    await stop(accessLost ? 'page-access-lost' : 'capture-failed');
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
    // The review guards passed, so an unchanged draft means the removal
    // itself was refused; say so instead of leaving the step in silently.
    if (next === previous) throw new Error('The step could not be removed.');
    publish(next);
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

  async function redactLabel(input: JourneyRedactLabelInput): Promise<void> {
    const previous = currentReview(state, input);
    const next = redactJourneyLabel(previous, input);
    if (next !== previous) publish(next);
  }

  async function reviewImage(input: JourneyImageReviewRequest): Promise<void> {
    const previous = currentReview(state, input);
    const updatedAt = new Date(Math.max(now(), Date.parse(previous.draft.updatedAt))).toISOString();
    const guard = { epoch: input.epoch, journeyId: input.journeyId, revision: input.revision, imageId: input.imageId, updatedAt };
    const result = applyJourneyImageReview(previous, input.operation === 'replace'
      ? {
        operation: 'replace', ...guard,
        image: { dataUrl: input.image.dataUrl, width: input.image.width, height: input.image.height, byteLength: input.image.byteLength },
      }
      : { operation: 'remove', ...guard });
    if (!result.ok) throw new Error('The screenshot review could not be applied.');
    publish(result.value);
  }

  async function reopen(input: {
    ownerTabId: number; ownerWindowId: number;
    draft: JourneyDraftV1; images: Record<string, JourneyDraftImage>;
  }): Promise<ReviewingJourneySession> {
    const previous = state;
    if (previous.phase === 'starting' || previous.phase === 'recording'
      || previous.phase === 'reviewing' || previous.phase === 'saving') {
      throw new JourneyControllerError('busy', 'Finish or discard the current journey before reopening a saved one.');
    }
    if (!Number.isSafeInteger(input.ownerTabId) || input.ownerTabId < 0
      || !Number.isSafeInteger(input.ownerWindowId) || input.ownerWindowId < 0) {
      throw new Error('Reopening needs an available website tab.');
    }
    invalidateWork();
    launching = false;
    pendingHandshake = undefined;
    const next = reopenJourneySnapshot(previous, {
      sessionId: newId('session'),
      ownerTabId: input.ownerTabId,
      ownerWindowId: input.ownerWindowId,
      nowMs: now(),
      draft: input.draft,
      images: input.images,
    });
    if (!next) throw new Error('The saved journey no longer fits in temporary storage.');
    if (next === previous || next.phase !== 'reviewing') throw new Error('The saved journey could not be reopened.');
    publish(next);
    return next;
  }

  async function save(acknowledged: unknown): Promise<{ journeyId: string; revision: number }> {
    const previous = state;
    if (previous.phase !== 'reviewing') throw new Error('Journey review is not ready to save.');
    const gating = reviewSaveGating(previous);
    if (!gating.ready) {
      throw new Error(`Journey review is not ready to save: ${gating.reasons.join(', ')}.`);
    }
    if (acknowledged !== true) throw new Error('Journey saving needs a review acknowledgement.');
    if (!adapter.saveSnapshot) throw new Error('Journey saving is unavailable.');
    // Every review edit requires the reviewing phase, so while the snapshot
    // is written an edit from any review surface is refused as stale instead
    // of landing in the draft and being published over by the saved state.
    const saving: SavingJourneySession = {
      phase: 'saving', sessionId: previous.sessionId, journeyId: previous.journeyId, epoch: previous.epoch,
      ownerTabId: previous.ownerTabId, ownerWindowId: previous.ownerWindowId, draft: previous.draft,
    };
    publish(saving);
    let saved: { journeyId: string; revision: number };
    try {
      saved = await adapter.saveSnapshot({ draft: previous.draft, images: previous.draft.images });
    } catch (error) {
      if (state === saving) publish(previous);
      throw error;
    }
    // A discard during the write already ended the review; the snapshot stays saved.
    if (state === saving) {
      publish({ phase: 'saved', epoch: previous.epoch + 1, journeyId: saved.journeyId, revision: saved.revision });
    }
    return saved;
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

  return { getState: () => state, start, observeNavigation, acceptBatch, stop, discard, updateSummary, removeStep, editValue, redactUrl, redactLabel, reviewImage, save, reopen };
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

function startingUrl(state: RecordingJourneySession): string | undefined {
  const first = state.draft.steps[0];
  return first?.sourceUrl;
}

// Exact origin, not registrable site: another subdomain, port, or scheme leaves.
function sameOrigin(first: string, second: string | undefined): boolean {
  if (!second) return true;
  try {
    return new URL(first).origin === new URL(second).origin;
  } catch {
    return false;
  }
}

// Each action opens a capture window: its screenshot, and that of any
// navigation it causes, is taken at least 500 ms after it and within five
// seconds of it, so redirects share the action's window instead of
// restarting it. A navigation observed after the window closed had no recent
// action (an idle reload, back/forward, or a timer): it opens its own window
// from the moment it was observed, and its redirects share that one.
function captureWindowStartMs(state: RecordingJourneySession, receiptMs: number): number {
  let startMs = Date.parse(state.draft.startedAt);
  for (const step of state.draft.steps) {
    const observedMs = Date.parse(step.observedAt);
    if (step.kind !== 'navigation' || observedMs >= startMs + NAVIGATION_WINDOW_MS) startMs = observedMs;
  }
  return receiptMs >= startMs + NAVIGATION_WINDOW_MS ? receiptMs : startMs;
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
  // No save survives in this controller, so an interrupted save returns to review.
  const restored = restoredState.phase === 'saving' ? resumeSavingReview(restoredState) : restoredState;
  if (restored.phase === 'reviewing' && nowMs >= Date.parse(restored.expiresAt)) {
    return { phase: 'idle', epoch: restored.epoch + 1 };
  }
  if (restored !== restoredState) return restored;
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
