import { JOURNEY_LIMITATIONS, JOURNEY_LIMITS, STOP_REASONS, type CaptureFailure, type StopReason } from './journey-limits';
import {
  stripUrlCredentials,
  validateJourneyEventBatch,
  type JourneyEventBatchV1,
  type JourneyInputEvent,
} from './journey-events';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: string[] };

export interface Point { x: number; y: number }
export interface Viewport { width: number; height: number }
export interface ReviewedText { text: string; edited: boolean; redacted: boolean }

export interface SafeTarget {
  tag: string;
  role?: string;
  selectorPath: string[];
  label: ReviewedText;
  editable: boolean;
  viewport: Viewport;
  scroll: Point;
  point?: Point;
}

export interface DraftSafeTarget extends Omit<SafeTarget, 'label'> { label: string }

export type ReviewedFieldValue =
  | { kind: 'text'; value: ReviewedText; truncated: boolean }
  | { kind: 'selection'; values: ReviewedText[]; multiple: boolean; truncated: boolean }
  | { kind: 'checked'; checked: boolean };

export type DraftFieldValue =
  | { kind: 'text'; value: string; truncated: boolean; edited?: true }
  | { kind: 'selection'; values: string[]; multiple: boolean; truncated: boolean; edited?: true }
  | { kind: 'checked'; checked: boolean; edited?: true };

export type JourneyUrlRedactions = {
  steps: Record<string, { sourceUrl?: true; captureUrl?: true; toUrl?: true }>;
};

export type JourneyUrlRedactionTarget = 'source' | 'capture' | 'destination';

export const JOURNEY_REDACTED_URL = '[redacted]';

export type ImageState =
  | { status: 'retained'; imageId: string; sharedNavigationResult?: true }
  | { status: 'removed' }
  | { status: 'unavailable'; reason: CaptureFailure };

export type DraftImageState = ImageState | { status: 'pending'; captureId: string };

interface JourneyStepBase<TUrl, TImage extends ImageState | DraftImageState> {
  id: string;
  seq: number;
  observedAt: string;
  elapsedMs: number;
  sourceUrl: TUrl;
  image: TImage;
}

export type JourneyStep =
  | (JourneyStepBase<ReviewedText, ImageState> & {
      kind: 'initial'; target?: never; enteredValue?: never; navigation?: never;
    })
  | (JourneyStepBase<ReviewedText, ImageState> & {
      kind: 'click'; target: SafeTarget; enteredValue?: never; navigation?: never;
    })
  | (JourneyStepBase<ReviewedText, ImageState> & {
      kind: 'navigation'; target?: never; enteredValue?: never;
      navigation: { toUrl: ReviewedText; causedByStepId?: string };
    })
  | (JourneyStepBase<ReviewedText, ImageState> & {
      kind: 'field-change'; target: SafeTarget; enteredValue: ReviewedFieldValue; navigation?: never;
    });

export type JourneyDraftStep =
  | (JourneyStepBase<string, DraftImageState> & {
      kind: 'initial'; target?: never; enteredValue?: never; navigation?: never;
    })
  | (JourneyStepBase<string, DraftImageState> & {
      kind: 'click'; target: DraftSafeTarget; enteredValue?: never; navigation?: never;
    })
  | (JourneyStepBase<string, DraftImageState> & {
      kind: 'navigation'; target?: never; enteredValue?: never;
      navigation: { toUrl: string; causedByStepId?: string };
    })
  | (JourneyStepBase<string, DraftImageState> & {
      kind: 'field-change'; target: DraftSafeTarget; enteredValue: DraftFieldValue; navigation?: never;
    });

export interface JourneyImage {
  capturedAt: string;
  captureUrl: ReviewedText;
  width: number;
  height: number;
  byteLength: number;
  viewport: Viewport;
  scroll: Point;
  redacted: boolean;
}

export interface JourneyDraftImage extends Omit<JourneyImage, 'captureUrl' | 'redacted'> {
  captureUrl: string;
  dataUrl?: string;
  redacted?: boolean;
}

export interface JourneyManifestV1 {
  schemaVersion: 1;
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  startedAt: string;
  stoppedAt: string;
  includeEnteredValues: boolean;
  stopReason: StopReason;
  expected: string;
  actual: string;
  steps: JourneyStep[];
  images: Record<string, JourneyImage>;
  limitations: string[];
}

export interface JourneyDraftV1 {
  schemaVersion: 1;
  status: 'draft';
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  startedAt: string;
  stoppedAt?: string;
  includeEnteredValues: boolean;
  stopReason?: StopReason;
  expected: string;
  actual: string;
  steps: JourneyDraftStep[];
  images: Record<string, JourneyDraftImage>;
  limitations: string[];
  redactions?: JourneyUrlRedactions;
}

interface SessionOwner {
  sessionId: string;
  journeyId: string;
  epoch: number;
  ownerTabId: number;
  ownerWindowId: number;
}

export interface IdleJourneySession { phase: 'idle'; epoch: number }
export interface StartingJourneySession extends SessionOwner {
  phase: 'starting';
  documentToken: string;
  deadlineAt: string;
  draft: JourneyDraftV1;
}
export interface RecordingJourneySession extends SessionOwner {
  phase: 'recording';
  documentToken: string;
  deadlineAt: string;
  documentCounters: Record<string, number>;
  draft: JourneyDraftV1;
}
export interface ReviewingJourneySession extends SessionOwner {
  phase: 'reviewing';
  warningAt: string;
  expiresAt: string;
  draft: JourneyDraftV1;
}
export interface SavingJourneySession extends SessionOwner {
  phase: 'saving';
  draft: JourneyDraftV1;
}
export interface SavedJourneySession {
  phase: 'saved';
  epoch: number;
  journeyId: string;
  revision: number;
}
export type JourneySession = IdleJourneySession | StartingJourneySession | RecordingJourneySession
  | ReviewingJourneySession | SavingJourneySession | SavedJourneySession;

export interface CreateJourneySessionInput {
  sessionId: string;
  journeyId: string;
  ownerTabId: number;
  ownerWindowId: number;
  documentToken: string;
  startedAt: string;
  deadlineAt: string;
  includeEnteredValues?: boolean;
}

export interface InitialImageInput {
  id: string;
  observedAt: string;
  elapsedMs: number;
  sourceUrl: string;
  imageId: string;
  image: JourneyDraftImage;
}

export interface NavigationInput {
  epoch: number;
  id: string;
  observedAt: string;
  elapsedMs: number;
  sourceUrl: string;
  toUrl: string;
  causedByStepId?: string;
  previousDocumentToken: string;
  documentToken: string;
  image: DraftImageState;
}

export interface AdoptJourneyDocumentInput {
  epoch: number;
  previousDocumentToken: string;
  documentToken: string;
}

export interface SupersedeJourneyImagesInput {
  epoch: number;
  observedAt: string;
  excludeStepIds?: string[];
}

interface JourneyCaptureResolutionBase {
  epoch: number;
  documentToken: string;
  captureId: string;
}

export type JourneyCaptureResolution =
  | (JourneyCaptureResolutionBase & {
      status: 'retained';
      imageId: string;
      image: JourneyDraftImage;
      sharedNavigationResult?: true;
    })
  | (JourneyCaptureResolutionBase & {
      status: 'unavailable';
      reason: CaptureFailure;
    });

const encoder = new TextEncoder();
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/;
const PNG_DATA_URL_PREFIX = 'data:image/png;base64,';
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const MAX_DATE_MS = 8_640_000_000_000_000;
const REDACTION_FLAGS: readonly string[] = ['sourceUrl', 'captureUrl', 'toUrl'];

function isObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, required: string[], optional: string[], path: string, errors: string[]): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) if (!Object.hasOwn(value, key)) errors.push(`${path}.${key} is required`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) errors.push(`${path}.${key} is not allowed`);
}

function isJsonValue(value: unknown, seen = new Set<object>(), depth = 0): value is JsonValue {
  if (depth > 64) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.every(item => isJsonValue(item, seen, depth + 1));
  if (!isObject(value)) return false;
  return Object.values(value).every(item => isJsonValue(item, seen, depth + 1));
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= JOURNEY_LIMITS.maxIdCharacters && ID_PATTERN.test(value);
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
}

function characters(value: string): number { return Array.from(value).length }
function bytes(value: string): number { return encoder.encode(value).byteLength }

type PngInspection = { ok: true } | { ok: false; reason: 'too-large' | 'capture-error'; detail: string };

function inspectPngDataUrl(dataUrl: string, byteLength: number, width: number, height: number): PngInspection {
  if (!dataUrl.startsWith(PNG_DATA_URL_PREFIX)) return { ok: false, reason: 'capture-error', detail: 'must be a PNG data URL' };
  const payload = dataUrl.slice(PNG_DATA_URL_PREFIX.length);
  const maxPayloadLength = Math.ceil(JOURNEY_LIMITS.maxImageBytes / 3) * 4;
  if (payload.length > maxPayloadLength) return { ok: false, reason: 'too-large', detail: 'exceeds the encoded PNG limit' };
  if (!payload || payload.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(payload)) {
    return { ok: false, reason: 'capture-error', detail: 'must use canonical base64' };
  }
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  const decodedLength = payload.length / 4 * 3 - padding;
  if (decodedLength > JOURNEY_LIMITS.maxImageBytes) return { ok: false, reason: 'too-large', detail: 'exceeds the PNG byte limit' };
  if (decodedLength !== byteLength) return { ok: false, reason: 'capture-error', detail: 'does not match byteLength' };
  let binary: string;
  try { binary = atob(payload); }
  catch { return { ok: false, reason: 'capture-error', detail: 'contains invalid base64' }; }
  if (binary.length !== decodedLength || btoa(binary) !== payload) return { ok: false, reason: 'capture-error', detail: 'must use canonical base64' };
  if (binary.length < 33 || PNG_SIGNATURE.some((value, index) => binary.charCodeAt(index) !== value)) {
    return { ok: false, reason: 'capture-error', detail: 'has an invalid PNG signature' };
  }
  if (readUint32(binary, 8) !== 13 || binary.slice(12, 16) !== 'IHDR') {
    return { ok: false, reason: 'capture-error', detail: 'must begin with a canonical IHDR chunk' };
  }
  if (readUint32(binary, 16) !== width || readUint32(binary, 20) !== height) {
    return { ok: false, reason: 'capture-error', detail: 'IHDR dimensions do not match metadata' };
  }
  return { ok: true };
}

