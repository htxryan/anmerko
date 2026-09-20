import { expect, test } from '@playwright/test';
import {
  acceptInitialImage,
  acceptJourneyEventBatch,
  createJourneySession,
  stopJourney,
  type JourneyDraftImage,
  type JourneySession,
  type RecordingJourneySession,
} from '../../src/journey-core';
import {
  createJourneyController,
  type JourneyControllerAdapter,
  type JourneyPageIdentity,
} from '../../src/journey-controller';
import type { JourneyEventBatchV1 } from '../../src/journey-events';
import { JOURNEY_LIMITS } from '../../src/journey-limits';

const START_MS = Date.parse('2026-09-20T12:00:00.000Z');
const START_URL = 'https://example.com/start?item=1#details';
const MINIMAL_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+AvzvAAAAAElFTkSuQmCC';

function image(captureUrl = START_URL, capturedMs = START_MS + 100): JourneyDraftImage {
  return {
    capturedAt: new Date(capturedMs).toISOString(), captureUrl,
    width: 1, height: 1, byteLength: 69, dataUrl: MINIMAL_PNG,
    viewport: { width: 390, height: 844 }, scroll: { x: 0, y: 0 },
  };
}

function baseRecording(): RecordingJourneySession {
  const starting = createJourneySession({
    sessionId: 'session-restored', journeyId: 'journey-restored',
    ownerTabId: 42, ownerWindowId: 7, documentToken: 'document-restored',
    startedAt: new Date(START_MS).toISOString(),
    deadlineAt: new Date(START_MS + JOURNEY_LIMITS.maxDurationMs).toISOString(),
  });
  const active = acceptInitialImage(starting, {
    id: 'step-initial', imageId: 'image-initial',
    observedAt: new Date(START_MS + 100).toISOString(), elapsedMs: 100,
    sourceUrl: START_URL, image: image(),
  });
  if (active.phase !== 'recording') throw new Error('fixture did not enter recording');
  return active;
}

function restoredWithPending(): RecordingJourneySession {
  const active = baseRecording();
  const restored = acceptJourneyEventBatch(active, {
    schemaVersion: 1, sessionId: active.sessionId, epoch: active.epoch,
    documentToken: active.documentToken, localCounter: 2,
    events: [
      clickEvent('step-pending-1', 'capture-pending-1', 200),
      clickEvent('step-pending-2', 'capture-pending-2', 300),
    ],
  });
  if (restored.phase !== 'recording') throw new Error('fixture did not retain recording');
  return restored;
}

function clickEvent(id: string, captureId: string | undefined, elapsedMs: number): JourneyEventBatchV1['events'][number] {
  return {
    kind: 'click', id, observedAt: new Date(START_MS + elapsedMs).toISOString(), elapsedMs,
    sourceUrl: START_URL,
    target: {
      tag: 'button', role: 'button', selectorPath: ['main', 'button'], label: 'Continue',
      editable: false, viewport: { width: 390, height: 844 }, scroll: { x: 0, y: 0 },
      point: { x: 100, y: 200 },
    },
    image: captureId
      ? { status: 'pending', captureId }
      : { status: 'unavailable', reason: 'capture-error' },
  };
}

function batch(
  state: RecordingJourneySession,
  localCounter: number,
  options: { documentToken?: string; captureId?: string; id?: string } = {},
): JourneyEventBatchV1 {
  const elapsedMs = (state.draft.steps.at(-1)?.elapsedMs ?? 0) + 100;
  return {
    schemaVersion: 1, sessionId: state.sessionId, epoch: state.epoch,
    documentToken: options.documentToken ?? state.documentToken, localCounter,
    events: [clickEvent(options.id ?? `step-${localCounter}`, options.captureId, elapsedMs)],
  };
}

function identity(documentToken = 'document-restored', url = START_URL): JourneyPageIdentity {
  return {
    documentToken, url, generation: 1, visible: true,
    viewport: { width: 390, height: 844 }, scroll: { x: 0, y: 0 },
  };
}

