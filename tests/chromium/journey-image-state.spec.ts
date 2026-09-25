import { expect, test } from '@playwright/test';
import {
  JOURNEY_LIMITS,
} from '../../src/journey-limits';
import {
  redactJourneyUrl,
  removeJourneyStep,
  validateJourneyDraft,
  type JourneyDraftImage,
  type JourneyDraftStep,
  type JourneySession,
  type ReviewingJourneySession,
} from '../../src/journey-core';
import { applyJourneyImageReview, type JourneyImageReviewInput } from '../../src/journey-review';

const updatedAt = '2026-09-20T12:06:00.000Z';

function pngDataUrl(byteLength: number, width = 390, height = 844): string {
  const png = new Uint8Array(byteLength);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  png.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8);
  png.set([(width >>> 24) & 0xff, (width >>> 16) & 0xff, (width >>> 8) & 0xff, width & 0xff], 16);
  png.set([(height >>> 24) & 0xff, (height >>> 16) & 0xff, (height >>> 8) & 0xff, height & 0xff], 20);
  return `data:image/png;base64,${Buffer.from(png).toString('base64')}`;
}

function draftImage(byteLength = 64, suffix = 'original'): JourneyDraftImage {
  return {
    capturedAt: '2026-09-20T12:00:01.100Z',
    captureUrl: `https://example.com/path?source=${suffix}#capture`,
    width: 390,
    height: 844,
    byteLength,
    dataUrl: pngDataUrl(byteLength),
    viewport: { width: 390, height: 844 },
    scroll: { x: 0, y: 120 },
  };
}

function reviewingSession(): ReviewingJourneySession {
  return {
    phase: 'reviewing',
    epoch: 3,
    sessionId: 'session-1',
    journeyId: 'journey-1',
    ownerTabId: 42,
    ownerWindowId: 7,
    warningAt: '2026-09-20T12:28:00.000Z',
    expiresAt: '2026-09-20T12:30:00.000Z',
    draft: {
      schemaVersion: 1,
      status: 'draft',
      id: 'journey-1',
      revision: 0,
      createdAt: '2026-09-20T12:00:00.000Z',
      updatedAt: '2026-09-20T12:05:00.000Z',
      startedAt: '2026-09-20T12:00:00.000Z',
      stoppedAt: '2026-09-20T12:05:00.000Z',
      stopReason: 'user',
      includeEnteredValues: false,
      expected: '',
      actual: '',
      steps: [
        {
          kind: 'click', id: 'step-click', seq: 1,
          observedAt: '2026-09-20T12:00:01.000Z', elapsedMs: 1_000,
          sourceUrl: 'https://example.com/start?item=1#details',
          target: {
            tag: 'button', role: 'button', selectorPath: ['main', 'button'], label: 'Continue',
            editable: false, viewport: { width: 390, height: 844 }, scroll: { x: 0, y: 120 },
            point: { x: 195, y: 700 },
          },
          image: { status: 'retained', imageId: 'image-shared', sharedNavigationResult: true },
        },
        {
          kind: 'navigation', id: 'step-navigation', seq: 2,
          observedAt: '2026-09-20T12:00:01.100Z', elapsedMs: 1_100,
          sourceUrl: 'https://example.com/start?item=1#details',
          navigation: { toUrl: 'https://example.com/next?item=1#done', causedByStepId: 'step-click' },
          image: { status: 'retained', imageId: 'image-shared', sharedNavigationResult: true },
        },
      ],
      images: { 'image-shared': draftImage() },
      limitations: [],
    },
  };
}

function replaceInput(dataUrl = pngDataUrl(80)): Extract<JourneyImageReviewInput, { operation: 'replace' }> {
  return {
    operation: 'replace',
    epoch: 3,
    journeyId: 'journey-1',
    revision: 0,
    imageId: 'image-shared',
    updatedAt,
    image: { dataUrl, width: 390, height: 844, byteLength: 80 },
  };
}