function readUint32(binary: string, offset: number): number {
  return binary.charCodeAt(offset) * 0x1000000 + binary.charCodeAt(offset + 1) * 0x10000
    + binary.charCodeAt(offset + 2) * 0x100 + binary.charCodeAt(offset + 3);
}

function boundedIsoAfter(baseMs: number, deltaMs: number): string {
  return new Date(Math.min(MAX_DATE_MS, baseMs + deltaMs)).toISOString();
}

// An unsaved review is discarded after maxReviewIdleMs without an accepted
// change. Stop, reopen, and every review edit restart the window from their
// own time, so a reviewer who keeps editing never loses the draft.
export function journeyReviewWindow(baseMs: number): { warningAt: string; expiresAt: string } {
  return {
    warningAt: boundedIsoAfter(baseMs, JOURNEY_LIMITS.maxReviewIdleMs - JOURNEY_LIMITS.reviewWarningMs),
    expiresAt: boundedIsoAfter(baseMs, JOURNEY_LIMITS.maxReviewIdleMs),
  };
}

// The reviewing state after an accepted edit, whose draft carries its time.
function editedJourneyReview(state: ReviewingJourneySession, draft: JourneyDraftV1): ReviewingJourneySession {
  return { ...state, ...journeyReviewWindow(Date.parse(draft.updatedAt)), draft };
}

// Limitations are recorded once each and never crowd out earlier ones.
function withLimitation(limitations: string[], limitation: string | undefined): string[] {
  if (!limitation || limitations.includes(limitation) || limitations.length >= JOURNEY_LIMITS.maxLimitations) return limitations;
  return [...limitations, limitation];
}

// Stops that lose recorded information say what is missing.
const STOP_LIMITATIONS: Partial<Record<StopReason, string>> = {
  'session-storage-limit': JOURNEY_LIMITATIONS.sessionStorage,
  'page-access-lost': JOURNEY_LIMITATIONS.pageAccessLost,
  'image-budget': JOURNEY_LIMITATIONS.imageBudget,
  'capture-failed': JOURNEY_LIMITATIONS.captureFailed,
};
// How much longer than the storage stop's limitation another stop's can be.
const STOP_LIMITATION_HEADROOM_BYTES = Math.max(...Object.values(STOP_LIMITATIONS).map(text => bytes(text ?? '')))
  - bytes(JOURNEY_LIMITATIONS.sessionStorage);

function validateUrl(value: unknown, path: string, errors: string[]): string | undefined {
  if (typeof value !== 'string') {
    errors.push(`${path} must be a URL string`);
    return;
  }
  if (bytes(value) > JOURNEY_LIMITS.maxUrlBytes) errors.push(`${path} exceeds the URL limit`);
  try { return stripUrlCredentials(value); }
  catch { errors.push(`${path} must be a complete HTTP(S) URL`); }
}

function validatePoint(value: unknown, path: string, errors: string[]): value is Point {
  if (!isObject(value)) { errors.push(`${path} must be a point`); return false; }
  exactKeys(value, ['x', 'y'], [], path, errors);
  for (const key of ['x', 'y'] as const) if (typeof value[key] !== 'number' || !Number.isFinite(value[key])) errors.push(`${path}.${key} must be finite`);
  return errors.length === 0;
}

function validateViewport(value: unknown, path: string, errors: string[]): value is Viewport {
  if (!isObject(value)) { errors.push(`${path} must be a viewport`); return false; }
  exactKeys(value, ['width', 'height'], [], path, errors);
  for (const key of ['width', 'height'] as const) if (!Number.isInteger(value[key]) || (value[key] as number) <= 0) errors.push(`${path}.${key} must be a positive integer`);
  return errors.length === 0;
}

function validateReviewedText(value: unknown, path: string, errors: string[], url = false): value is ReviewedText {
  if (!isObject(value)) { errors.push(`${path} must be reviewed text`); return false; }
  exactKeys(value, ['text', 'edited', 'redacted'], [], path, errors);
  if (typeof value.text !== 'string') errors.push(`${path}.text must be a string`);
  if (typeof value.edited !== 'boolean') errors.push(`${path}.edited must be a boolean`);
  if (typeof value.redacted !== 'boolean') errors.push(`${path}.redacted must be a boolean`);
  if (value.redacted === true && value.edited !== true) errors.push(`${path}.redacted text must be marked edited`);
  if (url && typeof value.text === 'string') {
    if (value.edited === true) {
      if (bytes(value.text) > JOURNEY_LIMITS.maxUrlBytes) errors.push(`${path}.text exceeds the URL text limit`);
      try { value.text = stripUrlCredentials(value.text); }
      catch { /* Reviewed replacements may be empty or literal redaction text. */ }
    } else {
      const sanitized = validateUrl(value.text, `${path}.text`, errors);
      if (sanitized !== undefined) value.text = sanitized;
    }
  }
  return errors.length === 0;
}

function validateTarget(value: unknown, path: string, errors: string[], reviewed: boolean): boolean {
  if (!isObject(value)) { errors.push(`${path} must be a safe target`); return false; }
  exactKeys(value, ['tag', 'selectorPath', 'label', 'editable', 'viewport', 'scroll'], ['role', 'point'], path, errors);
  if (typeof value.tag !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value.tag)) errors.push(`${path}.tag is invalid`);
  if (value.role !== undefined && (typeof value.role !== 'string' || !value.role.trim() || characters(value.role) > 64)) errors.push(`${path}.role is invalid`);
  if (!Array.isArray(value.selectorPath) || value.selectorPath.length < 1 || value.selectorPath.length > JOURNEY_LIMITS.maxTargetSegments
    || value.selectorPath.some(segment => typeof segment !== 'string' || characters(segment) > JOURNEY_LIMITS.maxSelectorSegmentCharacters
      || !/^[a-z][a-z0-9-]*(?::nth-of-type\([1-9]\d*\))?$/.test(segment))) {
    errors.push(`${path}.selectorPath is invalid`);
  }
  if (reviewed) validateReviewedText(value.label, `${path}.label`, errors);
  else if (typeof value.label !== 'string' || !value.label.trim() || characters(value.label) > JOURNEY_LIMITS.maxTargetTextCharacters) errors.push(`${path}.label is invalid`);
  if (reviewed && isObject(value.label) && typeof value.label.text === 'string' && characters(value.label.text) > JOURNEY_LIMITS.maxTargetTextCharacters) errors.push(`${path}.label.text is too long`);
  if (typeof value.editable !== 'boolean') errors.push(`${path}.editable must be a boolean`);
  validateViewport(value.viewport, `${path}.viewport`, errors);
  validatePoint(value.scroll, `${path}.scroll`, errors);
  if (value.point !== undefined) validatePoint(value.point, `${path}.point`, errors);
  if (isObject(value.viewport) && isObject(value.point)
    && typeof value.viewport.width === 'number' && typeof value.viewport.height === 'number'
    && typeof value.point.x === 'number' && typeof value.point.y === 'number'
    && (value.point.x < 0 || value.point.y < 0 || value.point.x > value.viewport.width || value.point.y > value.viewport.height)) errors.push(`${path}.point lies outside the viewport`);
  return errors.length === 0;
}

function validateFieldValue(value: unknown, path: string, errors: string[], reviewed: boolean): number {
  if (!isObject(value) || typeof value.kind !== 'string') { errors.push(`${path} must be a field value`); return 0; }
  if (value.kind === 'text') {
    exactKeys(value, ['kind', 'value', 'truncated'], ['edited'], path, errors);
    if (value.edited !== undefined && value.edited !== true) errors.push(`${path}.edited must be true when present`);
    if (typeof value.truncated !== 'boolean') errors.push(`${path}.truncated must be a boolean`);
    if (reviewed) {
      validateReviewedText(value.value, `${path}.value`, errors);
      if (isObject(value.value) && typeof value.value.text === 'string') {
        if (characters(value.value.text) > JOURNEY_LIMITS.maxFieldValueCharacters) errors.push(`${path}.value.text is too long`);
        return bytes(value.value.text);
      }
    } else if (typeof value.value === 'string') {
      if (characters(value.value) > JOURNEY_LIMITS.maxFieldValueCharacters) errors.push(`${path}.value is too long`);
      return bytes(value.value);
    } else errors.push(`${path}.value must be a string`);
    return 0;
  }
  if (value.kind === 'selection') {
    exactKeys(value, ['kind', 'values', 'multiple', 'truncated'], ['edited'], path, errors);
    if (value.edited !== undefined && value.edited !== true) errors.push(`${path}.edited must be true when present`);
    if (typeof value.multiple !== 'boolean') errors.push(`${path}.multiple must be a boolean`);
    if (typeof value.truncated !== 'boolean') errors.push(`${path}.truncated must be a boolean`);
    if (!Array.isArray(value.values) || value.values.length > 100) { errors.push(`${path}.values is invalid`); return 0; }
    let total = 0;
    for (const [index, item] of value.values.entries()) {
      if (reviewed) {
        validateReviewedText(item, `${path}.values[${index}]`, errors);
        if (isObject(item) && typeof item.text === 'string') {
          if (characters(item.text) > JOURNEY_LIMITS.maxFieldValueCharacters) errors.push(`${path}.values[${index}].text is too long`);
          total += bytes(item.text);
        }
      } else if (typeof item === 'string') {
        if (characters(item) > JOURNEY_LIMITS.maxFieldValueCharacters) errors.push(`${path}.values[${index}] is too long`);
        total += bytes(item);
      } else errors.push(`${path}.values[${index}] is invalid`);
    }
    return total;
  }
  if (value.kind === 'checked') {
    exactKeys(value, ['kind', 'checked'], ['edited'], path, errors);
    if (value.edited !== undefined && value.edited !== true) errors.push(`${path}.edited must be true when present`);
    if (typeof value.checked !== 'boolean') errors.push(`${path}.checked must be a boolean`);
    return 0;
  }
  errors.push(`${path}.kind is unknown`);
  return 0;
}

