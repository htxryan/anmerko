import type { DraftFieldValue, DraftSafeTarget, ValidationResult } from './journey-core';
import { CAPTURE_FAILURES, JOURNEY_LIMITS } from './journey-limits';
import { validJourneySelectorPath } from './journey-selector';

interface JourneyInputEventBase {
  id: string;
  observedAt: string;
  elapsedMs: number;
  sourceUrl: string;
  image: JourneyPendingImageState;
}

export type JourneyPendingImageState =
  | { status: 'pending'; captureId: string }
  | { status: 'unavailable'; reason: (typeof CAPTURE_FAILURES)[number] };

export interface JourneyClickEvent extends JourneyInputEventBase {
  kind: 'click';
  target: DraftSafeTarget;
}

export interface JourneyFieldChangeEvent extends JourneyInputEventBase {
  kind: 'field-change';
  target: DraftSafeTarget;
  enteredValue: DraftFieldValue;
}

export type JourneyInputEvent = JourneyClickEvent | JourneyFieldChangeEvent;

export interface JourneyEventBatchV1 {
  schemaVersion: 1;
  sessionId: string;
  epoch: number;
  documentToken: string;
  localCounter: number;
  events: JourneyInputEvent[];
}

const encoder = new TextEncoder();
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/;

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

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= JOURNEY_LIMITS.maxIdCharacters && ID_PATTERN.test(value);
}

function characters(value: string): number { return Array.from(value).length }
function bytes(value: string): number { return encoder.encode(value).byteLength }

export function stripUrlCredentials(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new TypeError('Journey URLs must use HTTP(S)');
  url.username = '';
  url.password = '';
  return url.href;
}

function validateUrl(value: unknown, path: string, errors: string[]): string | undefined {
  if (typeof value !== 'string') { errors.push(`${path} must be a URL string`); return; }
  if (bytes(value) > JOURNEY_LIMITS.maxUrlBytes) errors.push(`${path} exceeds the URL limit`);
  try { return stripUrlCredentials(value); }
  catch { errors.push(`${path} must be a complete HTTP(S) URL`); }
}

function validatePoint(value: unknown, path: string, errors: string[]): void {
  if (!isObject(value)) { errors.push(`${path} must be a point`); return; }
  exactKeys(value, ['x', 'y'], [], path, errors);
  if (typeof value.x !== 'number' || !Number.isFinite(value.x)) errors.push(`${path}.x must be finite`);
  if (typeof value.y !== 'number' || !Number.isFinite(value.y)) errors.push(`${path}.y must be finite`);
}

function validateViewport(value: unknown, path: string, errors: string[]): void {
  if (!isObject(value)) { errors.push(`${path} must be a viewport`); return; }
  exactKeys(value, ['width', 'height'], [], path, errors);
  if (!Number.isInteger(value.width) || (value.width as number) <= 0) errors.push(`${path}.width must be a positive integer`);
  if (!Number.isInteger(value.height) || (value.height as number) <= 0) errors.push(`${path}.height must be a positive integer`);
}

function validateTarget(value: unknown, path: string, errors: string[]): void {
  if (!isObject(value)) { errors.push(`${path} must be a safe target`); return; }
  exactKeys(value, ['tag', 'selectorPath', 'label', 'viewport', 'scroll', 'editable'], ['role', 'point'], path, errors);
  if (typeof value.tag !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value.tag)) errors.push(`${path}.tag is invalid`);
  if (value.role !== undefined && (typeof value.role !== 'string' || !value.role.trim() || characters(value.role) > 64)) errors.push(`${path}.role is invalid`);
  if (!validJourneySelectorPath(value.selectorPath)) errors.push(`${path}.selectorPath is invalid`);
  if (typeof value.label !== 'string' || !value.label.trim() || characters(value.label) > JOURNEY_LIMITS.maxTargetTextCharacters) errors.push(`${path}.label is invalid`);
  if (typeof value.editable !== 'boolean') errors.push(`${path}.editable must be a boolean`);
  validateViewport(value.viewport, `${path}.viewport`, errors);
  validatePoint(value.scroll, `${path}.scroll`, errors);
  if (value.point !== undefined) validatePoint(value.point, `${path}.point`, errors);
  if (isObject(value.viewport) && isObject(value.point)
    && typeof value.viewport.width === 'number' && typeof value.viewport.height === 'number'
    && typeof value.point.x === 'number' && typeof value.point.y === 'number'
    && (value.point.x < 0 || value.point.y < 0 || value.point.x > value.viewport.width || value.point.y > value.viewport.height)) errors.push(`${path}.point lies outside the viewport`);
}

function validateImageState(value: unknown, path: string, errors: string[]): void {
  if (!isObject(value) || typeof value.status !== 'string') { errors.push(`${path} must be an image state`); return; }
  if (value.status === 'pending') {
    exactKeys(value, ['status', 'captureId'], [], path, errors);
    if (!validId(value.captureId)) errors.push(`${path}.captureId is invalid`);
  } else if (value.status === 'unavailable') {
    exactKeys(value, ['status', 'reason'], [], path, errors);
    if (typeof value.reason !== 'string' || !CAPTURE_FAILURES.includes(value.reason as never)) errors.push(`${path}.reason is unknown`);
  } else errors.push(`${path}.status is unknown for an incoming event`);
}

