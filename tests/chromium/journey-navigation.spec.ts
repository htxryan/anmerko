import { expect, test } from '@playwright/test';
import { createJourneyController, type JourneyControllerAdapter, type JourneyPageIdentity } from '../../src/journey-controller';
import type { JourneyDraftImage, JourneySession } from '../../src/journey-core';
import type { JourneyEventBatchV1 } from '../../src/journey-events';
import { JOURNEY_LIMITS } from '../../src/journey-limits';

const START_MS = Date.parse('2026-09-20T12:00:00.000Z');
const START_URL = 'https://example.com/start';

test('document commits are ordered synchronously and only the newest handshake can resume capture', async () => {
  const b = deferred<JourneyPageIdentity>();
  const c = deferred<JourneyPageIdentity>();
  const fixture = navigationFixture({
    connect: (_tabId, expectedUrl) => expectedUrl.endsWith('/b') ? b.promise : c.promise,
  });
  const controller = createJourneyController(fixture.adapter);
  await controller.start({ ownerTabId: 42, ownerWindowId: 7 });
  const oldToken = recording(controller.getState()).documentToken;

  fixture.nowMs = START_MS + 1_000;
  controller.observeNavigation({ ownerTabId: 42, url: 'https://user:secret@example.com/b', kind: 'document' });
  const afterB = recording(controller.getState());
  expect(afterB.documentToken).not.toBe(oldToken);
  expect(afterB.draft.steps.at(-1)?.navigation?.toUrl).toBe('https://example.com/b');

  fixture.nowMs = START_MS + 1_100;
  controller.observeNavigation({ ownerTabId: 42, url: 'https://example.com/c', kind: 'document' });
  const afterC = recording(controller.getState());
  expect(afterC.draft.steps.slice(-2).map(step => step.kind === 'navigation'
    ? [step.sourceUrl, step.navigation.toUrl, step.image.status]
    : [])).toEqual([
    [START_URL, 'https://example.com/b', 'unavailable'],
    ['https://example.com/b', 'https://example.com/c', 'pending'],
  ]);

  b.resolve(identity('document-b', 'https://example.com/b', 2));
  await Promise.resolve();
  expect(fixture.calls.begin).toHaveLength(1);

  fixture.current = identity('document-c', 'https://example.com/c', 3);
  c.resolve(fixture.current);
  await eventually(() => expect(fixture.calls.begin).toHaveLength(2));
  expect(fixture.calls.begin[1].input).toMatchObject({ documentToken: 'document-c', expectedUrl: 'https://example.com/c' });
  expect(recording(controller.getState()).documentToken).toBe('document-c');

  fixture.nowMs = START_MS + 1_600;
  fixture.resolveDelay(0, 1);
  await eventually(() => expect(fixture.calls.capture).toHaveLength(2));
  expect(fixture.calls.capture[1].identity.url).toBe('https://example.com/c');
});

test('a same-document observation during a document handshake restarts that handshake for the latest URL', async () => {
  const first = deferred<JourneyPageIdentity>();
  const second = deferred<JourneyPageIdentity>();
  const fixture = navigationFixture({
    connect: (_tabId, expectedUrl) => expectedUrl.endsWith('/next') ? first.promise : second.promise,
  });
  const controller = createJourneyController(fixture.adapter);
  await controller.start({ ownerTabId: 42, ownerWindowId: 7 });

  fixture.nowMs = START_MS + 1_000;
  controller.observeNavigation({ ownerTabId: 42, url: 'https://example.com/next', kind: 'document' });
  const provisionalToken = recording(controller.getState()).documentToken;
  fixture.nowMs = START_MS + 1_050;
  controller.observeNavigation({ ownerTabId: 42, url: 'https://example.com/next#details', kind: 'same-document' });

  expect(fixture.calls.connect.map(call => call.expectedUrl)).toEqual([
    'https://example.com/next', 'https://example.com/next#details',
  ]);
  expect(recording(controller.getState()).documentToken).toBe(provisionalToken);
  first.resolve(identity('document-stale', 'https://example.com/next', 2));
  await Promise.resolve();
  expect(recording(controller.getState()).documentToken).toBe(provisionalToken);

  fixture.current = identity('document-next', 'https://example.com/next#details', 3);
  second.resolve(fixture.current);
  await eventually(() => expect(recording(controller.getState()).documentToken).toBe('document-next'));
});

