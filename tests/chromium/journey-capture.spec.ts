import { expect, test } from '@playwright/test';
import { createJourneyController, type JourneyControllerAdapter, type JourneyPageIdentity } from '../../src/journey-controller';
import type { JourneyDraftImage, JourneySession } from '../../src/journey-core';
import type { JourneyEventBatchV1 } from '../../src/journey-events';
import { JOURNEY_LIMITS } from '../../src/journey-limits';

const startMs = Date.parse('2026-09-20T12:00:00.000Z');

test('initial capture gates recorder begin and strips URL credentials', async () => {
  const capture = deferred<JourneyDraftImage>();
  const fixture = adapterFixture({ capture: () => capture.promise });
  const controller = createJourneyController(fixture.adapter);

  const starting = controller.start({ ownerTabId: 42, ownerWindowId: 7 });
  await eventually(() => expect(controller.getState().phase).toBe('starting'));
  expect(fixture.calls.begin).toHaveLength(0);

  capture.resolve(image('https://user:secret@example.com/start?q=1#top'));
  await starting;

  expect(controller.getState().phase).toBe('recording');
  expect(fixture.calls.begin).toHaveLength(1);
  const state = controller.getState();
  if (state.phase === 'recording') {
    expect(state.draft.includeEnteredValues).toBe(false);
    expect(state.draft.steps[0].sourceUrl).toBe('https://example.com/start?q=1#top');
    expect(state.draft.images[state.draft.steps[0].image.status === 'retained' ? state.draft.steps[0].image.imageId : ''].captureUrl)
      .toBe('https://example.com/start?q=1#top');
  }
});

test('initial capture failure returns to idle and permits a retry', async () => {
  let attempts = 0;
  const fixture = adapterFixture({
    capture: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('capture denied');
      return image('https://user:secret@example.com/start?q=1#top');
    },
  });
  const controller = createJourneyController(fixture.adapter);

  await expect(controller.start({ ownerTabId: 42, ownerWindowId: 7, includeEnteredValues: true }))
    .rejects.toMatchObject({ code: 'initial-capture-failed' });
  expect(controller.getState().phase).toBe('idle');
  expect(fixture.calls.begin).toHaveLength(0);

  await controller.start({ ownerTabId: 42, ownerWindowId: 7, includeEnteredValues: true });
  expect(controller.getState().phase).toBe('recording');
  const state = controller.getState();
  if (state.phase === 'recording') expect(state.draft.includeEnteredValues).toBe(true);
});

test('invalid or concurrent starts reject with actionable generic errors', async () => {
  const fixture = adapterFixture();
  const controller = createJourneyController(fixture.adapter);

  await expect(controller.start({ ownerTabId: -1, ownerWindowId: 7 }))
    .rejects.toMatchObject({ code: 'invalid-start' });
  expect(controller.getState().phase).toBe('idle');

  await controller.start({ ownerTabId: 42, ownerWindowId: 7 });
  await expect(controller.start({ ownerTabId: 42, ownerWindowId: 7 }))
    .rejects.toMatchObject({ code: 'busy' });
});

test('Stop during initial identification invalidates the late launch', async () => {
  const identify = deferred<JourneyPageIdentity>();
  const fixture = adapterFixture({ identify: () => identify.promise });
  const controller = createJourneyController(fixture.adapter);

  const starting = controller.start({ ownerTabId: 42, ownerWindowId: 7 });
  const stopping = controller.stop();
  expect(controller.getState().phase).toBe('idle');
  identify.resolve(fixture.identity);
  await Promise.all([starting, stopping]);

  expect(controller.getState().phase).toBe('idle');
  expect(fixture.calls.capture).toHaveLength(0);
  expect(fixture.calls.begin).toHaveLength(0);
});

