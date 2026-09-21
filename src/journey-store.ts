import {
  validateJourneyDraft,
  type JourneyDraftImage,
  type JourneyDraftV1,
} from './journey-core';
import { JOURNEY_LIMITS } from './journey-limits';

export type JourneyStoreErrorCode =
  | 'quota-exceeded'
  | 'aborted'
  | 'not-found'
  | 'stale-revision'
  | 'invalid-snapshot';

const ERROR_MESSAGES: Record<JourneyStoreErrorCode, string> = {
  'quota-exceeded': 'The reviewed journey exceeds available storage.',
  aborted: 'The reviewed journey could not be written.',
  'not-found': 'The saved journey is incomplete.',
  'stale-revision': 'The journey revision is stale.',
  'invalid-snapshot': 'The reviewed journey is invalid.',
};

export class JourneyStoreError extends Error {
  readonly code: JourneyStoreErrorCode;

  constructor(code: JourneyStoreErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'JourneyStoreError';
    this.code = code;
  }
}

export interface SaveJourneySnapshotInput {
  draft: JourneyDraftV1;
  images: Record<string, JourneyDraftImage>;
}

export interface OpenJourneySnapshotResult {
  draft: JourneyDraftV1;
  images: Record<string, JourneyDraftImage>;
}

export interface JourneySnapshotSummary {
  journeyId: string;
  revision: number;
  updatedAt: string;
  stepCount: number;
  spansPages: boolean;
}

export const JOURNEY_SNAPSHOT_DB_NAME = 'anmerko:journey-store:v1';
export const JOURNEY_SNAPSHOT_STORE_NAMES = {
  snapshots: 'snapshots',
  blobs: 'blobs',
} as const;

interface StoredSnapshot {
  schemaVersion: 1;
  journeyId: string;
  revision: number;
  updatedAt: string;
  stepCount: number;
  manifestBytes: number;
  imageBytes: number;
  blobIds: string[];
  draft: JourneyDraftV1;
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/;
const BLOB_SEPARATOR = '\u0000';
const encoder = new TextEncoder();

export const __journeyStoreTestHooks: {
  beforeCommit?: (tx: IDBTransaction) => void;
} = {};

function isObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireJourneyId(value: unknown): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > JOURNEY_LIMITS.maxIdCharacters
    || !ID_PATTERN.test(value)
  ) {
    throw new JourneyStoreError('invalid-snapshot');
  }
  return value;
}

function blobKey(journeyId: string, imageId: string): string {
  return `${journeyId}${BLOB_SEPARATOR}${imageId}`;
}

function blobRange(journeyId: string): IDBKeyRange {
  return IDBKeyRange.bound(`${journeyId}${BLOB_SEPARATOR}`, `${journeyId}${BLOB_SEPARATOR}\uffff`);
}

function request<T>(ongoing: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    ongoing.onsuccess = () => resolve(ongoing.result);
    ongoing.onerror = () => reject(ongoing.error ?? new JourneyStoreError('aborted'));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new JourneyStoreError('aborted'));
    tx.onabort = () => reject(tx.error ?? new JourneyStoreError('aborted'));
  });
}

let database: Promise<IDBDatabase> | undefined;

function openDatabase(): Promise<IDBDatabase> {
  database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const pending = indexedDB.open(JOURNEY_SNAPSHOT_DB_NAME, 1);
    pending.onupgradeneeded = () => {
      const db = pending.result;
      if (!db.objectStoreNames.contains(JOURNEY_SNAPSHOT_STORE_NAMES.snapshots)) {
        db.createObjectStore(JOURNEY_SNAPSHOT_STORE_NAMES.snapshots, { keyPath: 'journeyId' });
      }
      if (!db.objectStoreNames.contains(JOURNEY_SNAPSHOT_STORE_NAMES.blobs)) {
        db.createObjectStore(JOURNEY_SNAPSHOT_STORE_NAMES.blobs, { keyPath: 'key' });
      }
    };
    pending.onsuccess = () => {
      const db = pending.result;
      db.onversionchange = () => db.close();
      db.onclose = () => {
        if (database) database = undefined;
      };
      resolve(db);
    };
    pending.onerror = () => {
      database = undefined;
      reject(pending.error ?? new JourneyStoreError('aborted'));
    };
    pending.onblocked = () => {
      database = undefined;
      reject(new JourneyStoreError('aborted'));
    };
  });
  return database;
}

