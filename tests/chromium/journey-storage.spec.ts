import { expect, test, type Page } from '@playwright/test';
import { buildSync } from 'esbuild';
import {
  acceptInitialImage,
  createJourneySession,
  stopJourney,
  type DraftImageState,
  type JourneyDraftImage,
  type JourneyDraftStep,
  type JourneyDraftV1,
} from '../../src/journey-core';

const STARTED_AT = '2026-09-20T12:00:00.000Z';
const OBSERVED_AT = '2026-09-20T12:00:01.000Z';
const CLICK_AT = '2026-09-20T12:00:02.000Z';
const STOPPED_AT = '2026-09-20T12:04:00.000Z';
const UPDATED_V2_AT = '2026-09-20T12:04:30.000Z';
const DEADLINE_AT = '2026-09-20T12:05:00.000Z';
const SOURCE_URL = 'https://example.com/path?private-value-7z=1#detail';
// List labels: the expected-summary snippet and the first page's host and path, never its query.
const LABELS = { expected: 'Checkout shows the total', startPage: 'example.com/path' } as const;
const MINIMAL_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+AvzvAAAAAElFTkSuQmCC';

function baseDraft(): JourneyDraftV1 {
  const starting = createJourneySession({
    sessionId: 'session-1',
    journeyId: 'journey-1',
    ownerTabId: 42,
    ownerWindowId: 7,
    documentToken: 'document-1',
    startedAt: STARTED_AT,
    deadlineAt: DEADLINE_AT,
  });
  const recording = acceptInitialImage(starting, {
    id: 'step-1',
    observedAt: OBSERVED_AT,
    elapsedMs: 1_000,
    sourceUrl: SOURCE_URL,
    imageId: 'image-1',
    image: {
      capturedAt: OBSERVED_AT,
      captureUrl: SOURCE_URL,
      width: 1,
      height: 1,
      byteLength: 69,
      dataUrl: MINIMAL_PNG,
      viewport: { width: 390, height: 844 },
      scroll: { x: 0, y: 0 },
    },
  });
  if (recording.phase !== 'recording') throw new Error('fixture did not enter recording');
  const clickStep: JourneyDraftStep = {
    kind: 'click',
    id: 'step-2',
    seq: 2,
    observedAt: CLICK_AT,
    elapsedMs: 2_000,
    sourceUrl: SOURCE_URL,
    target: {
      tag: 'button',
      selectorPath: ['button'],
      label: 'private-value-7z label',
      editable: false,
      viewport: { width: 390, height: 844 },
      scroll: { x: 0, y: 0 },
    },
    image: { status: 'retained', imageId: 'image-2' },
  };
  const clicked = {
    ...recording,
    draft: {
      ...recording.draft,
      steps: [...recording.draft.steps, clickStep],
      images: {
        ...recording.draft.images,
        'image-2': {
          capturedAt: CLICK_AT,
          captureUrl: SOURCE_URL,
          width: 1,
          height: 1,
          byteLength: 69,
          dataUrl: MINIMAL_PNG,
          viewport: { width: 390, height: 844 },
          scroll: { x: 0, y: 0 },
        } satisfies JourneyDraftImage,
      },
    },
  };
  const stopped = stopJourney(clicked, { epoch: clicked.epoch, stoppedAt: STOPPED_AT, reason: 'user' });
  if (stopped.phase !== 'reviewing') throw new Error('fixture did not enter review');
  return { ...stopped.draft, expected: 'Checkout shows the total', actual: 'Checkout shows no total' };
}

declare global {
  interface Window {
    journeyStoreHarness: {
      invoke(
        op: string,
        payload: Record<string, unknown>,
      ): Promise<{ ok: boolean; value?: unknown; code?: string; message?: string }>;
    };
  }
}

function snapshotInput(draft: JourneyDraftV1): { draft: JourneyDraftV1; images: Record<string, JourneyDraftImage> } {
  return { draft, images: structuredClone(draft.images) };
}

