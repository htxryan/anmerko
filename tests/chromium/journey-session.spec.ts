import { expect, test } from '@playwright/test';
import {
  acceptInitialImage,
  createJourneySession,
  stopJourney,
  type JourneySession,
  type RecordingJourneySession,
  type ReviewingJourneySession,
} from '../../src/journey-core';
import { JOURNEY_LIMITS } from '../../src/journey-limits';
import {
  createJourneySessionStore,
  JourneySessionStorageError,
  validateJourneySession,
} from '../../src/journey-session';

const startedAt = '2026-09-20T12:00:00.000Z';
const deadlineAt = '2026-09-20T12:05:00.000Z';
const MINIMAL_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+AvzvAAAAAElFTkSuQmCC';

type Stored = Record<string, unknown>;

function recording(): RecordingJourneySession {
  const starting = createJourneySession({
    sessionId: 'session-1', journeyId: 'journey-1', ownerTabId: 42, ownerWindowId: 7,
    documentToken: 'document-1', startedAt, deadlineAt,
  });
  const state = acceptInitialImage(starting, {
    id: 'step-1', observedAt: '2026-09-20T12:00:01.000Z', elapsedMs: 1_000,
    sourceUrl: 'https://example.com/path?private=value#detail', imageId: 'image-1',
    image: {
      capturedAt: '2026-09-20T12:00:01.000Z',
      captureUrl: 'https://example.com/path?private=value#detail',
      width: 1, height: 1, byteLength: 69, dataUrl: MINIMAL_PNG,
      viewport: { width: 390, height: 844 }, scroll: { x: 0, y: 0 },
    },
  });
  if (state.phase !== 'recording') throw new Error('fixture did not enter recording');
  return state;
}

function reviewing(reason: 'user' | 'duration-limit' = 'user'): ReviewingJourneySession {
  const active = recording();
  const stoppedAt = reason === 'duration-limit' ? deadlineAt : '2026-09-20T12:04:00.000Z';
  const state = stopJourney(active, { epoch: active.epoch, stoppedAt, reason });
  if (state.phase !== 'reviewing') throw new Error('fixture did not enter review');
  return state;
}

function saving(): Extract<JourneySession, { phase: 'saving' }> {
  const { warningAt: _warningAt, expiresAt: _expiresAt, ...state } = reviewing();
  return { ...state, phase: 'saving' };
}

class MemoryStorage {
  data: Stored = {};
  calls: Array<{ method: 'get' | 'set' | 'remove'; keys: string[] }> = [];
  setCount = 0;
  removeCount = 0;
  failGet = false;
  failSetAt?: number;
  failRemove = false;
  pauseSetAt?: number;
  pauseRemoveAt?: number;
  private resume?: () => void;
  private resumeRemove?: () => void;

  get = async (keys: string[]): Promise<Stored> => {
    this.calls.push({ method: 'get', keys: [...keys] });
    if (this.failGet) throw new Error('read failed with private=value and PNG bytes');
    return Object.fromEntries(keys.filter(key => Object.hasOwn(this.data, key)).map(key => [key, structuredClone(this.data[key])]));
  };

  set = async (items: Stored): Promise<void> => {
    const count = ++this.setCount;
    this.calls.push({ method: 'set', keys: Object.keys(items) });
    if (count === this.pauseSetAt) await new Promise<void>(resolve => { this.resume = resolve });
    if (count === this.failSetAt) throw new Error('quota failed with private=value and PNG bytes');
    for (const [key, value] of Object.entries(items)) this.data[key] = structuredClone(value);
  };

  remove = async (keys: string[]): Promise<void> => {
    const count = ++this.removeCount;
    this.calls.push({ method: 'remove', keys: [...keys] });
    if (count === this.pauseRemoveAt) await new Promise<void>(resolve => { this.resumeRemove = resolve });
    if (this.failRemove) throw new Error('cleanup failed with private=value');
    for (const key of keys) delete this.data[key];
  };

  release(): void { this.resume?.() }
  releaseRemove(): void { this.resumeRemove?.() }
}

test('strict validation deep clones every supported session phase', () => {
  const active = recording();
  const review = reviewing();
  const cases: JourneySession[] = [
    { phase: 'idle', epoch: 0 },
    createJourneySession({
      sessionId: 'session-1', journeyId: 'journey-1', ownerTabId: 42, ownerWindowId: 7,
      documentToken: 'document-1', startedAt, deadlineAt,
    }),
    active,
    review,
    saving(),
    { phase: 'saved', epoch: 4, journeyId: 'journey-1', revision: 2 },
  ];

  for (const state of cases) {
    const validated = validateJourneySession(state);
    expect(validated).toEqual(state);
    expect(validated).not.toBe(state);
  }
});