function errorCode(error: unknown): JourneyStoreErrorCode {
  if (error instanceof JourneyStoreError) return error.code;
  if (error instanceof DOMException && error.name === 'QuotaExceededError') return 'quota-exceeded';
  return 'aborted';
}

function storageError(error: unknown): JourneyStoreError {
  return new JourneyStoreError(errorCode(error));
}

interface ValidatedSnapshot {
  draft: JourneyDraftV1;
  manifestBytes: number;
  imageBytes: number;
  blobIds: string[];
}

function validateSnapshotInput(input: SaveJourneySnapshotInput): ValidatedSnapshot {
  const raw: unknown = input;
  if (!isObject(raw) || !isObject(raw.images)) throw new JourneyStoreError('invalid-snapshot');
  const draftPart = isObject(raw.draft) ? raw.draft : {};
  const merged = { ...draftPart, images: raw.images };
  const validated = validateJourneyDraft(merged);
  if (!validated.ok) throw new JourneyStoreError('invalid-snapshot');
  const draft = validated.value;
  if (!draft.expected.trim() || !draft.actual.trim()) throw new JourneyStoreError('invalid-snapshot');
  if (draft.steps.length < 1) throw new JourneyStoreError('invalid-snapshot');
  if (draft.steps.some(step => step.image.status === 'pending')) {
    throw new JourneyStoreError('invalid-snapshot');
  }
  const manifestBytes = encoder.encode(JSON.stringify(draft)).byteLength;
  if (manifestBytes > JOURNEY_LIMITS.maxReviewedManifestBytes) {
    throw new JourneyStoreError('invalid-snapshot');
  }
  const imageBytes = Object.values(draft.images).reduce((total, image) => total + image.byteLength, 0);
  if (imageBytes > JOURNEY_LIMITS.maxReviewedImageBytes) {
    throw new JourneyStoreError('invalid-snapshot');
  }
  const blobIds = Object.entries(draft.images)
    .filter((entry): entry is [string, JourneyDraftImage & { dataUrl: string }] => typeof entry[1].dataUrl === 'string')
    .map(([imageId]) => imageId);
  return { draft, manifestBytes, imageBytes, blobIds };
}

function toStoredSnapshot(validated: ValidatedSnapshot): StoredSnapshot {
  const { draft, manifestBytes, imageBytes, blobIds } = validated;
  const images = Object.fromEntries(
    Object.entries(draft.images).map(([imageId, image]) => {
      const metadata = { ...image };
      delete metadata.dataUrl;
      return [imageId, metadata];
    }),
  );
  return {
    schemaVersion: 1,
    journeyId: draft.id,
    revision: draft.revision,
    updatedAt: draft.updatedAt,
    stepCount: draft.steps.length,
    manifestBytes,
    imageBytes,
    blobIds,
    draft: { ...draft, images },
  };
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
}

function toSummary(record: unknown): JourneySnapshotSummary | undefined {
  if (!isObject(record)) return;
  const { journeyId, revision, updatedAt, stepCount } = record;
  if (typeof journeyId !== 'string' || journeyId.length === 0 || !ID_PATTERN.test(journeyId)) return;
  if (!Number.isSafeInteger(revision) || (revision as number) < 0) return;
  if (!validTimestamp(updatedAt)) return;
  if (!Number.isSafeInteger(stepCount) || (stepCount as number) < 0) return;
  const draft = (record as { draft?: unknown }).draft;
  const steps = isObject(draft) && Array.isArray(draft.steps) ? draft.steps : [];
  const sources = new Set<string>();
  for (const step of steps) {
    if (isObject(step) && typeof step.sourceUrl === 'string') sources.add(step.sourceUrl);
  }
  return {
    journeyId,
    revision: revision as number,
    updatedAt: updatedAt as string,
    stepCount: stepCount as number,
    spansPages: sources.size > 1,
  };
}