function validateImageState(value: unknown, path: string, errors: string[], draft: boolean): void {
  if (!isObject(value) || typeof value.status !== 'string') { errors.push(`${path} must be an image state`); return; }
  if (value.status === 'retained') {
    exactKeys(value, ['status', 'imageId'], ['sharedNavigationResult'], path, errors);
    if (!validId(value.imageId)) errors.push(`${path}.imageId is invalid`);
    if (value.sharedNavigationResult !== undefined && value.sharedNavigationResult !== true) errors.push(`${path}.sharedNavigationResult must be true when present`);
  } else if (value.status === 'removed') exactKeys(value, ['status'], [], path, errors);
  else if (value.status === 'unavailable') {
    exactKeys(value, ['status', 'reason'], [], path, errors);
    if (typeof value.reason !== 'string' || ![
      'superseded', 'navigation-timeout', 'capture-denied', 'protected-page', 'page-document-changed',
      'viewport-changed', 'too-large', 'storage-limit', 'stopped', 'capture-error',
    ].includes(value.reason)) errors.push(`${path}.reason is unknown`);
  } else if (draft && value.status === 'pending') {
    exactKeys(value, ['status', 'captureId'], [], path, errors);
    if (!validId(value.captureId)) errors.push(`${path}.captureId is invalid`);
  } else errors.push(`${path}.status is unknown`);
}

function validateImage(value: unknown, path: string, errors: string[], reviewed: boolean): number {
  if (!isObject(value)) { errors.push(`${path} must be image metadata`); return 0; }
  exactKeys(value, reviewed
    ? ['capturedAt', 'captureUrl', 'width', 'height', 'byteLength', 'viewport', 'scroll', 'redacted']
    : ['capturedAt', 'captureUrl', 'width', 'height', 'byteLength', 'viewport', 'scroll'], reviewed ? [] : ['dataUrl', 'redacted'], path, errors);
  if (!validTimestamp(value.capturedAt)) errors.push(`${path}.capturedAt is invalid`);
  if (reviewed) {
    validateReviewedText(value.captureUrl, `${path}.captureUrl`, errors, true);
    if (typeof value.redacted !== 'boolean') errors.push(`${path}.redacted must be a boolean`);
  } else {
    // A capture URL redacted during review keeps only the marker; the
    // redactions map records it. The pixels are checked either way.
    if (value.captureUrl !== JOURNEY_REDACTED_URL) {
      const sanitized = validateUrl(value.captureUrl, `${path}.captureUrl`, errors);
      if (sanitized !== undefined) value.captureUrl = sanitized;
    }
    if (value.dataUrl !== undefined) {
      if (typeof value.dataUrl !== 'string' || typeof value.byteLength !== 'number'
        || typeof value.width !== 'number' || typeof value.height !== 'number') errors.push(`${path}.dataUrl metadata is invalid`);
      else {
        const inspection = inspectPngDataUrl(value.dataUrl, value.byteLength, value.width, value.height);
        if (!inspection.ok) errors.push(`${path}.dataUrl ${inspection.detail}`);
      }
    }
    if (value.redacted !== undefined && typeof value.redacted !== 'boolean') errors.push(`${path}.redacted must be a boolean`);
  }
  if (!Number.isInteger(value.width) || (value.width as number) <= 0 || (value.width as number) > JOURNEY_LIMITS.maxImageLongestSide) errors.push(`${path}.width is invalid`);
  if (!Number.isInteger(value.height) || (value.height as number) <= 0 || (value.height as number) > JOURNEY_LIMITS.maxImageLongestSide) errors.push(`${path}.height is invalid`);
  if (!Number.isInteger(value.byteLength) || (value.byteLength as number) < 1 || (value.byteLength as number) > JOURNEY_LIMITS.maxImageBytes) errors.push(`${path}.byteLength is invalid`);
  validateViewport(value.viewport, `${path}.viewport`, errors);
  validatePoint(value.scroll, `${path}.scroll`, errors);
  return typeof value.byteLength === 'number' ? value.byteLength : 0;
}

function validateStep(value: unknown, path: string, errors: string[], reviewed: boolean): { imageId?: string; fieldBytes: number } {
  if (!isObject(value) || typeof value.kind !== 'string') { errors.push(`${path} must be a journey step`); return { fieldBytes: 0 }; }
  const base = ['kind', 'id', 'seq', 'observedAt', 'elapsedMs', 'sourceUrl', 'image'];
  if (value.kind === 'initial') exactKeys(value, base, [], path, errors);
  else if (value.kind === 'click') exactKeys(value, [...base, 'target'], [], path, errors);
  else if (value.kind === 'navigation') exactKeys(value, [...base, 'navigation'], [], path, errors);
  else if (value.kind === 'field-change') exactKeys(value, [...base, 'target', 'enteredValue'], [], path, errors);
  else { errors.push(`${path}.kind is unknown`); return { fieldBytes: 0 }; }
  if (!validId(value.id)) errors.push(`${path}.id is invalid`);
  if (!Number.isInteger(value.seq) || (value.seq as number) < 1) errors.push(`${path}.seq must be a positive integer`);
  if (!validTimestamp(value.observedAt)) errors.push(`${path}.observedAt is invalid`);
  if (!Number.isInteger(value.elapsedMs) || (value.elapsedMs as number) < 0 || (value.elapsedMs as number) > JOURNEY_LIMITS.maxDurationMs) errors.push(`${path}.elapsedMs is invalid`);
  if (reviewed) validateReviewedText(value.sourceUrl, `${path}.sourceUrl`, errors, true);
  else if (value.sourceUrl === JOURNEY_REDACTED_URL) {
    // Redacted during review; the redactions map records the marker.
  } else {
    const sanitized = validateUrl(value.sourceUrl, `${path}.sourceUrl`, errors);
    if (sanitized !== undefined) value.sourceUrl = sanitized;
  }
  validateImageState(value.image, `${path}.image`, errors, !reviewed);
  if (value.kind === 'click' || value.kind === 'field-change') validateTarget(value.target, `${path}.target`, errors, reviewed);
  let fieldBytes = 0;
  if (value.kind === 'field-change') fieldBytes = validateFieldValue(value.enteredValue, `${path}.enteredValue`, errors, reviewed);
  if (value.kind === 'navigation') {
    if (!isObject(value.navigation)) errors.push(`${path}.navigation is invalid`);
    else {
      exactKeys(value.navigation, ['toUrl'], ['causedByStepId'], `${path}.navigation`, errors);
      if (reviewed) validateReviewedText(value.navigation.toUrl, `${path}.navigation.toUrl`, errors, true);
      else if (value.navigation.toUrl === JOURNEY_REDACTED_URL) {
        // Redacted during review; the redactions map records the marker.
      } else {
        const sanitized = validateUrl(value.navigation.toUrl, `${path}.navigation.toUrl`, errors);
        if (sanitized !== undefined) value.navigation.toUrl = sanitized;
      }
      if (value.navigation.causedByStepId !== undefined && !validId(value.navigation.causedByStepId)) errors.push(`${path}.navigation.causedByStepId is invalid`);
    }
  }
  return {
    imageId: isObject(value.image) && value.image.status === 'retained' && typeof value.image.imageId === 'string' ? value.image.imageId : undefined,
    fieldBytes,
  };
}