test('only the owner can add a current batch and its image is captured after 500 ms', async () => {
  const fixture = adapterFixture();
  const controller = createJourneyController(fixture.adapter);
  await controller.start({ ownerTabId: 42, ownerWindowId: 7 });
  const state = recording(controller.getState());
  const batch = clickBatch(state, 1, 'step-click-1', 'capture-click-1');

  controller.acceptBatch(batch, 99);
  expect(recording(controller.getState()).draft.steps).toHaveLength(1);
  controller.acceptBatch({ ...batch, documentToken: 'stale-document' }, 42);
  expect(recording(controller.getState()).draft.steps).toHaveLength(1);

  fixture.nowMs = startMs + 100;
  controller.acceptBatch(batch, 42);
  expect(recording(controller.getState()).draft.steps.map(step => step.seq)).toEqual([1, 2]);
  expect(fixture.calls.delays).toEqual([500]);
  expect(fixture.calls.capture).toHaveLength(1);

  fixture.nowMs = startMs + 600;
  fixture.resolveDelay(0);
  await eventually(() => {
    const updated = recording(controller.getState());
    expect(updated.draft.steps[1].image.status).toBe('retained');
  });
  expect(fixture.calls.capture).toHaveLength(2);
});

test('a newer action supersedes an older pending image without queuing its capture', async () => {
  const fixture = adapterFixture();
  const controller = createJourneyController(fixture.adapter);
  await controller.start({ ownerTabId: 42, ownerWindowId: 7 });
  let state = recording(controller.getState());

  controller.acceptBatch(clickBatch(state, 1, 'step-click-1', 'capture-click-1'), 42);
  state = recording(controller.getState());
  controller.acceptBatch(clickBatch(state, 2, 'step-click-2', 'capture-click-2'), 42);

  state = recording(controller.getState());
  expect(state.draft.steps[1].image).toEqual({ status: 'unavailable', reason: 'superseded' });
  expect(state.draft.steps[2].image).toEqual({ status: 'pending', captureId: 'capture-click-2' });
  fixture.resolveDelay(0);
  await Promise.resolve();
  expect(fixture.calls.capture).toHaveLength(1);
  fixture.nowMs = startMs + 700;
  fixture.resolveDelay(1);
  await eventually(() => expect(fixture.calls.capture).toHaveLength(2));
  expect(recording(controller.getState()).draft.steps[2].image.status).toBe('retained');
});

test('a post-action image from another URL is explicitly unavailable', async () => {
  let captures = 0;
  const fixture = adapterFixture({
    capture: async (_tabId, identity) => {
      captures += 1;
      return captures === 1
        ? image(identity.url)
        : image('https://wrong.example/result', iso(fixture.nowMs));
    },
  });
  const controller = createJourneyController(fixture.adapter);
  await controller.start({ ownerTabId: 42, ownerWindowId: 7 });
  const state = recording(controller.getState());
  controller.acceptBatch(clickBatch(state, 1, 'step-click-1', 'capture-click-1'), 42);
  fixture.nowMs = startMs + 600;
  fixture.resolveDelay(0);

  await eventually(() => {
    const updated = recording(controller.getState());
    expect(updated.draft.steps[1].image).toEqual({ status: 'unavailable', reason: 'page-document-changed' });
  });
});

test('post-action capture preserves a safe typed image failure reason', async () => {
  let captures = 0;
  const fixture = adapterFixture({
    capture: async (_tabId, identity) => {
      captures += 1;
      if (captures > 1) throw Object.assign(new Error('normalized image rejected'), { reason: 'too-large' });
      return image(identity.url);
    },
  });
  const controller = createJourneyController(fixture.adapter);
  await controller.start({ ownerTabId: 42, ownerWindowId: 7 });
  const state = recording(controller.getState());
  controller.acceptBatch(clickBatch(state, 1, 'step-click-1', 'capture-click-1'), 42);
  fixture.resolveDelay(0);

  await eventually(() => {
    const updated = recording(controller.getState());
    expect(updated.draft.steps[1].image).toEqual({ status: 'unavailable', reason: 'too-large' });
  });
});