function reassemble(stored: StoredSnapshot, blobs: Map<string, string>): OpenJourneySnapshotResult {
  const images: Record<string, JourneyDraftImage> = {};
  for (const [imageId, metadata] of Object.entries(stored.draft.images)) {
    const dataUrl = blobs.get(imageId);
    images[imageId] = dataUrl === undefined ? { ...metadata } : { ...metadata, dataUrl };
  }
  for (const imageId of stored.blobIds) {
    const dataUrl = blobs.get(imageId);
    if (dataUrl === undefined) throw new JourneyStoreError('not-found');
  }
  const merged = { ...stored.draft, images };
  const validated = validateJourneyDraft(merged);
  if (!validated.ok) throw new JourneyStoreError('invalid-snapshot');
  const draft = validated.value;
  return { draft, images: structuredClone(draft.images) };
}

export async function saveJourneySnapshot(
  input: SaveJourneySnapshotInput,
): Promise<{ journeyId: string; revision: number }> {
  const validated = validateSnapshotInput(input);
  let db: IDBDatabase;
  try {
    db = await openDatabase();
  } catch (error) {
    throw storageError(error);
  }
  const stored = toStoredSnapshot(validated);
  let outcome: { journeyId: string; revision: number } | undefined;
  let failure: JourneyStoreError | undefined;
  const tx = db.transaction(
    [JOURNEY_SNAPSHOT_STORE_NAMES.snapshots, JOURNEY_SNAPSHOT_STORE_NAMES.blobs],
    'readwrite',
  );
  const snapshots = tx.objectStore(JOURNEY_SNAPSHOT_STORE_NAMES.snapshots);
  const blobs = tx.objectStore(JOURNEY_SNAPSHOT_STORE_NAMES.blobs);
  const completion = transactionDone(tx);
  try {
    const existing = (await request(snapshots.get(stored.journeyId))) as StoredSnapshot | undefined;
    const existingBlobs = existing?.blobIds;
    if (
      existing !== undefined
      && (toSummary(existing) === undefined
        || !Array.isArray(existingBlobs)
        || !existingBlobs.every(entry => typeof entry === 'string'))
    ) {
      throw new JourneyStoreError('invalid-snapshot');
    }
    if (existing !== undefined && existing.revision > stored.revision) {
      throw new JourneyStoreError('stale-revision');
    }
    if (existing !== undefined && existing.revision === stored.revision) {
      outcome = { journeyId: stored.journeyId, revision: stored.revision };
    } else {
      const obsolete = (existing?.blobIds ?? []).filter(imageId => !stored.blobIds.includes(imageId));
      await request(snapshots.put(stored));
      for (const imageId of stored.blobIds) {
        const dataUrl = validated.draft.images[imageId]?.dataUrl;
        if (typeof dataUrl !== 'string') throw new JourneyStoreError('invalid-snapshot');
        await request(blobs.put({ key: blobKey(stored.journeyId, imageId), dataUrl }));
      }
      for (const imageId of obsolete) {
        await request(blobs.delete(blobKey(stored.journeyId, imageId)));
      }
      __journeyStoreTestHooks.beforeCommit?.(tx);
      outcome = { journeyId: stored.journeyId, revision: stored.revision };
    }
  } catch (error) {
    failure = error instanceof JourneyStoreError ? error : storageError(error);
    try {
      tx.abort();
    } catch {
      /* abort is best-effort; onabort settles the completion promise */
    }
  }
  try {
    await completion;
  } catch (error) {
    throw failure ?? storageError(error);
  }
  if (failure) throw failure;
  return outcome ?? { journeyId: stored.journeyId, revision: stored.revision };
}