function fixture(overrides: Partial<JourneyControllerAdapter> = {}) {
  const calls = {
    identify: [] as number[],
    capture: [] as string[],
    begin: [] as Parameters<JourneyControllerAdapter['begin']>[1][],
    end: [] as Parameters<JourneyControllerAdapter['end']>[1][],
    changed: [] as JourneySession[],
  };
  const value = {
    nowMs: START_MS + 1_000,
    current: identity(),
    calls,
    adapter: undefined as unknown as JourneyControllerAdapter,
  };
  value.adapter = {
    now: () => value.nowMs,
    delay: overrides.delay ?? (async () => undefined),
    identify: async tabId => {
      calls.identify.push(tabId);
      return overrides.identify ? overrides.identify(tabId) : structuredClone(value.current);
    },
    capture: async (tabId, pageIdentity, captureId) => {
      calls.capture.push(captureId);
      return overrides.capture
        ? overrides.capture(tabId, pageIdentity, captureId)
        : image(pageIdentity.url, value.nowMs + 100);
    },
    begin: async (tabId, input) => {
      calls.begin.push(input);
      await overrides.begin?.(tabId, input);
    },
    end: async (tabId, input) => {
      calls.end.push(input);
      await overrides.end?.(tabId, input);
    },
    changed: state => { calls.changed.push(state); overrides.changed?.(state); },
  };
  return value;
}

test('restored recording preserves ownership and counters, abandons pending captures, and accepts only the next authentic batch', () => {
  const restored = restoredWithPending();
  const harness = fixture();
  const controller = createJourneyController(harness.adapter, restored);

  const recovered = controller.getState();
  expect(recovered.phase).toBe('recording');
  if (recovered.phase !== 'recording') return;
  expect({
    sessionId: recovered.sessionId,
    journeyId: recovered.journeyId,
    ownerTabId: recovered.ownerTabId,
    ownerWindowId: recovered.ownerWindowId,
    epoch: recovered.epoch,
    documentToken: recovered.documentToken,
    documentCounters: recovered.documentCounters,
    sequences: recovered.draft.steps.map(step => step.seq),
  }).toEqual({
    sessionId: restored.sessionId,
    journeyId: restored.journeyId,
    ownerTabId: restored.ownerTabId,
    ownerWindowId: restored.ownerWindowId,
    epoch: restored.epoch,
    documentToken: restored.documentToken,
    documentCounters: restored.documentCounters,
    sequences: [1, 2, 3],
  });
  expect(recovered.draft.steps.slice(1).map(step => step.image)).toEqual([
    { status: 'unavailable', reason: 'capture-error' },
    { status: 'unavailable', reason: 'capture-error' },
  ]);
  expect(harness.calls.capture).toEqual([]);
  expect(harness.calls.begin).toEqual([]);

  const next = batch(recovered, 3);
  controller.acceptBatch(next, recovered.ownerTabId);
  const accepted = controller.getState();
  expect(accepted.phase).toBe('recording');
  if (accepted.phase !== 'recording') return;
  expect(accepted.documentCounters[accepted.documentToken]).toBe(3);
  expect(accepted.draft.steps.map(step => step.seq)).toEqual([1, 2, 3, 4]);

  controller.acceptBatch(next, accepted.ownerTabId);
  controller.acceptBatch(batch(accepted, 4, { documentToken: 'document-stale', id: 'stale-document' }), accepted.ownerTabId);
  controller.acceptBatch(batch(accepted, 4, { id: 'wrong-owner' }), 99);
  expect(controller.getState()).toBe(accepted);
  expect(harness.calls.capture).toEqual([]);
});