test('validation rejects unknown keys and invalid owner, epoch, counter, time, and phase invariants', () => {
  const active = recording();
  const review = reviewing();
  const invalid: unknown[] = [
    { ...active, privateExtra: 'secret' },
    { ...active, epoch: -1 },
    { ...active, ownerTabId: 1.5 },
    { ...active, documentCounters: { 'document-1': -1 } },
    { ...active, documentCounters: { 'not valid': 0 } },
    { ...active, deadlineAt: active.draft.startedAt },
    { ...active, journeyId: 'different-journey' },
    { ...active, draft: { ...active.draft, stoppedAt: deadlineAt, stopReason: 'user' } },
    { ...review, warningAt: review.expiresAt },
    { ...review, draft: { ...review.draft, stopReason: undefined } },
    { phase: 'saved', epoch: 1, journeyId: 'bad id', revision: 0 },
    { phase: 'idle', epoch: 0, draft: active.draft },
    { phase: 'future', epoch: 1 },
  ];

  for (const value of invalid) expect(validateJourneySession(value)).toBeUndefined();
});

test('writes control and payload separately and returns isolated read copies', async () => {
  const storage = new MemoryStorage();
  const store = createJourneySessionStore(storage);
  const state = recording();

  await store.write(state);

  expect(storage.calls.filter(call => call.method === 'set').map(call => call.keys.length)).toEqual([1, 1, 1]);
  const keys = Object.keys(storage.data);
  expect(keys).toHaveLength(2);
  const controlKey = storage.calls.find(call => call.method === 'set')!.keys[0];
  const payloadKey = keys.find(key => key !== controlKey)!;
  expect(JSON.stringify(storage.data[controlKey])).not.toContain('private=value');
  expect(JSON.stringify(storage.data[controlKey])).not.toContain(MINIMAL_PNG.slice(30));
  expect(JSON.stringify(storage.data[payloadKey])).toContain('private=value');

  const restored = await store.read(Date.parse('2026-09-20T12:01:00.000Z'));
  expect(restored).toEqual(state);
  expect(restored).not.toBe(state);
  if (restored.phase === 'recording') restored.draft.expected = 'changed outside storage';
  expect(await store.read(Date.parse('2026-09-20T12:01:00.000Z'))).toEqual(state);
});

test('idle clears control and payload records', async () => {
  const storage = new MemoryStorage();
  const store = createJourneySessionStore(storage);
  await store.write(recording());

  await store.write({ phase: 'idle', epoch: 2 });

  expect(storage.data).toEqual({});
  expect(await store.read(Date.parse(startedAt))).toEqual({ phase: 'idle', epoch: 0 });
});

test('expired review is purged from control metadata without reading its payload', async () => {
  const storage = new MemoryStorage();
  const store = createJourneySessionStore(storage);
  const state = reviewing();
  await store.write(state);
  storage.calls.length = 0;

  await expect(store.read(Date.parse(state.expiresAt))).resolves.toEqual({ phase: 'idle', epoch: state.epoch + 1 });

  expect(storage.calls.filter(call => call.method === 'get')).toHaveLength(1);
  expect(storage.calls[0].keys).toHaveLength(1);
  expect(storage.data).toEqual({});
});

test('expired recording stops at its original deadline and anchors review expiry there', async () => {
  const storage = new MemoryStorage();
  const store = createJourneySessionStore(storage);
  const active = recording();
  await store.write(active);

  const restored = await store.read(Date.parse(deadlineAt) + 1);

  expect(restored.phase).toBe('reviewing');
  if (restored.phase !== 'reviewing') return;
  expect(restored.draft.stoppedAt).toBe(deadlineAt);
  expect(restored.draft.stopReason).toBe('duration-limit');
  expect(restored.expiresAt).toBe(new Date(Date.parse(deadlineAt) + JOURNEY_LIMITS.maxReviewIdleMs).toISOString());
  expect(await store.read(Date.parse(deadlineAt) + 2)).toEqual(restored);
});

test('recording past its entire review window is purged without reading payload bytes', async () => {
  const storage = new MemoryStorage();
  const store = createJourneySessionStore(storage);
  const active = recording();
  await store.write(active);
  storage.calls.length = 0;

  await expect(store.read(Date.parse(deadlineAt) + JOURNEY_LIMITS.maxReviewIdleMs)).resolves.toEqual({
    phase: 'idle', epoch: active.epoch + 2,
  });

  expect(storage.calls.filter(call => call.method === 'get')).toHaveLength(1);
  expect(storage.calls[0].keys).toHaveLength(1);
  expect(storage.data).toEqual({});
});