export async function openJourneySnapshot(journeyId: string): Promise<OpenJourneySnapshotResult | undefined> {
  const id = requireJourneyId(journeyId);
  let db: IDBDatabase;
  try {
    db = await openDatabase();
  } catch (error) {
    throw storageError(error);
  }
  try {
    const tx = db.transaction(
      [JOURNEY_SNAPSHOT_STORE_NAMES.snapshots, JOURNEY_SNAPSHOT_STORE_NAMES.blobs],
      'readonly',
    );
    const snapshots = tx.objectStore(JOURNEY_SNAPSHOT_STORE_NAMES.snapshots);
    const blobs = tx.objectStore(JOURNEY_SNAPSHOT_STORE_NAMES.blobs);
    const completion = transactionDone(tx);
    const record = (await request(snapshots.get(id))) as StoredSnapshot | undefined;
    let result: OpenJourneySnapshotResult | undefined;
    if (record !== undefined) {
      const draftCandidate = isObject(record)
        ? { ...record.draft, images: isObject(record.draft) ? record.draft.images : undefined }
        : undefined;
      if (
        !isObject(record)
        || record.schemaVersion !== 1
        || record.journeyId !== id
        || !Array.isArray(record.blobIds)
        || !record.blobIds.every(entry => typeof entry === 'string')
        || !validateJourneyDraft(draftCandidate).ok
      ) {
        throw new JourneyStoreError('invalid-snapshot');
      }
      const payloads = new Map<string, string>();
      for (const imageId of record.blobIds) {
        const blob = (await request(blobs.get(blobKey(id, imageId)))) as
          | { key: string; dataUrl: unknown }
          | undefined;
        if (!isObject(blob) || typeof blob.dataUrl !== 'string') throw new JourneyStoreError('not-found');
        payloads.set(imageId, blob.dataUrl);
      }
      result = reassemble(record, payloads);
    }
    await completion;
    return result;
  } catch (error) {
    throw error instanceof JourneyStoreError ? error : storageError(error);
  }
}

export async function deleteJourneySnapshot(journeyId: string): Promise<void> {
  const id = requireJourneyId(journeyId);
  let db: IDBDatabase;
  try {
    db = await openDatabase();
  } catch (error) {
    throw storageError(error);
  }
  try {
    const tx = db.transaction(
      [JOURNEY_SNAPSHOT_STORE_NAMES.snapshots, JOURNEY_SNAPSHOT_STORE_NAMES.blobs],
      'readwrite',
    );
    const snapshots = tx.objectStore(JOURNEY_SNAPSHOT_STORE_NAMES.snapshots);
    const blobs = tx.objectStore(JOURNEY_SNAPSHOT_STORE_NAMES.blobs);
    const completion = transactionDone(tx);
    await request(snapshots.delete(id));
    const keys = (await request(blobs.getAllKeys(blobRange(id)))) as IDBValidKey[];
    for (const key of keys) {
      await request(blobs.delete(key));
    }
    await completion;
  } catch (error) {
    throw error instanceof JourneyStoreError ? error : storageError(error);
  }
}

export async function listJourneySnapshots(): Promise<JourneySnapshotSummary[]> {
  let db: IDBDatabase;
  try {
    db = await openDatabase();
  } catch (error) {
    throw storageError(error);
  }
  try {
    const tx = db.transaction(JOURNEY_SNAPSHOT_STORE_NAMES.snapshots, 'readonly');
    const snapshots = tx.objectStore(JOURNEY_SNAPSHOT_STORE_NAMES.snapshots);
    const completion = transactionDone(tx);
    const records = (await request(snapshots.getAll())) as unknown[];
    await completion;
    return records
      .map(record => toSummary(record))
      .filter((summary): summary is JourneySnapshotSummary => summary !== undefined)
      .sort((a, b) =>
        Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || (a.journeyId < b.journeyId ? -1 : 1),
      );
  } catch (error) {
    throw error instanceof JourneyStoreError ? error : storageError(error);
  }
}
