import { expect, test } from '@playwright/test';
import {
  acceptInitialImage,
  acceptJourneyEventBatch,
  commitJourneyNavigation,
  createJourneySession,
  resolveJourneyCapture,
  stopJourney,
  validateJourneyDraft,
  validateJourneyManifest,
  type JourneyDraftV1,
  type JourneyManifestV1,
} from '../../src/journey-core';
import { stripUrlCredentials, validateJourneyEventBatch } from '../../src/journey-events';
import { JOURNEY_LIMITS } from '../../src/journey-limits';

const reviewed = (text: string) => ({ text, edited: false, redacted: false });

function validManifest(): JourneyManifestV1 {
  return {
    schemaVersion: 1,
    id: 'journey-1',
    revision: 1,
    createdAt: '2026-09-20T12:00:00.000Z',
    updatedAt: '2026-09-20T12:00:03.000Z',
    startedAt: '2026-09-20T12:00:00.000Z',
    stoppedAt: '2026-09-20T12:00:03.000Z',
    includeEnteredValues: true,
    stopReason: 'user',
    expected: 'The selected item remains in the cart.',
    actual: 'Checkout is empty.',
    steps: [
      {
        kind: 'initial', id: 'step-1', seq: 1,
        observedAt: '2026-09-20T12:00:00.100Z', elapsedMs: 100,
        sourceUrl: reviewed('https://shop.example/items?q=green&q=large#list'),
        image: { status: 'retained', imageId: 'image-1' },
      },
      {
        kind: 'click', id: 'step-2', seq: 2,
        observedAt: '2026-09-20T12:00:01.000Z', elapsedMs: 1_000,
        sourceUrl: reviewed('https://shop.example/items?q=green&q=large#list'),
        target: {
          tag: 'button', role: 'button', selectorPath: ['main', 'button:nth-of-type(2)'],
          label: reviewed('Checkout'), editable: false, viewport: { width: 1_280, height: 720 },
          scroll: { x: 0, y: 300 }, point: { x: 1_010, y: 650 },
        },
        image: { status: 'retained', imageId: 'image-2', sharedNavigationResult: true },
      },
      {
        kind: 'navigation', id: 'step-3', seq: 5,
        observedAt: '2026-09-20T12:00:01.100Z', elapsedMs: 1_100,
        sourceUrl: reviewed('https://shop.example/items?q=green&q=large#list'),
        navigation: {
          toUrl: reviewed('https://checkout.example/pay?cart=7&mode=test#details'),
          causedByStepId: 'step-2',
        },
        image: { status: 'retained', imageId: 'image-2', sharedNavigationResult: true },
      },
      {
        kind: 'field-change', id: 'step-4', seq: 7,
        observedAt: '2026-09-20T12:00:02.000Z', elapsedMs: 2_000,
        sourceUrl: reviewed('https://checkout.example/pay?cart=7&mode=test#details'),
        target: {
          tag: 'input', role: 'textbox', selectorPath: ['form', 'input:nth-of-type(1)'],
          label: reviewed('Email'), editable: true, viewport: { width: 1_280, height: 720 }, scroll: { x: 0, y: 0 },
        },
        enteredValue: { kind: 'text', value: reviewed('test@example.invalid'), truncated: false },
        image: { status: 'unavailable', reason: 'superseded' },
      },
    ],
    images: {
      'image-1': {
        capturedAt: '2026-09-20T12:00:00.100Z',
        captureUrl: reviewed('https://shop.example/items?q=green&q=large#list'),
        width: 1_280, height: 720, byteLength: 100_000,
        viewport: { width: 1_280, height: 720 }, scroll: { x: 0, y: 300 }, redacted: false,
      },
      'image-2': {
        capturedAt: '2026-09-20T12:00:01.600Z',
        captureUrl: reviewed('https://checkout.example/pay?cart=7&mode=test#details'),
        width: 1_280, height: 720, byteLength: 120_000,
        viewport: { width: 1_280, height: 720 }, scroll: { x: 0, y: 0 }, redacted: false,
      },
    },
    limitations: ['Observation only; animated content may be intermediate.'],
  };
}

test('full journey URLs lose only embedded credentials', () => {
  expect(stripUrlCredentials('https://user:p%40ss@example.com:8443/a%2Fb?x=1&x=&q=a%20b#route/2'))
    .toBe('https://example.com:8443/a%2Fb?x=1&x=&q=a%20b#route/2');
});

test('reviewed manifest accepts stable sequence gaps, shared images, and JSON round trips', () => {
  const input = JSON.parse(JSON.stringify(validManifest()));
  const result = validateJourneyManifest(input);

  expect(result).toEqual({ ok: true, value: input });
});

