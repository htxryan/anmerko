import { JOURNEY_LIMITS, STOP_REASONS, type CaptureFailure, type StopReason } from './journey-limits';
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
  | { kind: 'text'; value: string; truncated: boolean }
  | { kind: 'selection'; values: string[]; multiple: boolean; truncated: boolean }
  | { kind: 'checked'; checked: boolean };

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
    exactKeys(value, ['kind', 'value', 'truncated'], [], path, errors);
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
    exactKeys(value, ['kind', 'values', 'multiple', 'truncated'], [], path, errors);
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
    exactKeys(value, ['kind', 'checked'], [], path, errors);
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
    const sanitized = validateUrl(value.captureUrl, `${path}.captureUrl`, errors);
    if (sanitized !== undefined) value.captureUrl = sanitized;
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
  else {
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
      else {
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
  if (reviewed) exactKeys(copy, [...required, 'stoppedAt', 'stopReason'], [], 'journey', errors);
  else exactKeys(copy, [...required, 'status'], ['stoppedAt', 'stopReason'], 'journey', errors);
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
  if (errors.length) return state;
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

function draftFieldTextBytes(steps: JourneyDraftStep[]): number {
  let total = 0;
  for (const step of steps) {
    if (step.kind !== 'field-change') continue;
    if (step.enteredValue.kind === 'text') total += bytes(step.enteredValue.value);
    else if (step.enteredValue.kind === 'selection') total += step.enteredValue.values.reduce((sum, value) => sum + bytes(value), 0);
  }
  return total;
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
  const incomingFieldBytes = batch.events.reduce((total, event) => {
    if (event.kind !== 'field-change' || event.enteredValue.kind === 'checked') return total;
    if (event.enteredValue.kind === 'text') return total + bytes(event.enteredValue.value);
    return total + event.enteredValue.values.reduce((sum, value) => sum + bytes(value), 0);
  }, 0);
  if (draftFieldTextBytes(state.draft.steps) + incomingFieldBytes > JOURNEY_LIMITS.maxJourneyFieldTextBytes) return state;
  let elapsed = state.draft.steps.at(-1)?.elapsedMs ?? -1;
  for (const event of batch.events) {
    if (event.elapsedMs < elapsed) return state;
    elapsed = event.elapsedMs;
  }
  const remaining = JOURNEY_LIMITS.maxSteps - state.draft.steps.length;
  if (remaining <= 0) return stopJourney(state, { epoch: state.epoch, stoppedAt: state.draft.updatedAt, reason: 'step-limit' });
  const accepted = batch.events.slice(0, remaining);
  const lastSeq = state.draft.steps.at(-1)?.seq ?? 0;
  const steps = accepted.map((event, index) => draftStep(event, lastSeq + index + 1));
  const lastObservedAt = steps.at(-1)?.observedAt ?? state.draft.updatedAt;
  const updatedAt = Date.parse(lastObservedAt) > Date.parse(state.draft.updatedAt) ? lastObservedAt : state.draft.updatedAt;
  const next: RecordingJourneySession = {
    ...state,
    documentCounters: { ...state.documentCounters, [batch.documentToken]: batch.localCounter },
    draft: { ...state.draft, updatedAt, steps: [...state.draft.steps, ...steps] },
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
  const accepted = batch.events.slice(0, remaining);
  const baseSeq = predecessor?.seq ?? 0;
  const steps = accepted.map((event, index) => ({
    ...draftStep(event, baseSeq + index + 1),
    image: { status: 'unavailable', reason: 'superseded' } as const,
  }));
  const next: RecordingJourneySession = {
    ...state,
    documentCounters: { ...state.documentCounters, [batch.documentToken]: batch.localCounter },
    draft: {
      ...state.draft,
      steps: [...state.draft.steps.slice(0, -1), ...steps, { ...trailing, seq: baseSeq + steps.length + 1 }],
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
    warningAt: boundedIsoAfter(stoppedMs, JOURNEY_LIMITS.maxReviewIdleMs - JOURNEY_LIMITS.reviewWarningMs),
    expiresAt: boundedIsoAfter(stoppedMs, JOURNEY_LIMITS.maxReviewIdleMs),
    draft: {
      ...state.draft,
      stoppedAt: input.stoppedAt,
      updatedAt: Date.parse(input.stoppedAt) > Date.parse(state.draft.updatedAt) ? input.stoppedAt : state.draft.updatedAt,
      stopReason: input.reason,
      steps,
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

function recordingSessionFits(state: RecordingJourneySession): boolean {
  if (bytes(JSON.stringify(state)) > JOURNEY_LIMITS.maxSessionBytes) return false;
  const terminal = stopJourney(state, {
    epoch: state.epoch,
    stoppedAt: chronologicalTimestamp(state, state.deadlineAt),
    reason: 'session-storage-limit',
  });
  return bytes(JSON.stringify(terminal)) <= JOURNEY_LIMITS.maxSessionBytes;
}
