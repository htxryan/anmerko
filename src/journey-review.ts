import {
  validateJourneyDraft,
  type JourneyDraftImage,
  type JourneyDraftStep,
  type JourneySession,
  type ReviewingJourneySession,
  type ValidationResult,
} from './journey-core';
import type { NormalizedJourneyPng } from './journey-image';
import { JOURNEY_LIMITS } from './journey-limits';

interface JourneyImageReviewGuard {
  epoch: number;
  journeyId: string;
  revision: number;
  imageId: string;
  updatedAt: string;
}

export type JourneyImageReviewInput =
  | (JourneyImageReviewGuard & { operation: 'replace'; image: NormalizedJourneyPng })
  | (JourneyImageReviewGuard & { operation: 'remove' });

const encoder = new TextEncoder();

function failure(error: string): ValidationResult<ReviewingJourneySession> {
  return { ok: false, errors: [error] };
}

function isObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === required.length && required.every(key => Object.hasOwn(value, key));
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
}

function validReviewInput(value: unknown): value is JourneyImageReviewInput {
  if (!isObject(value) || (value.operation !== 'replace' && value.operation !== 'remove')) return false;
  const common = ['operation', 'epoch', 'journeyId', 'revision', 'imageId', 'updatedAt'] as const;
  if (!hasExactKeys(value, value.operation === 'replace' ? [...common, 'image'] : common)) return false;
  if (!Number.isSafeInteger(value.epoch) || !Number.isSafeInteger(value.revision)
    || typeof value.journeyId !== 'string' || typeof value.imageId !== 'string'
    || !validTimestamp(value.updatedAt)) return false;
  if (value.operation === 'remove') return true;
  if (!isObject(value.image) || !hasExactKeys(value.image, ['dataUrl', 'width', 'height', 'byteLength'])) return false;
  return typeof value.image.dataUrl === 'string'
    && Number.isSafeInteger(value.image.width)
    && Number.isSafeInteger(value.image.height)
    && Number.isSafeInteger(value.image.byteLength);
}

function removedReferences(steps: JourneyDraftStep[], imageId: string): JourneyDraftStep[] {
  return steps.map(step => step.image.status === 'retained' && step.image.imageId === imageId
    ? { ...step, image: { status: 'removed' } }
    : step);
}

function replacementImage(current: JourneyDraftImage, image: NormalizedJourneyPng): JourneyDraftImage {
  return {
    capturedAt: current.capturedAt,
    captureUrl: current.captureUrl,
    width: image.width,
    height: image.height,
    byteLength: image.byteLength,
    dataUrl: image.dataUrl,
    viewport: { width: current.viewport.width, height: current.viewport.height },
    scroll: { x: current.scroll.x, y: current.scroll.y },
    redacted: true,
  };
}

export function applyJourneyImageReview(
  state: JourneySession,
  input: JourneyImageReviewInput,
): ValidationResult<ReviewingJourneySession> {
  if (state.phase !== 'reviewing') return failure('journey is not available for image review');
  if (!validReviewInput(input)) return failure('image review input is malformed');
  if (input.epoch !== state.epoch || input.journeyId !== state.journeyId
    || input.journeyId !== state.draft.id || input.revision !== state.draft.revision) {
    return failure('image review input is stale');
  }
  if (!Number.isSafeInteger(state.draft.revision) || state.draft.revision >= Number.MAX_SAFE_INTEGER) {
    return failure('journey revision cannot be advanced');
  }
  if (!validTimestamp(state.expiresAt) || !validTimestamp(state.draft.updatedAt)) {
    return failure('journey review timestamps are invalid');
  }
  const updateMs = Date.parse(input.updatedAt);
  if (updateMs < Date.parse(state.draft.updatedAt) || updateMs >= Date.parse(state.expiresAt)) {
    return failure('image review timestamp is outside the active review period');
  }

  const currentDraft = validateJourneyDraft(state.draft);
  if (!currentDraft.ok) return failure('journey draft is invalid');
  const currentImage = currentDraft.value.images[input.imageId];
  const referenced = currentDraft.value.steps.some(step => step.image.status === 'retained' && step.image.imageId === input.imageId);
  if (!currentImage || !referenced) return failure('journey image is not available');
  if (input.operation === 'replace'
    && (input.image.width !== currentImage.width || input.image.height !== currentImage.height)) {
    return failure('replacement image dimensions must match');
  }

  const images = input.operation === 'remove'
    ? Object.fromEntries(Object.entries(currentDraft.value.images).filter(([imageId]) => imageId !== input.imageId))
    : { ...currentDraft.value.images, [input.imageId]: replacementImage(currentImage, input.image) };
  const draft = {
    ...currentDraft.value,
    revision: currentDraft.value.revision + 1,
    updatedAt: input.updatedAt,
    steps: input.operation === 'remove'
      ? removedReferences(currentDraft.value.steps, input.imageId)
      : currentDraft.value.steps,
    images,
  };
  const validatedDraft = validateJourneyDraft(draft);
  if (!validatedDraft.ok) return failure('image review candidate is invalid');

  const next: ReviewingJourneySession = {
    phase: 'reviewing',
    sessionId: state.sessionId,
    journeyId: state.journeyId,
    epoch: state.epoch,
    ownerTabId: state.ownerTabId,
    ownerWindowId: state.ownerWindowId,
    warningAt: state.warningAt,
    expiresAt: state.expiresAt,
    draft: validatedDraft.value,
  };
  if (encoder.encode(JSON.stringify(next)).byteLength > JOURNEY_LIMITS.maxSessionBytes) {
    return failure('image review candidate exceeds the session limit');
  }
  return { ok: true, value: next };
}