test('recovery never promotes starting or resumes saving', async () => {
  const startingStorage = new MemoryStorage();
  const startingStore = createJourneySessionStore(startingStorage);
  const starting = createJourneySession({
    sessionId: 'session-1', journeyId: 'journey-1', ownerTabId: 42, ownerWindowId: 7,
    documentToken: 'document-1', startedAt, deadlineAt,
  });
  await startingStore.write(starting);
  await expect(startingStore.read(Date.parse(startedAt) + 1)).resolves.toEqual({ phase: 'idle', epoch: 2 });
  expect(startingStorage.data).toEqual({});

  const savingStorage = new MemoryStorage();
  const savingStore = createJourneySessionStore(savingStorage);
  await savingStore.write(saving());
  const restored = await savingStore.read(Date.parse('2026-09-20T12:06:00.000Z'));
  expect(restored.phase).toBe('reviewing');
  if (restored.phase !== 'reviewing') return;
  expect(restored.expiresAt).toBe('2026-09-20T12:34:00.000Z');
});

test('expired saving is purged from derived control expiry without reading payload bytes', async () => {
  const storage = new MemoryStorage();
  const store = createJourneySessionStore(storage);
  const state = saving();
  await store.write(state);
  storage.calls.length = 0;

  await expect(store.read(Date.parse('2026-09-20T12:34:00.000Z'))).resolves.toEqual({
    phase: 'idle', epoch: state.epoch + 1,
  });

  expect(storage.calls.filter(call => call.method === 'get')).toHaveLength(1);
  expect(storage.calls[0].keys).toHaveLength(1);
  expect(storage.data).toEqual({});
});

test('interrupted invalidation and payload boundaries purge rather than recover stale recording', async () => {
  const seeded = new MemoryStorage();
  const seedStore = createJourneySessionStore(seeded);
  await seedStore.write(recording());
  const sets = seeded.calls.filter(call => call.method === 'set');
  const controlKey = sets[0].keys[0];
  const payloadKey = sets[1].keys[0];
  const invalidControl = structuredClone((seeded as MemoryStorage & { data: Stored }).data[controlKey]) as Record<string, unknown>;
  invalidControl.status = 'writing';

  for (const partial of [
    { [controlKey]: invalidControl },
    { [controlKey]: invalidControl, [payloadKey]: seeded.data[payloadKey] },
  ]) {
    const storage = new MemoryStorage();
    storage.data = structuredClone(partial);
    const store = createJourneySessionStore(storage);
    await expect(store.read(Date.parse(startedAt) + 1)).resolves.toEqual({ phase: 'idle', epoch: 0 });
    expect(storage.data).toEqual({});
  }
});

test('malformed committed control and payload records are rejected and purged', async () => {
  const seeded = new MemoryStorage();
  await createJourneySessionStore(seeded).write(recording());
  const sets = seeded.calls.filter(call => call.method === 'set');
  const controlKey = sets[0].keys[0];
  const payloadKey = sets[1].keys[0];
  const control = seeded.data[controlKey] as Record<string, unknown>;
  const payload = seeded.data[payloadKey] as Record<string, unknown>;
  const oversizedPayload = structuredClone(payload) as Record<string, unknown>;
  const oversizedState = oversizedPayload.state as RecordingJourneySession;
  oversizedState.draft.expected = 'private='.repeat(JOURNEY_LIMITS.maxSessionBytes);
  const cases: Stored[] = [
    { [controlKey]: { ...control, unknown: true }, [payloadKey]: payload },
    { [controlKey]: control, [payloadKey]: { ...payload, generation: Number(payload.generation) + 1 } },
    { [controlKey]: control, [payloadKey]: { ...payload, unknown: true } },
    { [controlKey]: control, [payloadKey]: oversizedPayload },
  ];

  for (const records of cases) {
    const storage = new MemoryStorage();
    storage.data = structuredClone(records);
    const restored = createJourneySessionStore(storage).read(Date.parse(startedAt) + 1);
    await expect(restored).resolves.toMatchObject({ phase: 'idle' });
    expect(storage.data).toEqual({});
  }
});

test('quota or commit failure purges bytes and returns a private generic error', async () => {
  for (const failureBoundary of [1, 2, 3]) {
    const storage = new MemoryStorage();
    const store = createJourneySessionStore(storage);
    storage.failSetAt = failureBoundary;
    const error = await store.write(recording()).catch(value => value);

    expect(error).toBeInstanceOf(JourneySessionStorageError);
    expect(error.code).toBe('storage-unavailable');
    expect(error.message).not.toContain('private=value');
    expect(error.message).not.toContain('PNG');
    expect(storage.data).toEqual({});
  }
});