test('replacement updates one image bank entry shared by every step and removes original pixels', () => {
  const state = reviewingSession();
  const original = structuredClone(state);
  const input = replaceInput();

  const result = applyJourneyImageReview(state, input);

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.draft.revision).toBe(1);
  expect(result.value.draft.updatedAt).toBe(updatedAt);
  expect(result.value.draft.steps.map(step => step.image)).toEqual([
    { status: 'retained', imageId: 'image-shared', sharedNavigationResult: true },
    { status: 'retained', imageId: 'image-shared', sharedNavigationResult: true },
  ]);
  expect(result.value.draft.images['image-shared']).toEqual({
    capturedAt: original.draft.images['image-shared'].capturedAt,
    captureUrl: original.draft.images['image-shared'].captureUrl,
    width: 390,
    height: 844,
    byteLength: 80,
    dataUrl: input.operation === 'replace' ? input.image.dataUrl : '',
    viewport: original.draft.images['image-shared'].viewport,
    scroll: original.draft.images['image-shared'].scroll,
    redacted: true,
  });
  expect(JSON.stringify(result.value)).not.toContain(original.draft.images['image-shared'].dataUrl);
  expect(state).toEqual(original);
  expect(validateJourneyDraft(result.value.draft).ok).toBe(true);
});

test('successive replacements in the same millisecond stay redacted and advance revision without retaining prior pixels', () => {
  const firstPixels = pngDataUrl(80);
  const first = applyJourneyImageReview(reviewingSession(), replaceInput(firstPixels));
  expect(first.ok).toBe(true);
  if (!first.ok) return;
  const secondPixels = pngDataUrl(96);
  const second = applyJourneyImageReview(first.value, {
    ...replaceInput(secondPixels), revision: 1,
    image: { dataUrl: secondPixels, width: 390, height: 844, byteLength: 96 },
  });

  expect(second.ok).toBe(true);
  if (!second.ok) return;
  expect(second.value.draft.revision).toBe(2);
  expect(second.value.draft.images['image-shared'].redacted).toBe(true);
  expect(JSON.stringify(second.value)).not.toContain(firstPixels);
});

test('removal deletes image payload and marks every shared reference removed', () => {
  const state = reviewingSession();
  const originalPixels = state.draft.images['image-shared'].dataUrl;

  const result = applyJourneyImageReview(state, {
    operation: 'remove', epoch: 3, journeyId: 'journey-1', revision: 0,
    imageId: 'image-shared', updatedAt,
  });

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.draft.images).toEqual({});
  expect(result.value.draft.steps.map(step => step.image)).toEqual([
    { status: 'removed' },
    { status: 'removed' },
  ]);
  expect(JSON.stringify(result.value)).not.toContain(originalPixels);
  expect(validateJourneyDraft(result.value.draft).ok).toBe(true);
});