test('a same-document observation while recorder begin is pending inherits the adopted handshake', async () => {
  const firstBegin = deferred<void>();
  let beginCount = 0;
  const fixture = navigationFixture({
    begin: async () => {
      beginCount += 1;
      if (beginCount === 2) await firstBegin.promise;
    },
  });
  const controller = createJourneyController(fixture.adapter);
  await controller.start({ ownerTabId: 42, ownerWindowId: 7 });

  fixture.nowMs = START_MS + 1_000;
  fixture.current = identity('document-next', 'https://example.com/next', 2);
  controller.observeNavigation({ ownerTabId: 42, url: fixture.current.url, kind: 'document' });
  await eventually(() => expect(fixture.calls.begin).toHaveLength(2));
  expect(recording(controller.getState()).documentToken).toBe('document-next');

  fixture.nowMs = START_MS + 1_050;
  fixture.current = identity('document-next', 'https://example.com/next#details', 3);
  controller.observeNavigation({ ownerTabId: 42, url: fixture.current.url, kind: 'same-document' });
  await eventually(() => expect(fixture.calls.begin).toHaveLength(3));
  expect(fixture.calls.connect.at(-1)?.expectedUrl).toBe('https://example.com/next#details');
  expect(fixture.calls.begin.at(-1)?.input.expectedUrl).toBe('https://example.com/next#details');

  firstBegin.resolve();
  await Promise.resolve();
  expect(recording(controller.getState()).documentToken).toBe('document-next');
  expect(fixture.calls.end).toHaveLength(0);
});

test('a stale begin is ended only for its adopted document after a newer full commit', async () => {
  const firstBegin = deferred<void>();
  let beginCount = 0;
  const fixture = navigationFixture({
    connect: async (_tabId, expectedUrl) => expectedUrl.endsWith('/b')
      ? identity('document-b', expectedUrl, 2)
      : identity('document-c', expectedUrl, 3),
    begin: async () => {
      beginCount += 1;
      if (beginCount === 2) await firstBegin.promise;
    },
  });
  const controller = createJourneyController(fixture.adapter);
  await controller.start({ ownerTabId: 42, ownerWindowId: 7 });

  fixture.nowMs = START_MS + 1_000;
  controller.observeNavigation({ ownerTabId: 42, url: 'https://example.com/b', kind: 'document' });
  await eventually(() => expect(fixture.calls.begin).toHaveLength(2));
  fixture.nowMs = START_MS + 1_100;
  fixture.current = identity('document-c', 'https://example.com/c', 3);
  controller.observeNavigation({ ownerTabId: 42, url: fixture.current.url, kind: 'document' });
  await eventually(() => expect(fixture.calls.begin).toHaveLength(3));
  expect(recording(controller.getState()).documentToken).toBe('document-c');

  firstBegin.resolve();
  await eventually(() => expect(fixture.calls.end).toHaveLength(1));
  expect(fixture.calls.end[0].input).toMatchObject({ documentToken: 'document-b' });
  expect(recording(controller.getState()).documentToken).toBe('document-c');
});