test('Stop advances state and epoch before awaiting teardown, then ignores a late capture', async () => {
  const end = deferred<void>();
  const capture = deferred<JourneyDraftImage>();
  let captureCount = 0;
  const fixture = adapterFixture({
    capture: async (_tabId, identity) => {
      captureCount += 1;
      return captureCount === 1 ? image(identity.url) : capture.promise;
    },
    end: () => end.promise,
  });
  const controller = createJourneyController(fixture.adapter);
  await controller.start({ ownerTabId: 42, ownerWindowId: 7 });
  const state = recording(controller.getState());
  controller.acceptBatch(clickBatch(state, 1, 'step-click-1', 'capture-click-1'), 42);
  fixture.resolveDelay(0);
  await eventually(() => expect(fixture.calls.capture).toHaveLength(2));

  const stopping = controller.stop();
  const stopped = controller.getState();
  expect(stopped.phase).toBe('reviewing');
  expect(stopped.epoch).toBe(state.epoch + 1);
  if (stopped.phase === 'reviewing') expect(stopped.draft.steps[1].image).toEqual({ status: 'unavailable', reason: 'stopped' });
  expect(fixture.calls.end).toHaveLength(1);

  capture.resolve(image(fixture.identity.url));
  end.resolve();
  await stopping;
  expect(controller.getState()).toBe(stopped);
});

test('an action image-budget stop tears down the page recorder', async () => {
  const fixture = adapterFixture({
    capture: async (_tabId, identity) => ({
      ...image(identity.url, iso(fixture.nowMs)),
      width: 1, height: 1,
      byteLength: JOURNEY_LIMITS.maxImageBytes,
      dataUrl: fixturePngDataUrl(JOURNEY_LIMITS.maxImageBytes),
    }),
  });
  const controller = createJourneyController(fixture.adapter);
  await controller.start({ ownerTabId: 42, ownerWindowId: 7 });

  for (let counter = 1; counter <= 6; counter += 1) {
    const state = recording(controller.getState());
    const actionAt = startMs + counter * 1000;
    fixture.nowMs = actionAt;
    controller.acceptBatch(timedClickBatch(state, counter, `budget-step-${counter}`, `budget-capture-${counter}`, iso(actionAt), counter * 1000), 42);
    fixture.nowMs = actionAt + 500;
    fixture.resolveDelay(counter - 1);
    await eventually(() => {
      if (counter < 6) expect(recording(controller.getState()).draft.steps.at(-1)?.image.status).toBe('retained');
      else expect(controller.getState().phase).toBe('reviewing');
    });
  }

  const stopped = controller.getState();
  expect(stopped.phase).toBe('reviewing');
  if (stopped.phase === 'reviewing') expect(stopped.draft.stopReason).toBe('image-budget');
  expect(fixture.calls.end).toHaveLength(1);
  expect(fixture.calls.end[0]).toMatchObject({ tabId: 42 });
  expect((fixture.calls.end[0] as { input: object }).input).not.toHaveProperty('documentToken');
});

test('the core step and duration limits freeze capture for review', async () => {
  const fixture = adapterFixture();
  const controller = createJourneyController(fixture.adapter);
  await controller.start({ ownerTabId: 42, ownerWindowId: 7 });
  let state = recording(controller.getState());
  const events = Array.from({ length: 29 }, (_, index) => clickEvent(index + 1, `limit-step-${index}`, `limit-capture-${index}`));
  controller.acceptBatch({
    schemaVersion: 1, sessionId: state.sessionId, epoch: state.epoch,
    documentToken: state.documentToken, localCounter: 1, events,
  }, 42);
  expect(controller.getState().phase).toBe('reviewing');

  await controller.discard();
  fixture.nowMs = startMs;
  await controller.start({ ownerTabId: 42, ownerWindowId: 7 });
  state = recording(controller.getState());
  fixture.nowMs = startMs + 5 * 60 * 1_000;
  controller.acceptBatch(clickBatch(state, 1, 'late-step', 'late-capture'), 42);
  const expired = controller.getState();
  expect(expired.phase).toBe('reviewing');
  if (expired.phase === 'reviewing') expect(expired.draft.stopReason).toBe('duration-limit');
});

