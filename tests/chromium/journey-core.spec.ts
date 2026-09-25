import { expect, test } from '@playwright/test';
import {
  acceptInitialImage,
  acceptJourneyEventBatch,
  commitJourneyNavigation,
  createJourneySession,
  editJourneyValue,
  redactJourneyUrl,
  reopenJourneySnapshot,
  resolveJourneyCapture,
  recordingSessionFits,
  removeJourneyStep,
  reviewSaveGating,
  stopJourney,
  supersedeJourneyImagesAfter,
  updateJourneySummary,
  validateJourneyDraft,
  validateJourneyManifest,
  type JourneyDraftStep,
  type JourneyDraftV1,
  type JourneyManifestV1,
  type JourneySession,
} from '../../src/journey-core';
import { stripUrlCredentials, validateJourneyEventBatch } from '../../src/journey-events';
import { JOURNEY_LIMITS } from '../../src/journey-limits';

const reviewed = (text: string) => ({ text, edited: false, redacted: false });
const MINIMAL_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+AvzvAAAAAElFTkSuQmCC';
const MINIMAL_PNG_DATA_URL = `data:image/png;base64,${MINIMAL_PNG_BASE64}`;
const MINIMAL_PNG_BYTES = 69;

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

test('snapshots keep validating with earlier stop reasons and accept page-access-lost', () => {
  // Reasons that shipped before page-access-lost must keep loading unchanged.
  const earlier = ['user', 'duration-limit', 'step-limit', 'image-budget', 'session-storage-limit',
    'left-site', 'focus-lost', 'tab-lost', 'protected-page', 'capture-failed'] as const;
  for (const stopReason of [...earlier, 'page-access-lost'] as const) {
    expect(validateJourneyManifest({ ...validManifest(), stopReason }).ok, stopReason).toBe(true);
  }
  expect(validateJourneyManifest({ ...validManifest(), stopReason: 'site-left' as never }).ok).toBe(false);
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

test('shared images require one marked click and its marked correlated navigation', () => {
  const missingMarkers = validManifest();
  const click = missingMarkers.steps[1];
  const navigation = missingMarkers.steps[2];
  if (click.image.status === 'retained') delete click.image.sharedNavigationResult;
  if (navigation.image.status === 'retained') delete navigation.image.sharedNavigationResult;

  const unrelated = validManifest();
  const unrelatedNavigation = unrelated.steps[2];
  if (unrelatedNavigation.kind === 'navigation') delete unrelatedNavigation.navigation.causedByStepId;

  const orphanMarker = validManifest();
  orphanMarker.steps = orphanMarker.steps.filter(step => step.kind !== 'navigation');

  expect(validateJourneyManifest(missingMarkers).ok).toBe(false);
  expect(validateJourneyManifest(unrelated).ok).toBe(false);
  expect(validateJourneyManifest(orphanMarker).ok).toBe(false);
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

test('raw PNG data uses canonical bytes for signature, IHDR, dimensions, and byte accounting', () => {
  const recording = recordingSession();
  if (recording.phase !== 'recording') throw new Error('expected recording fixture');
  const pending = acceptJourneyEventBatch(recording, clickBatch(1, 'capture-click'));
  const forgedPayload = `data:image/png;base64,${'A'.repeat(1_100_000)}`;
  const forged = resolveJourneyCapture(pending, {
    epoch: 1, documentToken: 'document-1', captureId: 'capture-click',
    status: 'retained', imageId: 'image-forged',
    image: {
      capturedAt: '2026-09-20T12:00:01.100Z', captureUrl: 'https://example.com/start',
      width: 1, height: 1, byteLength: 1, dataUrl: forgedPayload,
      viewport: { width: 390, height: 844 }, scroll: { x: 0, y: 0 },
    },
  });

  expect(forged.phase).toBe('recording');
  if (forged.phase === 'recording') {
    expect(forged.draft.steps[1].image).toEqual({ status: 'unavailable', reason: 'too-large' });
    expect(forged.draft.images['image-forged']).toBeUndefined();
  }

  const wrongByteLength = structuredClone(recording.draft);
  wrongByteLength.images['image-initial'].byteLength = MINIMAL_PNG_BYTES - 1;
  const wrongDimensions = structuredClone(recording.draft);
  wrongDimensions.images['image-initial'].width = 2;
  const wrongSignature = structuredClone(recording.draft);
  wrongSignature.images['image-initial'].dataUrl = `data:image/png;base64,A${MINIMAL_PNG_BASE64.slice(1)}`;

  for (const invalid of [wrongByteLength, wrongDimensions, wrongSignature]) {
    expect(validateJourneyDraft(invalid).ok).toBe(false);
  }
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
      width: 1, height: 1, byteLength: MINIMAL_PNG_BYTES, dataUrl: MINIMAL_PNG_DATA_URL,
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

test('initial image gate rejects another URL and timestamps at the recording deadline', () => {
  const starting = createJourneySession({
    sessionId: 'session-1', journeyId: 'journey-1', ownerTabId: 42, ownerWindowId: 7,
    documentToken: 'document-1', startedAt: '2026-09-20T12:00:00.000Z',
    deadlineAt: '2026-09-20T12:05:00.000Z', includeEnteredValues: false,
  });
  const input = {
    id: 'step-initial', observedAt: '2026-09-20T12:00:00.100Z', elapsedMs: 100,
    sourceUrl: 'https://example.com/start?q=1#top', imageId: 'image-initial',
    image: {
      capturedAt: '2026-09-20T12:00:00.100Z', captureUrl: 'https://other.example/wrong',
      width: 1, height: 1, byteLength: MINIMAL_PNG_BYTES, dataUrl: MINIMAL_PNG_DATA_URL,
      viewport: { width: 390, height: 844 }, scroll: { x: 0, y: 0 },
    },
  };

  expect(acceptInitialImage(starting, input)).toBe(starting);
  expect(acceptInitialImage(starting, {
    ...input,
    observedAt: '2026-09-20T12:05:00.000Z', elapsedMs: 300_000,
    image: { ...input.image, capturedAt: '2026-09-20T12:05:00.000Z', captureUrl: input.sourceUrl },
  })).toBe(starting);
  const { dataUrl: _omitted, ...imageless } = input.image;
  expect(acceptInitialImage(starting, { ...input, image: imageless })).toBe(starting);
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

test('navigation and event batches stop before publishing a draft over the session cap', () => {
  const previous = nearSessionLimitRecording();
  const previousBytes = Buffer.byteLength(JSON.stringify(previous));
  expect(previousBytes).toBeLessThanOrEqual(JOURNEY_LIMITS.maxSessionBytes);
  expect(JOURNEY_LIMITS.maxSessionBytes - previousBytes).toBeLessThan(25_000);

  const navigated = commitJourneyNavigation(previous, {
    epoch: previous.epoch,
    id: 'over-cap-navigation',
    observedAt: '2026-09-20T12:00:02.000Z',
    elapsedMs: 40_000,
    sourceUrl: maximumFixtureUrl('navigation-source'),
    toUrl: maximumFixtureUrl('navigation-destination'),
    previousDocumentToken: previous.documentToken,
    documentToken: previous.documentToken,
    image: { status: 'unavailable', reason: 'superseded' },
  });
  expect(navigated.phase).toBe('reviewing');
  if (navigated.phase === 'reviewing') {
    expect(navigated.draft.stopReason).toBe('session-storage-limit');
    expect(navigated.draft.steps).toEqual(previous.draft.steps);
    expect(navigated.draft.images).toEqual(previous.draft.images);
    expect(Buffer.byteLength(JSON.stringify(navigated))).toBeLessThanOrEqual(JOURNEY_LIMITS.maxSessionBytes);
  }

  const batched = acceptJourneyEventBatch(previous, {
    schemaVersion: 1,
    sessionId: previous.sessionId,
    epoch: previous.epoch,
    documentToken: previous.documentToken,
    localCounter: 7,
    events: [{
      kind: 'click',
      id: 'over-cap-click',
      observedAt: '2026-09-20T12:00:02.000Z',
      elapsedMs: 40_000,
      sourceUrl: maximumFixtureUrl('batch-source'),
      target: {
        tag: 'button', selectorPath: ['button'], label: 'Go', editable: false,
        viewport: { width: 390, height: 844 }, scroll: { x: 0, y: 0 }, point: { x: 100, y: 100 },
      },
      image: { status: 'unavailable', reason: 'superseded' },
    }],
  });
  expect(batched.phase).toBe('reviewing');
  if (batched.phase === 'reviewing') {
    expect(batched.draft.stopReason).toBe('session-storage-limit');
    expect(batched.draft.steps).toEqual(previous.draft.steps);
    expect(batched.draft.images).toEqual(previous.draft.images);
    expect(Buffer.byteLength(JSON.stringify(batched))).toBeLessThanOrEqual(JOURNEY_LIMITS.maxSessionBytes);
  }
});

test('a later-delivered action supersedes retained pixels captured at or after its observation', () => {
  const recording = recordingSession();
  const accepted = acceptJourneyEventBatch(recording, {
    ...clickBatch(1, 'capture-later-action'),
    events: [{
      ...clickBatch(1, 'capture-later-action').events[0],
      id: 'step-later-action',
      observedAt: '2026-09-20T12:00:00.050Z',
      elapsedMs: 200,
    }],
  });
  const superseded = supersedeJourneyImagesAfter(accepted, {
    epoch: 1,
    observedAt: '2026-09-20T12:00:00.050Z',
    excludeStepIds: ['step-later-action'],
  });

  expect(superseded.phase).toBe('recording');
  if (superseded.phase === 'recording') {
    expect(superseded.draft.steps[0].image).toEqual({ status: 'unavailable', reason: 'superseded' });
    expect(superseded.draft.steps[1].image).toEqual({ status: 'pending', captureId: 'capture-later-action' });
    expect(superseded.draft.images).toEqual({});
  }
  expect(supersedeJourneyImagesAfter(superseded, {
    epoch: 2,
    observedAt: '2026-09-20T12:00:00.050Z',
  })).toBe(superseded);
});

test('capture resolution replaces one pending state with bounded image metadata', () => {
  const recording = recordingSession();
  const withClick = acceptJourneyEventBatch(recording, clickBatch(1, 'capture-click'));
  const resolved = resolveJourneyCapture(withClick, {
    epoch: 1, documentToken: 'document-1', captureId: 'capture-click', status: 'retained', imageId: 'image-click',
    image: {
      capturedAt: '2026-09-20T12:00:01.000Z', captureUrl: 'https://user:secret@example.com/result?x=1#done',
      width: 1, height: 1, byteLength: MINIMAL_PNG_BYTES, dataUrl: MINIMAL_PNG_DATA_URL,
      viewport: { width: 390, height: 844 }, scroll: { x: 0, y: 0 },
    },
  });

  expect(resolved.phase).toBe('recording');
  if (resolved.phase === 'recording') {
    expect(resolved.draft.steps[1].image).toEqual({ status: 'retained', imageId: 'image-click' });
    expect(resolved.draft.images['image-click'].captureUrl).toBe('https://example.com/result?x=1#done');
  }
});

test('retained captures require an actual PNG payload', () => {
  const recording = recordingSession();
  const withClick = acceptJourneyEventBatch(recording, clickBatch(1, 'capture-click'));
  const resolved = resolveJourneyCapture(withClick, {
    epoch: 1, documentToken: 'document-1', captureId: 'capture-click', status: 'retained', imageId: 'image-click',
    image: {
      capturedAt: '2026-09-20T12:00:01.000Z', captureUrl: 'https://example.com/start',
      width: 1, height: 1, byteLength: MINIMAL_PNG_BYTES,
      viewport: { width: 390, height: 844 }, scroll: { x: 0, y: 0 },
    },
  });

  expect(resolved.phase).toBe('recording');
  if (resolved.phase === 'recording') {
    expect(resolved.draft.steps[1].image).toEqual({ status: 'unavailable', reason: 'capture-error' });
    expect(resolved.draft.images['image-click']).toBeUndefined();
  }
});

test('session fits reserves control space below the aggregate byte limit', () => {
  const session = recordingSession();
  if (session.phase !== 'recording') throw new Error('expected recording fixture');
  const recording = session;
  expect(recordingSessionFits(recording)).toBe(true);
  const limit = JOURNEY_LIMITS.maxSessionBytes - JOURNEY_LIMITS.sessionMetadataReserveBytes;
  const base = new TextEncoder().encode(JSON.stringify(recording)).byteLength;
  const padTo = (target: number) => {
    const padded = structuredClone(recording);
    padded.draft.expected = 'x'.repeat(Math.max(0, target - base));
    return padded;
  };
  expect(recordingSessionFits(padTo(limit - 2048))).toBe(true);
  expect(recordingSessionFits(padTo(limit + 1))).toBe(false);
});

test('review summaries store trimmed text with revision guards', () => {
  const reviewing = reviewingSession();
  const input = {
    epoch: 2, journeyId: 'journey-1', revision: reviewing.draft.revision,
    updatedAt: '2026-09-20T12:01:30.000Z',
    expected: '  The cart keeps its item.  ', actual: 'Checkout is empty.',
  };
  const updated = updateJourneySummary(reviewing, input);
  expect(updated).not.toBe(reviewing);
  if (updated.phase !== 'reviewing') throw new Error('expected reviewing state');
  expect(updated.draft.expected).toBe('The cart keeps its item.');
  expect(updated.draft.actual).toBe('Checkout is empty.');
  expect(updated.draft.revision).toBe(reviewing.draft.revision + 1);
  expect(updated.draft.updatedAt).toBe('2026-09-20T12:01:30.000Z');

  expect(updateJourneySummary(reviewing, { ...input, epoch: 3 })).toBe(reviewing);
  expect(updateJourneySummary(reviewing, { ...input, revision: 99 })).toBe(reviewing);
  expect(updateJourneySummary(reviewing, { ...input, expected: 'x'.repeat(4001) })).toBe(reviewing);
  expect(updateJourneySummary(reviewing, { ...input, updatedAt: '2026-09-20T12:00:00.000Z' })).toBe(reviewing);
  expect(updateJourneySummary(updated, input)).toBe(updated);
});

test('review step removal preserves order with stable gaps and prunes images', () => {
  const recording = recordingSession();
  if (recording.phase !== 'recording') throw new Error('expected recording fixture');
  const withClick = acceptJourneyEventBatch(recording, clickBatch(1, 'capture-click'));
  if (withClick.phase !== 'recording') throw new Error('expected recording state');
  const reviewing = stopJourney(withClick, { epoch: 1, stoppedAt: '2026-09-20T12:01:00.000Z', reason: 'user' });
  if (reviewing.phase !== 'reviewing') throw new Error('expected reviewing state');
  const stepId = reviewing.draft.steps[1].id;
  const removed = removeJourneyStep(reviewing, {
    epoch: 2, journeyId: 'journey-1', revision: reviewing.draft.revision,
    updatedAt: '2026-09-20T12:01:30.000Z', stepId,
  });
  expect(removed).not.toBe(reviewing);
  if (removed.phase !== 'reviewing') throw new Error('expected reviewing state');
  expect(removed.draft.steps.map(step => [step.id, step.seq])).toEqual(
    reviewing.draft.steps.filter(step => step.id !== stepId).map(step => [step.id, step.seq]));
  expect(removed.draft.steps).toHaveLength(1);
  expect(removed.draft.images).toEqual(
    { 'image-initial': reviewing.draft.images['image-initial'] });
  expect(removed.draft.revision).toBe(reviewing.draft.revision + 1);

  expect(removeJourneyStep(reviewing, {
    epoch: 2, journeyId: 'journey-1', revision: reviewing.draft.revision,
    updatedAt: '2026-09-20T12:01:30.000Z', stepId: 'missing-step',
  })).toBe(reviewing);
  const lone = { ...reviewing, draft: { ...reviewing.draft, steps: [reviewing.draft.steps[0]] } };
  const refused = removeJourneyStep(lone, {
    epoch: 2, journeyId: 'journey-1', revision: reviewing.draft.revision,
    updatedAt: '2026-09-20T12:01:30.000Z', stepId: reviewing.draft.steps[0].id,
  });
  expect(refused).toBe(lone);
  if (refused.phase !== 'reviewing') throw new Error('expected reviewing state');
  expect(refused.draft.steps).toHaveLength(1);
});

test('save gating requires summaries, a retained step, and a valid draft', () => {
  const reviewing = reviewingSession();
  expect(reviewSaveGating(reviewing)).toEqual({ ready: false, reasons: ['summaries-required'] });

  const summarized = updateJourneySummary(reviewing, {
    epoch: 2, journeyId: 'journey-1', revision: reviewing.draft.revision,
    updatedAt: '2026-09-20T12:01:30.000Z',
    expected: 'The cart keeps its item.', actual: 'Checkout is empty.',
  });
  expect(reviewSaveGating(summarized)).toEqual({ ready: true, reasons: [] });
  expect(reviewSaveGating(recordingSession())).toEqual({ ready: false, reasons: ['invalid-draft'] });
  if (summarized.phase !== 'reviewing') throw new Error('expected reviewing state');

  const imageless = {
    ...summarized,
    draft: {
      ...summarized.draft,
      steps: summarized.draft.steps.map(step => ({ ...step, image: { status: 'removed' as const } })),
      images: {},
    },
  };
  expect(reviewSaveGating(imageless)).toEqual({ ready: false, reasons: ['retained-step-required'] });
});

test('saved snapshots reopen into a fresh reviewing session', () => {
  const reviewing = reviewingSession();
  const snapshot = {
    draft: { ...reviewing.draft, expected: 'Kept.', actual: 'Gone.' },
    images: structuredClone(reviewing.draft.images),
  };
  const idle = { phase: 'idle', epoch: 0 } as const;
  const reopened = reopenJourneySnapshot(idle, {
    sessionId: 'session-9', ownerTabId: 7, ownerWindowId: 8, nowMs: Date.parse('2026-09-20T12:02:00.000Z'),
    draft: snapshot.draft, images: snapshot.images,
  });
  expect(reopened).not.toBe(idle);
  if (!reopened || reopened.phase !== 'reviewing') throw new Error('expected reviewing state');
  expect(reopened.sessionId).toBe('session-9');
  expect(reopened.journeyId).toBe('journey-1');
  expect(reopened.epoch).toBe(1);
  expect(reopened.ownerTabId).toBe(7);
  expect(reopened.draft.expected).toBe('Kept.');
  expect(reopened.draft.steps).toHaveLength(reviewing.draft.steps.length);
  expect(reopened.draft.images['image-initial'].dataUrl).toBe(MINIMAL_PNG_DATA_URL);

  expect(reopenJourneySnapshot(reviewing, {
    sessionId: 'session-9', ownerTabId: 7, ownerWindowId: 8, nowMs: Date.parse('2026-09-20T12:02:00.000Z'),
    draft: snapshot.draft, images: snapshot.images,
  })).toBe(reviewing);

  const missingBytes = {
    draft: snapshot.draft,
    images: {} as Record<string, { dataUrl?: string }>,
  };
  expect(reopenJourneySnapshot(idle, {
    sessionId: 'session-9', ownerTabId: 7, ownerWindowId: 8, nowMs: Date.parse('2026-09-20T12:02:00.000Z'),
    draft: missingBytes.draft, images: missingBytes.images as Record<string, never>,
  })).toBe(idle);
});

function reviewingWithField() {
  const recording = recordingSession();
  if (recording.phase !== 'recording') throw new Error('expected recording fixture');
  const withField = acceptJourneyEventBatch(recording, fieldBatch(1, 'capture-field', ['First']));
  if (withField.phase !== 'recording') throw new Error('expected recording state');
  const stopped = stopJourney(withField, { epoch: 1, stoppedAt: '2026-09-20T12:01:00.000Z', reason: 'user' });
  if (stopped.phase !== 'reviewing') throw new Error('expected reviewing state');
  return stopped;
}

const reviewGuards = (state: { epoch: number; journeyId: string; draft: { revision: number } }) => ({
  epoch: state.epoch, journeyId: state.journeyId, revision: state.draft.revision,
  updatedAt: '2026-09-20T12:01:30.000Z',
});

test('review value edits replace text without retaining originals', () => {
  const reviewing = reviewingWithField();
  const stepId = reviewing.draft.steps[1].id;
  const edited = editJourneyValue(reviewing, {
    ...reviewGuards(reviewing),
    stepId, value: { kind: 'text', value: 'edited search', truncated: false },
  });
  expect(edited).not.toBe(reviewing);
  if (edited.phase !== 'reviewing') throw new Error('expected reviewing state');
  const step = edited.draft.steps[1];
  if (step.kind !== 'field-change') throw new Error('expected field step');
  expect(step.enteredValue).toEqual({ kind: 'text', value: 'edited search', truncated: false, edited: true });
  expect(JSON.stringify(edited)).not.toContain('First');
  expect(step.target.label).toBe('Options');
  expect(edited.draft.revision).toBe(reviewing.draft.revision + 1);

  const removed = editJourneyValue(edited, {
    ...reviewGuards(edited),
    stepId, value: { kind: 'text', value: '', truncated: false },
  });
  if (removed.phase !== 'reviewing') throw new Error('expected reviewing state');
  const cleared = removed.draft.steps[1];
  if (cleared.kind !== 'field-change') throw new Error('expected field step');
  expect(cleared.enteredValue).toEqual({ kind: 'text', value: '', truncated: false, edited: true });

  expect(editJourneyValue(reviewing, {
    ...reviewGuards(reviewing),
    stepId, value: { kind: 'text', value: 'x'.repeat(2001), truncated: false },
  })).toBe(reviewing);
  expect(editJourneyValue(reviewing, {
    ...reviewGuards(reviewing), stepId: reviewing.draft.steps[0].id,
    value: { kind: 'text', value: 'nope', truncated: false },
  })).toBe(reviewing);
  expect(editJourneyValue(reviewing, {
    ...reviewGuards(reviewing), revision: 99,
    stepId, value: { kind: 'text', value: 'stale', truncated: false },
  })).toBe(reviewing);
});

test('review URL redaction keeps step and image association', () => {
  const reviewing = reviewingSession();
  const stepId = reviewing.draft.steps[0].id;
  const imageId = 'image-initial';
  const sourceRedacted = redactJourneyUrl(reviewing, {
    ...reviewGuards(reviewing), stepId, url: 'source',
  });
  expect(sourceRedacted).not.toBe(reviewing);
  if (sourceRedacted.phase !== 'reviewing') throw new Error('expected reviewing state');
  expect(sourceRedacted.draft.steps[0].sourceUrl).toBe('[redacted]');
  expect(sourceRedacted.draft.redactions).toEqual({ steps: { [stepId]: { sourceUrl: true } } });
  expect(sourceRedacted.draft.steps[0].image).toEqual({ status: 'retained', imageId });
  expect(sourceRedacted.draft.images[imageId].dataUrl).toBe(MINIMAL_PNG_DATA_URL);

  const captureRedacted = redactJourneyUrl(sourceRedacted, {
    ...reviewGuards(sourceRedacted), stepId, url: 'capture',
  });
  if (captureRedacted.phase !== 'reviewing') throw new Error('expected reviewing state');
  expect(captureRedacted.draft.images[imageId].captureUrl).toBe('[redacted]');
  expect(captureRedacted.draft.images[imageId].dataUrl).toBe(MINIMAL_PNG_DATA_URL);
  expect(captureRedacted.draft.redactions).toEqual({
    steps: { [stepId]: { sourceUrl: true, captureUrl: true } },
  });

  expect(redactJourneyUrl(captureRedacted, {
    ...reviewGuards(captureRedacted), stepId, url: 'source',
  })).toBe(captureRedacted);
  expect(redactJourneyUrl(reviewing, {
    ...reviewGuards(reviewing), stepId: 'missing-step', url: 'source',
  })).toBe(reviewing);
});

test('review destination redaction removes only the navigation destination', () => {
  const reviewing = reviewingWithNavigation();
  const stepId = 'step-navigation';
  const redacted = redactJourneyUrl(reviewing, { ...reviewGuards(reviewing), stepId, url: 'destination' });
  expect(redacted).not.toBe(reviewing);
  if (redacted.phase !== 'reviewing') throw new Error('expected reviewing state');
  const step = redacted.draft.steps[1];
  if (step.kind !== 'navigation') throw new Error('expected navigation step');
  expect(step.navigation).toEqual({ toUrl: '[redacted]' });
  expect(step.sourceUrl).toBe('https://example.com/start');
  expect(redacted.draft.redactions).toEqual({ steps: { [stepId]: { toUrl: true } } });
  expect(redacted.draft.revision).toBe(reviewing.draft.revision + 1);
  expect(JSON.stringify(redacted)).not.toContain('private-token-9q');
  expect(validateJourneyDraft(redacted.draft).ok).toBe(true);

  expect(redactJourneyUrl(redacted, { ...reviewGuards(redacted), stepId, url: 'destination' })).toBe(redacted);
  expect(redactJourneyUrl(reviewing, {
    ...reviewGuards(reviewing), stepId: 'step-initial', url: 'destination',
  })).toBe(reviewing);
  expect(redactJourneyUrl(reviewing, {
    ...reviewGuards(reviewing), stepId, url: 'location' as unknown as 'destination',
  })).toBe(reviewing);

  const both = redactJourneyUrl(redacted, { ...reviewGuards(redacted), stepId, url: 'source' });
  if (both.phase !== 'reviewing') throw new Error('expected reviewing state');
  expect(both.draft.redactions).toEqual({ steps: { [stepId]: { toUrl: true, sourceUrl: true } } });
});

test('persisted drafts accept destination markers only with consistent redaction flags', () => {
  const reviewing = reviewingWithNavigation();
  const redacted = redactJourneyUrl(reviewing, {
    ...reviewGuards(reviewing), stepId: 'step-navigation', url: 'destination',
  });
  if (redacted.phase !== 'reviewing') throw new Error('expected reviewing state');
  const draft = { ...redacted.draft, expected: 'Reset link opens.', actual: 'Reset link fails.' };
  const navigationOf = (value: JourneyDraftV1) => value.steps[1] as Extract<JourneyDraftStep, { kind: 'navigation' }>;

  const visible = structuredClone(draft);
  navigationOf(visible).navigation.toUrl = 'https://example.com/reset?token=other';
  expect(validateJourneyDraft(visible)).toEqual({
    ok: false, errors: ['journey.redactions for step step-navigation marks a visible destination URL'],
  });
  const misplaced = { ...structuredClone(draft), redactions: { steps: { 'step-initial': { toUrl: true as const } } } };
  expect(validateJourneyDraft(misplaced)).toEqual({
    ok: false, errors: ['journey.redactions for step step-initial marks a visible destination URL'],
  });
  const malformed = { ...structuredClone(draft), redactions: { steps: { 'step-navigation': { toUrl: 'yes' } } } };
  expect(validateJourneyDraft(malformed)).toEqual({
    ok: false, errors: ['journey.redactions for step step-navigation is invalid'],
  });

  const idle = { phase: 'idle', epoch: 0 } as const;
  const reopenInput = (value: JourneyDraftV1) => ({
    sessionId: 'session-9', ownerTabId: 7, ownerWindowId: 8, nowMs: Date.parse('2026-09-20T12:02:00.000Z'),
    draft: value, images: structuredClone(value.images),
  });
  const reopened = reopenJourneySnapshot(idle, reopenInput(draft));
  if (!reopened || reopened.phase !== 'reviewing') throw new Error('expected reviewing state');
  expect(navigationOf(reopened.draft).navigation.toUrl).toBe('[redacted]');
  expect(reopened.draft.redactions).toEqual({ steps: { 'step-navigation': { toUrl: true } } });

  // Snapshots saved before destination redaction carry only source and capture flags.
  const legacySource = redactJourneyUrl(reviewing, {
    ...reviewGuards(reviewing), stepId: 'step-initial', url: 'source',
  });
  if (legacySource.phase !== 'reviewing') throw new Error('expected reviewing state');
  const legacy = redactJourneyUrl(legacySource, {
    ...reviewGuards(legacySource), stepId: 'step-initial', url: 'capture',
  });
  if (legacy.phase !== 'reviewing') throw new Error('expected reviewing state');
  const legacyDraft = { ...legacy.draft, expected: 'Kept.', actual: 'Gone.' };
  expect(legacyDraft.redactions).toEqual({ steps: { 'step-initial': { sourceUrl: true, captureUrl: true } } });
  expect(navigationOf(legacyDraft).navigation.toUrl).toBe('https://example.com/reset?token=private-token-9q');
  expect(reopenJourneySnapshot(idle, reopenInput(legacyDraft))?.phase).toBe('reviewing');
});

test('reviewed destination URLs follow the redacted-implies-edited rule', () => {
  const manifest = validManifest();
  const navigation = manifest.steps[2];
  if (navigation.kind !== 'navigation') throw new Error('expected navigation step');
  navigation.navigation.toUrl = { text: '[redacted]', edited: true, redacted: true };
  expect(validateJourneyManifest(manifest).ok).toBe(true);

  navigation.navigation.toUrl = { text: '[redacted]', edited: false, redacted: true };
  const unmarked = validateJourneyManifest(manifest);
  expect(unmarked.ok).toBe(false);
  if (!unmarked.ok) expect(unmarked.errors).toContain('journey.steps[2].navigation.toUrl.redacted text must be marked edited');

  navigation.navigation.toUrl = { text: '[redacted]', edited: false, redacted: false };
  const unedited = validateJourneyManifest(manifest);
  expect(unedited.ok).toBe(false);
  if (!unedited.ok) expect(unedited.errors).toContain('journey.steps[2].navigation.toUrl.text must be a complete HTTP(S) URL');
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

test('manifest lifecycle requires stoppedAt at or before updatedAt', () => {
  const manifest = validManifest();
  manifest.updatedAt = '2026-09-20T12:00:02.999Z';

  expect(validateJourneyManifest(manifest).ok).toBe(false);
});

test('Stop bounds review deadlines at the maximum representable date', () => {
  const recording = recordingSession();
  let stopped: JourneySession | undefined;

  expect(() => {
    stopped = stopJourney(recording, {
      epoch: 1, stoppedAt: '+275760-09-13T00:00:00.000Z', reason: 'user',
    });
  }).not.toThrow();
  expect(stopped?.phase).toBe('reviewing');
  if (stopped?.phase === 'reviewing') {
    expect(stopped.warningAt).toBe('+275760-09-13T00:00:00.000Z');
    expect(stopped.expiresAt).toBe('+275760-09-13T00:00:00.000Z');
  }
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
      width: 1, height: 1, byteLength: MINIMAL_PNG_BYTES, dataUrl: MINIMAL_PNG_DATA_URL,
      viewport: { width: 390, height: 844 }, scroll: { x: 0, y: 0 },
    },
  });
}

function reviewingSession() {
  const recording = recordingSession();
  if (recording.phase !== 'recording') throw new Error('expected recording fixture');
  const stopped = stopJourney(recording, {
    epoch: 1, stoppedAt: '2026-09-20T12:01:00.000Z', reason: 'user',
  });
  if (stopped.phase !== 'reviewing') throw new Error('expected reviewing fixture');
  return stopped;
}

function reviewingWithNavigation() {
  const recording = recordingSession();
  if (recording.phase !== 'recording') throw new Error('expected recording fixture');
  const navigated = commitJourneyNavigation(recording, {
    epoch: 1, id: 'step-navigation', observedAt: '2026-09-20T12:00:02.000Z', elapsedMs: 2_000,
    sourceUrl: 'https://example.com/start', toUrl: 'https://example.com/reset?token=private-token-9q',
    previousDocumentToken: 'document-1', documentToken: 'document-2',
    image: { status: 'unavailable', reason: 'superseded' },
  });
  if (navigated.phase !== 'recording' || navigated.draft.steps.length !== 2) throw new Error('expected navigation step');
  const stopped = stopJourney(navigated, { epoch: 1, stoppedAt: '2026-09-20T12:01:00.000Z', reason: 'user' });
  if (stopped.phase !== 'reviewing') throw new Error('expected reviewing fixture');
  return stopped;
}

function nearSessionLimitRecording() {
  const imageByteLength = Math.floor(JOURNEY_LIMITS.maxJourneyImageBytes / 7);
  const dataUrl = fixturePngDataUrl(imageByteLength);
  const image = (capturedAt: string) => ({
    capturedAt,
    captureUrl: 'https://example.com/start',
    width: 1,
    height: 1,
    byteLength: imageByteLength,
    dataUrl,
    viewport: { width: 390, height: 844 },
    scroll: { x: 0, y: 0 },
  });
  const starting = createJourneySession({
    sessionId: 'session-1', journeyId: 'journey-1', ownerTabId: 42, ownerWindowId: 7,
    documentToken: 'document-1', startedAt: '2026-09-20T12:00:00.000Z',
    deadlineAt: '2026-09-20T12:05:00.000Z', includeEnteredValues: true,
  });
  let session: JourneySession = acceptInitialImage(starting, {
    id: 'step-initial', imageId: 'image-0', observedAt: '2026-09-20T12:00:00.100Z', elapsedMs: 100,
    sourceUrl: 'https://example.com/start', image: image('2026-09-20T12:00:00.100Z'),
  });
  for (let index = 1; index <= 6; index += 1) {
    session = acceptJourneyEventBatch(session, clickBatch(index, `capture-${index}`));
    session = resolveJourneyCapture(session, {
      epoch: 1,
      documentToken: 'document-1',
      captureId: `capture-${index}`,
      status: 'retained',
      imageId: `image-${index}`,
      image: image(`2026-09-20T12:00:0${index}.100Z`),
    });
  }
  for (let index = 1; index <= 21; index += 1) {
    if (session.phase !== 'recording') throw new Error('Near-cap fixture stopped too early');
    session = commitJourneyNavigation(session, {
      epoch: 1,
      id: `fixture-navigation-${index}`,
      observedAt: `2026-09-20T12:00:01.${String(index).padStart(3, '0')}Z`,
      elapsedMs: 10_000 + index,
      sourceUrl: maximumFixtureUrl(`source-${index}`),
      toUrl: maximumFixtureUrl(`destination-${index}`),
      previousDocumentToken: session.documentToken,
      documentToken: session.documentToken,
      image: { status: 'unavailable', reason: 'superseded' },
    });
  }
  if (session.phase !== 'recording') throw new Error('Near-cap fixture must remain recording');
  expect(validateJourneyDraft(session.draft).ok).toBe(true);
  return session;
}

function maximumFixtureUrl(label: string): string {
  const prefix = `https://example.com/${label}/`;
  return `${prefix}${'a'.repeat(32_700 - prefix.length)}`;
}

function fixturePngDataUrl(byteLength: number): string {
  const png = new Uint8Array(byteLength);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  png.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8);
  png.set([0, 0, 0, 1, 0, 0, 0, 1], 16);
  return `data:image/png;base64,${Buffer.from(png).toString('base64')}`;
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