test('same-document commits retain the recorder token and counter after the document handshake', async () => {
  const fixture = navigationFixture();
  const controller = createJourneyController(fixture.adapter);
  await controller.start({ ownerTabId: 42, ownerWindowId: 7 });
  let state = recording(controller.getState());
  controller.acceptBatch(clickBatch(state, 1, START_URL), 42);
  state = recording(controller.getState());
  const token = state.documentToken;

  fixture.nowMs = START_MS + 500;
  fixture.current = identity(token, `${START_URL}#one`, 2);
  controller.observeNavigation({ ownerTabId: 42, url: fixture.current.url, kind: 'same-document' });
  fixture.nowMs = START_MS + 400;
  fixture.current = identity(token, `${START_URL}#two`, 3);
  controller.observeNavigation({ ownerTabId: 42, url: fixture.current.url, kind: 'same-document' });

  state = recording(controller.getState());
  expect(state.documentToken).toBe(token);
  expect(state.documentCounters[token]).toBe(1);
  expect(state.draft.steps.slice(-2).map(step => step.kind === 'navigation' && step.navigation.toUrl))
    .toEqual([`${START_URL}#one`, `${START_URL}#two`]);
  expect(state.draft.steps.slice(-2).map(step => step.elapsedMs)).toEqual([500, 500]);
  expect(fixture.calls.connect).toHaveLength(0);
});

test('old-document and wrong-URL event batches are rejected after navigation', async () => {
  const connect = deferred<JourneyPageIdentity>();
  const fixture = navigationFixture({ connect: () => connect.promise });
  const controller = createJourneyController(fixture.adapter);
  await controller.start({ ownerTabId: 42, ownerWindowId: 7 });
  const before = recording(controller.getState());

  fixture.nowMs = START_MS + 1_000;
  controller.observeNavigation({ ownerTabId: 42, url: START_URL, kind: 'document' });
  const provisional = recording(controller.getState());
  controller.acceptBatch(clickBatch(before, 1, START_URL), 42);
  expect(recording(controller.getState()).draft.steps).toHaveLength(2);

  fixture.current = identity('document-reloaded', START_URL, 2);
  connect.resolve(fixture.current);
  await eventually(() => expect(recording(controller.getState()).documentToken).toBe('document-reloaded'));
  const current = recording(controller.getState());
  controller.acceptBatch(clickBatch(current, 1, 'https://wrong.example/'), 42);
  expect(recording(controller.getState()).draft.steps).toHaveLength(2);
  expect(provisional.documentToken).not.toBe(current.documentToken);
});

test('document handshakes fall back to identify for adapters without connect', async () => {
  const fixture = navigationFixture();
  fixture.adapter.connect = undefined;
  const controller = createJourneyController(fixture.adapter);
  await controller.start({ ownerTabId: 42, ownerWindowId: 7 });
  const identifiesBeforeNavigation = fixture.calls.identify.length;

  fixture.nowMs = START_MS + 1_000;
  fixture.current = identity('document-next', 'https://example.com/next', 2);
  controller.observeNavigation({ ownerTabId: 42, url: fixture.current.url, kind: 'document' });

  await eventually(() => expect(recording(controller.getState()).documentToken).toBe('document-next'));
  expect(fixture.calls.identify.length).toBeGreaterThan(identifiesBeforeNavigation);
  expect(fixture.calls.begin.at(-1)?.input.expectedUrl).toBe('https://example.com/next');
});

test('Stop during a document handshake prevents recorder begin and capture', async () => {
  const connect = deferred<JourneyPageIdentity>();
  const fixture = navigationFixture({ connect: () => connect.promise });
  const controller = createJourneyController(fixture.adapter);
  await controller.start({ ownerTabId: 42, ownerWindowId: 7 });

  fixture.nowMs = START_MS + 1_000;
  controller.observeNavigation({ ownerTabId: 42, url: 'https://example.com/next', kind: 'document' });
  await controller.stop();
  connect.resolve(identity('document-next', 'https://example.com/next', 2));
  await Promise.resolve();

  expect(controller.getState().phase).toBe('reviewing');
  expect(fixture.calls.begin).toHaveLength(1);
  expect(fixture.calls.capture).toHaveLength(1);
  expect(fixture.calls.end.at(-1)?.input.documentToken).toBeUndefined();
});