test('reviewed URL text may be replaced or irreversibly redacted without retaining a raw URL', () => {
  const replaced = validManifest();
  replaced.steps[0].sourceUrl = { text: '[checkout URL removed]', edited: true, redacted: true };
  replaced.images['image-1'].captureUrl = { text: '', edited: true, redacted: true };

  expect(validateJourneyManifest(replaced)).toEqual({ ok: true, value: replaced });
});

test('reviewed manifest rejects unknown versions and fields from another union member', () => {
  const unknownVersion = { ...validManifest(), schemaVersion: 2 };
  const invalidUnion = validManifest();
  Object.assign(invalidUnion.steps[0], { target: validManifest().steps[1].target });

  expect(validateJourneyManifest(unknownVersion).ok).toBe(false);
  expect(validateJourneyManifest(invalidUnion).ok).toBe(false);
});

test('reviewed manifest rejects duplicate step IDs and dangling or unreferenced images', () => {
  const duplicate = validManifest();
  duplicate.steps[1].id = duplicate.steps[0].id;
  const dangling = validManifest();
  dangling.steps[0].image = { status: 'retained', imageId: 'missing' };
  const unreferenced = validManifest();
  unreferenced.steps = unreferenced.steps.filter(step => step.image.status !== 'retained' || step.image.imageId !== 'image-1');

  expect(validateJourneyManifest(duplicate).ok).toBe(false);
  expect(validateJourneyManifest(dangling).ok).toBe(false);
  expect(validateJourneyManifest(unreferenced).ok).toBe(false);
});

test('reviewed manifest enforces URL, target, value, image, and summary bounds', () => {
  const cases: JourneyManifestV1[] = [];
  const longUrl = validManifest();
  longUrl.steps[0].sourceUrl.text = `https://example.com/?q=${'x'.repeat(JOURNEY_LIMITS.maxUrlBytes)}`;
  cases.push(longUrl);
  const deepTarget = validManifest();
  const click = deepTarget.steps[1];
  if (click.kind === 'click') click.target.selectorPath = Array.from({ length: JOURNEY_LIMITS.maxTargetSegments + 1 }, (_, i) => `div:nth-of-type(${i + 1})`);
  cases.push(deepTarget);
  const longValue = validManifest();
  const field = longValue.steps[3];
  if (field.kind === 'field-change' && field.enteredValue.kind === 'text') field.enteredValue.value.text = 'x'.repeat(JOURNEY_LIMITS.maxFieldValueCharacters + 1);
  cases.push(longValue);
  const largeImage = validManifest();
  largeImage.images['image-1'].byteLength = JOURNEY_LIMITS.maxImageBytes + 1;
  cases.push(largeImage);
  const blankSummary = validManifest();
  blankSummary.expected = '   ';
  cases.push(blankSummary);

  for (const manifest of cases) expect(validateJourneyManifest(manifest).ok).toBe(false);
});

test('raw draft permits pending images and blank summaries while reviewed validation does not', () => {
  const draft: JourneyDraftV1 = {
    schemaVersion: 1, status: 'draft', id: 'journey-1', revision: 0,
    createdAt: '2026-09-20T12:00:00.000Z', updatedAt: '2026-09-20T12:00:00.000Z',
    startedAt: '2026-09-20T12:00:00.000Z', includeEnteredValues: false,
    expected: '', actual: '', limitations: [], images: {},
    steps: [{
      kind: 'click', id: 'step-1', seq: 1, observedAt: '2026-09-20T12:00:01.000Z', elapsedMs: 1_000,
      sourceUrl: 'https://example.com/?x=1#route',
      target: {
        tag: 'button', selectorPath: ['button'], label: 'Continue', editable: false,
        viewport: { width: 390, height: 844 }, scroll: { x: 0, y: 0 }, point: { x: 195, y: 700 },
      },
      image: { status: 'pending', captureId: 'capture-1' },
    }],
  };

  expect(validateJourneyDraft(draft)).toEqual({ ok: true, value: draft });
  expect(validateJourneyManifest(draft).ok).toBe(false);
});