function validateFieldValue(value: unknown, path: string, errors: string[]): number {
  if (!isObject(value) || typeof value.kind !== 'string') { errors.push(`${path} must be a field value`); return 0; }
  if (value.kind === 'text') {
    exactKeys(value, ['kind', 'value', 'truncated'], [], path, errors);
    if (typeof value.value !== 'string' || characters(value.value) > JOURNEY_LIMITS.maxFieldValueCharacters) errors.push(`${path}.value is invalid`);
    if (typeof value.truncated !== 'boolean') errors.push(`${path}.truncated must be a boolean`);
    return typeof value.value === 'string' ? bytes(value.value) : 0;
  }
  if (value.kind === 'selection') {
    exactKeys(value, ['kind', 'values', 'multiple', 'truncated'], [], path, errors);
    if (!Array.isArray(value.values) || value.values.length > 100
      || value.values.some(item => typeof item !== 'string' || characters(item) > JOURNEY_LIMITS.maxFieldValueCharacters)) errors.push(`${path}.values is invalid`);
    if (typeof value.multiple !== 'boolean') errors.push(`${path}.multiple must be a boolean`);
    if (typeof value.truncated !== 'boolean') errors.push(`${path}.truncated must be a boolean`);
    return Array.isArray(value.values) ? value.values.reduce((total, item) => total + (typeof item === 'string' ? bytes(item) : 0), 0) : 0;
  }
  if (value.kind === 'checked') {
    exactKeys(value, ['kind', 'checked'], [], path, errors);
    if (typeof value.checked !== 'boolean') errors.push(`${path}.checked must be a boolean`);
    return 0;
  }
  errors.push(`${path}.kind is unknown`);
  return 0;
}

function validateEvent(value: unknown, path: string, errors: string[]): number {
  if (!isObject(value) || typeof value.kind !== 'string') { errors.push(`${path} must be an event`); return 0; }
  const base = ['kind', 'id', 'observedAt', 'elapsedMs', 'sourceUrl', 'target', 'image'];
  if (value.kind === 'click') exactKeys(value, base, [], path, errors);
  else if (value.kind === 'field-change') exactKeys(value, [...base, 'enteredValue'], [], path, errors);
  else { errors.push(`${path}.kind is unknown`); return 0; }
  if (!validId(value.id)) errors.push(`${path}.id is invalid`);
  if (typeof value.observedAt !== 'string' || value.observedAt.length > 40 || !Number.isFinite(Date.parse(value.observedAt))) errors.push(`${path}.observedAt is invalid`);
  if (!Number.isInteger(value.elapsedMs) || (value.elapsedMs as number) < 0 || (value.elapsedMs as number) > JOURNEY_LIMITS.maxDurationMs) errors.push(`${path}.elapsedMs is invalid`);
  const sourceUrl = validateUrl(value.sourceUrl, `${path}.sourceUrl`, errors);
  if (sourceUrl !== undefined) value.sourceUrl = sourceUrl;
  validateTarget(value.target, `${path}.target`, errors);
  if (value.kind === 'field-change' && isObject(value.target) && value.target.editable !== true) errors.push(`${path}.target must be editable`);
  validateImageState(value.image, `${path}.image`, errors);
  return value.kind === 'field-change' ? validateFieldValue(value.enteredValue, `${path}.enteredValue`, errors) : 0;
}

export function validateJourneyEventBatch(value: unknown): ValidationResult<JourneyEventBatchV1> {
  const errors: string[] = [];
  let serialized: string;
  try { serialized = JSON.stringify(value); }
  catch { return { ok: false, errors: ['event batch must be JSON serializable'] }; }
  if (serialized === undefined || bytes(serialized) > JOURNEY_LIMITS.maxEventPayloadBytes) return { ok: false, errors: ['event batch exceeds the payload limit'] };
  let copy: unknown;
  try { copy = JSON.parse(serialized); }
  catch { return { ok: false, errors: ['event batch must be JSON serializable'] }; }
  if (!isObject(copy)) return { ok: false, errors: ['event batch must be an object'] };
  exactKeys(copy, ['schemaVersion', 'sessionId', 'epoch', 'documentToken', 'localCounter', 'events'], [], 'batch', errors);
  if (copy.schemaVersion !== 1) errors.push('batch.schemaVersion is unknown');
  if (!validId(copy.sessionId)) errors.push('batch.sessionId is invalid');
  if (!Number.isInteger(copy.epoch) || (copy.epoch as number) < 1) errors.push('batch.epoch is invalid');
  if (!validId(copy.documentToken)) errors.push('batch.documentToken is invalid');
  if (!Number.isInteger(copy.localCounter) || (copy.localCounter as number) < 1) errors.push('batch.localCounter is invalid');
  if (!Array.isArray(copy.events) || copy.events.length < 1 || copy.events.length > JOURNEY_LIMITS.maxSteps) errors.push('batch.events has an invalid length');
  const ids = new Set<string>();
  const captureIds = new Set<string>();
  let fieldBytes = 0;
  let previousElapsed = -1;
  if (Array.isArray(copy.events)) for (const [index, event] of copy.events.entries()) {
    fieldBytes += validateEvent(event, `batch.events[${index}]`, errors);
    if (isObject(event) && typeof event.id === 'string') {
      if (ids.has(event.id)) errors.push(`batch.events[${index}].id is duplicated`);
      ids.add(event.id);
    }
    if (isObject(event) && typeof event.elapsedMs === 'number') {
      if (event.elapsedMs < previousElapsed) errors.push('batch.events must have nondecreasing elapsedMs values');
      previousElapsed = event.elapsedMs;
    }
    if (isObject(event) && isObject(event.image) && event.image.status === 'pending' && typeof event.image.captureId === 'string') {
      if (captureIds.has(event.image.captureId)) errors.push(`batch.events[${index}].image.captureId is duplicated`);
      captureIds.add(event.image.captureId);
    }
  }
  if (fieldBytes > JOURNEY_LIMITS.maxJourneyFieldTextBytes) errors.push('batch field text exceeds its limit');
  return errors.length ? { ok: false, errors } : { ok: true, value: copy as unknown as JourneyEventBatchV1 };
}