test('restored review remains passive and an expired review becomes idle without adapter work', () => {
  const active = baseRecording();
  const review = stopJourney(active, {
    epoch: active.epoch, stoppedAt: new Date(START_MS + 1_000).toISOString(), reason: 'user',
  });
  if (review.phase !== 'reviewing') throw new Error('fixture did not enter review');

  const liveHarness = fixture();
  const live = createJourneyController(liveHarness.adapter, review);
  live.acceptBatch(batch(active, 1), active.ownerTabId);
  live.observeNavigation({ ownerTabId: active.ownerTabId, url: 'https://example.com/next', kind: 'document' });
  expect(live.getState()).toEqual(review);
  expect(liveHarness.calls).toEqual({ identify: [], capture: [], begin: [], end: [], changed: [] });

  const expiredHarness = fixture();
  expiredHarness.nowMs = Date.parse(review.expiresAt);
  const expired = createJourneyController(expiredHarness.adapter, review);
  expect(expired.getState()).toEqual({ phase: 'idle', epoch: review.epoch + 1 });
  expect(expiredHarness.calls).toEqual({ identify: [], capture: [], begin: [], end: [], changed: [] });
});

test('restored recording elapsed during suspension stops at its original deadline and review expiry stays anchored there', () => {
  const active = restoredWithPending();
  const harness = fixture();
  harness.nowMs = Date.parse(active.deadlineAt) + 45_000;

  const stopped = createJourneyController(harness.adapter, active).getState();

  expect(stopped.phase).toBe('reviewing');
  if (stopped.phase !== 'reviewing') return;
  expect(stopped.draft.stoppedAt).toBe(active.deadlineAt);
  expect(stopped.draft.stopReason).toBe('duration-limit');
  expect(stopped.expiresAt).toBe(new Date(Date.parse(active.deadlineAt) + JOURNEY_LIMITS.maxReviewIdleMs).toISOString());
  expect(stopped.draft.steps.slice(1).map(step => step.image)).toEqual([
    { status: 'unavailable', reason: 'stopped' },
    { status: 'unavailable', reason: 'stopped' },
  ]);

  const expiryHarness = fixture();
  expiryHarness.nowMs = Date.parse(stopped.expiresAt);
  expect(createJourneyController(expiryHarness.adapter, stopped).getState()).toEqual({
    phase: 'idle', epoch: stopped.epoch + 1,
  });
  expect(harness.calls.capture).toEqual([]);
  expect(harness.calls.begin).toEqual([]);
});

test('late start and capture promises cannot mutate discarded or replacement state', async () => {
  const pendingIdentity = deferred<JourneyPageIdentity>();
  const startHarness = fixture({ identify: () => pendingIdentity.promise });
  const startingController = createJourneyController(startHarness.adapter);
  const starting = startingController.start({ ownerTabId: 42, ownerWindowId: 7 });
  await startingController.discard();
  pendingIdentity.resolve(identity());
  await starting;
  expect(startingController.getState()).toEqual({ phase: 'idle', epoch: 0 });
  expect(startHarness.calls.capture).toEqual([]);
  expect(startHarness.calls.begin).toEqual([]);

  const oldCapture = deferred<JourneyDraftImage>();
  let captures = 0;
  const captureHarness = fixture({
    capture: (_tabId, pageIdentity) => {
      captures += 1;
      return captures === 1 ? oldCapture.promise : Promise.resolve(image(pageIdentity.url, captureHarness.nowMs + 100));
    },
  });
  const controller = createJourneyController(captureHarness.adapter, baseRecording());
  const restored = controller.getState();
  if (restored.phase !== 'recording') throw new Error('fixture did not recover recording');
  controller.acceptBatch(batch(restored, 1, { captureId: 'capture-old' }), restored.ownerTabId);
  await expect.poll(() => captureHarness.calls.capture.length).toBe(1);

  await controller.discard();
  await controller.start({ ownerTabId: 42, ownerWindowId: 7 });
  const replacement = structuredClone(controller.getState());
  expect(replacement.phase).toBe('recording');

  oldCapture.resolve(image(START_URL, captureHarness.nowMs + 100));
  await Promise.resolve();
  await Promise.resolve();
  expect(controller.getState()).toEqual(replacement);
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject });
  return { promise, resolve, reject };
}