function validateCommon(value: unknown, reviewed: boolean): ValidationResult<JourneyManifestV1 | JourneyDraftV1> {
  const errors: string[] = [];
  if (!isJsonValue(value) || !isObject(value)) return { ok: false, errors: ['journey must be a JSON object'] };
  const copy = cloneJson(value) as Record<string, unknown>;
  const required = ['schemaVersion', 'id', 'revision', 'createdAt', 'updatedAt', 'startedAt', 'includeEnteredValues', 'expected', 'actual', 'steps', 'images', 'limitations'];
  if (reviewed) exactKeys(copy, [...required, 'stoppedAt', 'stopReason'], ['redactions'], 'journey', errors);
  else exactKeys(copy, [...required, 'status'], ['stoppedAt', 'stopReason', 'redactions'], 'journey', errors);
  if (copy.schemaVersion !== 1) errors.push('journey.schemaVersion is unknown');
  if (reviewed) {
    if (Object.hasOwn(copy, 'status')) errors.push('journey.status is not allowed');
  } else if (copy.status !== 'draft') errors.push('journey.status must be draft');
  if (!validId(copy.id)) errors.push('journey.id is invalid');
  if (!Number.isInteger(copy.revision) || (copy.revision as number) < 0) errors.push('journey.revision is invalid');
  for (const key of ['createdAt', 'updatedAt', 'startedAt'] as const) if (!validTimestamp(copy[key])) errors.push(`journey.${key} is invalid`);
  if (copy.stoppedAt !== undefined && !validTimestamp(copy.stoppedAt)) errors.push('journey.stoppedAt is invalid');
  if (validTimestamp(copy.createdAt) && validTimestamp(copy.updatedAt) && Date.parse(copy.updatedAt) < Date.parse(copy.createdAt)) errors.push('journey.updatedAt precedes createdAt');
  if (validTimestamp(copy.createdAt) && validTimestamp(copy.startedAt) && Date.parse(copy.startedAt) < Date.parse(copy.createdAt)) errors.push('journey.startedAt precedes createdAt');
  if (validTimestamp(copy.startedAt) && validTimestamp(copy.updatedAt) && Date.parse(copy.updatedAt) < Date.parse(copy.startedAt)) errors.push('journey.updatedAt precedes startedAt');
  if (validTimestamp(copy.startedAt) && validTimestamp(copy.stoppedAt) && Date.parse(copy.stoppedAt) < Date.parse(copy.startedAt)) errors.push('journey.stoppedAt precedes startedAt');
  if (validTimestamp(copy.stoppedAt) && validTimestamp(copy.updatedAt) && Date.parse(copy.updatedAt) < Date.parse(copy.stoppedAt)) errors.push('journey.updatedAt precedes stoppedAt');
  if (typeof copy.includeEnteredValues !== 'boolean') errors.push('journey.includeEnteredValues must be a boolean');
  if (copy.stopReason !== undefined && (typeof copy.stopReason !== 'string' || !STOP_REASONS.includes(copy.stopReason as StopReason))) errors.push('journey.stopReason is unknown');
  if (reviewed && copy.stopReason === undefined) errors.push('journey.stopReason is required');
  if (!reviewed && (copy.stoppedAt === undefined) !== (copy.stopReason === undefined)) errors.push('draft stoppedAt and stopReason must appear together');
  for (const key of ['expected', 'actual'] as const) {
    if (typeof copy[key] !== 'string' || characters(copy[key]) > JOURNEY_LIMITS.maxSummaryCharacters || (reviewed && !copy[key].trim())) errors.push(`journey.${key} is invalid`);
  }
  if (!Array.isArray(copy.steps) || copy.steps.length > JOURNEY_LIMITS.maxSteps || (reviewed && copy.steps.length < 1)) errors.push('journey.steps has an invalid length');
  const stepIds = new Set<string>();
  const stepKinds = new Map<string, string>();
  const imageRefs = new Map<string, Array<{ index: number; step: Record<string, unknown>; image: Record<string, unknown> }>>();
  const captureIds = new Set<string>();
  let previousSeq = 0;
  let previousElapsed = -1;
  let fieldBytes = 0;
  if (Array.isArray(copy.steps)) for (const [index, step] of copy.steps.entries()) {
    const result = validateStep(step, `journey.steps[${index}]`, errors, reviewed);
    if (isObject(step)) {
      if (typeof step.id === 'string') {
        if (stepIds.has(step.id)) errors.push(`journey.steps[${index}].id is duplicated`);
        stepIds.add(step.id);
        if (typeof step.kind === 'string') stepKinds.set(step.id, step.kind);
      }
      if (typeof step.seq === 'number' && step.seq <= previousSeq) errors.push('journey.steps must have strictly increasing seq values');
      if (typeof step.seq === 'number') previousSeq = step.seq;
      if (typeof step.elapsedMs === 'number' && step.elapsedMs < previousElapsed) errors.push('journey.steps must have nondecreasing elapsedMs values');
      if (typeof step.elapsedMs === 'number') previousElapsed = step.elapsedMs;
      if (step.kind === 'field-change' && copy.includeEnteredValues !== true) errors.push('field-change steps require includeEnteredValues');
      if (step.kind === 'navigation' && isObject(step.navigation) && typeof step.navigation.causedByStepId === 'string') {
        const cause = step.navigation.causedByStepId;
        if (!stepIds.has(cause) || stepKinds.get(cause) !== 'click') errors.push(`journey.steps[${index}].navigation.causedByStepId must reference an earlier click`);
      }
      if (isObject(step.image) && step.image.status === 'pending' && typeof step.image.captureId === 'string') {
        if (captureIds.has(step.image.captureId)) errors.push(`journey.steps[${index}].image.captureId is duplicated`);
        captureIds.add(step.image.captureId);
      }
    }
    if (result.imageId && isObject(step) && isObject(step.image)) {
      const references = imageRefs.get(result.imageId) ?? [];
      references.push({ index, step, image: step.image });
      imageRefs.set(result.imageId, references);
    }
    fieldBytes += result.fieldBytes;
  }
  if (fieldBytes > JOURNEY_LIMITS.maxJourneyFieldTextBytes) errors.push('journey field text exceeds its total limit');
  if (copy.redactions !== undefined) {
    if (!isObject(copy.redactions) || !isObject(copy.redactions.steps)) {
      errors.push('journey.redactions must map step IDs to redacted URL flags');
    } else {
      const stepsById = new Map<string, Record<string, unknown>>();
      if (Array.isArray(copy.steps)) for (const step of copy.steps) {
        if (isObject(step) && typeof step.id === 'string') stepsById.set(step.id, step);
      }
      for (const [stepId, flags] of Object.entries(copy.redactions.steps)) {
        const step = stepsById.get(stepId);
        if (!validId(stepId) || !step) errors.push(`journey.redactions references unknown step ${stepId}`);
        else if (!isObject(flags) || Object.keys(flags).some(key => !REDACTION_FLAGS.includes(key))
          || REDACTION_FLAGS.some(key => flags[key] !== undefined && flags[key] !== true)
          || REDACTION_FLAGS.every(key => flags[key] === undefined)) {
          errors.push(`journey.redactions for step ${stepId} is invalid`);
        } else {
          if (flags.sourceUrl === true && step.sourceUrl !== JOURNEY_REDACTED_URL) {
            errors.push(`journey.redactions for step ${stepId} marks a visible source URL`);
          }
          if (flags.toUrl === true && (step.kind !== 'navigation' || !isObject(step.navigation)
            || step.navigation.toUrl !== JOURNEY_REDACTED_URL)) {
            errors.push(`journey.redactions for step ${stepId} marks a visible destination URL`);
          }
          if (flags.captureUrl === true) {
            const image = step.image;
            const record = isObject(image) && image.status === 'retained' && typeof image.imageId === 'string'
              ? (isObject(copy.images) ? copy.images[image.imageId] : undefined) : undefined;
            if (!isObject(record) || record.captureUrl !== JOURNEY_REDACTED_URL) {
              errors.push(`journey.redactions for step ${stepId} marks a visible capture URL`);
            }
          }
        }
      }
    }
  }
  for (const [imageId, references] of imageRefs) {
    if (references.length === 1) {
      if (references[0].image.sharedNavigationResult === true) errors.push(`retained image ${imageId} has an orphan shared-navigation marker`);
      continue;
    }
    if (references.length !== 2) {
      errors.push(`retained image ${imageId} has too many references`);
      continue;
    }
    const [clickReference, navigationReference] = references;
    const navigation = navigationReference.step.navigation;
    if (clickReference.step.kind !== 'click' || navigationReference.step.kind !== 'navigation'
      || clickReference.image.sharedNavigationResult !== true || navigationReference.image.sharedNavigationResult !== true
      || !isObject(navigation) || navigation.causedByStepId !== clickReference.step.id
      || clickReference.index >= navigationReference.index) {
      errors.push(`retained image ${imageId} is not an explicit correlated click/navigation result`);
    }
  }
  if (!isObject(copy.images)) errors.push('journey.images must be an object');
  let imageBytes = 0;
  if (isObject(copy.images)) for (const [id, image] of Object.entries(copy.images)) {
    if (!validId(id)) errors.push(`journey.images key ${id} is invalid`);
    imageBytes += validateImage(image, `journey.images.${id}`, errors, reviewed);
    if (!imageRefs.has(id)) errors.push(`journey.images.${id} is not referenced`);
  }
  for (const imageId of imageRefs.keys()) if (!isObject(copy.images) || !Object.hasOwn(copy.images, imageId)) errors.push(`retained image ${imageId} is missing`);
  if (imageBytes > JOURNEY_LIMITS.maxJourneyImageBytes) errors.push('journey images exceed the journey budget');
  if (!Array.isArray(copy.limitations) || copy.limitations.length > JOURNEY_LIMITS.maxLimitations
    || copy.limitations.some(item => typeof item !== 'string' || !item.trim() || characters(item) > JOURNEY_LIMITS.maxLimitationCharacters)) errors.push('journey.limitations is invalid');
  const serializedBytes = bytes(JSON.stringify(copy));
  if (reviewed && serializedBytes > JOURNEY_LIMITS.maxReviewedManifestBytes) errors.push('journey manifest exceeds the reviewed manifest limit');
  if (!reviewed && serializedBytes > JOURNEY_LIMITS.maxSessionBytes) errors.push('journey draft exceeds the session limit');
  return errors.length ? { ok: false, errors } : { ok: true, value: copy as unknown as JourneyManifestV1 | JourneyDraftV1 };
}

export function validateJourneyManifest(value: unknown): ValidationResult<JourneyManifestV1> {
  const result = validateCommon(value, true);
  return result.ok ? { ok: true, value: result.value as JourneyManifestV1 } : result;
}

export function validateJourneyDraft(value: unknown): ValidationResult<JourneyDraftV1> {
  const result = validateCommon(value, false);
  return result.ok ? { ok: true, value: result.value as JourneyDraftV1 } : result;
}