test('restores recording ownership and counters while abandoning old pending capture work', async () => {
  const firstFixture = adapterFixture();
  const first = createJourneyController(firstFixture.adapter);
  await first.start({ ownerTabId: 42, ownerWindowId: 7 });
  let before = recording(first.getState());
  first.acceptBatch(clickBatch(before, 4, 'recovered-step', 'recovered-capture'), 42);
  before = recording(first.getState());
  expect(before.draft.steps.at(-1)?.image).toEqual({ status: 'pending', captureId: 'recovered-capture' });

  const recoveredFixture = adapterFixture();
  const recovered = createJourneyController(recoveredFixture.adapter, before);
  const state = recording(recovered.getState());

  expect(state).toMatchObject({
    sessionId: before.sessionId,
    journeyId: before.journeyId,
    epoch: before.epoch,
    ownerTabId: before.ownerTabId,
    ownerWindowId: before.ownerWindowId,
    documentToken: before.documentToken,
    documentCounters: { [before.documentToken]: 4 },
  });
  expect(state.draft.steps.map(step => step.seq)).toEqual([1, 2]);
  expect(state.draft.steps.at(-1)?.image).toEqual({ status: 'unavailable', reason: 'capture-error' });
  expect(recoveredFixture.calls.capture).toHaveLength(0);
  expect(recoveredFixture.calls.begin).toHaveLength(0);
});

test('applies an elapsed recording deadline at recovery and anchors review expiry to that deadline', async () => {
  const firstFixture = adapterFixture();
  const first = createJourneyController(firstFixture.adapter);
  await first.start({ ownerTabId: 42, ownerWindowId: 7 });
  const before = recording(first.getState());
  const recoveredFixture = adapterFixture();
  recoveredFixture.nowMs = Date.parse(before.deadlineAt) + 60_000;

  const recovered = createJourneyController(recoveredFixture.adapter, before);
  const state = recovered.getState();

  expect(state.phase).toBe('reviewing');
  if (state.phase === 'reviewing') {
    expect(state.draft.stopReason).toBe('duration-limit');
    expect(state.draft.stoppedAt).toBe(before.deadlineAt);
    expect(state.expiresAt).toBe(new Date(Date.parse(before.deadlineAt) + JOURNEY_LIMITS.maxReviewIdleMs).toISOString());
  }
});

function adapterFixture(overrides: Partial<JourneyControllerAdapter> = {}) {
  const delays: Array<ReturnType<typeof deferred<void>>> = [];
  const calls = {
    identify: [] as number[], capture: [] as Array<{ tabId: number; identity: JourneyPageIdentity; captureId: string }>,
    begin: [] as unknown[], end: [] as unknown[], changed: [] as JourneySession[], delays: [] as number[],
  };
  const fixture = {
    nowMs: startMs,
    identity: {
      documentToken: 'document-1', url: 'https://user:secret@example.com/start?q=1#top',
      viewport: { width: 390, height: 844 }, scroll: { x: 0, y: 0 }, generation: 1, visible: true,
    } satisfies JourneyPageIdentity,
    calls,
    resolveDelay(index: number) { delays[index].resolve(); },
    adapter: undefined as unknown as JourneyControllerAdapter,
  };
  fixture.adapter = {
    now: () => overrides.now?.() ?? fixture.nowMs,
    delay: ms => {
      calls.delays.push(ms);
      if (overrides.delay) return overrides.delay(ms);
      const wait = deferred<void>(); delays.push(wait); return wait.promise;
    },
    identify: async tabId => {
      calls.identify.push(tabId);
      return overrides.identify ? overrides.identify(tabId) : { ...fixture.identity };
    },
    capture: async (tabId, identity, captureId) => {
      calls.capture.push({ tabId, identity, captureId });
      return overrides.capture ? overrides.capture(tabId, identity, captureId) : image(identity.url, iso(fixture.nowMs));
    },
    begin: async (tabId, input) => {
      calls.begin.push({ tabId, input });
      await overrides.begin?.(tabId, input);
    },
    end: async (tabId, input) => {
      calls.end.push({ tabId, input });
      await overrides.end?.(tabId, input);
    },
    changed: state => { calls.changed.push(state); overrides.changed?.(state); },
  };
  return fixture;
}