test('a document handshake timeout records the outcome and cannot start late', async () => {
  const connect = deferred<JourneyPageIdentity>();
  const fixture = navigationFixture({ connect: () => connect.promise });
  const controller = createJourneyController(fixture.adapter);
  await controller.start({ ownerTabId: 42, ownerWindowId: 7 });

  fixture.nowMs = START_MS + 1_000;
  controller.observeNavigation({ ownerTabId: 42, url: 'https://example.com/slow-document', kind: 'document' });
  fixture.nowMs = START_MS + 6_000;
  fixture.resolveDelay(4_100, 0);
  await eventually(() => expect(controller.getState().phase).toBe('reviewing'));
  const stopped = controller.getState();
  if (stopped.phase !== 'reviewing') throw new Error('Expected review after navigation timeout');
  expect(stopped.draft.steps.at(-1)?.image).toEqual({ status: 'unavailable', reason: 'navigation-timeout' });

  connect.resolve(identity('document-late', 'https://example.com/slow-document', 2));
  await Promise.resolve();
  expect(fixture.calls.begin).toHaveLength(1);
  expect(fixture.calls.capture).toHaveLength(1);
});

test('navigation capture uses the destination URL and times out within five seconds', async () => {
  const fixture = navigationFixture();
  const controller = createJourneyController(fixture.adapter);
  await controller.start({ ownerTabId: 42, ownerWindowId: 7 });
  const token = recording(controller.getState()).documentToken;

  fixture.nowMs = START_MS + 1_000;
  fixture.current = identity(token, 'https://example.com/result', 2);
  controller.observeNavigation({ ownerTabId: 42, url: fixture.current.url, kind: 'same-document' });
  expect(fixture.calls.capture).toHaveLength(1);
  fixture.nowMs = START_MS + 1_500;
  fixture.resolveDelay(0, 0);
  await eventually(() => expect(fixture.calls.capture).toHaveLength(2));
  await eventually(() => {
    const step = recording(controller.getState()).draft.steps.at(-1)!;
    expect(step.image.status).toBe('retained');
    if (step.image.status === 'retained') {
      expect(recording(controller.getState()).draft.images[step.image.imageId].captureUrl).toBe('https://example.com/result');
    }
  });

  fixture.nowMs = START_MS + 2_000;
  fixture.current = identity(token, 'https://example.com/slow', 3);
  controller.observeNavigation({ ownerTabId: 42, url: fixture.current.url, kind: 'same-document' });
  fixture.nowMs = START_MS + 7_000;
  fixture.resolveDelay(3_100, 0);
  await eventually(() => expect(recording(controller.getState()).draft.steps.at(-1)?.image)
    .toEqual({ status: 'unavailable', reason: 'navigation-timeout' }));
});

test('a later-arriving action invalidates an earlier navigation image captured after the action occurred', async () => {
  const fixture = navigationFixture();
  const controller = createJourneyController(fixture.adapter);
  await controller.start({ ownerTabId: 42, ownerWindowId: 7 });
  const token = recording(controller.getState()).documentToken;

  fixture.nowMs = START_MS + 1_000;
  fixture.current = identity(token, 'https://example.com/result', 2);
  controller.observeNavigation({ ownerTabId: 42, url: fixture.current.url, kind: 'same-document' });
  fixture.nowMs = START_MS + 1_500;
  fixture.resolveDelay(0, 0);
  await eventually(() => expect(recording(controller.getState()).draft.steps.at(-1)?.image.status).toBe('retained'));

  let state = recording(controller.getState());
  const navigationStep = state.draft.steps.at(-1)!;
  const navigationImageId = navigationStep.image.status === 'retained' ? navigationStep.image.imageId : '';
  expect(state.draft.images[navigationImageId].capturedAt).toBe('2026-09-20T12:00:01.600Z');
  fixture.nowMs = START_MS + 1_700;
  const action = clickBatch(state, 1, fixture.current.url, 'late-action-capture');
  action.events[0].observedAt = '2026-09-20T12:00:01.550Z';
  action.events[0].elapsedMs = 1_550;
  controller.acceptBatch(action, 42);

  state = recording(controller.getState());
  expect(state.draft.steps.at(-2)?.image).toEqual({ status: 'unavailable', reason: 'superseded' });
  expect(state.draft.images).not.toHaveProperty(navigationImageId);
  expect(state.draft.steps.at(-1)?.image).toEqual({ status: 'pending', captureId: 'late-action-capture' });
});