test('removing a screenshot whose capture URL was redacted drops only that redaction flag', () => {
  let state: JourneySession = reviewingSession();
  for (const [stepId, url] of [['step-click', 'capture'], ['step-navigation', 'source']] as const) {
    if (state.phase !== 'reviewing') throw new Error('expected reviewing state');
    const next = redactJourneyUrl(state, {
      epoch: 3, journeyId: 'journey-1', revision: state.draft.revision, updatedAt: '2026-09-20T12:05:30.000Z', stepId, url,
    });
    expect(next).not.toBe(state);
    state = next;
  }
  if (state.phase !== 'reviewing') throw new Error('expected reviewing state');
  expect(state.draft.images['image-shared'].captureUrl).toBe('[redacted]');

  const result = applyJourneyImageReview(state, {
    operation: 'remove', epoch: 3, journeyId: 'journey-1', revision: state.draft.revision,
    imageId: 'image-shared', updatedAt,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.draft.steps.map(step => step.image)).toEqual([{ status: 'removed' }, { status: 'removed' }]);
  expect(result.value.draft.images).toEqual({});
  expect(result.value.draft.redactions).toEqual({ steps: { 'step-navigation': { sourceUrl: true } } });
  expect(validateJourneyDraft(result.value.draft).ok).toBe(true);
});

test('removing either step of a shared click and navigation result keeps the other step valid', () => {
  const guards = { epoch: 3, journeyId: 'journey-1', revision: 0, updatedAt };
  const withoutClick = removeJourneyStep(reviewingSession(), { ...guards, stepId: 'step-click' });
  if (withoutClick.phase !== 'reviewing') throw new Error('expected reviewing state');
  expect(withoutClick.draft.revision).toBe(1);
  expect(withoutClick.draft.steps).toEqual([expect.objectContaining({
    id: 'step-navigation',
    navigation: { toUrl: 'https://example.com/next?item=1#done' },
    image: { status: 'retained', imageId: 'image-shared' },
  })]);
  expect(Object.keys(withoutClick.draft.images)).toEqual(['image-shared']);
  expect(validateJourneyDraft(withoutClick.draft).ok).toBe(true);

  const withoutNavigation = removeJourneyStep(reviewingSession(), { ...guards, stepId: 'step-navigation' });
  if (withoutNavigation.phase !== 'reviewing') throw new Error('expected reviewing state');
  expect(withoutNavigation.draft.steps).toEqual([expect.objectContaining({
    id: 'step-click', image: { status: 'retained', imageId: 'image-shared' },
  })]);
  expect(validateJourneyDraft(withoutNavigation.draft).ok).toBe(true);
});

test('stale identity, non-review phases, missing images, unsafe revisions, and expiry are rejected without mutation', () => {
  const cases: Array<[JourneySession, unknown]> = [
    [reviewingSession(), { ...replaceInput(), epoch: 2 }],
    [reviewingSession(), { ...replaceInput(), journeyId: 'journey-other' }],
    [reviewingSession(), { ...replaceInput(), revision: 1 }],
    [reviewingSession(), { ...replaceInput(), imageId: 'image-missing' }],
    [{ phase: 'idle', epoch: 3 }, replaceInput()],
    [{ ...reviewingSession(), phase: 'saving' }, replaceInput()],
    [{ ...reviewingSession(), draft: { ...reviewingSession().draft, revision: Number.MAX_SAFE_INTEGER } }, { ...replaceInput(), revision: Number.MAX_SAFE_INTEGER }],
    [reviewingSession(), { ...replaceInput(), updatedAt: '2026-09-20T12:04:59.999Z' }],
    [reviewingSession(), { ...replaceInput(), updatedAt: '2026-09-20T12:30:00.000Z' }],
  ];

  for (const [state, input] of cases) {
    const before = structuredClone(state);
    const result = applyJourneyImageReview(state, input as JourneyImageReviewInput);
    expect(result.ok).toBe(false);
    expect(state).toEqual(before);
  }
});

test('malformed images, changed dimensions, oversized images, and hidden fields are rejected without leaking values', () => {
  const secretUrl = 'https://secret.invalid/path?token=private#value';
  const secretPixels = `data:image/png;base64,${Buffer.from(secretUrl).toString('base64')}`;
  const cases: unknown[] = [
    { ...replaceInput(), image: { dataUrl: secretPixels, width: 390, height: 844, byteLength: secretUrl.length } },
    { ...replaceInput(), image: { ...replaceInput().image, width: 391 } },
    { ...replaceInput(), image: { dataUrl: pngDataUrl(JOURNEY_LIMITS.maxImageBytes + 1), width: 390, height: 844, byteLength: JOURNEY_LIMITS.maxImageBytes + 1 } },
    { ...replaceInput(), hidden: secretUrl },
    { ...replaceInput(), image: { ...replaceInput().image, original: secretPixels } },
  ];

  for (const input of cases) {
    const state = reviewingSession();
    const before = structuredClone(state);
    const result = applyJourneyImageReview(state, input as JourneyImageReviewInput);
    expect(result.ok).toBe(false);
    expect(state).toEqual(before);
    if (!result.ok) {
      expect(JSON.stringify(result.errors)).not.toContain(secretUrl);
      expect(JSON.stringify(result.errors)).not.toContain(secretPixels);
    }
  }
});

test('replacement rejects a candidate that crosses the serialized 8 MiB session cap', () => {
  const state = nearSessionBudget();
  expect(Buffer.byteLength(JSON.stringify(state.draft))).toBeLessThanOrEqual(JOURNEY_LIMITS.maxSessionBytes);
  const validation = validateJourneyDraft(state.draft);
  expect(validation.ok ? [] : validation.errors).toEqual([]);
  const replacement = pngDataUrl(JOURNEY_LIMITS.maxImageBytes, 1, 1);
  const candidateDraft = structuredClone(state.draft);
  candidateDraft.revision += 1;
  candidateDraft.updatedAt = updatedAt;
  candidateDraft.images['image-0'] = {
    ...candidateDraft.images['image-0'], dataUrl: replacement,
    byteLength: JOURNEY_LIMITS.maxImageBytes, redacted: true,
  };
  expect(validateJourneyDraft(candidateDraft).ok).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(candidateDraft))).toBeLessThanOrEqual(JOURNEY_LIMITS.maxSessionBytes);
  expect(Buffer.byteLength(JSON.stringify({ ...state, draft: candidateDraft }))).toBeGreaterThan(JOURNEY_LIMITS.maxSessionBytes);
  const before = structuredClone(state);

  const result = applyJourneyImageReview(state, {
    operation: 'replace', epoch: 3, journeyId: 'journey-1', revision: 0,
    imageId: 'image-0', updatedAt,
    image: { dataUrl: replacement, width: 1, height: 1, byteLength: JOURNEY_LIMITS.maxImageBytes },
  });

  expect(result.ok).toBe(false);
  expect(state).toEqual(before);
});

