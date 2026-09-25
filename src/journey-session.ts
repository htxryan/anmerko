import {
  resumeSavingReview,
  stopJourney,
  validateJourneyDraft,
  type JourneyDraftV1,
  type JourneySession,
} from './journey-core';
import { JOURNEY_LIMITS } from './journey-limits';

const CONTROL_KEY = 'anmerko:journey-session:v1:control';
const PAYLOAD_KEY = 'anmerko:journey-session:v1:payload';
const CONTROL_MAX_BYTES = 512;
const SESSION_STATE_MAX_BYTES = JOURNEY_LIMITS.maxSessionBytes - JOURNEY_LIMITS.sessionMetadataReserveBytes;
const MAX_DATE_MS = 8_640_000_000_000_000;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/;
const encoder = new TextEncoder();

export type JourneySessionStorageErrorCode = 'invalid-session' | 'session-too-large' | 'storage-unavailable' | 'cleanup-failed';

const ERROR_MESSAGES: Record<JourneySessionStorageErrorCode, string> = {
  'invalid-session': 'The temporary journey session is invalid.',
  'session-too-large': 'The temporary journey exceeds its storage limit.',
  'storage-unavailable': 'Temporary journey storage is unavailable.',
  'cleanup-failed': 'Temporary journey storage could not be safely cleared.',
};

export class JourneySessionStorageError<Code extends JourneySessionStorageErrorCode = JourneySessionStorageErrorCode> extends Error {
  readonly code: Code;

  constructor(code: Code) {
    super(ERROR_MESSAGES[code]);
    this.name = 'JourneySessionStorageError';
    this.code = code;
  }
}

interface JourneySessionStorageAdapter {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

interface WritingControl {
  schemaVersion: 1;
  status: 'writing';
  generation: number;
}

interface CommittedControl {
  schemaVersion: 1;
  status: 'committed';
  generation: number;
  phase: JourneySession['phase'];
  epoch: number;
  lifecycleAt?: string;
}

interface SessionPayload {
  schemaVersion: 1;
  generation: number;
  state: JourneySession;
}

type Control = WritingControl | CommittedControl;

function isObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => allowed.has(key));
}

function isSafeCounter(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}

function validEpochForPhase(phase: JourneySession['phase'], value: unknown): value is number {
  const minimum = phase === 'idle' || phase === 'saved' ? 0 : 1;
  const transitionHeadroom = phase === 'starting' || phase === 'recording' ? 2
    : phase === 'idle' ? 0
      : 1;
  return isSafeCounter(value, minimum)
    && value <= Number.MAX_SAFE_INTEGER - transitionHeadroom;
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= JOURNEY_LIMITS.maxIdCharacters && ID_PATTERN.test(value);
}

function timestampMs(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.length > 40) return;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function serializedBytes(value: unknown): number | undefined {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? undefined : encoder.encode(serialized).byteLength;
  } catch {
    return;
  }
}

function hasOwner(
  value: Record<string, unknown>,
  draft: JourneyDraftV1,
  phase: Extract<JourneySession['phase'], 'starting' | 'recording' | 'reviewing' | 'saving'>,
): boolean {
  return isId(value.sessionId)
    && isId(value.journeyId)
    && value.journeyId === draft.id
    && validEpochForPhase(phase, value.epoch)
    && isSafeCounter(value.ownerTabId)
    && isSafeCounter(value.ownerWindowId);
}

function isUnstopped(draft: JourneyDraftV1): boolean {
  return draft.stoppedAt === undefined && draft.stopReason === undefined;
}

function hasNoPendingImages(draft: JourneyDraftV1): boolean {
  return draft.steps.every(step => step.image.status !== 'pending');
}

function validDeadline(value: unknown, draft: JourneyDraftV1): boolean {
  const deadline = timestampMs(value);
  const started = timestampMs(draft.startedAt);
  return deadline !== undefined && started !== undefined
    && deadline > started && deadline - started <= JOURNEY_LIMITS.maxDurationMs;
}

function validReviewTimes(value: Record<string, unknown>, draft: JourneyDraftV1): boolean {
  const warning = timestampMs(value.warningAt);
  const expires = timestampMs(value.expiresAt);
  const updated = timestampMs(draft.updatedAt);
  if (warning === undefined || expires === undefined || updated === undefined) return false;
  return warning <= expires
    && ((expires === MAX_DATE_MS && warning === MAX_DATE_MS)
      || expires - warning === JOURNEY_LIMITS.reviewWarningMs)
    && expires >= updated
    && expires - updated <= JOURNEY_LIMITS.maxReviewIdleMs;
}

function validateDraft(value: unknown): JourneyDraftV1 | undefined {
  const result = validateJourneyDraft(value);
  return result.ok ? result.value : undefined;
}