test('a terminal 30th action still invalidates an overlapping retained navigation image', async () => {
  const fixture = navigationFixture();
  const controller = createJourneyController(fixture.adapter);
  await controller.start({ ownerTabId: 42, ownerWindowId: 7 });
  let state = recording(controller.getState());
  const event = clickBatch(state, 1, START_URL).events[0];
  controller.acceptBatch({
    schemaVersion: 1,
    sessionId: state.sessionId,
    epoch: state.epoch,
    documentToken: state.documentToken,
    localCounter: 1,
    events: Array.from({ length: 27 }, (_, index) => ({
      ...event,
      id: `setup-click-${index + 1}`,
      observedAt: new Date(START_MS + (index + 1) * 100).toISOString(),
      elapsedMs: (index + 1) * 100,
    })),
  }, 42);
  state = recording(controller.getState());
  expect(state.draft.steps).toHaveLength(28);

  fixture.nowMs = START_MS + 3_000;
  fixture.current = identity(state.documentToken, 'https://example.com/result', 2);
  controller.observeNavigation({ ownerTabId: 42, url: fixture.current.url, kind: 'same-document' });
  fixture.nowMs = START_MS + 3_500;
  fixture.resolveDelay(200, 0);
  await eventually(() => expect(recording(controller.getState()).draft.steps.at(-1)?.image.status).toBe('retained'));
  state = recording(controller.getState());
  const imageState = state.draft.steps.at(-1)!.image;
  const navigationImageId = imageState.status === 'retained' ? imageState.imageId : '';

  fixture.nowMs = START_MS + 3_700;
  const terminalAction = clickBatch(state, 2, fixture.current.url, 'terminal-action-capture');
  terminalAction.events[0].observedAt = '2026-09-20T12:00:03.550Z';
  terminalAction.events[0].elapsedMs = 3_550;
  controller.acceptBatch(terminalAction, 42);

  const stopped = controller.getState();
  expect(stopped.phase).toBe('reviewing');
  if (stopped.phase !== 'reviewing') throw new Error('Expected review at the step limit');
  expect(stopped.draft.stopReason).toBe('step-limit');
  expect(stopped.draft.steps.at(-2)?.image).toEqual({ status: 'unavailable', reason: 'superseded' });
  expect(stopped.draft.images).not.toHaveProperty(navigationImageId);
  expect(stopped.draft.steps.at(-1)?.image).toEqual({ status: 'unavailable', reason: 'stopped' });
});

test('an oversized document destination stops for capture failure and tears down instead of silently ignoring navigation', async () => {
  const fixture = navigationFixture();
  const controller = createJourneyController(fixture.adapter);
  await controller.start({ ownerTabId: 42, ownerWindowId: 7 });
  const oversizedUrl = `https://example.com/${'a'.repeat(JOURNEY_LIMITS.maxUrlBytes)}`;

  controller.observeNavigation({ ownerTabId: 42, url: oversizedUrl, kind: 'document' });

  const stopped = controller.getState();
  expect(stopped.phase).toBe('reviewing');
  if (stopped.phase === 'reviewing') expect(stopped.draft.stopReason).toBe('capture-failed');
  expect(fixture.calls.connect).toEqual([]);
  expect(fixture.calls.end).toHaveLength(1);
});

test('a non-HTTP document destination stops as a protected page', async () => {
  const fixture = navigationFixture();
  const controller = createJourneyController(fixture.adapter);
  await controller.start({ ownerTabId: 42, ownerWindowId: 7 });

  controller.observeNavigation({ ownerTabId: 42, url: 'chrome://settings/', kind: 'document' });

  const stopped = controller.getState();
  expect(stopped.phase).toBe('reviewing');
  if (stopped.phase === 'reviewing') expect(stopped.draft.stopReason).toBe('protected-page');
  expect(fixture.calls.end).toHaveLength(1);
});