const bundle = () =>
  buildSync({
    stdin: {
      contents: `
  import {
    JOURNEY_SNAPSHOT_DB_NAME,
    JOURNEY_SNAPSHOT_STORE_NAMES,
    __journeyStoreTestHooks,
    deleteJourneySnapshot,
    listJourneySnapshots,
    openJourneySnapshot,
    saveJourneySnapshot,
  } from './src/journey-store';
  import { JOURNEY_LIMITS } from './src/journey-limits';
  const originalLimits = { ...JOURNEY_LIMITS };
  const harness = {
    async invoke(op, payload) {
      try {
        if (payload && payload.fault === 'abort-commit') {
          __journeyStoreTestHooks.beforeCommit = tx => tx.abort();
        }
        if (payload && payload.shrinkLimits) {
          for (const [key, value] of Object.entries(payload.shrinkLimits)) {
            JOURNEY_LIMITS[key] = value;
          }
        }
        let value = null;
        if (op === 'save') value = await saveJourneySnapshot(payload.input);
        else if (op === 'open') value = (await openJourneySnapshot(payload.journeyId)) ?? null;
        else if (op === 'delete') await deleteJourneySnapshot(payload.journeyId);
        else if (op === 'list') value = await listJourneySnapshots();
        else if (op === 'close') { /* connections are released when the page closes */ }
        else if (op === 'dropBlobs') {
          const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open(JOURNEY_SNAPSHOT_DB_NAME);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          try {
            await new Promise((resolve, reject) => {
              const tx = db.transaction(JOURNEY_SNAPSHOT_STORE_NAMES.blobs, 'readwrite');
              tx.oncomplete = () => resolve(undefined);
              tx.onerror = () => reject(tx.error);
              tx.onabort = () => reject(tx.error ?? new Error('dropBlobs transaction aborted'));
              tx.objectStore(JOURNEY_SNAPSHOT_STORE_NAMES.blobs).delete(
                IDBKeyRange.bound(payload.journeyId + '\\u0000', payload.journeyId + '\\u0000\\uffff'),
              );
            });
          } finally {
            db.close();
          }
        }
        else if (op === 'corrupt') {
          const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open(JOURNEY_SNAPSHOT_DB_NAME);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          try {
            await new Promise((resolve, reject) => {
              const tx = db.transaction(JOURNEY_SNAPSHOT_STORE_NAMES.snapshots, 'readwrite');
              tx.oncomplete = () => resolve(undefined);
              tx.onerror = () => reject(tx.error);
              tx.onabort = () => reject(tx.error ?? new Error('corrupt transaction aborted'));
              tx.objectStore(JOURNEY_SNAPSHOT_STORE_NAMES.snapshots).put(payload.record);
            });
          } finally {
            db.close();
          }
        }
        return { ok: true, value };
      } catch (error) {
        return { ok: false, code: error && error.code ? error.code : 'unknown', message: String((error && error.message) || error) };
      } finally {
        __journeyStoreTestHooks.beforeCommit = undefined;
        Object.assign(JOURNEY_LIMITS, originalLimits);
      }
    },
  };
  window.journeyStoreHarness = harness;
  `,
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    format: 'iife',
  }).outputFiles[0].text;

async function openStore(page: Page): Promise<void> {
  await page.goto('http://127.0.0.1:4173');
  await page.addScriptTag({ content: bundle() });
  await page.evaluate(`indexedDB.deleteDatabase('anmerko:journey-store:v1')`);
}

async function invoke(
  page: Page,
  op: string,
  payload: Record<string, unknown> = {},
): Promise<{ ok: boolean; value?: unknown; code?: string; message?: string }> {
  const args: [string, Record<string, unknown>] = [op, payload];
  return (await page.evaluate(
    ([operation, operationArgs]: [string, Record<string, unknown>]) =>
      window.journeyStoreHarness.invoke(operation, operationArgs),
    args,
  )) as { ok: boolean; value?: unknown; code?: string; message?: string };
}

async function expectInvalid(
  page: Page,
  payload: Record<string, unknown>,
): Promise<{ code?: string; message?: string }> {
  const result = await invoke(page, 'save', payload);
  expect(result.ok).toBe(false);
  expect(result.code).toBe('invalid-snapshot');
  expect(result.message).not.toContain('private-value-7z');
  expect(result.message).not.toContain(MINIMAL_PNG.slice(30));
  expect(result.message).not.toContain('https://example.com');
  return result;
}

test('save, open, list, and delete round-trip with byte-identical images', async ({ page }) => {
  await openStore(page);
  const input = snapshotInput(baseDraft());

  const saved = await invoke(page, 'save', { input });
  expect(saved).toEqual({ ok: true, value: { journeyId: 'journey-1', revision: 0 } });

  const opened = await invoke(page, 'open', { journeyId: 'journey-1' });
  expect(opened.ok).toBe(true);
  const snapshot = opened.value as { draft: JourneyDraftV1; images: Record<string, JourneyDraftImage> };
  expect(snapshot.draft).toEqual(input.draft);
  expect(snapshot.images).toEqual(input.images);
  expect(snapshot.images['image-1'].dataUrl).toBe(MINIMAL_PNG);
  expect(snapshot.images['image-2'].dataUrl).toBe(MINIMAL_PNG);
  expect(snapshot.draft.images['image-1'].dataUrl).toBe(MINIMAL_PNG);

  const listed = await invoke(page, 'list', {});
  expect(listed).toEqual({
    ok: true,
    value: [{ journeyId: 'journey-1', revision: 0, updatedAt: STOPPED_AT, stepCount: 2, spansPages: false, ...LABELS }],
  });

  expect(await invoke(page, 'delete', { journeyId: 'journey-1' })).toEqual({ ok: true, value: null });
  expect(await invoke(page, 'open', { journeyId: 'journey-1' })).toEqual({ ok: true, value: null });
  expect(await invoke(page, 'list', {})).toEqual({ ok: true, value: [] });
});

test('list marks journeys spanning more than one source URL', async ({ page }) => {
  await openStore(page);
  const spanned = baseDraft();
  spanned.steps = spanned.steps.map((step, index) => index === 0
    ? step
    : { ...step, sourceUrl: 'https://other.example/checkout', sourcePage: 2 });
  expect(await invoke(page, 'save', { input: snapshotInput(spanned) })).toEqual({
    ok: true, value: { journeyId: 'journey-1', revision: 0 },
  });
  expect(await invoke(page, 'list', {})).toEqual({
    ok: true,
    value: [{ journeyId: 'journey-1', revision: 0, updatedAt: STOPPED_AT, stepCount: 2, spansPages: true, ...LABELS }],
  });
});

function withNavigation(draft: JourneyDraftV1, toUrl: string): JourneyDraftV1 {
  const navigation: JourneyDraftStep = {
    kind: 'navigation',
    id: 'step-3',
    seq: 3,
    observedAt: '2026-09-20T12:00:03.000Z',
    elapsedMs: 3_000,
    sourceUrl: SOURCE_URL,
    sourcePage: 1,
    navigation: { toUrl, causedByStepId: 'step-2', toPage: 2 },
    image: { status: 'unavailable', reason: 'navigation-timeout' },
  };
  return { ...draft, steps: [...draft.steps, navigation] };
}

test('list counts navigation destinations as pages without exposing redacted ones', async ({ page }) => {
  await openStore(page);
  const summary = (spansPages: boolean, revision = 0, updatedAt = STOPPED_AT, labels: object = LABELS) => ({
    ok: true, value: [{ journeyId: 'journey-1', revision, updatedAt, stepCount: 3, spansPages, ...labels }],
  });

  // Every step starts on the same source URL; only the destination differs.
  const visible = withNavigation(baseDraft(), 'https://example.com/checkout?private-value-7z=2');
  expect(await invoke(page, 'save', { input: snapshotInput(visible) })).toEqual({
    ok: true, value: { journeyId: 'journey-1', revision: 0 },
  });
  expect(await invoke(page, 'list', {})).toEqual(summary(true));

  const redacted: JourneyDraftV1 = {
    ...withNavigation(baseDraft(), '[redacted]'),
    revision: 1,
    updatedAt: UPDATED_V2_AT,
    redactions: { steps: { 'step-3': { toUrl: true } } },
  };
  expect(await invoke(page, 'save', { input: snapshotInput(redacted) })).toEqual({
    ok: true, value: { journeyId: 'journey-1', revision: 1 },
  });
  const opened = await invoke(page, 'open', { journeyId: 'journey-1' });
  expect(opened.ok).toBe(true);
  expect((opened.value as { draft: JourneyDraftV1 }).draft).toEqual(redacted);
  expect(JSON.stringify(opened.value)).not.toContain('private-value-7z=2');
  expect(await invoke(page, 'list', {})).toEqual(summary(true, 1, UPDATED_V2_AT));

  // Redacted URLs keep the page numbers recorded for them, so redacting every
  // URL leaves the scope as it was without keeping any hidden value.
  const allRedacted: JourneyDraftV1 = {
    ...redacted,
    revision: 2,
    steps: redacted.steps.map(step => ({ ...step, sourceUrl: '[redacted]' })),
    redactions: {
      steps: { 'step-1': { sourceUrl: true }, 'step-2': { sourceUrl: true }, 'step-3': { sourceUrl: true, toUrl: true } },
    },
  };
  expect(await invoke(page, 'save', { input: snapshotInput(allRedacted) })).toEqual({
    ok: true, value: { journeyId: 'journey-1', revision: 2 },
  });
  // A redacted first page gives no start-page label.
  expect(await invoke(page, 'list', {})).toEqual(summary(true, 2, UPDATED_V2_AT, { expected: LABELS.expected }));
  expect(JSON.stringify(await invoke(page, 'list', {}))).not.toContain('private-value-7z');
});

test('list keeps a single-page journey single when review redacts one of its URLs', async ({ page }) => {
  await openStore(page);
  const single: JourneyDraftV1 = {
    ...baseDraft(),
    steps: baseDraft().steps.map(step => step.id === 'step-2' ? { ...step, sourceUrl: '[redacted]' } : step),
    redactions: { steps: { 'step-2': { sourceUrl: true } } },
  };
  expect(await invoke(page, 'save', { input: snapshotInput(single) })).toEqual({
    ok: true, value: { journeyId: 'journey-1', revision: 0 },
  });
  expect(await invoke(page, 'list', {})).toEqual({
    ok: true, value: [{ journeyId: 'journey-1', revision: 0, updatedAt: STOPPED_AT, stepCount: 2, spansPages: false, ...LABELS }],
  });
});

test('snapshots saved with only source and capture redactions still open', async ({ page }) => {
  await openStore(page);
  const draft = withNavigation(baseDraft(), 'https://example.com/checkout');
  const legacy: JourneyDraftV1 = {
    ...draft,
    steps: draft.steps.map(step => step.id === 'step-1' ? { ...step, sourceUrl: '[redacted]' } : step),
    images: { ...draft.images, 'image-2': { ...draft.images['image-2'], captureUrl: '[redacted]' } },
    redactions: { steps: { 'step-1': { sourceUrl: true }, 'step-2': { captureUrl: true } } },
  };
  expect(await invoke(page, 'save', { input: snapshotInput(legacy) })).toEqual({
    ok: true, value: { journeyId: 'journey-1', revision: 0 },
  });
  const opened = await invoke(page, 'open', { journeyId: 'journey-1' });
  expect(opened.ok).toBe(true);
  expect((opened.value as { draft: JourneyDraftV1 }).draft).toEqual(legacy);
  expect(await invoke(page, 'list', {})).toEqual({
    ok: true, value: [{ journeyId: 'journey-1', revision: 0, updatedAt: STOPPED_AT, stepCount: 3, spansPages: true, expected: LABELS.expected }],
  });
});

test('invalid snapshots are rejected and never stored', async ({ page }) => {
  await openStore(page);

  const pendingImage: DraftImageState = { status: 'pending', captureId: 'capture-1' };
  const pending = baseDraft();
  pending.steps = pending.steps.map((step): JourneyDraftStep =>
    step.id === 'step-1' ? { ...step, image: pendingImage } : step,
  );
  await expectInvalid(page, { input: snapshotInput(pending) });

  const blankExpected = { ...baseDraft(), expected: '   ' };
  await expectInvalid(page, { input: snapshotInput(blankExpected) });

  const blankActual = { ...baseDraft(), actual: '' };
  await expectInvalid(page, { input: snapshotInput(blankActual) });

  const stepless = { ...baseDraft(), steps: [], images: {} };
  await expectInvalid(page, { input: snapshotInput(stepless) });

  await expectInvalid(page, {
    input: snapshotInput(baseDraft()),
    shrinkLimits: { maxReviewedManifestBytes: 16 },
  });

  await expectInvalid(page, {
    input: snapshotInput(baseDraft()),
    shrinkLimits: { maxReviewedImageBytes: 10 },
  });

  expect(await invoke(page, 'open', { journeyId: 'journey-1' })).toEqual({ ok: true, value: null });
  expect(await invoke(page, 'list', {})).toEqual({ ok: true, value: [] });
});

test('stale revisions are rejected while the stored snapshot stays intact', async ({ page }) => {
  await openStore(page);
  const first = baseDraft();
  expect(await invoke(page, 'save', { input: snapshotInput(first) })).toEqual({
    ok: true,
    value: { journeyId: 'journey-1', revision: 0 },
  });

  const second = { ...baseDraft(), revision: 1, updatedAt: UPDATED_V2_AT, expected: 'Second write' };
  expect(await invoke(page, 'save', { input: snapshotInput(second) })).toEqual({
    ok: true,
    value: { journeyId: 'journey-1', revision: 1 },
  });

  const stale = { ...baseDraft(), revision: 0, expected: 'Stale write' };
  const rejected = await invoke(page, 'save', { input: snapshotInput(stale) });
  expect(rejected.ok).toBe(false);
  expect(rejected.code).toBe('stale-revision');
  expect(rejected.message).not.toContain('Stale write');

  const opened = await invoke(page, 'open', { journeyId: 'journey-1' });
  expect(opened.ok).toBe(true);
  const snapshot = opened.value as { draft: JourneyDraftV1 };
  expect(snapshot.draft.revision).toBe(1);
  expect(snapshot.draft.expected).toBe('Second write');
  expect(snapshot.draft.images['image-1'].dataUrl).toBe(MINIMAL_PNG);
});

test('rewriting the same revision is a no-op success', async ({ page }) => {
  await openStore(page);
  const input = snapshotInput(baseDraft());
  expect(await invoke(page, 'save', { input })).toEqual({
    ok: true,
    value: { journeyId: 'journey-1', revision: 0 },
  });

  expect(await invoke(page, 'save', { input: structuredClone(input) })).toEqual({
    ok: true,
    value: { journeyId: 'journey-1', revision: 0 },
  });

  const diverged = snapshotInput({ ...baseDraft(), expected: 'Diverged retry' });
  expect(await invoke(page, 'save', { input: diverged })).toEqual({
    ok: true,
    value: { journeyId: 'journey-1', revision: 0 },
  });

  const opened = await invoke(page, 'open', { journeyId: 'journey-1' });
  expect((opened.value as { draft: JourneyDraftV1 }).draft).toEqual(input.draft);
});

test('a higher revision replaces the snapshot atomically', async ({ page }) => {
  await openStore(page);
  expect(await invoke(page, 'save', { input: snapshotInput(baseDraft()) })).toEqual({
    ok: true,
    value: { journeyId: 'journey-1', revision: 0 },
  });

  const full = baseDraft();
  const pruned: JourneyDraftV1 = {
    ...full,
    revision: 1,
    updatedAt: UPDATED_V2_AT,
    expected: 'Pruned to one step',
    steps: full.steps.filter(step => step.id === 'step-1'),
    images: { 'image-1': full.images['image-1'] },
  };
  expect(await invoke(page, 'save', { input: snapshotInput(pruned) })).toEqual({
    ok: true,
    value: { journeyId: 'journey-1', revision: 1 },
  });

  const opened = await invoke(page, 'open', { journeyId: 'journey-1' });
  const snapshot = opened.value as { draft: JourneyDraftV1; images: Record<string, JourneyDraftImage> };
  expect(snapshot.draft).toEqual(pruned);
  expect(Object.keys(snapshot.images)).toEqual(['image-1']);
  expect(snapshot.images['image-1'].dataUrl).toBe(MINIMAL_PNG);

  expect(await invoke(page, 'list', {})).toEqual({
    ok: true,
    value: [{ journeyId: 'journey-1', revision: 1, updatedAt: UPDATED_V2_AT, stepCount: 1, spansPages: false, expected: 'Pruned to one step', startPage: LABELS.startPage }],
  });
});

test('failed writes leave the prior snapshot and the caller draft intact', async ({ page }) => {
  await openStore(page);
  const first = snapshotInput(baseDraft());
  await invoke(page, 'save', { input: first });

  const rejected = snapshotInput({ ...baseDraft(), revision: 1, updatedAt: UPDATED_V2_AT, expected: '' });
  const beforeRejected = JSON.stringify(rejected);
  await expectInvalid(page, { input: rejected });
  expect(JSON.stringify(rejected)).toBe(beforeRejected);

  const aborted = snapshotInput({ ...baseDraft(), revision: 1, updatedAt: UPDATED_V2_AT, expected: 'Aborted write' });
  const abortedResult = await invoke(page, 'save', { input: aborted, fault: 'abort-commit' });
  expect(abortedResult.ok).toBe(false);
  expect(abortedResult.code).toBe('aborted');
  expect(abortedResult.message).not.toContain('Aborted write');
  expect(abortedResult.message).not.toContain('private-value-7z');

  const opened = await invoke(page, 'open', { journeyId: 'journey-1' });
  expect(opened.ok).toBe(true);
  expect((opened.value as { draft: JourneyDraftV1 }).draft).toEqual(first.draft);
  expect(
    ((opened.value as { images: Record<string, JourneyDraftImage> }).images['image-2'].dataUrl),
  ).toBe(MINIMAL_PNG);
});

test('deleted snapshots stay deleted and missing snapshots are safe', async ({ page }) => {
  await openStore(page);
  await invoke(page, 'save', { input: snapshotInput(baseDraft()) });

  expect(await invoke(page, 'open', { journeyId: 'missing-journey' })).toEqual({ ok: true, value: null });
  expect(await invoke(page, 'delete', { journeyId: 'missing-journey' })).toEqual({ ok: true, value: null });

  expect(await invoke(page, 'delete', { journeyId: 'journey-1' })).toEqual({ ok: true, value: null });
  expect(await invoke(page, 'delete', { journeyId: 'journey-1' })).toEqual({ ok: true, value: null });
  expect(await invoke(page, 'open', { journeyId: 'journey-1' })).toEqual({ ok: true, value: null });
  expect(await invoke(page, 'list', {})).toEqual({ ok: true, value: [] });

  expect(await invoke(page, 'save', { input: snapshotInput(baseDraft()) })).toEqual({
    ok: true,
    value: { journeyId: 'journey-1', revision: 0 },
  });
  expect(await invoke(page, 'list', {})).toEqual({
    ok: true,
    value: [{ journeyId: 'journey-1', revision: 0, updatedAt: STOPPED_AT, stepCount: 2, spansPages: false, ...LABELS }],
  });
});

test('opening a snapshot with missing blobs reports not-found without leaking', async ({ page }) => {
  await openStore(page);
  await invoke(page, 'save', { input: snapshotInput(baseDraft()) });
  expect(await invoke(page, 'dropBlobs', { journeyId: 'journey-1' })).toEqual({ ok: true, value: null });

  const opened = await invoke(page, 'open', { journeyId: 'journey-1' });
  expect(opened.ok).toBe(false);
  expect(opened.code).toBe('not-found');
  expect(opened.message).not.toContain('private-value-7z');
  expect(opened.message).not.toContain(MINIMAL_PNG.slice(30));

  expect(await invoke(page, 'delete', { journeyId: 'journey-1' })).toEqual({ ok: true, value: null });
  expect(await invoke(page, 'list', {})).toEqual({ ok: true, value: [] });
});

test('corrupt stored records never leak and never break the list', async ({ page }) => {
  await openStore(page);
  await invoke(page, 'save', { input: snapshotInput(baseDraft()) });
  await invoke(page, 'corrupt', {
    record: { journeyId: 'corrupt-1', revision: 'not-a-revision', draft: { secret: 'private-value-7z' } },
  });

  expect(await invoke(page, 'list', {})).toEqual({
    ok: true,
    value: [{ journeyId: 'journey-1', revision: 0, updatedAt: STOPPED_AT, stepCount: 2, spansPages: false, ...LABELS }],
  });

  const opened = await invoke(page, 'open', { journeyId: 'corrupt-1' });
  expect(opened.ok).toBe(false);
  expect(opened.code).toBe('invalid-snapshot');
  expect(opened.message).not.toContain('private-value-7z');
});