export function createJourneySession(input: CreateJourneySessionInput): StartingJourneySession {
  if (!validId(input.sessionId) || !validId(input.journeyId) || !validId(input.documentToken)) throw new TypeError('Journey session IDs are invalid');
  if (!Number.isInteger(input.ownerTabId) || input.ownerTabId < 0 || !Number.isInteger(input.ownerWindowId) || input.ownerWindowId < 0) throw new TypeError('Journey owner IDs are invalid');
  if (!validTimestamp(input.startedAt) || !validTimestamp(input.deadlineAt)
    || Date.parse(input.deadlineAt) <= Date.parse(input.startedAt)
    || Date.parse(input.deadlineAt) - Date.parse(input.startedAt) > JOURNEY_LIMITS.maxDurationMs) throw new TypeError('Journey session timestamps are invalid');
  return {
    phase: 'starting', sessionId: input.sessionId, journeyId: input.journeyId, epoch: 1,
    ownerTabId: input.ownerTabId, ownerWindowId: input.ownerWindowId,
    documentToken: input.documentToken, deadlineAt: input.deadlineAt,
    draft: {
      schemaVersion: 1, status: 'draft', id: input.journeyId, revision: 0,
      createdAt: input.startedAt, updatedAt: input.startedAt, startedAt: input.startedAt,
      includeEnteredValues: input.includeEnteredValues ?? false,
      expected: '', actual: '', steps: [], images: {}, limitations: [],
    },
  };
}

export function acceptInitialImage(state: JourneySession, input: InitialImageInput): JourneySession {
  if (state.phase !== 'starting' || !validId(input.id) || !validId(input.imageId) || !validTimestamp(input.observedAt)
    || !Number.isInteger(input.elapsedMs) || input.elapsedMs < 0 || input.elapsedMs >= JOURNEY_LIMITS.maxDurationMs) return state;
  const sourceUrl = safeUrl(input.sourceUrl);
  const image = cloneJson(input.image);
  const captureUrl = safeUrl(image.captureUrl);
  const startedMs = Date.parse(state.draft.startedAt);
  const deadlineMs = Date.parse(state.deadlineAt);
  const observedMs = Date.parse(input.observedAt);
  const capturedMs = Date.parse(image.capturedAt);
  if (!sourceUrl || !captureUrl || sourceUrl !== captureUrl
    || !Number.isFinite(capturedMs)
    || observedMs < startedMs || observedMs >= deadlineMs
    || capturedMs < startedMs || capturedMs >= deadlineMs) return state;
  image.captureUrl = captureUrl;
  const errors: string[] = [];
  validateImage(image, 'initial.image', errors, false);
  if (errors.length || typeof image.dataUrl !== 'string') return state;
  const draft: JourneyDraftV1 = {
    ...state.draft,
    updatedAt: Date.parse(input.observedAt) > Date.parse(state.draft.updatedAt) ? input.observedAt : state.draft.updatedAt,
    steps: [{
      kind: 'initial', id: input.id, seq: 1, observedAt: input.observedAt,
      elapsedMs: input.elapsedMs, sourceUrl, image: { status: 'retained', imageId: input.imageId },
    }],
    images: { [input.imageId]: image },
  };
  const recording: RecordingJourneySession = {
    ...state,
    phase: 'recording',
    documentCounters: { [state.documentToken]: 0 },
    draft,
  };
  return recordingSessionFits(recording) ? recording : state;
}

export function failInitialImage(state: JourneySession): JourneySession {
  return state.phase === 'starting' ? { phase: 'idle', epoch: state.epoch + 1 } : state;
}

function safeUrl(value: string): string | undefined {
  try {
    if (bytes(value) > JOURNEY_LIMITS.maxUrlBytes) return;
    return stripUrlCredentials(value);
  } catch { return; }
}

function draftStep(event: JourneyInputEvent, seq: number): JourneyDraftStep {
  const base = {
    id: event.id, seq, observedAt: event.observedAt, elapsedMs: event.elapsedMs,
    sourceUrl: stripUrlCredentials(event.sourceUrl), image: cloneJson(event.image),
  };
  if (event.kind === 'click') return { ...base, kind: 'click', target: cloneJson(event.target) };
  return { ...base, kind: 'field-change', target: cloneJson(event.target), enteredValue: cloneJson(event.enteredValue) };
}

function fieldTextBytes(value: DraftFieldValue): number {
  if (value.kind === 'text') return bytes(value.value);
  if (value.kind === 'selection') return value.values.reduce((sum, item) => sum + bytes(item), 0);
  return 0;
}

function draftFieldTextBytes(steps: JourneyDraftStep[]): number {
  let total = 0;
  for (const step of steps) if (step.kind === 'field-change') total += fieldTextBytes(step.enteredValue);
  return total;
}

// The longest run of whole characters from the start of `value` that fits in
// `budget` UTF-8 bytes.
function utf8Prefix(value: string, budget: number): string {
  let used = 0;
  let end = 0;
  for (const character of value) {
    const code = character.codePointAt(0)!;
    const size = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (used + size > budget) break;
    used += size;
    end += character.length;
  }
  return value.slice(0, end);
}

function truncatedValue(value: DraftFieldValue): boolean {
  return value.kind !== 'checked' && value.truncated;
}

// Entered text shares one budget per journey. A value that no longer fits
// keeps what does and is marked truncated, so the action that carried it is
// still recorded and no step claims a complete value it does not have.
// `truncated` also reports values the page already shortened to the
// per-field limit: the draft says so either way.
function fitFieldTextBudget(
  steps: JourneyDraftStep[],
  events: JourneyInputEvent[],
): { events: JourneyInputEvent[]; truncated: boolean } {
  let remaining = Math.max(0, JOURNEY_LIMITS.maxJourneyFieldTextBytes - draftFieldTextBytes(steps));
  let truncated = false;
  const fitted = events.map((event): JourneyInputEvent => {
    if (event.kind !== 'field-change') return event;
    const value = event.enteredValue;
    const size = fieldTextBytes(value);
    if (size <= remaining) {
      remaining -= size;
      if (truncatedValue(value)) truncated = true;
      return event;
    }
    truncated = true;
    if (value.kind === 'text') {
      const text = utf8Prefix(value.value, remaining);
      remaining -= bytes(text);
      return { ...event, enteredValue: { ...value, value: text, truncated: true } };
    }
    if (value.kind !== 'selection') return event;
    const values: string[] = [];
    for (const item of value.values) {
      const itemBytes = bytes(item);
      if (itemBytes > remaining) break;
      values.push(item);
      remaining -= itemBytes;
    }
    return { ...event, enteredValue: { ...value, values, truncated: true } };
  });
  return { events: fitted, truncated };
}

export function acceptJourneyEventBatch(state: JourneySession, input: JourneyEventBatchV1): JourneySession {
  if (state.phase !== 'recording') return state;
  const validated = validateJourneyEventBatch(input);
  if (!validated.ok) return state;
  const batch = validated.value;
  if (batch.sessionId !== state.sessionId || batch.epoch !== state.epoch || batch.documentToken !== state.documentToken) return state;
  if (batch.localCounter <= (state.documentCounters[batch.documentToken] ?? 0)) return state;
  const lastEvent = batch.events.at(-1)!;
  if (Date.parse(lastEvent.observedAt) >= Date.parse(state.deadlineAt)) {
    return stopJourney(state, { epoch: state.epoch, stoppedAt: lastEvent.observedAt, reason: 'duration-limit' });
  }
  if (!state.draft.includeEnteredValues && batch.events.some(event => event.kind === 'field-change')) return state;
  const existingIds = new Set(state.draft.steps.map(step => step.id));
  if (batch.events.some(event => existingIds.has(event.id))) return state;
  const pendingCaptureIds = new Set(state.draft.steps.flatMap(step => step.image.status === 'pending' ? [step.image.captureId] : []));
  if (batch.events.some(event => event.image.status === 'pending' && pendingCaptureIds.has(event.image.captureId))) return state;
  let elapsed = state.draft.steps.at(-1)?.elapsedMs ?? -1;
  for (const event of batch.events) {
    if (event.elapsedMs < elapsed) return state;
    elapsed = event.elapsedMs;
  }
  const remaining = JOURNEY_LIMITS.maxSteps - state.draft.steps.length;
  if (remaining <= 0) return stopJourney(state, { epoch: state.epoch, stoppedAt: state.draft.updatedAt, reason: 'step-limit' });
  const fitted = fitFieldTextBudget(state.draft.steps, batch.events.slice(0, remaining));
  const lastSeq = state.draft.steps.at(-1)?.seq ?? 0;
  const steps = fitted.events.map((event, index) => draftStep(event, lastSeq + index + 1));
  const lastObservedAt = steps.at(-1)?.observedAt ?? state.draft.updatedAt;
  const updatedAt = Date.parse(lastObservedAt) > Date.parse(state.draft.updatedAt) ? lastObservedAt : state.draft.updatedAt;
  const limitations = fitted.truncated
    ? withLimitation(state.draft.limitations, JOURNEY_LIMITATIONS.enteredValuesTruncated)
    : state.draft.limitations;
  const next: RecordingJourneySession = {
    ...state,
    documentCounters: { ...state.documentCounters, [batch.documentToken]: batch.localCounter },
    draft: { ...state.draft, updatedAt, steps: [...state.draft.steps, ...steps], limitations },
  };
  if (!recordingSessionFits(next)) {
    return stopJourney(state, {
      epoch: state.epoch,
      stoppedAt: chronologicalTimestamp(state, lastObservedAt),
      reason: 'session-storage-limit',
    });
  }
  return next.draft.steps.length >= JOURNEY_LIMITS.maxSteps
    ? stopJourney(next, { epoch: next.epoch, stoppedAt: updatedAt, reason: 'step-limit' })
    : next;
}