test('a cross-origin navigation stops the journey as left-site without recording a step', async () => {
  const fixture = navigationFixture();
  const controller = createJourneyController(fixture.adapter);
  await controller.start({ ownerTabId: 42, ownerWindowId: 7 });

  controller.observeNavigation({ ownerTabId: 42, url: 'https://other.example/away', kind: 'document' });

  const stopped = controller.getState();
  expect(stopped.phase).toBe('reviewing');
  if (stopped.phase !== 'reviewing') throw new Error('Expected review after leaving the site');
  expect(stopped.draft.stopReason).toBe('left-site');
  expect(stopped.draft.steps).toHaveLength(1);
  expect(fixture.calls.connect).toEqual([]);
  expect(fixture.calls.end).toHaveLength(1);
});

test('same-origin path changes and same-URL reloads keep recording instead of leaving the site', async () => {
  const fixture = navigationFixture();
  const controller = createJourneyController(fixture.adapter);
  await controller.start({ ownerTabId: 42, ownerWindowId: 7 });
  const reloadUrl = `${START_URL}#one`;

  fixture.nowMs = START_MS + 500;
  controller.observeNavigation({ ownerTabId: 42, url: reloadUrl, kind: 'same-document' });
  expect(recording(controller.getState()).draft.steps.at(-1)?.navigation?.toUrl).toBe(reloadUrl);

  fixture.nowMs = START_MS + 1_000;
  fixture.current = identity('document-reload', reloadUrl, 2);
  controller.observeNavigation({ ownerTabId: 42, url: reloadUrl, kind: 'document' });
  await eventually(() => expect(recording(controller.getState()).documentToken).toBe('document-reload'));

  const state = recording(controller.getState());
  expect(state.phase).toBe('recording');
  expect(state.draft.stopReason).toBeUndefined();
  expect(state.draft.steps.slice(-2).map(step => step.kind)).toEqual(['navigation', 'navigation']);
  expect(state.draft.steps.slice(-2).map(step => step.kind === 'navigation' && step.navigation.toUrl)).toEqual([reloadUrl, reloadUrl]);
});

test('navigation while the initial recorder begin is pending cannot publish the old document', async () => {
  const initialBegin = deferred<void>();
  const fixture = navigationFixture({ begin: () => initialBegin.promise });
  const controller = createJourneyController(fixture.adapter);
  const starting = controller.start({ ownerTabId: 42, ownerWindowId: 7 });
  await eventually(() => expect(fixture.calls.begin).toHaveLength(1));

  fixture.current = identity('document-next', 'https://example.com/next', 2);
  controller.observeNavigation({ ownerTabId: 42, url: fixture.current.url, kind: 'document' });
  initialBegin.resolve();

  await expect(starting).rejects.toMatchObject({ code: 'initial-capture-failed' });
  expect(controller.getState().phase).toBe('idle');
  expect(fixture.calls.end).toHaveLength(1);
  expect(fixture.calls.connect).toEqual([]);
});

test('an initial recorder begin that crosses the session deadline cannot publish recording', async () => {
  const initialBegin = deferred<void>();
  const fixture = navigationFixture({ begin: () => initialBegin.promise });
  const controller = createJourneyController(fixture.adapter);
  const starting = controller.start({ ownerTabId: 42, ownerWindowId: 7 });
  await eventually(() => expect(fixture.calls.begin).toHaveLength(1));

  fixture.nowMs = START_MS + JOURNEY_LIMITS.maxDurationMs;
  initialBegin.resolve();

  await expect(starting).rejects.toMatchObject({ code: 'initial-capture-failed' });
  expect(controller.getState().phase).toBe('idle');
  expect(fixture.calls.end).toHaveLength(1);
});