function nearSessionBudget(): ReviewingJourneySession {
  const imageByteLength = Math.floor((JOURNEY_LIMITS.maxJourneyImageBytes - 340 * 1_024) / 7);
  const images: Record<string, JourneyDraftImage> = {};
  const steps: JourneyDraftStep[] = [];
  for (let index = 0; index < 7; index += 1) {
    const imageId = `image-${index}`;
    images[imageId] = {
      ...draftImage(imageByteLength, String(index)), width: 1, height: 1,
      dataUrl: pngDataUrl(imageByteLength, 1, 1),
    };
    const base = {
      id: `step-image-${index}`, seq: index + 1,
      observedAt: `2026-09-20T12:00:0${index}.000Z`, elapsedMs: index * 1_000,
      sourceUrl: maximumUrl(`image-${index}`), image: { status: 'retained' as const, imageId },
    };
    steps.push(index === 0 ? { ...base, kind: 'initial' } : {
      ...base, kind: 'click',
      target: {
        tag: 'button', selectorPath: ['button'], label: 'Continue', editable: false,
        viewport: { width: 1, height: 1 }, scroll: { x: 0, y: 0 }, point: { x: 1, y: 1 },
      },
    });
  }
  for (let index = 0; index < 23; index += 1) {
    steps.push({
      kind: 'navigation', id: `step-navigation-${index}`, seq: index + 8,
      observedAt: `2026-09-20T12:00:${String(index + 7).padStart(2, '0')}.000Z`, elapsedMs: 7_000 + index,
      sourceUrl: maximumUrl(`source-${index}`),
      navigation: { toUrl: maximumUrl(`destination-${index}`) },
      image: { status: 'unavailable', reason: 'superseded' },
    });
  }
  return {
    ...reviewingSession(),
    draft: { ...reviewingSession().draft, steps, images, limitations: ['x'.repeat(100)] },
  };
}

function maximumUrl(label: string): string {
  const prefix = `https://example.com/${label}/`;
  return `${prefix}${'a'.repeat(JOURNEY_LIMITS.maxUrlBytes - prefix.length)}`;
}