export function acceptLateJourneyEventBatch(state: JourneySession, input: JourneyEventBatchV1): JourneySession {
  if (state.phase !== 'recording') return state;
  const validated = validateJourneyEventBatch(input);
  if (!validated.ok) return state;
  const batch = validated.value;
  if (batch.sessionId !== state.sessionId || batch.epoch !== state.epoch || batch.documentToken !== state.documentToken) return state;
  if (batch.localCounter <= (state.documentCounters[batch.documentToken] ?? 0)) return state;
  if (batch.events.length === 0) return state;
  const batchUrl = safeUrl(batch.events[0].sourceUrl);
  if (!batchUrl || batch.events.some(event => safeUrl(event.sourceUrl) !== batchUrl)) return state;
  const trailing = state.draft.steps.at(-1);
  if (!trailing || trailing.kind !== 'navigation' || safeUrl(trailing.sourceUrl) !== batchUrl) return state;
  const navigatedAt = Date.parse(trailing.observedAt);
  if (batch.events.some(event => Date.parse(event.observedAt) > navigatedAt)) return state;
  const lastEvent = batch.events.at(-1)!;
  if (Date.parse(lastEvent.observedAt) >= Date.parse(state.deadlineAt)) {
    return stopJourney(state, { epoch: state.epoch, stoppedAt: lastEvent.observedAt, reason: 'duration-limit' });
  }
  if (!state.draft.includeEnteredValues && batch.events.some(event => event.kind === 'field-change')) return state;
  const existingIds = new Set(state.draft.steps.map(step => step.id));
  if (batch.events.some(event => existingIds.has(event.id))) return state;
  const predecessor = state.draft.steps.at(-2);
  let elapsed = predecessor?.elapsedMs ?? -1;
  for (const event of batch.events) {
    if (event.elapsedMs < elapsed || event.elapsedMs > trailing.elapsedMs) return state;
    elapsed = event.elapsedMs;
  }
  const remaining = JOURNEY_LIMITS.maxSteps - state.draft.steps.length;
  if (remaining <= 0) return stopJourney(state, { epoch: state.epoch, stoppedAt: state.draft.updatedAt, reason: 'step-limit' });
  const fitted = fitFieldTextBudget(state.draft.steps, batch.events.slice(0, remaining));
  const baseSeq = predecessor?.seq ?? 0;
  const steps = fitted.events.map((event, index) => ({
    ...draftStep(event, baseSeq + index + 1),
    image: { status: 'unavailable', reason: 'superseded' } as const,
  }));
  const next: RecordingJourneySession = {
    ...state,
    documentCounters: { ...state.documentCounters, [batch.documentToken]: batch.localCounter },
    draft: {
      ...state.draft,
      steps: [...state.draft.steps.slice(0, -1), ...steps, { ...trailing, seq: baseSeq + steps.length + 1 }],
      limitations: fitted.truncated
        ? withLimitation(state.draft.limitations, JOURNEY_LIMITATIONS.enteredValuesTruncated)
        : state.draft.limitations,
    },
  };
  if (!recordingSessionFits(next)) {
    return stopJourney(state, {
      epoch: state.epoch,
      stoppedAt: chronologicalTimestamp(state, lastEvent.observedAt),
      reason: 'session-storage-limit',
    });
  }
  return next.draft.steps.length >= JOURNEY_LIMITS.maxSteps
    ? stopJourney(next, { epoch: next.epoch, stoppedAt: state.draft.updatedAt, reason: 'step-limit' })
    : next;
}

export interface JourneySummaryInput {
  epoch: number;
  journeyId: string;
  revision: number;
  updatedAt: string;
  expected: string;
  actual: string;
}

export function updateJourneySummary(state: JourneySession, input: JourneySummaryInput): JourneySession {
  if (state.phase !== 'reviewing' || input.epoch !== state.epoch || input.journeyId !== state.journeyId
    || input.journeyId !== state.draft.id || input.revision !== state.draft.revision
    || typeof input.expected !== 'string' || typeof input.actual !== 'string'
    || characters(input.expected) > JOURNEY_LIMITS.maxSummaryCharacters
    || characters(input.actual) > JOURNEY_LIMITS.maxSummaryCharacters
    || !Number.isSafeInteger(state.draft.revision) || state.draft.revision >= Number.MAX_SAFE_INTEGER
    || !validTimestamp(input.updatedAt)) return state;
  const updateMs = Date.parse(input.updatedAt);
  if (updateMs < Date.parse(state.draft.updatedAt) || updateMs >= Date.parse(state.expiresAt)) return state;
  const expected = input.expected.trim();
  const actual = input.actual.trim();
  const draft = {
    ...state.draft, expected, actual, revision: state.draft.revision + 1, updatedAt: input.updatedAt,
  };
  if (validateJourneyDraft(draft).ok === false) return state;
  return editedJourneyReview(state, draft);
}

export interface JourneyRemoveStepInput {
  epoch: number;
  journeyId: string;
  revision: number;
  updatedAt: string;
  stepId: string;
}

export function removeJourneyStep(state: JourneySession, input: JourneyRemoveStepInput): JourneySession {
  if (state.phase !== 'reviewing' || input.epoch !== state.epoch || input.journeyId !== state.journeyId
    || input.journeyId !== state.draft.id || input.revision !== state.draft.revision
    || !validId(input.stepId)
    || !Number.isSafeInteger(state.draft.revision) || state.draft.revision >= Number.MAX_SAFE_INTEGER
    || !validTimestamp(input.updatedAt)) return state;
  const updateMs = Date.parse(input.updatedAt);
  if (updateMs < Date.parse(state.draft.updatedAt) || updateMs >= Date.parse(state.expiresAt)) return state;
  const index = state.draft.steps.findIndex(step => step.id === input.stepId);
  if (index < 0 || state.draft.steps.length <= 1) return state;
  const remaining = state.draft.steps.filter(step => step.id !== input.stepId);
  const references = new Map<string, number>();
  for (const step of remaining) {
    if (step.image.status === 'retained') references.set(step.image.imageId, (references.get(step.image.imageId) ?? 0) + 1);
  }
  // A removed click takes its causal link along, and a shared result image
  // left with one step is no longer a shared click/navigation result.
  const steps = remaining.map(step => {
    let next = step;
    if (next.kind === 'navigation' && next.navigation.causedByStepId === input.stepId) {
      next = { ...next, navigation: { toUrl: next.navigation.toUrl } };
    }
    if (next.image.status === 'retained' && next.image.sharedNavigationResult && references.get(next.image.imageId) === 1) {
      next = { ...next, image: { status: 'retained', imageId: next.image.imageId } };
    }
    return next;
  });
  const images = Object.fromEntries(Object.entries(state.draft.images)
    .filter(([imageId]) => references.has(imageId)));
  const draft = pruneTruncationLimitation(pruneJourneyRedactions({
    ...state.draft, steps, images, revision: state.draft.revision + 1, updatedAt: input.updatedAt,
  }));
  if (validateJourneyDraft(draft).ok === false) return state;
  return editedJourneyReview(state, draft);
}

// The truncation limitation describes values still marked truncated. Once
// the reviewer removes or rewrites every one, it no longer applies.
function pruneTruncationLimitation(draft: JourneyDraftV1): JourneyDraftV1 {
  const limitation = JOURNEY_LIMITATIONS.enteredValuesTruncated;
  if (!draft.limitations.includes(limitation)
    || draft.steps.some(step => step.kind === 'field-change' && truncatedValue(step.enteredValue))) return draft;
  return { ...draft, limitations: draft.limitations.filter(item => item !== limitation) };
}

// Redaction flags describe markers still in the draft. Removing a step or a
// screenshot removes the markers it carried, so its flags go with it;
// otherwise validation would reject, and silently undo, the removal.
export function pruneJourneyRedactions(draft: JourneyDraftV1): JourneyDraftV1 {
  if (!draft.redactions) return draft;
  const steps: JourneyUrlRedactions['steps'] = {};
  for (const step of draft.steps) {
    const flags = draft.redactions.steps[step.id];
    if (!flags) continue;
    const kept: JourneyUrlRedactions['steps'][string] = {};
    if (flags.sourceUrl && step.sourceUrl === JOURNEY_REDACTED_URL) kept.sourceUrl = true;
    if (flags.captureUrl && step.image.status === 'retained'
      && draft.images[step.image.imageId]?.captureUrl === JOURNEY_REDACTED_URL) kept.captureUrl = true;
    if (flags.toUrl && step.kind === 'navigation' && step.navigation.toUrl === JOURNEY_REDACTED_URL) kept.toUrl = true;
    if (Object.keys(kept).length > 0) steps[step.id] = kept;
  }
  const { redactions: _pruned, ...rest } = draft;
  return Object.keys(steps).length > 0 ? { ...rest, redactions: { steps } } : rest;
}

export interface JourneyReopenInput {
  sessionId: string;
  ownerTabId: number;
  ownerWindowId: number;
  nowMs: number;
  draft: JourneyDraftV1;
  images: Record<string, JourneyDraftImage>;
}