export function validateJourneySession(value: unknown): JourneySession | undefined {
  if (!isObject(value)) return;
  const size = serializedBytes(value);
  if (size === undefined || size > SESSION_STATE_MAX_BYTES) return;

  if (value.phase === 'idle') {
    if (!hasExactKeys(value, ['phase', 'epoch']) || !validEpochForPhase(value.phase, value.epoch)) return;
    return structuredClone(value) as unknown as JourneySession;
  }

  if (value.phase === 'saved') {
    if (!hasExactKeys(value, ['phase', 'epoch', 'journeyId', 'revision'])
      || !validEpochForPhase(value.phase, value.epoch) || !isId(value.journeyId) || !isSafeCounter(value.revision)) return;
    return structuredClone(value) as unknown as JourneySession;
  }

  const draft = validateDraft(value.draft);
  if (!draft) return;

  if (value.phase === 'starting') {
    if (!hasExactKeys(value, [
      'phase', 'sessionId', 'journeyId', 'epoch', 'ownerTabId', 'ownerWindowId',
      'documentToken', 'deadlineAt', 'draft',
    ]) || !hasOwner(value, draft, value.phase) || !isId(value.documentToken) || !validDeadline(value.deadlineAt, draft)
      || !isUnstopped(draft) || draft.steps.length !== 0 || Object.keys(draft.images).length !== 0) return;
    return { ...value, draft } as JourneySession;
  }

  if (value.phase === 'recording') {
    if (!hasExactKeys(value, [
      'phase', 'sessionId', 'journeyId', 'epoch', 'ownerTabId', 'ownerWindowId',
      'documentToken', 'deadlineAt', 'documentCounters', 'draft',
    ]) || !hasOwner(value, draft, value.phase) || !isId(value.documentToken) || !validDeadline(value.deadlineAt, draft)
      || !isUnstopped(draft) || !isObject(value.documentCounters)
      || draft.steps.length === 0 || draft.steps[0].kind !== 'initial') return;
    if (!Object.entries(value.documentCounters).every(([id, counter]) => isId(id) && isSafeCounter(counter))
      || !Object.hasOwn(value.documentCounters, value.documentToken)) return;
    return { ...value, documentCounters: structuredClone(value.documentCounters), draft } as JourneySession;
  }

  if (value.phase === 'reviewing') {
    if (!hasExactKeys(value, [
      'phase', 'sessionId', 'journeyId', 'epoch', 'ownerTabId', 'ownerWindowId',
      'warningAt', 'expiresAt', 'draft',
    ]) || !hasOwner(value, draft, value.phase) || !draft.stoppedAt || !draft.stopReason || !hasNoPendingImages(draft)
      || !validReviewTimes(value, draft)) return;
    return { ...value, draft } as JourneySession;
  }

  if (value.phase === 'saving') {
    if (!hasExactKeys(value, [
      'phase', 'sessionId', 'journeyId', 'epoch', 'ownerTabId', 'ownerWindowId', 'draft',
    ]) || !hasOwner(value, draft, value.phase) || !draft.stoppedAt || !draft.stopReason || !hasNoPendingImages(draft)) return;
    return { ...value, draft } as JourneySession;
  }

  return;
}

function validateControl(value: unknown): Control | undefined {
  const size = serializedBytes(value);
  if (!isObject(value) || size === undefined || size > CONTROL_MAX_BYTES
    || value.schemaVersion !== 1 || !isSafeCounter(value.generation, 1)) return;
  if (value.status === 'writing') {
    return hasExactKeys(value, ['schemaVersion', 'status', 'generation']) ? value as unknown as WritingControl : undefined;
  }
  if (value.status !== 'committed' || !hasExactKeys(
    value,
    ['schemaVersion', 'status', 'generation', 'phase', 'epoch'],
    ['lifecycleAt'],
  ) || !['idle', 'starting', 'recording', 'reviewing', 'saving', 'saved'].includes(String(value.phase))) return;
  const phase = value.phase as JourneySession['phase'];
  if (!validEpochForPhase(phase, value.epoch)) return;
  const needsLifecycle = value.phase === 'recording' || value.phase === 'reviewing' || value.phase === 'saving';
  if (needsLifecycle !== Object.hasOwn(value, 'lifecycleAt')) return;
  if (needsLifecycle && timestampMs(value.lifecycleAt) === undefined) return;
  return value as unknown as CommittedControl;
}

function validatePayload(value: unknown, generation: number): JourneySession | undefined {
  if (!isObject(value) || !hasExactKeys(value, ['schemaVersion', 'generation', 'state'])
    || value.schemaVersion !== 1 || value.generation !== generation) return;
  return validateJourneySession(value.state);
}