test('reports unresolved cleanup when invalidation and removal both fail', async () => {
  const storage = new MemoryStorage();
  const store = createJourneySessionStore(storage);
  await store.write(recording());
  storage.setCount = 0;
  storage.failSetAt = 1;
  storage.failRemove = true;

  const error = await store.write(reviewing()).catch(value => value);

  expect(error).toBeInstanceOf(JourneySessionStorageError);
  expect(error.code).toBe('cleanup-failed');
  expect(error.message).not.toContain('private=value');
  expect(storage.data).not.toEqual({});
});

test('read failures never include adapter messages or stored payloads', async () => {
  const storage = new MemoryStorage();
  const store = createJourneySessionStore(storage);
  await store.write(recording());
  storage.failGet = true;

  const error = await store.read(Date.parse(startedAt) + 1).catch(value => value);

  expect(error).toBeInstanceOf(JourneySessionStorageError);
  expect(error.code).toBe('storage-unavailable');
  expect(error.message).not.toContain('private=value');
  expect(error.message).not.toContain('PNG');
  expect(error).not.toHaveProperty('cause');
});

test('concurrent writes stay ordered and a stale queued recording cannot resurrect after failure', async () => {
  const orderedStorage = new MemoryStorage();
  orderedStorage.pauseSetAt = 2;
  const orderedStore = createJourneySessionStore(orderedStorage);
  const first = orderedStore.write(recording());
  const latest = reviewing();
  const second = orderedStore.write(latest);
  await expect.poll(() => orderedStorage.setCount).toBe(2);
  orderedStorage.release();
  await Promise.all([first, second]);
  await expect(orderedStore.read(Date.parse('2026-09-20T12:04:01.000Z'))).resolves.toEqual(latest);

  const failedStorage = new MemoryStorage();
  failedStorage.pauseSetAt = 2;
  failedStorage.failSetAt = 2;
  const failedStore = createJourneySessionStore(failedStorage);
  const failing = failedStore.write(recording());
  const stale = failedStore.write(recording());
  await expect.poll(() => failedStorage.setCount).toBe(2);
  failedStorage.release();
  await expect(failing).rejects.toBeInstanceOf(JourneySessionStorageError);
  await expect(stale).rejects.toBeInstanceOf(JourneySessionStorageError);
  expect(failedStorage.data).toEqual({});
});

test('failure remains latched for writes enqueued during cleanup until an explicit idle clear succeeds', async () => {
  const storage = new MemoryStorage();
  storage.failSetAt = 2;
  storage.pauseRemoveAt = 1;
  const store = createJourneySessionStore(storage);
  const failing = store.write(recording());
  await expect.poll(() => storage.removeCount).toBe(1);
  const queuedDuringCleanup = store.write(recording());
  storage.releaseRemove();

  await expect(failing).rejects.toMatchObject({ code: 'storage-unavailable' });
  await expect(queuedDuringCleanup).rejects.toMatchObject({ code: 'storage-unavailable' });
  await expect(store.write(reviewing())).rejects.toMatchObject({ code: 'storage-unavailable' });
  expect(storage.data).toEqual({});

  await store.write({ phase: 'idle', epoch: 3 });
  await expect(store.write(reviewing())).resolves.toBeUndefined();
});

test('aggregate budget includes payload envelope, control metadata, and storage keys', async () => {
  const state = recording();
  const measured = new MemoryStorage();
  await createJourneySessionStore(measured).write(state);
  for (const value of Object.values(measured.data)) {
    if (typeof value === 'object' && value !== null && 'generation' in value) {
      (value as { generation: number }).generation = Number.MAX_SAFE_INTEGER;
    }
  }
  const aggregateBytes = new TextEncoder().encode(JSON.stringify(measured.data)).byteLength;
  const limits = JOURNEY_LIMITS as unknown as { maxSessionBytes: number };
  const originalLimit = limits.maxSessionBytes;
  try {
    limits.maxSessionBytes = aggregateBytes - 1;
    const rejected = new MemoryStorage();
    await expect(createJourneySessionStore(rejected).write(state)).rejects.toMatchObject({ code: 'session-too-large' });
    expect(rejected.data).toEqual({});

    limits.maxSessionBytes = aggregateBytes;
    await expect(createJourneySessionStore(new MemoryStorage()).write(state)).resolves.toBeUndefined();
  } finally {
    limits.maxSessionBytes = originalLimit;
  }
});

test('malformed and oversized payloads are purged without exposing their contents', async () => {
  const storage = new MemoryStorage();
  const store = createJourneySessionStore(storage);
  await expect(store.write({ ...recording(), secret: 'private=value' } as JourneySession)).rejects.toMatchObject({ code: 'invalid-session' });
  await expect(store.write({
    ...recording(),
    draft: { ...recording().draft, expected: 'x'.repeat(JOURNEY_LIMITS.maxSessionBytes + 1) },
  })).rejects.toMatchObject({ code: 'session-too-large' });
  expect(storage.data).toEqual({});
});