function fixturePngDataUrl(byteLength: number): string {
  const png = new Uint8Array(byteLength);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  png.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8);
  png.set([0, 0, 0, 1, 0, 0, 0, 1], 16);
  return `data:image/png;base64,${Buffer.from(png).toString('base64')}`;
}

function image(captureUrl: string, capturedAt = '2026-09-20T12:00:00.100Z'): JourneyDraftImage {
  return {
    capturedAt, captureUrl,
    width: 1, height: 1, byteLength: 64,
    dataUrl: fixturePngDataUrl(64),
    viewport: { width: 390, height: 844 }, scroll: { x: 0, y: 0 },
  };
}

function clickBatch(state: Extract<JourneySession, { phase: 'recording' }>, localCounter: number, id: string, captureId: string): JourneyEventBatchV1 {
  return {
    schemaVersion: 1, sessionId: state.sessionId, epoch: state.epoch,
    documentToken: state.documentToken, localCounter,
    events: [clickEvent(localCounter, id, captureId)],
  };
}

function clickEvent(counter: number, id: string, captureId: string) {
  return {
    kind: 'click' as const, id, observedAt: new Date(startMs + counter * 100).toISOString(), elapsedMs: counter * 100,
    sourceUrl: 'https://example.com/start?q=1#top',
    target: {
      tag: 'button', role: 'button', selectorPath: ['main', 'button:nth-of-type(1)'],
      label: 'Continue', editable: false, viewport: { width: 390, height: 844 },
      scroll: { x: 0, y: 0 }, point: { x: 195, y: 700 },
    },
    image: { status: 'pending' as const, captureId },
  };
}

function recording(state: JourneySession) {
  if (state.phase !== 'recording') throw new Error(`Expected recording, received ${state.phase}`);
  return state;
}

function timedClickBatch(
  state: Extract<JourneySession, { phase: 'recording' }>,
  localCounter: number, id: string, captureId: string, observedAt: string, elapsedMs: number,
): JourneyEventBatchV1 {
  return {
    schemaVersion: 1, sessionId: state.sessionId, epoch: state.epoch,
    documentToken: state.documentToken, localCounter,
    events: [{
      kind: 'click', id, observedAt, elapsedMs,
      sourceUrl: 'https://example.com/start?q=1#top',
      target: {
        tag: 'button', selectorPath: ['button'], label: 'Go', editable: false,
        viewport: { width: 390, height: 844 }, scroll: { x: 0, y: 0 }, point: { x: 10, y: 10 },
      },
      image: { status: 'pending', captureId },
    }],
  };
}

const iso = (ms: number) => new Date(ms).toISOString();

test('an action capture 499 ms after the action is explicitly unavailable', async () => {
  const actionAt = startMs + 1000;
  let capturedAt: string | undefined;
  const fixture = adapterFixture({
    capture: async (_tabId, identity) => image(identity.url, capturedAt ?? iso(fixture.nowMs)),
  });
  const controller = createJourneyController(fixture.adapter);
  await controller.start({ ownerTabId: 42, ownerWindowId: 7 });
  capturedAt = iso(actionAt + 499);
  const state = recording(controller.getState());
  controller.acceptBatch(timedClickBatch(state, 1, 'step-early', 'capture-early', iso(actionAt), 1000), 42);

  expect(fixture.calls.delays.at(-1)).toBe(1500);
  fixture.resolveDelay(fixture.calls.delays.length - 1);
  await eventually(() => {
    expect(recording(controller.getState()).draft.steps[1].image)
      .toEqual({ status: 'unavailable', reason: 'navigation-timeout' });
  });
});