function boundedIsoAfter(baseMs: number, deltaMs: number): string {
  return new Date(Math.min(MAX_DATE_MS, baseMs + deltaMs)).toISOString();
}

function controlFor(state: Exclude<JourneySession, { phase: 'idle' }>, generation: number): CommittedControl {
  const lifecycleAt = state.phase === 'recording' ? state.deadlineAt
    : state.phase === 'reviewing' ? state.expiresAt
      : state.phase === 'saving' ? boundedIsoAfter(Date.parse(state.draft.updatedAt), JOURNEY_LIMITS.maxReviewIdleMs)
      : undefined;
  return {
    schemaVersion: 1,
    status: 'committed',
    generation,
    phase: state.phase,
    epoch: state.epoch,
    ...(lifecycleAt ? { lifecycleAt } : {}),
  };
}

function aggregateStorageBytes(state: Exclude<JourneySession, { phase: 'idle' }>, generation: number): number | undefined {
  return serializedBytes({
    [CONTROL_KEY]: controlFor(state, generation),
    [PAYLOAD_KEY]: { schemaVersion: 1, generation, state } satisfies SessionPayload,
  });
}

// Published states are never mutated, so the committed state's own object
// needs no second write. Nor does a save's saving phase over the review it
// began from: a restart resumes either as that review, and rewriting it would
// copy every screenshot again only to change the phase.
function storedAs(state: JourneySession, committed: JourneySession | undefined): boolean {
  if (!committed) return false;
  if (state === committed) return true;
  return state.phase === 'saving' && committed.phase === 'reviewing' && state.draft === committed.draft
    && state.sessionId === committed.sessionId && state.journeyId === committed.journeyId
    && state.epoch === committed.epoch && state.ownerTabId === committed.ownerTabId
    && state.ownerWindowId === committed.ownerWindowId;
}