test('a navigation image-budget stop tears down the page recorder', async () => {
  let capturedMs = START_MS + 100;
  const fixture = navigationFixture({
    capture: async (_tabId, pageIdentity) => ({
      ...image(pageIdentity.url, capturedMs),
      width: 1, height: 1,
      byteLength: JOURNEY_LIMITS.maxImageBytes,
      dataUrl: fixturePngDataUrl(JOURNEY_LIMITS.maxImageBytes),
    }),
  });
  const controller = createJourneyController(fixture.adapter);
  await controller.start({ ownerTabId: 42, ownerWindowId: 7 });

  for (let counter = 1; counter <= 5; counter += 1) {
    const state = recording(controller.getState());
    const actionAt = START_MS + counter * 1000;
    const action = clickBatch(state, counter, START_URL, `budget-action-${counter}`);
    action.events[0].observedAt = new Date(actionAt).toISOString();
    action.events[0].elapsedMs = counter * 1000;
    fixture.nowMs = actionAt;
    controller.acceptBatch(action, 42);
    capturedMs = actionAt + 500;
    fixture.nowMs = actionAt + 500;
    fixture.resolveDelay(500, counter - 1);
    await eventually(() => expect(recording(controller.getState()).draft.steps.at(-1)?.image.status).toBe('retained'));
  }

  const token = recording(controller.getState()).documentToken;
  fixture.nowMs = START_MS + 6_500;
  fixture.current = identity(token, 'https://example.com/result', 2);
  controller.observeNavigation({ ownerTabId: 42, url: fixture.current.url, kind: 'same-document' });
  fixture.nowMs = START_MS + 7_000;
  capturedMs = START_MS + 7_100;
  fixture.resolveDelay(0, 0);

  await eventually(() => expect(controller.getState().phase).toBe('reviewing'));
  const stopped = controller.getState();
  if (stopped.phase !== 'reviewing') throw new Error('Expected review at the image budget');
  expect(stopped.draft.stopReason).toBe('image-budget');
  expect(fixture.calls.end).toHaveLength(1);
});

test('navigation reaching the session deadline during capture stops for duration', async () => {
  const navigationCapture = deferred<JourneyDraftImage>();
  let captures = 0;
  const fixture = navigationFixture({
    capture: async (_tabId, pageIdentity) => {
      captures += 1;
      return captures === 1 ? image(pageIdentity.url, START_MS + 100) : navigationCapture.promise;
    },
  });
  const controller = createJourneyController(fixture.adapter);
  await controller.start({ ownerTabId: 42, ownerWindowId: 7 });
  const token = recording(controller.getState()).documentToken;

  fixture.nowMs = START_MS + 1_000;
  fixture.current = identity(token, 'https://example.com/result', 2);
  controller.observeNavigation({ ownerTabId: 42, url: fixture.current.url, kind: 'same-document' });
  fixture.nowMs = START_MS + 1_500;
  fixture.resolveDelay(0, 0);
  await eventually(() => expect(fixture.calls.capture).toHaveLength(2));

  fixture.nowMs = START_MS + JOURNEY_LIMITS.maxDurationMs;
  navigationCapture.resolve(image(fixture.current.url, START_MS + 1_600));
  await eventually(() => expect(controller.getState().phase).toBe('reviewing'));
  const stopped = controller.getState();
  if (stopped.phase !== 'reviewing') throw new Error('Expected review at the duration limit');
  expect(stopped.draft.stopReason).toBe('duration-limit');
  expect(fixture.calls.end).toHaveLength(1);
});