test('recording begins only after an accepted initial image', () => {
  const starting = createJourneySession({
    sessionId: 'session-1', journeyId: 'journey-1', ownerTabId: 42, ownerWindowId: 7,
    documentToken: 'document-1', startedAt: '2026-09-20T12:00:00.000Z',
    deadlineAt: '2026-09-20T12:05:00.000Z', includeEnteredValues: false,
  });

  expect(starting.phase).toBe('starting');
  const recording = acceptInitialImage(starting, {
    id: 'step-initial', observedAt: '2026-09-20T12:00:00.100Z', elapsedMs: 100,
    sourceUrl: 'https://user:secret@example.com/start?q=1#top', imageId: 'image-initial',
    image: {
      capturedAt: '2026-09-20T12:00:00.100Z', captureUrl: 'https://user:secret@example.com/start?q=1#top',
      width: 390, height: 844, byteLength: 10_000,
      viewport: { width: 390, height: 844 }, scroll: { x: 0, y: 0 },
    },
  });

  expect(recording.phase).toBe('recording');
  if (recording.phase === 'recording') {
    expect(recording.draft.steps).toHaveLength(1);
    expect(recording.draft.steps[0].sourceUrl).toBe('https://example.com/start?q=1#top');
    expect(recording.draft.images['image-initial'].captureUrl).toBe('https://example.com/start?q=1#top');
  }
});

test('event batches are sequenced once, deduplicated by document counter, and ordered independently of wall clock', () => {
  const recording = recordingSession();
  const batch = {
    schemaVersion: 1 as const, sessionId: 'session-1', epoch: 1,
    documentToken: 'document-1', localCounter: 1,
    events: [
      {
        kind: 'field-change' as const, id: 'step-field', observedAt: '2026-09-20T11:59:59.000Z', elapsedMs: 200,
        sourceUrl: 'https://example.com/start?x=1#top',
        target: { tag: 'input', selectorPath: ['input'], label: 'Search', editable: true, viewport: { width: 390, height: 844 }, scroll: { x: 0, y: 0 } },
        enteredValue: { kind: 'text' as const, value: 'green', truncated: false },
        image: { status: 'unavailable' as const, reason: 'superseded' as const },
      },
      {
        kind: 'click' as const, id: 'step-click', observedAt: '2026-09-20T12:00:00.200Z', elapsedMs: 200,
        sourceUrl: 'https://example.com/start?x=1#top',
        target: { tag: 'button', selectorPath: ['button'], label: 'Go', editable: false, viewport: { width: 390, height: 844 }, scroll: { x: 0, y: 0 }, point: { x: 100, y: 100 } },
        image: { status: 'pending' as const, captureId: 'capture-click' },
      },
    ],
  };

  expect(validateJourneyEventBatch(batch).ok).toBe(true);
  const accepted = acceptJourneyEventBatch(recording, batch);
  const retried = acceptJourneyEventBatch(accepted, batch);

  expect(accepted.phase).toBe('recording');
  if (accepted.phase === 'recording') expect(accepted.draft.steps.map(step => [step.id, step.seq])).toEqual([
    ['step-initial', 1], ['step-field', 2], ['step-click', 3],
  ]);
  expect(retried).toBe(accepted);
});

test('navigation changes the document token and rejects old-document or stale-epoch work', () => {
  const recording = recordingSession();
  const navigated = commitJourneyNavigation(recording, {
    epoch: 1, id: 'step-nav', observedAt: '2026-09-20T12:00:01.000Z', elapsedMs: 1_000,
    sourceUrl: 'https://example.com/start', toUrl: 'https://example.net/next?x=1#done',
    previousDocumentToken: 'document-1', documentToken: 'document-2',
    image: { status: 'pending', captureId: 'capture-nav' },
  });
  const staleBatch = {
    schemaVersion: 1 as const, sessionId: 'session-1', epoch: 1,
    documentToken: 'document-1', localCounter: 1,
    events: [{
      kind: 'click' as const, id: 'late-click', observedAt: '2026-09-20T12:00:01.100Z', elapsedMs: 1_100,
      sourceUrl: 'https://example.com/start',
      target: { tag: 'button', selectorPath: ['button'], label: 'Late', editable: false, viewport: { width: 390, height: 844 }, scroll: { x: 0, y: 0 }, point: { x: 10, y: 10 } },
      image: { status: 'unavailable' as const, reason: 'page-document-changed' as const },
    }],
  };

  expect(navigated.phase).toBe('recording');
  if (navigated.phase === 'recording') expect(navigated.documentToken).toBe('document-2');
  expect(acceptJourneyEventBatch(navigated, staleBatch)).toBe(navigated);
});

test('capture resolution replaces one pending state with bounded image metadata', () => {
  const recording = recordingSession();
  const withClick = acceptJourneyEventBatch(recording, clickBatch(1, 'capture-click'));
  const resolved = resolveJourneyCapture(withClick, {
    epoch: 1, documentToken: 'document-1', captureId: 'capture-click', status: 'retained', imageId: 'image-click',
    image: {
      capturedAt: '2026-09-20T12:00:01.000Z', captureUrl: 'https://user:secret@example.com/result?x=1#done',
      width: 390, height: 844, byteLength: 10_000,
      viewport: { width: 390, height: 844 }, scroll: { x: 0, y: 0 },
    },
  });

  expect(resolved.phase).toBe('recording');
  if (resolved.phase === 'recording') {
    expect(resolved.draft.steps[1].image).toEqual({ status: 'retained', imageId: 'image-click' });
    expect(resolved.draft.images['image-click'].captureUrl).toBe('https://example.com/result?x=1#done');
  }
});