export function createJourneySessionStore(storage: JourneySessionStorageAdapter): {
  read(now: number): Promise<JourneySession>;
  write(state: JourneySession): Promise<void>;
} {
  let queue: Promise<void> = Promise.resolve();
  let generation = 0;
  let failed = false;
  let committed: JourneySession | undefined;

  const enqueue = <Value>(operation: () => Promise<Value>): Promise<Value> => {
    const result = queue.then(operation);
    queue = result.then(() => undefined, () => undefined);
    return result;
  };

  const clearRaw = async (): Promise<boolean> => {
    let cleared = true;
    try { await storage.remove([PAYLOAD_KEY]); } catch { cleared = false }
    try { await storage.remove([CONTROL_KEY]); } catch { cleared = false }
    return cleared;
  };

  const tombstoneControl = async (): Promise<void> => {
    const tombstone: WritingControl = {
      schemaVersion: 1,
      status: 'writing',
      generation: Math.max(1, generation),
    };
    try { await storage.set({ [CONTROL_KEY]: tombstone }) } catch { /* cleanup failure remains explicit */ }
  };

  const clearRawOrTombstone = async (): Promise<boolean> => {
    const cleared = await clearRaw();
    if (!cleared) await tombstoneControl();
    return cleared;
  };

  const failStorage = async (): Promise<never> => {
    failed = true;
    committed = undefined;
    const cleared = await clearRawOrTombstone();
    throw new JourneySessionStorageError(cleared ? 'storage-unavailable' : 'cleanup-failed');
  };

  const nextGeneration = async (): Promise<number> => {
    let stored: Record<string, unknown>;
    try { stored = await storage.get([CONTROL_KEY]); }
    catch { return failStorage() }
    if (!isObject(stored)) return failStorage();
    const current = validateControl(stored[CONTROL_KEY]);
    const previous = Math.max(generation, current?.generation ?? 0);
    generation = previous >= Number.MAX_SAFE_INTEGER ? 1 : previous + 1;
    return generation;
  };

  const persist = async (state: Exclude<JourneySession, { phase: 'idle' }>): Promise<void> => {
    const next = await nextGeneration();
    const writing: WritingControl = { schemaVersion: 1, status: 'writing', generation: next };
    const payload: SessionPayload = { schemaVersion: 1, generation: next, state };
    try {
      await storage.set({ [CONTROL_KEY]: writing });
      await storage.set({ [PAYLOAD_KEY]: payload });
      await storage.set({ [CONTROL_KEY]: controlFor(state, next) });
    } catch {
      return failStorage();
    }
  };

  const purgedIdle = async (epoch: number): Promise<JourneySession> => {
    if (!await clearRawOrTombstone()) throw new JourneySessionStorageError('cleanup-failed');
    return { phase: 'idle', epoch };
  };

  const read = (now: number): Promise<JourneySession> => enqueue(async () => {
    committed = undefined;
    const restored = await readCommitted(now);
    if (restored.phase !== 'idle') committed = restored;
    return restored;
  });

  const readCommitted = async (now: number): Promise<JourneySession> => {
    if (!Number.isFinite(now) || now < 0 || now > MAX_DATE_MS) {
      throw new JourneySessionStorageError('invalid-session');
    }
    if (failed) return purgedIdle(0);
    let rawControl: Record<string, unknown>;
    try { rawControl = await storage.get([CONTROL_KEY]); }
    catch { return failStorage() }
    if (!isObject(rawControl)) return failStorage();

    const controlValue = rawControl[CONTROL_KEY];
    if (controlValue === undefined) return purgedIdle(0);
    const control = validateControl(controlValue);
    if (!control || control.status === 'writing') return purgedIdle(0);
    if (control.phase === 'idle') return purgedIdle(control.epoch);
    if (control.phase === 'starting') return purgedIdle(control.epoch + 1);
    if (control.phase === 'reviewing' && now >= Date.parse(control.lifecycleAt!)) {
      return purgedIdle(control.epoch + 1);
    }
    if (control.phase === 'saving' && now >= Date.parse(control.lifecycleAt!)) {
      return purgedIdle(control.epoch + 1);
    }
    if (control.phase === 'recording'
      && now >= Date.parse(control.lifecycleAt!) + JOURNEY_LIMITS.maxReviewIdleMs) {
      return purgedIdle(control.epoch + 2);
    }

    let rawPayload: Record<string, unknown>;
    try { rawPayload = await storage.get([PAYLOAD_KEY]); }
    catch { return failStorage() }
    if (!isObject(rawPayload)) return failStorage();
    const state = validatePayload(rawPayload[PAYLOAD_KEY], control.generation);
    if (!state || state.phase !== control.phase || state.epoch !== control.epoch) {
      return purgedIdle(control.epoch + 1);
    }
    if (state.phase === 'recording' && state.deadlineAt !== control.lifecycleAt) {
      return purgedIdle(control.epoch + 1);
    }
    if (state.phase === 'reviewing' && state.expiresAt !== control.lifecycleAt) {
      return purgedIdle(control.epoch + 1);
    }
    if (state.phase === 'saving'
      && boundedIsoAfter(Date.parse(state.draft.updatedAt), JOURNEY_LIMITS.maxReviewIdleMs) !== control.lifecycleAt) {
      return purgedIdle(control.epoch + 1);
    }

    if (state.phase === 'recording' && now >= Date.parse(state.deadlineAt)) {
      const stopped = stopJourney(state, {
        epoch: state.epoch,
        stoppedAt: state.deadlineAt,
        reason: 'duration-limit',
      });
      const validStopped = validateJourneySession(stopped);
      if (!validStopped || validStopped.phase !== 'reviewing') return purgedIdle(state.epoch + 1);
      await persist(validStopped);
      return validStopped;
    }

    if (state.phase === 'saving') {
      const review = resumeSavingReview(state);
      if (now >= Date.parse(review.expiresAt)) return purgedIdle(state.epoch + 1);
      const validReview = validateJourneySession(review);
      if (!validReview || validReview.phase !== 'reviewing') return purgedIdle(state.epoch + 1);
      await persist(validReview);
      return validReview;
    }

    return state;
  };

  const write = (state: JourneySession): Promise<void> => enqueue(async () => {
    // Its draft was checked when it was stored, so skip serializing every
    // screenshot again just to measure and validate it.
    if (storedAs(state, committed)) return;
    const inputBytes = serializedBytes(state);
    if (inputBytes !== undefined && inputBytes > SESSION_STATE_MAX_BYTES) {
      throw new JourneySessionStorageError('session-too-large');
    }
    const snapshot = validateJourneySession(state);
    if (!snapshot) throw new JourneySessionStorageError('invalid-session');
    if (snapshot.phase !== 'idle') {
      const aggregateBytes = aggregateStorageBytes(snapshot, Number.MAX_SAFE_INTEGER);
      if (aggregateBytes === undefined || aggregateBytes > JOURNEY_LIMITS.maxSessionBytes) {
        throw new JourneySessionStorageError('session-too-large');
      }
    }
    if (failed && snapshot.phase !== 'idle') {
      throw new JourneySessionStorageError('storage-unavailable');
    }
    if (snapshot.phase === 'idle') {
      committed = undefined;
      if (!await clearRawOrTombstone()) {
        failed = true;
        throw new JourneySessionStorageError('cleanup-failed');
      }
      failed = false;
      return;
    }
    await persist(snapshot);
    committed = state;
  });

  return { read, write };
}
