import { expect, test } from '@playwright/test';
import {
  acceptInitialImage,
  acceptJourneyEventBatch,
  acceptLateJourneyEventBatch,
  commitJourneyNavigation,
  createJourneySession,
  editJourneyValue,
  markJourneyReviewStorageFailure,
  redactJourneyLabel,
  redactJourneyUrl,
  reopenJourneySnapshot,
  resolveJourneyCapture,
  recordingSessionFits,
  removeJourneyStep,
  reviewSaveGating,
  STOP_LIMITATIONS,
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
import { stripUrlCredentials, validateJourneyEventBatch, type JourneyInputEvent } from '../../src/journey-events';
import { formatJourneyMarkdown, journeyDraftToManifest, journeyPrompt } from '../../src/journey-export';
import { JOURNEY_LIMITATIONS, JOURNEY_LIMITS, STOP_REASONS } from '../../src/journey-limits';
import { applyJourneyImageReview } from '../../src/journey-review';

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
    expect(withoutPages(navigated.draft.steps)).toEqual(previous.draft.steps);
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
    expect(withoutPages(batched.draft.steps)).toEqual(previous.draft.steps);
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

test('removing a step drops its redaction flags and keeps the flags of remaining steps', () => {
  const recording = recordingSession();
  const withClick = acceptJourneyEventBatch(recording, clickBatch(1, 'capture-click'));
  if (withClick.phase !== 'recording') throw new Error('expected recording state');
  const resolved = resolveJourneyCapture(withClick, {
    epoch: 1, documentToken: 'document-1', captureId: 'capture-click', status: 'retained', imageId: 'image-click',
    image: {
      capturedAt: '2026-09-20T12:00:01.500Z', captureUrl: 'https://example.com/start',
      width: 1, height: 1, byteLength: MINIMAL_PNG_BYTES, dataUrl: MINIMAL_PNG_DATA_URL,
      viewport: { width: 390, height: 844 }, scroll: { x: 0, y: 0 },
    },
  });
  const reviewing = stopJourney(resolved, { epoch: 1, stoppedAt: '2026-09-20T12:01:00.000Z', reason: 'user' });
  if (reviewing.phase !== 'reviewing') throw new Error('expected reviewing state');
  let state: JourneySession = reviewing;
  for (const [stepId, url] of [
    ['step-click-1', 'source'], ['step-click-1', 'capture'], ['step-initial', 'source'],
  ] as const) {
    if (state.phase !== 'reviewing') throw new Error('expected reviewing state');
    const next = redactJourneyUrl(state, { ...reviewGuards(state), stepId, url });
    expect(next).not.toBe(state);
    state = next;
  }
  if (state.phase !== 'reviewing') throw new Error('expected reviewing state');
  expect(state.draft.redactions).toEqual({ steps: {
    'step-click-1': { sourceUrl: true, captureUrl: true }, 'step-initial': { sourceUrl: true },
  } });

  const removed = removeJourneyStep(state, { ...reviewGuards(state), stepId: 'step-click-1' });
  expect(removed).not.toBe(state);
  if (removed.phase !== 'reviewing') throw new Error('expected reviewing state');
  expect(removed.draft.steps.map(step => step.id)).toEqual(['step-initial']);
  expect(Object.keys(removed.draft.images)).toEqual(['image-initial']);
  expect(removed.draft.redactions).toEqual({ steps: { 'step-initial': { sourceUrl: true } } });
  expect(validateJourneyDraft(removed.draft).ok).toBe(true);

  // With the last flagged step gone, the draft carries no redaction map at all.
  const onlyRemoved = redactJourneyUrl(reviewing, { ...reviewGuards(reviewing), stepId: 'step-click-1', url: 'source' });
  if (onlyRemoved.phase !== 'reviewing') throw new Error('expected reviewing state');
  const cleared = removeJourneyStep(onlyRemoved, { ...reviewGuards(onlyRemoved), stepId: 'step-click-1' });
  if (cleared.phase !== 'reviewing') throw new Error('expected reviewing state');
  expect(cleared.draft.steps).toHaveLength(1);
  expect(cleared.draft).not.toHaveProperty('redactions');
});

test('draft validation checks screenshot bytes even when the capture URL was redacted', () => {
  const reviewing = reviewingSession();
  const redacted = redactJourneyUrl(reviewing, { ...reviewGuards(reviewing), stepId: 'step-initial', url: 'capture' });
  if (redacted.phase !== 'reviewing') throw new Error('expected reviewing state');
  expect(redacted.draft.images['image-initial'].captureUrl).toBe('[redacted]');
  expect(validateJourneyDraft(redacted.draft).ok).toBe(true);

  const mismatched = structuredClone(redacted.draft);
  mismatched.images['image-initial'].dataUrl = fixturePngDataUrl(MINIMAL_PNG_BYTES + 3);
  expect(validateJourneyDraft(mismatched)).toEqual({
    ok: false, errors: ['journey.images.image-initial.dataUrl does not match byteLength'],
  });
  const foreign = structuredClone(redacted.draft);
  foreign.images['image-initial'].dataUrl = 'data:image/jpeg;base64,AAAA';
  expect(validateJourneyDraft(foreign)).toEqual({
    ok: false, errors: ['journey.images.image-initial.dataUrl must be a PNG data URL'],
  });
  const malformed = structuredClone(redacted.draft) as unknown as { images: Record<string, Record<string, unknown>> };
  malformed.images['image-initial'].dataUrl = 42;
  malformed.images['image-initial'].redacted = 'yes';
  expect(validateJourneyDraft(malformed)).toEqual({
    ok: false, errors: [
      'journey.images.image-initial.dataUrl metadata is invalid',
      'journey.images.image-initial.redacted must be a boolean',
    ],
  });
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

// A text field, a select, a checkbox and a radio button, each committed once.
function reviewingWithEveryValueKind() {
  type FieldEvent = Extract<JourneyInputEvent, { kind: 'field-change' }>;
  const field = (id: string, elapsedMs: number, tag: string, role: string, enteredValue: FieldEvent['enteredValue']): JourneyInputEvent => ({
    ...textFieldEvent(id, elapsedMs, '') as FieldEvent,
    target: { tag, role, selectorPath: [tag], label: 'field', editable: true, viewport: { width: 390, height: 844 }, scroll: { x: 0, y: 0 } },
    enteredValue,
  });
  const recorded = acceptJourneyEventBatch(recordingSession(), eventBatch(1, [
    field('coupon', 1_000, 'input', 'textbox', { kind: 'text', value: 'SAVE10-private-2281', truncated: false }),
    field('plan', 1_100, 'select', 'combobox', { kind: 'selection', values: ['plan-private-4417'], multiple: false, truncated: false }),
    field('terms', 1_200, 'input', 'checkbox', { kind: 'checked', checked: true }),
    field('size', 1_300, 'input', 'radio', { kind: 'checked', checked: true }),
  ]));
  const stopped = stopJourney(recorded, { epoch: 1, stoppedAt: '2026-09-20T12:01:00.000Z', reason: 'user' });
  if (stopped.phase !== 'reviewing') throw new Error('expected reviewing state');
  return stopped;
}

test('removing a value of any kind keeps only its kind, marked removed, never a recorded state', () => {
  let session: JourneySession = reviewingWithEveryValueKind();
  const updatedAt = (index: number) => `2026-09-20T12:01:${String(10 + index).padStart(2, '0')}.000Z`;
  ['coupon', 'plan', 'terms', 'size'].forEach((stepId, index) => {
    if (session.phase !== 'reviewing') throw new Error('expected reviewing state');
    const next = editJourneyValue(session, { ...reviewGuards(session), updatedAt: updatedAt(index), stepId, value: { removed: true } });
    expect(next, stepId).not.toBe(session);
    session = next;
  });
  if (session.phase !== 'reviewing') throw new Error('expected reviewing state');
  const values = Object.fromEntries(session.draft.steps.flatMap(step => step.kind === 'field-change' ? [[step.id, step.enteredValue]] : []));
  expect(values).toEqual({
    coupon: { kind: 'text', value: '', truncated: false, edited: true, removed: true },
    plan: { kind: 'selection', values: [], multiple: false, truncated: false, edited: true, removed: true },
    terms: { kind: 'checked', checked: false, edited: true, removed: true },
    size: { kind: 'checked', checked: false, edited: true, removed: true },
  });
  // The saved snapshot is the validated draft: the markers survive it.
  const validated = validateJourneyDraft(session.draft);
  expect(validated.ok && validated.value.steps).toEqual(session.draft.steps);
  expect(JSON.stringify(session)).not.toContain('private');
  // An edit afterwards replaces the removal with the value entered in review.
  const edited = editJourneyValue(session, {
    ...reviewGuards(session), updatedAt: updatedAt(9), stepId: 'terms', value: { kind: 'checked', checked: true },
  });
  if (edited.phase !== 'reviewing') throw new Error('expected reviewing state');
  expect(edited.draft.steps.find(step => step.id === 'terms')).toMatchObject({ enteredValue: { kind: 'checked', checked: true, edited: true } });
  expect(JSON.stringify(edited.draft.steps.find(step => step.id === 'terms'))).not.toContain('removed');
  // Only { removed: true } removes.
  for (const value of [{ removed: false }, { removed: 'yes' }, { kind: 'checked', checked: false, removed: 1 }]) {
    expect(editJourneyValue(session, { ...reviewGuards(session), updatedAt: updatedAt(9), stepId: 'plan', value })).toBe(session);
  }
});

test('drafts and manifests accept removal and redaction markers only on an empty value marked edited', () => {
  const session = reviewingWithEveryValueKind();
  const withValue = (enteredValue: unknown) => ({
    ...session.draft,
    steps: session.draft.steps.map(step => step.id === 'plan' ? { ...step, enteredValue } : step),
  });
  const draftErrors = (enteredValue: unknown) => {
    const result = validateJourneyDraft(withValue(enteredValue));
    return result.ok ? [] : result.errors;
  };
  expect(draftErrors({ kind: 'selection', values: [], multiple: false, truncated: false, edited: true, removed: true })).toEqual([]);
  expect(draftErrors({ kind: 'checked', checked: false, edited: true, removed: true })).toEqual([]);
  expect(draftErrors({ kind: 'text', value: '', truncated: false, edited: true, removed: true })).toEqual([]);
  // A removed value keeps nothing, and says it was edited.
  expect(draftErrors({ kind: 'selection', values: ['plan-private-4417'], multiple: false, truncated: false, edited: true, removed: true }))
    .toContain('journey.steps[2].enteredValue.removed value must be empty');
  expect(draftErrors({ kind: 'checked', checked: true, edited: true, removed: true })).toContain('journey.steps[2].enteredValue.removed value must be empty');
  expect(draftErrors({ kind: 'text', value: 'x', truncated: false, edited: true, removed: true })).toContain('journey.steps[2].enteredValue.removed value must be empty');
  expect(draftErrors({ kind: 'selection', values: [], multiple: false, truncated: true, edited: true, removed: true })).toContain('journey.steps[2].enteredValue.removed value must be empty');
  expect(draftErrors({ kind: 'checked', checked: false, removed: true })).toContain('journey.steps[2].enteredValue.removed value must be marked edited');
  expect(draftErrors({ kind: 'checked', checked: false, edited: true, removed: false })).toContain('journey.steps[2].enteredValue.removed must be true when present');
  // Drafts remove; reviewed manifests redact.
  expect(draftErrors({ kind: 'checked', checked: false, edited: true, redacted: true })).toContain('journey.steps[2].enteredValue.redacted is not allowed');

  const manifest = validManifest();
  const manifestErrors = (enteredValue: unknown) => {
    const copy = structuredClone(manifest);
    const step = copy.steps[3];
    if (step.kind !== 'field-change') throw new Error('expected field step');
    (step as { enteredValue: unknown }).enteredValue = enteredValue;
    const result = validateJourneyManifest(copy);
    return result.ok ? [] : result.errors;
  };
  expect(manifestErrors({ kind: 'checked', checked: false, edited: true, redacted: true })).toEqual([]);
  expect(manifestErrors({ kind: 'checked', checked: true, edited: true })).toEqual([]);
  expect(manifestErrors({ kind: 'selection', values: [], multiple: true, truncated: false, edited: true, redacted: true })).toEqual([]);
  expect(manifestErrors({ kind: 'checked', checked: true, edited: true, redacted: true })).toContain('journey.steps[3].enteredValue.redacted value must be empty');
  expect(manifestErrors({ kind: 'selection', values: [], multiple: true, truncated: false, redacted: true }))
    .toContain('journey.steps[3].enteredValue.redacted value must be marked edited');
  expect(manifestErrors({ kind: 'checked', checked: false, edited: true, removed: true })).toContain('journey.steps[3].enteredValue.removed is not allowed');
  // Reviewed text is redacted through its text, as every other reviewed text is.
  expect(manifestErrors({ kind: 'text', value: { text: '', edited: true, redacted: true }, truncated: false, redacted: true }))
    .toContain('journey.steps[3].enteredValue.redacted is not allowed');
});

test('each lossy stop records the limitation review states in its notice', () => {
  for (const reason of STOP_REASONS) {
    const stopped = stopJourney(recordingSession(), { epoch: 1, stoppedAt: '2026-09-20T12:00:02.000Z', reason });
    if (stopped.phase !== 'reviewing') throw new Error('expected reviewing state');
    expect(stopped.draft.limitations, reason).toEqual(STOP_LIMITATIONS[reason] ? [STOP_LIMITATIONS[reason]] : []);
  }
  expect(Object.isFrozen(STOP_LIMITATIONS)).toBe(true);
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
  // The destination keeps its page number, so the journey still spans pages.
  expect(step.navigation).toEqual({ toUrl: '[redacted]', toPage: 2 });
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

test('stop numbers pages in the order the journey first reached them', () => {
  const recording = recordingSession();
  const reset = 'https://example.com/reset?token=private-token-9q';
  let session: JourneySession = recording;
  for (const [index, [sourceUrl, toUrl]] of [['https://example.com/start', reset], [reset, 'https://example.com/start']].entries()) {
    if (session.phase !== 'recording') throw new Error('expected recording state');
    session = commitJourneyNavigation(session, {
      epoch: 1, id: `step-navigation-${index + 1}`, observedAt: `2026-09-20T12:00:0${index + 2}.000Z`, elapsedMs: (index + 2) * 1_000,
      sourceUrl, toUrl, previousDocumentToken: session.documentToken, documentToken: `document-${index + 2}`,
      image: { status: 'unavailable', reason: 'superseded' },
    });
  }
  if (session.phase !== 'recording') throw new Error('expected recording state');
  // Recording leaves pages unnumbered; stopping numbers every URL once.
  expect(session.draft.steps.some(step => step.sourcePage !== undefined)).toBe(false);
  const stopped = stopJourney(session, { epoch: 1, stoppedAt: '2026-09-20T12:01:00.000Z', reason: 'user' });
  if (stopped.phase !== 'reviewing') throw new Error('expected reviewing state');
  expect(stopped.draft.steps.map(step => [step.sourcePage, step.kind === 'navigation' ? step.navigation.toPage : null]))
    .toEqual([[1, null], [1, 2], [2, 1]]);
  expect(validateJourneyDraft(stopped.draft).ok).toBe(true);

  // Numbers are bounded positive integers that agree with every visible URL.
  const draft = { ...stopped.draft, expected: 'Kept.', actual: 'Gone.' };
  const errors = (change: (value: JourneyDraftV1) => void) => {
    const value = structuredClone(draft);
    change(value);
    const result = validateJourneyDraft(value);
    return result.ok ? [] : result.errors;
  };
  const navigationAt = (value: JourneyDraftV1, index: number) => value.steps[index] as Extract<JourneyDraftStep, { kind: 'navigation' }>;
  expect(errors(value => { value.steps[0].sourcePage = 0; })).toEqual(['journey.steps[0].sourcePage is invalid']);
  expect(errors(value => { value.steps[0].sourcePage = 1.5; })).toEqual(['journey.steps[0].sourcePage is invalid']);
  expect(errors(value => { navigationAt(value, 1).navigation.toPage = JOURNEY_LIMITS.maxSteps * 2 + 1; }))
    .toEqual(['journey.steps[1].navigation.toPage is invalid']);
  expect(errors(value => { navigationAt(value, 2).navigation.toPage = 2; }))
    .toEqual(['journey.steps[2].navigation.toPage disagrees with its URL']);
  expect(errors(value => { value.steps[2].sourcePage = 3; }))
    .toEqual(['journey.steps[2].sourcePage disagrees with its URL']);
  // A redacted URL keeps its number without showing anything to compare.
  const redacted = redactJourneyUrl(stopped, { ...reviewGuards(stopped), stepId: 'step-navigation-2', url: 'source' });
  if (redacted.phase !== 'reviewing') throw new Error('expected reviewing state');
  expect(redacted.draft.steps[2]).toMatchObject({ sourceUrl: '[redacted]', sourcePage: 2 });
  expect(validateJourneyDraft(redacted.draft).ok).toBe(true);
});

test('every review edit keeps the page numbers stop gave the draft', () => {
  let session: JourneySession = acceptJourneyEventBatch(recordingSession(), clickBatch(1, 'capture-click'));
  session = resolveJourneyCapture(session, {
    epoch: 1, documentToken: 'document-1', captureId: 'capture-click', status: 'retained', imageId: 'image-click',
    image: {
      capturedAt: '2026-09-20T12:00:01.500Z', captureUrl: 'https://example.com/start',
      width: 1, height: 1, byteLength: MINIMAL_PNG_BYTES, dataUrl: MINIMAL_PNG_DATA_URL,
      viewport: { width: 390, height: 844 }, scroll: { x: 0, y: 0 },
    },
  });
  session = acceptJourneyEventBatch(session, fieldBatch(2, 'capture-field', ['First']));
  if (session.phase !== 'recording') throw new Error('expected recording state');
  session = commitJourneyNavigation(session, {
    epoch: 1, id: 'step-navigation', observedAt: '2026-09-20T12:00:03.000Z', elapsedMs: 3_000,
    sourceUrl: 'https://example.com/start', toUrl: 'https://example.com/reset?token=private-token-9q',
    causedByStepId: 'step-click-1', previousDocumentToken: session.documentToken, documentToken: 'document-2',
    image: { status: 'unavailable', reason: 'navigation-timeout' },
  });
  session = stopJourney(session, { epoch: 1, stoppedAt: '2026-09-20T12:01:00.000Z', reason: 'user' });
  if (session.phase !== 'reviewing') throw new Error('expected reviewing state');
  const pages = (state: JourneySession) => {
    if (state.phase !== 'reviewing') throw new Error('expected reviewing state');
    return state.draft.steps.map(step => [step.id, step.sourcePage, step.kind === 'navigation' ? step.navigation.toPage : null]);
  };
  const numbered = pages(session);
  expect(numbered).toEqual([
    ['step-initial', 1, null], ['step-click-1', 1, null], ['step-field-2', 1, null], ['step-navigation', 1, 2],
  ]);
  const edits: Array<(state: JourneySession) => JourneySession> = [
    state => state.phase === 'reviewing' ? updateJourneySummary(state, { ...reviewGuards(state), expected: 'Kept.', actual: 'Gone.' }) : state,
    state => state.phase === 'reviewing' ? editJourneyValue(state, {
      ...reviewGuards(state), stepId: 'step-field-2', value: { kind: 'selection', values: ['Other'], multiple: true, truncated: false },
    }) : state,
    ...(['step-initial', 'step-click-1', 'step-field-2', 'step-navigation'] as const).map(stepId =>
      (state: JourneySession) => state.phase === 'reviewing' ? redactJourneyUrl(state, { ...reviewGuards(state), stepId, url: 'source' }) : state),
    state => state.phase === 'reviewing' ? redactJourneyUrl(state, { ...reviewGuards(state), stepId: 'step-navigation', url: 'destination' }) : state,
    state => state.phase === 'reviewing' ? redactJourneyUrl(state, { ...reviewGuards(state), stepId: 'step-click-1', url: 'capture' }) : state,
    state => state.phase === 'reviewing' ? redactJourneyLabel(state, { ...reviewGuards(state), stepId: 'step-click-1' }) : state,
  ];
  for (const edit of edits) {
    const next = edit(session);
    expect(next).not.toBe(session);
    expect(pages(next)).toEqual(numbered);
    session = next;
  }
  // Removing the click that caused the navigation drops only the causal link.
  if (session.phase !== 'reviewing') throw new Error('expected reviewing state');
  const removed = removeJourneyStep(session, { ...reviewGuards(session), stepId: 'step-click-1' });
  expect(removed).not.toBe(session);
  expect(pages(removed)).toEqual(numbered.filter(([stepId]) => stepId !== 'step-click-1'));
  if (removed.phase !== 'reviewing') throw new Error('expected reviewing state');
  expect(removed.draft.steps.at(-1)).toMatchObject({ navigation: { toUrl: '[redacted]', toPage: 2 } });
  expect(removed.draft.steps.at(-1)?.navigation).not.toHaveProperty('causedByStepId');
  expect(validateJourneyDraft(removed.draft).ok).toBe(true);
});

test('click label redaction keeps only the marker and its flag, which travel with the click', () => {
  const recording = recordingSession();
  const withClick = acceptJourneyEventBatch(recording, clickBatch(1, 'capture-click'));
  if (withClick.phase !== 'recording') throw new Error('expected recording state');
  const reviewing = stopJourney(withClick, { epoch: 1, stoppedAt: '2026-09-20T12:01:00.000Z', reason: 'user' });
  if (reviewing.phase !== 'reviewing') throw new Error('expected reviewing state');
  const redacted = redactJourneyLabel(reviewing, { ...reviewGuards(reviewing), stepId: 'step-click-1' });
  if (redacted.phase !== 'reviewing') throw new Error('expected reviewing state');
  const click = redacted.draft.steps[1];
  if (click.kind !== 'click') throw new Error('expected click step');
  expect(click.target.label).toBe('[redacted]');
  expect(redacted.draft.redactions).toEqual({ steps: { 'step-click-1': { label: true } } });
  expect(JSON.stringify(redacted.draft)).not.toContain('"Go"');
  // Like every review edit, it restarts the idle window from its own time.
  const editMs = Date.parse(reviewGuards(reviewing).updatedAt);
  expect(Date.parse(redacted.warningAt)).toBeGreaterThan(Date.parse(reviewing.warningAt));
  expect(Date.parse(redacted.expiresAt)).toBeGreaterThan(Date.parse(reviewing.expiresAt));
  expect(redacted).toMatchObject({
    warningAt: new Date(editMs + JOURNEY_LIMITS.maxReviewIdleMs - JOURNEY_LIMITS.reviewWarningMs).toISOString(),
    expiresAt: new Date(editMs + JOURNEY_LIMITS.maxReviewIdleMs).toISOString(),
  });
  // Guards apply as for every review edit.
  expect(redactJourneyLabel(reviewing, { ...reviewGuards(reviewing), revision: 99, stepId: 'step-click-1' })).toBe(reviewing);
  expect(redactJourneyLabel(reviewing, { ...reviewGuards(reviewing), stepId: 'step-initial' })).toBe(reviewing);

  // The flag needs a click whose label is the marker.
  const draft = { ...redacted.draft, expected: 'Kept.', actual: 'Gone.' };
  const visible = structuredClone(draft);
  (visible.steps[1] as Extract<JourneyDraftStep, { kind: 'click' }>).target.label = 'Go';
  expect(validateJourneyDraft(visible)).toEqual({
    ok: false, errors: ['journey.redactions for step step-click-1 marks a visible click label'],
  });
  const misplaced = { ...structuredClone(draft), redactions: { steps: { 'step-initial': { label: true as const } } } };
  expect(validateJourneyDraft(misplaced)).toEqual({
    ok: false, errors: ['journey.redactions for step step-initial marks a visible click label'],
  });
  const removed = removeJourneyStep(redacted, { ...reviewGuards(redacted), stepId: 'step-click-1' });
  if (removed.phase !== 'reviewing') throw new Error('expected reviewing state');
  expect(removed.draft).not.toHaveProperty('redactions');
  expect(validateJourneyDraft(removed.draft).ok).toBe(true);
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

test('batches cannot reuse pending capture IDs, and selections past the aggregate field-text budget keep what fits', () => {
  const recording = recordingSession();
  const withClick = acceptJourneyEventBatch(recording, clickBatch(1, 'capture-click'));
  expect(acceptJourneyEventBatch(withClick, clickBatch(2, 'capture-click'))).toBe(withClick);

  const selection = Array.from({ length: 9 }, () => 'x'.repeat(1_000));
  const first = acceptJourneyEventBatch(recording, fieldBatch(1, 'capture-field-1', selection));
  expect(first).not.toBe(recording);
  // Seven more values fit in the 16 KiB budget: the step keeps whole values
  // up to it, marked truncated, and the draft says values were cut.
  const second = acceptJourneyEventBatch(first, fieldBatch(2, 'capture-field-2', selection));
  if (second.phase !== 'recording') throw new Error('expected recording state');
  expect(second.draft.steps.at(-1)).toMatchObject({
    id: 'step-field-2',
    enteredValue: { kind: 'selection', values: selection.slice(0, 7), multiple: true, truncated: true },
  });
  expect(second.draft.limitations).toEqual([JOURNEY_LIMITATIONS.enteredValuesTruncated]);
  expect(validateJourneyDraft(second.draft).ok).toBe(true);

  const fabricated = clickBatch(1, 'capture-fabricated') as unknown as { events: Array<Record<string, unknown>> };
  fabricated.events[0].image = { status: 'retained', imageId: 'made-up' };
  expect(validateJourneyEventBatch(fabricated).ok).toBe(false);
});

test('a click whose field commits cross the text budget is kept, with each value cut to what fits and marked truncated', () => {
  let state: JourneySession = recordingSession();
  // Eight 2,000-character values leave 384 bytes of the 16 KiB budget.
  state = acceptJourneyEventBatch(state, eventBatch(1, Array.from({ length: 8 }, (_, index) => (
    textFieldEvent(`fill-${index}`, 1_000 + index, 'a'.repeat(2_000))))));
  if (state.phase !== 'recording') throw new Error('expected recording state');
  expect(state.draft.steps).toHaveLength(9);
  expect(state.draft.limitations).toEqual([]);

  const click = clickBatch(2, 'capture-carrier').events[0];
  const carrier = acceptJourneyEventBatch(state, eventBatch(2, [
    textFieldEvent('two-byte', 2_000, 'é'.repeat(300)),
    textFieldEvent('no-room', 2_000, 'later'),
    { ...click, id: 'carrier-click', elapsedMs: 2_000 },
  ]));
  if (carrier.phase !== 'recording') throw new Error('expected recording state');
  expect(carrier.draft.steps.slice(-3).map(step => [step.id, step.kind === 'field-change' ? step.enteredValue : step.image])).toEqual([
    ['two-byte', { kind: 'text', value: 'é'.repeat(192), truncated: true }],
    ['no-room', { kind: 'text', value: '', truncated: true }],
    ['carrier-click', { status: 'pending', captureId: 'capture-carrier' }],
  ]);
  expect(carrier.draft.limitations).toEqual([JOURNEY_LIMITATIONS.enteredValuesTruncated]);
  expect(validateJourneyDraft(carrier.draft).ok).toBe(true);

  // A later value finds no room either; the limitation is recorded once.
  const later = acceptJourneyEventBatch(carrier, eventBatch(3, [textFieldEvent('after', 3_000, 'x')]));
  if (later.phase !== 'recording') throw new Error('expected recording state');
  expect(later.draft.steps.at(-1)).toMatchObject({ id: 'after', enteredValue: { kind: 'text', value: '', truncated: true } });
  expect(later.draft.limitations).toEqual([JOURNEY_LIMITATIONS.enteredValuesTruncated]);

  const stopped = stopJourney(later, { epoch: 1, stoppedAt: '2026-09-20T12:00:04.000Z', reason: 'user' });
  if (stopped.phase !== 'reviewing') throw new Error('expected reviewing state');
  const summarized = updateJourneySummary(stopped, {
    ...reviewGuards(stopped), expected: 'Every value is kept.', actual: 'Later values were cut.',
  });
  if (summarized.phase !== 'reviewing') throw new Error('expected reviewing state');
  expect(summarized).not.toBe(stopped);
  const markdown = formatJourneyMarkdown(journeyDraftToManifest(summarized.draft));
  expect(markdown).toContain(JOURNEY_LIMITATIONS.enteredValuesTruncated);
  expect(markdown).toContain('Entered text truncated: Yes');
  expect(markdown).not.toContain('None recorded.');
});

test('a late batch after a same-document navigation shares the field-text budget', () => {
  let state: JourneySession = recordingSession();
  state = acceptJourneyEventBatch(state, eventBatch(1, Array.from({ length: 8 }, (_, index) => (
    textFieldEvent(`fill-${index}`, 1_000 + index, 'a'.repeat(2_000))))));
  if (state.phase !== 'recording') throw new Error('expected recording state');
  const navigated = commitJourneyNavigation(state, {
    epoch: 1, id: 'step-route', observedAt: '2026-09-20T12:00:03.000Z', elapsedMs: 3_000,
    sourceUrl: 'https://example.com/start', toUrl: 'https://example.com/start#next',
    previousDocumentToken: 'document-1', documentToken: 'document-1',
    image: { status: 'pending', captureId: 'capture-route' },
  });
  // Field commits the route change overtook, delivered with the click that
  // triggered it: before the fix they pushed the draft past its budget.
  const late = acceptLateJourneyEventBatch(navigated, eventBatch(2, [
    textFieldEvent('late-value', 2_500, 'b'.repeat(2_000)),
    { ...clickBatch(2, 'capture-late').events[0], id: 'late-click', observedAt: '2026-09-20T12:00:02.600Z', elapsedMs: 2_600 },
  ]));
  if (late.phase !== 'recording') throw new Error('expected recording state');
  expect(late.draft.steps.slice(-3).map(step => step.id)).toEqual(['late-value', 'late-click', 'step-route']);
  expect(late.draft.steps.at(-3)).toMatchObject({ enteredValue: { kind: 'text', value: 'b'.repeat(384), truncated: true } });
  expect(late.draft.limitations).toEqual([JOURNEY_LIMITATIONS.enteredValuesTruncated]);
  expect(validateJourneyDraft(late.draft).ok).toBe(true);

  // The draft stays editable: review edits validate the whole draft.
  const stopped = stopJourney(late, { epoch: 1, stoppedAt: '2026-09-20T12:00:04.000Z', reason: 'user' });
  if (stopped.phase !== 'reviewing') throw new Error('expected reviewing state');
  expect(updateJourneySummary(stopped, { ...reviewGuards(stopped), expected: 'Kept.', actual: 'Cut.' })).not.toBe(stopped);
});

// A long form filled and then submitted: every commit rides on one click.
function longFormBatch(localCounter: number, observedAt: (elapsedMs: number) => string) {
  const fills = Array.from({ length: 9 }, (_, index) => ({
    ...textFieldEvent(`form-${index}`, 2_000 + index, String.fromCharCode(97 + index).repeat(2_000)),
    observedAt: observedAt(2_000 + index),
  }));
  const click = { ...clickBatch(localCounter, 'capture-submit').events[0], id: 'submit-click', observedAt: observedAt(2_100), elapsedMs: 2_100 };
  return eventBatch(localCounter, [...fills, click]);
}

test('one click carrying more than the whole text budget is kept, on the live path', () => {
  const recording = recordingSession();
  const batch = longFormBatch(1, elapsedMs => new Date(Date.parse('2026-09-20T12:00:00.000Z') + elapsedMs).toISOString());
  // 18,000 bytes of text in one batch: over the journey's budget on its own,
  // but a batch is only bounded by its payload.
  expect(validateJourneyEventBatch(batch).ok).toBe(true);
  const accepted = acceptJourneyEventBatch(recording, batch);
  if (accepted.phase !== 'recording') throw new Error('expected recording state');
  expect(accepted.draft.steps.map(step => step.id)).toEqual([
    'step-initial', ...Array.from({ length: 9 }, (_, index) => `form-${index}`), 'submit-click',
  ]);
  expect(accepted.draft.steps.at(-1)).toMatchObject({ kind: 'click', image: { status: 'pending', captureId: 'capture-submit' } });
  // Eight values fit whole; the ninth keeps the 384 bytes left.
  expect(accepted.draft.steps.at(-3)).toMatchObject({ enteredValue: { kind: 'text', value: 'h'.repeat(2_000), truncated: false } });
  expect(accepted.draft.steps.at(-2)).toMatchObject({ enteredValue: { kind: 'text', value: 'i'.repeat(384), truncated: true } });
  expect(accepted.draft.limitations).toEqual([JOURNEY_LIMITATIONS.enteredValuesTruncated]);
  expect(validateJourneyDraft(accepted.draft).ok).toBe(true);
});

test('one click carrying more than the whole text budget is kept, on the late path', () => {
  const recording = recordingSession();
  const navigated = commitJourneyNavigation(recording, {
    epoch: 1, id: 'step-route', observedAt: '2026-09-20T12:00:03.000Z', elapsedMs: 3_000,
    sourceUrl: 'https://example.com/start', toUrl: 'https://example.com/start#done',
    previousDocumentToken: 'document-1', documentToken: 'document-1',
    image: { status: 'pending', captureId: 'capture-route' },
  });
  const batch = longFormBatch(1, elapsedMs => new Date(Date.parse('2026-09-20T12:00:00.000Z') + elapsedMs).toISOString());
  const late = acceptLateJourneyEventBatch(navigated, batch);
  if (late.phase !== 'recording') throw new Error('expected recording state');
  expect(late.draft.steps.map(step => step.id)).toEqual([
    'step-initial', ...Array.from({ length: 9 }, (_, index) => `form-${index}`), 'submit-click', 'step-route',
  ]);
  expect(late.draft.steps.at(-3)).toMatchObject({ enteredValue: { kind: 'text', value: 'i'.repeat(384), truncated: true } });
  expect(late.draft.limitations).toEqual([JOURNEY_LIMITATIONS.enteredValuesTruncated]);
  expect(validateJourneyDraft(late.draft).ok).toBe(true);
});

test('a value the page already cut to the field limit is a limitation too, until review rewrites or removes it', () => {
  const recording = recordingSession();
  const cut = { ...textFieldEvent('page-cut', 1_000, 'p'.repeat(2_000)), enteredValue: { kind: 'text' as const, value: 'p'.repeat(2_000), truncated: true } };
  const second = { ...textFieldEvent('also-cut', 1_100, 'q'.repeat(2_000)), enteredValue: { kind: 'text' as const, value: 'q'.repeat(2_000), truncated: true } };
  const accepted = acceptJourneyEventBatch(recording, eventBatch(1, [cut, second]));
  if (accepted.phase !== 'recording') throw new Error('expected recording state');
  expect(accepted.draft.limitations).toEqual([JOURNEY_LIMITATIONS.enteredValuesTruncated]);

  const stopped = stopJourney(accepted, { epoch: 1, stoppedAt: '2026-09-20T12:00:02.000Z', reason: 'user' });
  if (stopped.phase !== 'reviewing') throw new Error('expected reviewing state');
  // One truncated value remains after each of these edits: the limitation stays.
  const edited = editJourneyValue(stopped, { ...reviewGuards(stopped), stepId: 'page-cut', value: { kind: 'text', value: 'Rewritten', truncated: false } });
  if (edited.phase !== 'reviewing') throw new Error('expected reviewing state');
  expect(edited.draft.limitations).toEqual([JOURNEY_LIMITATIONS.enteredValuesTruncated]);
  // Removing the last truncated value withdraws it; other limitations stay.
  const withOther = { ...edited, draft: { ...edited.draft, limitations: [...edited.draft.limitations, JOURNEY_LIMITATIONS.pageAccessLost] } };
  const removed = removeJourneyStep(withOther, { ...reviewGuards(withOther), updatedAt: '2026-09-20T12:01:40.000Z', stepId: 'also-cut' });
  if (removed.phase !== 'reviewing') throw new Error('expected reviewing state');
  expect(removed.draft.limitations).toEqual([JOURNEY_LIMITATIONS.pageAccessLost]);

  // Rewriting the last truncated value withdraws it as well.
  const rewritten = editJourneyValue(stopped, { ...reviewGuards(stopped), stepId: 'page-cut', value: { kind: 'text', value: 'A', truncated: false } });
  if (rewritten.phase !== 'reviewing') throw new Error('expected reviewing state');
  const cleared = editJourneyValue(rewritten, {
    ...reviewGuards(rewritten), updatedAt: '2026-09-20T12:01:40.000Z', stepId: 'also-cut', value: { kind: 'text', value: '', truncated: false },
  });
  if (cleared.phase !== 'reviewing') throw new Error('expected reviewing state');
  expect(cleared.draft.limitations).toEqual([]);
  expect(validateJourneyDraft(cleared.draft).ok).toBe(true);
});

test('lossy stops record what is missing once, and ordinary stops record nothing', () => {
  const recording = recordingSession();
  const stoppedAt = '2026-09-20T12:00:02.000Z';
  const limitations = (reason: 'user' | 'left-site' | 'page-access-lost' | 'session-storage-limit' | 'image-budget' | 'capture-failed') => {
    const stopped = stopJourney(recording, { epoch: 1, stoppedAt, reason });
    if (stopped.phase !== 'reviewing') throw new Error('expected reviewing state');
    return stopped.draft.limitations;
  };
  expect(limitations('user')).toEqual([]);
  expect(limitations('left-site')).toEqual([]);
  expect(limitations('page-access-lost')).toEqual([JOURNEY_LIMITATIONS.pageAccessLost]);
  expect(limitations('session-storage-limit')).toEqual([JOURNEY_LIMITATIONS.sessionStorage]);
  expect(limitations('image-budget')).toEqual([JOURNEY_LIMITATIONS.imageBudget]);
  expect(limitations('capture-failed')).toEqual([JOURNEY_LIMITATIONS.captureFailed]);
  for (const text of Object.values(JOURNEY_LIMITATIONS)) {
    expect(Array.from(text).length).toBeLessThanOrEqual(JOURNEY_LIMITS.maxLimitationCharacters);
  }

  // A batch that no longer fits in session storage stops the journey and
  // says the latest action may be missing.
  const previous = nearSessionLimitRecording();
  const overflowed = acceptJourneyEventBatch(previous, {
    ...clickBatch(7, 'capture-overflow'),
    events: [{ ...clickBatch(7, 'capture-overflow').events[0], id: 'overflow-click', observedAt: stoppedAt, elapsedMs: 40_000,
      sourceUrl: maximumFixtureUrl('overflow-source') }],
  });
  if (overflowed.phase !== 'reviewing') throw new Error('expected reviewing state');
  expect(overflowed.draft.stopReason).toBe('session-storage-limit');
  expect(overflowed.draft.limitations).toEqual([JOURNEY_LIMITATIONS.sessionStorage]);
  expect(Buffer.byteLength(JSON.stringify(overflowed)))
    .toBeLessThanOrEqual(JOURNEY_LIMITS.maxSessionBytes - JOURNEY_LIMITS.sessionMetadataReserveBytes);
});

test('a storage failure during review records why the stop reason changed, so a saved journey never shows it unexplained', () => {
  const recording = recordingSession();
  const stopped = stopJourney(recording, { epoch: 1, stoppedAt: '2026-09-20T12:00:02.000Z', reason: 'user' });
  if (stopped.phase !== 'reviewing') throw new Error('expected reviewing state');
  const summarized = updateJourneySummary(stopped, { ...reviewGuards(stopped), expected: 'The order saves.', actual: 'It spins.' });
  if (summarized.phase !== 'reviewing') throw new Error('expected reviewing state');
  expect(summarized.draft.limitations).toEqual([]);

  const marked = markJourneyReviewStorageFailure(summarized);
  expect(marked.draft.stopReason).toBe('session-storage-limit');
  expect(marked.draft.limitations).toEqual([JOURNEY_LIMITATIONS.reviewStorage]);
  // Every step and edit is still there; only the stop reason changed.
  expect({ ...marked.draft, stopReason: 'user', limitations: [] }).toEqual(summarized.draft);
  expect(validateJourneyDraft(marked.draft).ok).toBe(true);
  expect(reviewSaveGating(marked)).toEqual({ ready: true, reasons: [] });
  const markdown = formatJourneyMarkdown(journeyDraftToManifest(marked.draft));
  expect(markdown).toContain('Stop reason: `session-storage-limit`');
  expect(markdown).toContain(JOURNEY_LIMITATIONS.reviewStorage);
  expect(markdown).not.toContain('None recorded.');
  // Neither export says recording was cut short or that an action may be
  // missing: the prompt says why recording ended is unknown instead.
  const prompt = journeyPrompt(journeyDraftToManifest(marked.draft));
  expect(prompt).toContain('- **Stopped because:** unknown; journey storage failed after recording stopped and replaced the reason, but no recorded step is missing (`session-storage-limit`)');
  for (const text of [markdown, prompt]) {
    expect(text).not.toContain('while recording');
    expect(text).not.toMatch(/latest action[^\n]*may be (lost|missing)/);
  }

  // A second failure changes nothing, and one after a storage stop during
  // recording keeps that stop's own limitation alone.
  expect(markJourneyReviewStorageFailure(marked)).toBe(marked);
  const storageStop = stopJourney(recording, { epoch: 1, stoppedAt: '2026-09-20T12:00:02.000Z', reason: 'session-storage-limit' });
  if (storageStop.phase !== 'reviewing') throw new Error('expected reviewing state');
  expect(markJourneyReviewStorageFailure(storageStop)).toBe(storageStop);
  expect(storageStop.draft.limitations).toEqual([JOURNEY_LIMITATIONS.sessionStorage]);
  // That stop still reads as a recording cut short by storage.
  const storageSummarized = updateJourneySummary(storageStop, { ...reviewGuards(storageStop), expected: 'The order saves.', actual: 'It spins.' });
  if (storageSummarized.phase !== 'reviewing') throw new Error('expected reviewing state');
  expect(journeyPrompt(journeyDraftToManifest(storageSummarized.draft)))
    .toContain('- **Stopped because:** journey storage failed while recording (`session-storage-limit`)');

  // Earlier limitations stay first, and a saving session is marked the same way.
  const saving = {
    phase: 'saving' as const, sessionId: summarized.sessionId, journeyId: summarized.journeyId, epoch: summarized.epoch,
    ownerTabId: summarized.ownerTabId, ownerWindowId: summarized.ownerWindowId,
    draft: { ...summarized.draft, limitations: [JOURNEY_LIMITATIONS.enteredValuesTruncated] },
  };
  expect(markJourneyReviewStorageFailure(saving)).toMatchObject({
    phase: 'saving',
    draft: { stopReason: 'session-storage-limit', limitations: [JOURNEY_LIMITATIONS.enteredValuesTruncated, JOURNEY_LIMITATIONS.reviewStorage] },
  });
});

test('a draft with no room to explain a storage failure during review keeps its recorded stop reason', () => {
  const stopped = stopJourney(nearSessionLimitRecording(), { epoch: 1, stoppedAt: '2026-09-20T12:00:30.000Z', reason: 'user' });
  if (stopped.phase !== 'reviewing') throw new Error('expected reviewing state');
  // Fill the draft to 100 bytes under the session limit: the relabel alone
  // would fit, but not the limitation that explains it.
  const summarized = { ...stopped.draft, actual: 'It spins.' };
  const room = JOURNEY_LIMITS.maxSessionBytes - Buffer.byteLength(JSON.stringify(summarized)) - 100;
  const expected = '\u{1D11E}'.repeat(Math.floor(room / 4)) + 'a'.repeat(room % 4);
  const full = { ...stopped, draft: { ...summarized, expected } };
  expect(Buffer.byteLength(JSON.stringify(full.draft))).toBe(JOURNEY_LIMITS.maxSessionBytes - 100);
  expect(validateJourneyDraft(full.draft).ok).toBe(true);
  expect(validateJourneyDraft({ ...full.draft, stopReason: 'session-storage-limit' }).ok).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(JOURNEY_LIMITATIONS.reviewStorage))).toBeGreaterThan(100);

  // A storage stop reason never appears without its explanation.
  const marked = markJourneyReviewStorageFailure(full);
  expect(marked).toBe(full);
  expect(marked.draft.stopReason).toBe('user');
  expect(marked.draft.limitations).toEqual([]);
});

test('every accepted review edit restarts the idle window from its own time', () => {
  const stopMs = Date.parse('2026-09-20T12:01:00.000Z');
  const windowFrom = (ms: number) => ({
    warningAt: new Date(ms + JOURNEY_LIMITS.maxReviewIdleMs - JOURNEY_LIMITS.reviewWarningMs).toISOString(),
    expiresAt: new Date(ms + JOURNEY_LIMITS.maxReviewIdleMs).toISOString(),
  });
  const withField = reviewingWithField();
  expect(withField).toMatchObject(windowFrom(stopMs));
  // Each edit lands a minute before the window it was made in would expire.
  let state: JourneySession = withField;
  let editMs = stopMs;
  const edit = (apply: (guards: ReturnType<typeof reviewGuards>) => JourneySession) => {
    if (state.phase !== 'reviewing') throw new Error('expected reviewing state');
    editMs += JOURNEY_LIMITS.maxReviewIdleMs - 60_000;
    const next = apply({ ...reviewGuards(state), updatedAt: new Date(editMs).toISOString() });
    expect(next).not.toBe(state);
    expect(next).toMatchObject({ phase: 'reviewing', ...windowFrom(editMs) });
    state = next;
  };
  const fieldId = withField.draft.steps[1].id;
  edit(guards => updateJourneySummary(state, { ...guards, expected: 'Kept.', actual: 'Lost.' }));
  edit(guards => editJourneyValue(state, { ...guards, stepId: fieldId, value: { kind: 'selection', values: [], multiple: true, truncated: false } }));
  edit(guards => redactJourneyUrl(state, { ...guards, stepId: 'step-initial', url: 'source' }));
  edit(guards => removeJourneyStep(state, { ...guards, stepId: fieldId }));
  edit(guards => {
    const result = applyJourneyImageReview(state, { operation: 'remove', ...guards, imageId: 'image-initial' });
    if (!result.ok) throw new Error(result.errors.join(', '));
    return result.value;
  });
  // Two hours after Stop, the review is still open to edits.
  expect(editMs - stopMs).toBeGreaterThan(2 * 60 * 60 * 1_000);

  // A refused edit leaves the window alone.
  if (state.phase !== 'reviewing') throw new Error('expected reviewing state');
  const refused = updateJourneySummary(state, {
    ...reviewGuards(state), updatedAt: state.expiresAt, expected: 'Late.', actual: 'Late.',
  });
  expect(refused).toBe(state);
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

// Stop numbers each step's pages; the rest of a stopped step is as recorded.
function withoutPages(steps: JourneyDraftStep[]): JourneyDraftStep[] {
  return steps.map(step => {
    const { sourcePage: _sourcePage, ...rest } = step;
    if (rest.kind !== 'navigation') return rest;
    const { toPage: _toPage, ...navigation } = rest.navigation;
    return { ...rest, navigation };
  }) as JourneyDraftStep[];
}

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

function eventBatch(localCounter: number, events: JourneyInputEvent[]) {
  return { schemaVersion: 1 as const, sessionId: 'session-1', epoch: 1, documentToken: 'document-1', localCounter, events };
}

function textFieldEvent(id: string, elapsedMs: number, value: string): JourneyInputEvent {
  return {
    kind: 'field-change', id, observedAt: new Date(Date.parse('2026-09-20T12:00:00.000Z') + elapsedMs).toISOString(), elapsedMs,
    sourceUrl: 'https://example.com/start',
    target: { tag: 'input', selectorPath: ['input'], label: 'Notes', editable: true, viewport: { width: 390, height: 844 }, scroll: { x: 0, y: 0 } },
    enteredValue: { kind: 'text', value, truncated: false },
    image: { status: 'unavailable', reason: 'superseded' },
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
