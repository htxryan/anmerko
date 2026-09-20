import {
  acceptInitialImage,
  acceptJourneyEventBatch,
  createJourneySession,
  failInitialImage,
  resolveJourneyCapture,
  stopJourney,
  type JourneyDraftImage,
  type JourneySession,
  type Point,
  type RecordingJourneySession,
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
}

export interface JourneyControllerAdapter {
  identify(tabId: number): Promise<JourneyPageIdentity>;
  capture(tabId: number, identity: JourneyPageIdentity, captureId: string): Promise<JourneyDraftImage>;
  begin(tabId: number, input: {
    sessionId: string;
    epoch: number;
    documentToken: string;
    startedAt: string;
    count: number;
  }): Promise<void>;
  end(tabId: number, input: { sessionId: string; epoch: number }): Promise<void>;
  changed(state: JourneySession): void;
  now?(): number;
  delay?(ms: number): Promise<void>;
}

export interface JourneyController {
  getState(): JourneySession;
  start(input: { ownerTabId: number; ownerWindowId: number; includeEnteredValues?: boolean }): Promise<void>;
  acceptBatch(batch: unknown, senderTabId: number): void;
  stop(reason?: StopReason): Promise<void>;
  discard(): Promise<void>;
}

export type JourneyControllerErrorCode = 'busy' | 'invalid-start' | 'owner-unavailable' | 'initial-capture-failed';

export class JourneyControllerError extends Error {
  constructor(readonly code: JourneyControllerErrorCode, message: string) {
    super(message);
    this.name = 'JourneyControllerError';
  }
}

const POST_ACTION_DELAY_MS = 500;

export function createJourneyController(adapter: JourneyControllerAdapter): JourneyController {
  let state: JourneySession = { phase: 'idle', epoch: 0 };
  let workGeneration = 0;
  let launching = false;
  const now = () => adapter.now?.() ?? Date.now();
  const delay = (ms: number) => adapter.delay?.(ms) ?? new Promise<void>(resolve => setTimeout(resolve, ms));
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
      });
      if (!isCurrentStart(generation, starting)) {
        await safeEnd(input.ownerTabId, accepted.sessionId, state.epoch);
        return;
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
    const previous = state;
    let next = acceptJourneyEventBatch(previous, validated.value);
    if (next === previous) return;
    const generation = ++workGeneration;
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

  async function captureAfterAction(generation: number, captureId: string): Promise<void> {
    try {
      await delay(POST_ACTION_DELAY_MS);
      if (!isCurrentRecording(generation, captureId)) return;
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
      if (resolved !== state) publish(resolved);
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

  async function stop(reason: StopReason = 'user'): Promise<void> {
    const previous = state;
    ++workGeneration;
    launching = false;
    if (previous.phase !== 'starting' && previous.phase !== 'recording') return;
    const stopped = stopJourney(previous, {
      epoch: previous.epoch,
      stoppedAt: new Date(Math.max(now(), Date.parse(previous.draft.startedAt))).toISOString(),
      reason,
    });
    if (stopped !== previous) publish(stopped);
    await safeEnd(previous.ownerTabId, previous.sessionId, stopped.epoch);
  }

  async function discard(): Promise<void> {
    const previous = state;
    ++workGeneration;
    launching = false;
    if (previous.phase === 'idle') return;
    const next: JourneySession = { phase: 'idle', epoch: previous.epoch + 1 };
    publish(next);
    if ('ownerTabId' in previous && 'sessionId' in previous) await safeEnd(previous.ownerTabId, previous.sessionId, next.epoch);
  }

  async function safeEnd(tabId: number, sessionId: string, epoch: number): Promise<void> {
    try { await adapter.end(tabId, { sessionId, epoch }); }
    catch { /* State is already inactive; teardown is best effort. */ }
  }

  function isCurrentStart(generation: number, starting: JourneySession): boolean {
    return generation === workGeneration && state === starting && state.phase === 'starting';
  }

  function isCurrentRecording(generation: number, captureId: string): boolean {
    return generation === workGeneration && state.phase === 'recording'
      && state.draft.steps.some(step => step.image.status === 'pending' && step.image.captureId === captureId);
  }

  return { getState: () => state, start, acceptBatch, stop, discard };
}

function newId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
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