function navigationFixture(overrides: Partial<JourneyControllerAdapter> = {}) {
  const delays: Array<{ ms: number; wait: ReturnType<typeof deferred<void>>; resolved: boolean }> = [];
  const calls = {
    identify: [] as number[],
    connect: [] as Array<{ tabId: number; expectedUrl: string }>,
    capture: [] as Array<{ tabId: number; identity: JourneyPageIdentity; captureId: string }>,
    begin: [] as Array<{ tabId: number; input: Parameters<JourneyControllerAdapter['begin']>[1] }>,
    end: [] as Array<{ tabId: number; input: Parameters<JourneyControllerAdapter['end']>[1] }>,
    changed: [] as JourneySession[],
  };
  const fixture = {
    nowMs: START_MS,
    current: identity('document-start', START_URL, 1),
    calls,
    resolveDelay(ms: number, occurrence: number) {
      const delay = delays.filter(item => item.ms === ms)[occurrence];
      if (!delay) throw new Error(`Missing ${ms} ms delay #${occurrence}`);
      delay.resolved = true;
      delay.wait.resolve();
    },
    adapter: undefined as unknown as JourneyControllerAdapter,
  };
  fixture.adapter = {
    now: () => fixture.nowMs,
    delay: ms => {
      if (overrides.delay) return overrides.delay(ms);
      const wait = deferred<void>();
      delays.push({ ms, wait, resolved: false });
      return wait.promise;
    },
    identify: async tabId => {
      calls.identify.push(tabId);
      return overrides.identify ? overrides.identify(tabId) : { ...fixture.current };
    },
    connect: async (tabId, expectedUrl) => {
      calls.connect.push({ tabId, expectedUrl });
      return overrides.connect ? overrides.connect(tabId, expectedUrl) : { ...fixture.current };
    },
    capture: async (tabId, pageIdentity, captureId) => {
      calls.capture.push({ tabId, identity: pageIdentity, captureId });
      return overrides.capture
        ? overrides.capture(tabId, pageIdentity, captureId)
        : image(pageIdentity.url, fixture.nowMs + 100);
    },
    begin: async (tabId, input) => {
      calls.begin.push({ tabId, input });
      await overrides.begin?.(tabId, input);
    },
    end: async (tabId, input) => {
      calls.end.push({ tabId, input });
      await overrides.end?.(tabId, input);
    },
    changed: next => { calls.changed.push(next); overrides.changed?.(next); },
  };
  return fixture;
}

function identity(documentToken: string, url: string, generation: number): JourneyPageIdentity {
  return {
    documentToken, url, generation, visible: true,
    viewport: { width: 390, height: 844 }, scroll: { x: 0, y: 0 },
  };
}

function fixturePngDataUrl(byteLength: number): string {
  const png = new Uint8Array(byteLength);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  png.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8);
  png.set([0, 0, 0, 1, 0, 0, 0, 1], 16);
  return `data:image/png;base64,${Buffer.from(png).toString('base64')}`;
}

function image(captureUrl: string, capturedMs: number): JourneyDraftImage {
  return {
    capturedAt: new Date(capturedMs).toISOString(), captureUrl,
    width: 1, height: 1, byteLength: 64,
    dataUrl: fixturePngDataUrl(64),
    viewport: { width: 390, height: 844 }, scroll: { x: 0, y: 0 },
  };
}

function clickBatch(
  state: Extract<JourneySession, { phase: 'recording' }>,
  localCounter: number,
  sourceUrl: string,
  captureId?: string,
): JourneyEventBatchV1 {
  const elapsedMs = (state.draft.steps.at(-1)?.elapsedMs ?? 0) + 100;
  return {
    schemaVersion: 1, sessionId: state.sessionId, epoch: state.epoch,
    documentToken: state.documentToken, localCounter,
    events: [{
      kind: 'click', id: `click-${localCounter}-${state.documentToken}`,
      observedAt: new Date(START_MS + elapsedMs).toISOString(), elapsedMs,
      sourceUrl,
      target: {
        tag: 'button', selectorPath: ['button'], label: 'Continue', editable: false,
        viewport: { width: 390, height: 844 }, scroll: { x: 0, y: 0 }, point: { x: 10, y: 10 },
      },
      image: captureId
        ? { status: 'pending', captureId }
        : { status: 'unavailable', reason: 'superseded' },
    }],
  };
}

function recording(state: JourneySession): Extract<JourneySession, { phase: 'recording' }> {
  if (state.phase !== 'recording') throw new Error(`Expected recording, received ${state.phase}`);
  return state;
}

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