test('batches cannot reuse pending capture IDs or cross the aggregate field-text budget', () => {
  const recording = recordingSession();
  const withClick = acceptJourneyEventBatch(recording, clickBatch(1, 'capture-click'));
  expect(acceptJourneyEventBatch(withClick, clickBatch(2, 'capture-click'))).toBe(withClick);

  const selection = Array.from({ length: 9 }, () => 'x'.repeat(1_000));
  const first = acceptJourneyEventBatch(recording, fieldBatch(1, 'capture-field-1', selection));
  expect(first).not.toBe(recording);
  expect(acceptJourneyEventBatch(first, fieldBatch(2, 'capture-field-2', selection))).toBe(first);

  const fabricated = clickBatch(1, 'capture-fabricated') as unknown as { events: Array<Record<string, unknown>> };
  fabricated.events[0].image = { status: 'retained', imageId: 'made-up' };
  expect(validateJourneyEventBatch(fabricated).ok).toBe(false);
});

test('Stop increments the epoch before cleanup, rejects late work, marks pending captures, and is idempotent', () => {
  const recording = acceptJourneyEventBatch(recordingSession(), clickBatch(1, 'capture-click'));
  const stopped = stopJourney(recording, { epoch: 1, stoppedAt: '2026-09-20T12:00:02.000Z', reason: 'user' });

  expect(stopped.phase).toBe('reviewing');
  expect(stopped.epoch).toBe(2);
  if (stopped.phase === 'reviewing') {
    expect(stopped.draft.steps[0].image).toEqual({ status: 'retained', imageId: 'image-initial' });
    expect(stopped.draft.steps[1].image).toEqual({ status: 'unavailable', reason: 'stopped' });
  }
  expect(stopJourney(stopped, { epoch: 2, stoppedAt: '2026-09-20T12:00:03.000Z', reason: 'user' })).toBe(stopped);
});

function recordingSession() {
  const starting = createJourneySession({
    sessionId: 'session-1', journeyId: 'journey-1', ownerTabId: 42, ownerWindowId: 7,
    documentToken: 'document-1', startedAt: '2026-09-20T12:00:00.000Z',
    deadlineAt: '2026-09-20T12:05:00.000Z', includeEnteredValues: true,
  });
  return acceptInitialImage(starting, {
    id: 'step-initial', observedAt: '2026-09-20T12:00:00.100Z', elapsedMs: 100,
    sourceUrl: 'https://example.com/start', imageId: 'image-initial',
    image: {
      capturedAt: '2026-09-20T12:00:00.100Z', captureUrl: 'https://example.com/start',
      width: 390, height: 844, byteLength: 10_000,
      viewport: { width: 390, height: 844 }, scroll: { x: 0, y: 0 },
    },
  });
}

function clickBatch(localCounter: number, captureId: string) {
  return {
    schemaVersion: 1 as const, sessionId: 'session-1', epoch: 1,
    documentToken: 'document-1', localCounter,
    events: [{
      kind: 'click' as const, id: `step-click-${localCounter}`, observedAt: `2026-09-20T12:00:0${localCounter}.000Z`, elapsedMs: localCounter * 1_000,
      sourceUrl: 'https://example.com/start',
      target: { tag: 'button', selectorPath: ['button'], label: 'Go', editable: false, viewport: { width: 390, height: 844 }, scroll: { x: 0, y: 0 }, point: { x: 100, y: 100 } },
      image: { status: 'pending' as const, captureId },
    }],
  };
}

function fieldBatch(localCounter: number, captureId: string, values: string[]) {
  return {
    schemaVersion: 1 as const, sessionId: 'session-1', epoch: 1,
    documentToken: 'document-1', localCounter,
    events: [{
      kind: 'field-change' as const, id: `step-field-${localCounter}`, observedAt: `2026-09-20T12:00:0${localCounter}.000Z`, elapsedMs: localCounter * 1_000,
      sourceUrl: 'https://example.com/start',
      target: { tag: 'select', selectorPath: ['select'], label: 'Options', editable: true, viewport: { width: 390, height: 844 }, scroll: { x: 0, y: 0 } },
      enteredValue: { kind: 'selection' as const, values, multiple: true, truncated: false },
      image: { status: 'pending' as const, captureId },
    }],
  };
}