test('an action capture exactly 500 ms after the action is retained', async () => {
  const actionAt = startMs + 1000;
  let capturedAt: string | undefined;
  const fixture = adapterFixture({
    capture: async (_tabId, identity) => image(identity.url, capturedAt ?? iso(fixture.nowMs)),
  });
  const controller = createJourneyController(fixture.adapter);
  await controller.start({ ownerTabId: 42, ownerWindowId: 7 });
  capturedAt = iso(actionAt + 500);
  const state = recording(controller.getState());
  controller.acceptBatch(timedClickBatch(state, 1, 'step-boundary', 'capture-boundary', iso(actionAt), 1000), 42);

  fixture.resolveDelay(fixture.calls.delays.length - 1);
  await eventually(() => {
    expect(recording(controller.getState()).draft.steps[1].image.status).toBe('retained');
  });
});

test('an action capture 4999 ms after the action is retained', async () => {
  const actionAt = startMs + 1000;
  let capturedAt: string | undefined;
  const fixture = adapterFixture({
    capture: async (_tabId, identity) => image(identity.url, capturedAt ?? iso(fixture.nowMs)),
  });
  const controller = createJourneyController(fixture.adapter);
  await controller.start({ ownerTabId: 42, ownerWindowId: 7 });
  const state = recording(controller.getState());
  fixture.nowMs = actionAt + 4999;
  controller.acceptBatch(timedClickBatch(state, 1, 'step-late', 'capture-late', iso(actionAt), 1000), 42);

  fixture.resolveDelay(fixture.calls.delays.length - 1);
  await eventually(() => {
    expect(recording(controller.getState()).draft.steps[1].image.status).toBe('retained');
  });
});

test('an action capture at the five-second window end is explicitly unavailable', async () => {
  const actionAt = startMs + 1000;
  let capturedAt: string | undefined;
  const fixture = adapterFixture({
    capture: async (_tabId, identity) => image(identity.url, capturedAt ?? iso(fixture.nowMs)),
  });
  const controller = createJourneyController(fixture.adapter);
  await controller.start({ ownerTabId: 42, ownerWindowId: 7 });
  const state = recording(controller.getState());
  fixture.nowMs = actionAt + 5000;
  const capturesBefore = fixture.calls.capture.length;
  controller.acceptBatch(timedClickBatch(state, 1, 'step-expired', 'capture-expired', iso(actionAt), 1000), 42);

  fixture.resolveDelay(fixture.calls.delays.length - 1);
  await eventually(() => {
    expect(recording(controller.getState()).draft.steps[1].image)
      .toEqual({ status: 'unavailable', reason: 'navigation-timeout' });
  });
  expect(fixture.calls.capture.length).toBe(capturesBefore);
});

test('a redirect shares the initiating action window instead of restarting it', async () => {
  let capturedAt: string | undefined;
  const fixture = adapterFixture({
    capture: async (_tabId, identity) => image(identity.url, capturedAt ?? iso(fixture.nowMs)),
  });
  const controller = createJourneyController(fixture.adapter);
  await controller.start({ ownerTabId: 42, ownerWindowId: 7 });

  fixture.nowMs = startMs + 100;
  fixture.identity.url = 'https://example.com/second';
  controller.observeNavigation({ ownerTabId: 42, url: 'https://example.com/second', kind: 'same-document' });
  capturedAt = iso(startMs + 600);
  fixture.resolveDelay(0);
  await eventually(() => {
    expect(recording(controller.getState()).draft.steps.at(-1)?.image.status).toBe('retained');
  });

  fixture.nowMs = startMs + 4100;
  fixture.identity.url = 'https://example.com/third';
  capturedAt = iso(startMs + 5100);
  controller.observeNavigation({ ownerTabId: 42, url: 'https://example.com/third', kind: 'same-document' });
  fixture.resolveDelay(2);
  await eventually(() => {
    const steps = recording(controller.getState()).draft.steps;
    expect(steps.map(step => step.kind)).toEqual(['initial', 'navigation', 'navigation']);
    expect(steps.at(-1)?.image).toEqual({ status: 'unavailable', reason: 'navigation-timeout' });
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

async function eventually(assertion: () => void): Promise<void> {
  await expect.poll(() => {
    try { assertion(); return true; }
    catch { return false; }
  }).toBe(true);
}