export function reopenJourneySnapshot(
  state: JourneySession,
  input: JourneyReopenInput,
): JourneySession | undefined {
  if (state.phase !== 'idle' && state.phase !== 'saved') return state;
  if (!validId(input.sessionId) || !Number.isSafeInteger(input.ownerTabId) || input.ownerTabId < 0
    || !Number.isSafeInteger(input.ownerWindowId) || input.ownerWindowId < 0
    || !Number.isFinite(input.nowMs)) return state;
  if (validateJourneyDraft(input.draft).ok === false) return state;
  const source = input.draft;
  const images: Record<string, JourneyDraftImage> = {};
  for (const step of source.steps) {
    if (step.image.status !== 'retained') continue;
    const record = input.images[step.image.imageId];
    if (!isObject(record) || typeof record.dataUrl !== 'string') return state;
    images[step.image.imageId] = { ...record } as JourneyDraftImage;
  }
  const { warningAt, expiresAt } = journeyReviewWindow(input.nowMs);
  const updatedAt = new Date(Math.min(input.nowMs, MAX_DATE_MS)).toISOString();
  const draft = {
    ...input.draft,
    updatedAt,
    images,
  };
  if (validateJourneyDraft(draft).ok === false) return state;
  const next: ReviewingJourneySession = {
    phase: 'reviewing',
    sessionId: input.sessionId,
    journeyId: draft.id,
    epoch: 1,
    ownerTabId: input.ownerTabId,
    ownerWindowId: input.ownerWindowId,
    warningAt,
    expiresAt,
    draft,
  };
  if (input.nowMs >= MAX_DATE_MS - JOURNEY_LIMITS.maxReviewIdleMs
    || bytes(JSON.stringify(next)) > JOURNEY_LIMITS.maxSessionBytes - JOURNEY_LIMITS.sessionMetadataReserveBytes) {
    return undefined;
  }
  return next;
}

// A save that never finished returns to review. Saving refuses edits, so the
// draft is the reviewed one; its idle window restarts from its last edit.
export function resumeSavingReview(state: SavingJourneySession): ReviewingJourneySession {
  return { ...state, phase: 'reviewing', ...journeyReviewWindow(Date.parse(state.draft.updatedAt)) };
}

export type ReviewBlockReason = 'summaries-required' | 'retained-step-required' | 'images-pending' | 'invalid-draft';

export function reviewSaveGating(state: JourneySession): { ready: boolean; reasons: ReviewBlockReason[] } {
  if (state.phase !== 'reviewing') return { ready: false, reasons: ['invalid-draft'] };
  const reasons: ReviewBlockReason[] = [];
  const summary = (value: string) => value.trim();
  if (!summary(state.draft.expected) || !summary(state.draft.actual)
    || characters(state.draft.expected) > JOURNEY_LIMITS.maxSummaryCharacters
    || characters(state.draft.actual) > JOURNEY_LIMITS.maxSummaryCharacters) {
    reasons.push('summaries-required');
  }
  if (!state.draft.steps.some(step => step.image.status === 'retained')) reasons.push('retained-step-required');
  if (state.draft.steps.some(step => step.image.status === 'pending')) reasons.push('images-pending');
  if (reasons.length === 0 && validateJourneyDraft(state.draft).ok === false) reasons.push('invalid-draft');
  return { ready: reasons.length === 0, reasons };
}

export interface JourneyReviewEdit {
  epoch: number;
  journeyId: string;
  revision: number;
  updatedAt: string;
}

function reviewEditGuard(
  state: JourneySession,
  input: JourneyReviewEdit,
): ReviewingJourneySession | undefined {
  if (state.phase !== 'reviewing' || input.epoch !== state.epoch || input.journeyId !== state.journeyId
    || input.journeyId !== state.draft.id || input.revision !== state.draft.revision
    || !Number.isSafeInteger(state.draft.revision) || state.draft.revision >= Number.MAX_SAFE_INTEGER
    || !validTimestamp(input.updatedAt)) return undefined;
  const updateMs = Date.parse(input.updatedAt);
  if (updateMs < Date.parse(state.draft.updatedAt) || updateMs >= Date.parse(state.expiresAt)) return undefined;
  return state;
}

function sanitizeFieldValue(value: unknown): DraftFieldValue | undefined {
  if (!isObject(value) || typeof value.kind !== 'string') return undefined;
  if (value.kind === 'text') {
    if (typeof value.value !== 'string' || typeof value.truncated !== 'boolean'
      || characters(value.value) > JOURNEY_LIMITS.maxFieldValueCharacters) return undefined;
    return { kind: 'text', value: value.value, truncated: value.truncated, edited: true };
  }
  if (value.kind === 'selection') {
    if (!Array.isArray(value.values) || value.values.length > 100 || typeof value.multiple !== 'boolean'
      || typeof value.truncated !== 'boolean'
      || value.values.some(item => typeof item !== 'string' || characters(item) > JOURNEY_LIMITS.maxFieldValueCharacters)) {
      return undefined;
    }
    return { kind: 'selection', values: [...value.values], multiple: value.multiple, truncated: value.truncated, edited: true };
  }
  if (value.kind === 'checked') {
    if (typeof value.checked !== 'boolean') return undefined;
    return { kind: 'checked', checked: value.checked, edited: true };
  }
  return undefined;
}

export interface JourneyEditValueInput extends JourneyReviewEdit {
  stepId: string;
  value: unknown;
}

export function editJourneyValue(state: JourneySession, input: JourneyEditValueInput): JourneySession {
  const reviewing = reviewEditGuard(state, input);
  if (!reviewing || !validId(input.stepId)) return state;
  const step = reviewing.draft.steps.find(candidate => candidate.id === input.stepId);
  if (!step || step.kind !== 'field-change') return state;
  const enteredValue = sanitizeFieldValue(input.value);
  if (!enteredValue) return state;
  const steps = reviewing.draft.steps.map(candidate => candidate.id === input.stepId
    ? { ...candidate, target: candidate.target, enteredValue } as JourneyDraftStep
    : candidate);
  const draft = pruneTruncationLimitation({
    ...reviewing.draft, steps, revision: reviewing.draft.revision + 1, updatedAt: input.updatedAt,
  });
  if (validateJourneyDraft(draft).ok === false) return state;
  return editedJourneyReview(reviewing, draft);
}

export interface JourneyRedactUrlInput extends JourneyReviewEdit {
  stepId: string;
  url: JourneyUrlRedactionTarget;
}

export function redactJourneyUrl(state: JourneySession, input: JourneyRedactUrlInput): JourneySession {
  const reviewing = reviewEditGuard(state, input);
  if (!reviewing || !validId(input.stepId)
    || (input.url !== 'source' && input.url !== 'capture' && input.url !== 'destination')) return state;
  const step = reviewing.draft.steps.find(candidate => candidate.id === input.stepId);
  if (!step) return state;
  let redacted: Pick<JourneyDraftV1, 'steps' | 'images'>;
  let flag: keyof JourneyUrlRedactions['steps'][string];
  const replaceStep = (next: JourneyDraftStep) => reviewing.draft.steps.map(candidate => candidate.id === input.stepId ? next : candidate);
  if (input.url === 'source') {
    if (step.sourceUrl === JOURNEY_REDACTED_URL) return state;
    redacted = { steps: replaceStep({ ...step, sourceUrl: JOURNEY_REDACTED_URL }), images: reviewing.draft.images };
    flag = 'sourceUrl';
  } else if (input.url === 'destination') {
    if (step.kind !== 'navigation' || step.navigation.toUrl === JOURNEY_REDACTED_URL) return state;
    redacted = {
      steps: replaceStep({ ...step, navigation: { ...step.navigation, toUrl: JOURNEY_REDACTED_URL } }),
      images: reviewing.draft.images,
    };
    flag = 'toUrl';
  } else {
    if (step.image.status !== 'retained') return state;
    const record = reviewing.draft.images[step.image.imageId];
    if (!record || record.captureUrl === JOURNEY_REDACTED_URL) return state;
    redacted = {
      steps: reviewing.draft.steps,
      images: { ...reviewing.draft.images, [step.image.imageId]: { ...record, captureUrl: JOURNEY_REDACTED_URL } },
    };
    flag = 'captureUrl';
  }
  const redactions = reviewing.draft.redactions ?? { steps: {} };
  const draft = {
    ...reviewing.draft, ...redacted,
    redactions: { steps: { ...redactions.steps, [input.stepId]: { ...redactions.steps[input.stepId], [flag]: true as const } } },
    revision: reviewing.draft.revision + 1, updatedAt: input.updatedAt,
  };
  if (validateJourneyDraft(draft).ok === false) return state;
  return editedJourneyReview(reviewing, draft);
}

export function commitJourneyNavigation(state: JourneySession, input: NavigationInput): JourneySession {
  if (state.phase !== 'recording' || input.epoch !== state.epoch || input.previousDocumentToken !== state.documentToken
    || !validId(input.documentToken) || !validId(input.id) || state.draft.steps.some(step => step.id === input.id)
    || !validTimestamp(input.observedAt) || !Number.isInteger(input.elapsedMs) || input.elapsedMs < (state.draft.steps.at(-1)?.elapsedMs ?? 0)
    || input.elapsedMs > JOURNEY_LIMITS.maxDurationMs) return state;
  if (Date.parse(input.observedAt) >= Date.parse(state.deadlineAt)) {
    return stopJourney(state, { epoch: state.epoch, stoppedAt: input.observedAt, reason: 'duration-limit' });
  }
  const sourceUrl = safeUrl(input.sourceUrl);
  const toUrl = safeUrl(input.toUrl);
  const imageErrors: string[] = [];
  validateImageState(input.image, 'navigation.image', imageErrors, true);
  if (!sourceUrl || !toUrl || imageErrors.length) return state;
  if (input.image.status === 'removed' || (input.image.status === 'retained' && !Object.hasOwn(state.draft.images, input.image.imageId))) return state;
  if (input.image.status === 'pending') {
    const captureId = input.image.captureId;
    if (state.draft.steps.some(step => step.image.status === 'pending' && step.image.captureId === captureId)) return state;
  }
  if (input.causedByStepId && !state.draft.steps.some(step => step.id === input.causedByStepId && step.kind === 'click')) return state;
  const step: JourneyDraftStep = {
    kind: 'navigation', id: input.id, seq: (state.draft.steps.at(-1)?.seq ?? 0) + 1,
    observedAt: input.observedAt, elapsedMs: input.elapsedMs, sourceUrl,
    navigation: { toUrl, ...(input.causedByStepId ? { causedByStepId: input.causedByStepId } : {}) },
    image: cloneJson(input.image),
  };
  const next: RecordingJourneySession = {
    ...state, documentToken: input.documentToken,
    draft: {
      ...state.draft,
      updatedAt: Date.parse(input.observedAt) > Date.parse(state.draft.updatedAt) ? input.observedAt : state.draft.updatedAt,
      steps: [...state.draft.steps, step],
    },
  };
  if (!recordingSessionFits(next)) {
    return stopJourney(state, {
      epoch: state.epoch,
      stoppedAt: chronologicalTimestamp(state, input.observedAt),
      reason: 'session-storage-limit',
    });
  }
  return next.draft.steps.length >= JOURNEY_LIMITS.maxSteps
    ? stopJourney(next, { epoch: next.epoch, stoppedAt: input.observedAt, reason: 'step-limit' })
    : next;
}

export function adoptJourneyDocument(state: JourneySession, input: AdoptJourneyDocumentInput): JourneySession {
  if (state.phase !== 'recording' || input.epoch !== state.epoch
    || input.previousDocumentToken !== state.documentToken || !validId(input.documentToken)
    || input.documentToken === input.previousDocumentToken
    || Object.hasOwn(state.documentCounters, input.documentToken)) return state;
  const next: RecordingJourneySession = {
    ...state,
    documentToken: input.documentToken,
    documentCounters: { ...state.documentCounters, [input.documentToken]: 0 },
  };
  return recordingSessionFits(next) ? next : state;
}

export function supersedeJourneyImagesAfter(state: JourneySession, input: SupersedeJourneyImagesInput): JourneySession {
  if (state.phase !== 'recording' || input.epoch !== state.epoch || !validTimestamp(input.observedAt)) return state;
  const excluded = input.excludeStepIds ?? [];
  if (!Array.isArray(excluded) || excluded.length > JOURNEY_LIMITS.maxSteps
    || excluded.some(id => !validId(id)) || new Set(excluded).size !== excluded.length) return state;
  const excludedIds = new Set(excluded);
  const observedMs = Date.parse(input.observedAt);
  let changed = false;
  const steps = state.draft.steps.map(step => {
    if (excludedIds.has(step.id) || step.image.status !== 'retained') return step;
    const image = state.draft.images[step.image.imageId];
    if (!image || Date.parse(image.capturedAt) < observedMs) return step;
    changed = true;
    return { ...step, image: { status: 'unavailable', reason: 'superseded' } as const };
  }) as JourneyDraftStep[];
  if (!changed) return state;
  const referencedImageIds = new Set(steps.flatMap(step => step.image.status === 'retained' ? [step.image.imageId] : []));
  const images = Object.fromEntries(Object.entries(state.draft.images)
    .filter(([imageId]) => referencedImageIds.has(imageId)));
  return { ...state, draft: { ...state.draft, steps, images } };
}

export function resolveJourneyCapture(state: JourneySession, input: JourneyCaptureResolution): JourneySession {
  if (state.phase !== 'recording' || input.epoch !== state.epoch || input.documentToken !== state.documentToken || !validId(input.captureId)) return state;
  const matches = state.draft.steps.filter(step => step.image.status === 'pending' && step.image.captureId === input.captureId);
  if (matches.length !== 1) return state;
  if (input.status === 'unavailable') {
    if (!['superseded', 'navigation-timeout', 'capture-denied', 'protected-page', 'page-document-changed',
      'viewport-changed', 'too-large', 'storage-limit', 'stopped', 'capture-error'].includes(input.reason)) return state;
    const steps = state.draft.steps.map(step => step.image.status === 'pending' && step.image.captureId === input.captureId
      ? { ...step, image: { status: 'unavailable', reason: input.reason } as const }
      : step) as JourneyDraftStep[];
    return { ...state, draft: { ...state.draft, steps } };
  }
  if (Date.parse(input.image.capturedAt) >= Date.parse(state.deadlineAt)) {
    return stopJourney(state, { epoch: state.epoch, stoppedAt: input.image.capturedAt, reason: 'duration-limit' });
  }
  if (!validId(input.imageId) || Object.hasOwn(state.draft.images, input.imageId)) return state;
  const image = cloneJson(input.image);
  const captureUrl = safeUrl(image.captureUrl);
  if (!captureUrl) return state;
  image.captureUrl = captureUrl;
  const tooLarge = !Number.isInteger(image.width) || !Number.isInteger(image.height) || !Number.isInteger(image.byteLength)
    || image.width > JOURNEY_LIMITS.maxImageLongestSide || image.height > JOURNEY_LIMITS.maxImageLongestSide
    || image.byteLength > JOURNEY_LIMITS.maxImageBytes;
  if (tooLarge) return resolveJourneyCapture(state, { ...input, status: 'unavailable', reason: 'too-large' });
  if (image.dataUrl !== undefined) {
    if (typeof image.dataUrl !== 'string') {
      return resolveJourneyCapture(state, { ...input, status: 'unavailable', reason: 'capture-error' });
    }
    const inspection = inspectPngDataUrl(image.dataUrl, image.byteLength, image.width, image.height);
    if (!inspection.ok) return resolveJourneyCapture(state, { ...input, status: 'unavailable', reason: inspection.reason });
  } else {
    return resolveJourneyCapture(state, { ...input, status: 'unavailable', reason: 'capture-error' });
  }
  const errors: string[] = [];
  validateImage(image, 'capture.image', errors, false);
  if (errors.length) return resolveJourneyCapture(state, { ...input, status: 'unavailable', reason: 'capture-error' });
  const steps = state.draft.steps.map(step => step.image.status === 'pending' && step.image.captureId === input.captureId
    ? { ...step, image: { status: 'retained', imageId: input.imageId, ...(input.sharedNavigationResult ? { sharedNavigationResult: true as const } : {}) } }
    : step) as JourneyDraftStep[];
  const currentImageBytes = Object.values(state.draft.images).reduce((total, item) => total + item.byteLength, 0);
  if (currentImageBytes + image.byteLength > JOURNEY_LIMITS.maxJourneyImageBytes) {
    const unavailable = resolveJourneyCapture(state, { ...input, status: 'unavailable', reason: 'storage-limit' });
    return stopJourney(unavailable, { epoch: state.epoch, stoppedAt: image.capturedAt, reason: 'image-budget' });
  }
  const draft: JourneyDraftV1 = {
    ...state.draft,
    updatedAt: Date.parse(image.capturedAt) > Date.parse(state.draft.updatedAt) ? image.capturedAt : state.draft.updatedAt,
    steps,
    images: { ...state.draft.images, [input.imageId]: image },
  };
  const next: RecordingJourneySession = { ...state, draft };
  if (!recordingSessionFits(next)) {
    const unavailable = resolveJourneyCapture(state, { ...input, status: 'unavailable', reason: 'storage-limit' });
    return stopJourney(unavailable, { epoch: state.epoch, stoppedAt: image.capturedAt, reason: 'session-storage-limit' });
  }
  return next;
}

export function stopJourney(state: JourneySession, input: { epoch: number; stoppedAt: string; reason: StopReason }): JourneySession {
  if (state.phase === 'reviewing' || state.phase === 'saving' || state.phase === 'saved' || state.phase === 'idle') return state;
  if (input.epoch !== state.epoch || !validTimestamp(input.stoppedAt) || !STOP_REASONS.includes(input.reason)) return state;
  if (state.phase === 'starting') return { phase: 'idle', epoch: state.epoch + 1 };
  if (Date.parse(input.stoppedAt) < Date.parse(state.draft.startedAt)) return state;
  const stoppedMs = Date.parse(input.stoppedAt);
  const steps = state.draft.steps.map(step => step.image.status === 'pending'
    ? { ...step, image: { status: 'unavailable', reason: 'stopped' } as const }
    : step) as JourneyDraftStep[];
  return {
    phase: 'reviewing', sessionId: state.sessionId, journeyId: state.journeyId,
    epoch: state.epoch + 1, ownerTabId: state.ownerTabId, ownerWindowId: state.ownerWindowId,
    ...journeyReviewWindow(stoppedMs),
    draft: {
      ...state.draft,
      stoppedAt: input.stoppedAt,
      updatedAt: Date.parse(input.stoppedAt) > Date.parse(state.draft.updatedAt) ? input.stoppedAt : state.draft.updatedAt,
      stopReason: input.reason,
      steps,
      limitations: withLimitation(state.draft.limitations, STOP_LIMITATIONS[input.reason]),
    },
  };
}

function chronologicalTimestamp(state: RecordingJourneySession, candidate: string): string {
  return new Date(Math.max(
    Date.parse(candidate),
    Date.parse(state.draft.startedAt),
    Date.parse(state.draft.updatedAt),
  )).toISOString();
}

// Both the recording and any review a stop would leave behind must be
// storable: session storage refuses either past the cap. The storage stop is
// measured, with room for the longest limitation any stop can add instead.
export function recordingSessionFits(state: RecordingJourneySession): boolean {
  const cap = JOURNEY_LIMITS.maxSessionBytes - JOURNEY_LIMITS.sessionMetadataReserveBytes;
  if (bytes(JSON.stringify(state)) > cap) return false;
  const terminal = stopJourney(state, {
    epoch: state.epoch,
    stoppedAt: chronologicalTimestamp(state, state.deadlineAt),
    reason: 'session-storage-limit',
  });
  return bytes(JSON.stringify(terminal)) + STOP_LIMITATION_HEADROOM_BYTES <= cap;
}
