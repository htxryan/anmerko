import {
  JOURNEY_REDACTED_URL,
  validateJourneyDraft,
  validateJourneyManifest,
  type DraftFieldValue,
  type JourneyDraftStep,
  type JourneyDraftV1,
  type JourneyManifestV1,
  type JourneyStep,
  type ReviewedFieldValue,
  type ReviewedText,
  type SafeTarget,
} from './journey-core';
import { JOURNEY_LIMITS } from './journey-limits';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/;

function validId(value: string): boolean {
  return typeof value === 'string' && value.length <= JOURNEY_LIMITS.maxIdCharacters && ID_PATTERN.test(value);
}

function inlineCode(value: string): string {
  const text = value.replace(/\r\n?|\n/g, ' ');
  if (!text) return '*(empty)*';
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map(run => run.length));
  const delimiter = '`'.repeat(longest + 1);
  const pad = /^`|`$/.test(text) || (/^ .* $/.test(text) && !/^ +$/.test(text));
  return `${delimiter}${pad ? ' ' : ''}${text}${pad ? ' ' : ''}${delimiter}`;
}

function literalBlock(value: string): string {
  const longest = Math.max(0, ...(value.match(/`+/g) ?? []).map(run => run.length));
  const delimiter = '`'.repeat(Math.max(3, longest + 1));
  return `${delimiter}\n${value}\n${delimiter}`;
}

const yesNo = (value: boolean) => value ? 'Yes' : 'No';

function relativeTime(milliseconds: number): string {
  const sign = milliseconds < 0 ? '-' : '+';
  const total = Math.abs(Math.trunc(milliseconds));
  const minutes = Math.floor(total / 60_000);
  const seconds = Math.floor(total % 60_000 / 1_000);
  const remainder = total % 1_000;
  return `${sign}${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(remainder).padStart(3, '0')}`;
}

function pushReviewedText(lines: string[], label: string, value: ReviewedText): void {
  lines.push(`${label}:`, literalBlock(value.text),
    `${label} review: Edited: ${yesNo(value.edited)} · Redacted: ${yesNo(value.redacted)}`);
}

function pushTarget(lines: string[], target: SafeTarget): void {
  lines.push(`Target tag: ${inlineCode(target.tag)}`);
  if (target.role) lines.push(`Target role: ${inlineCode(target.role)}`);
  lines.push(`Target editable: ${yesNo(target.editable)}`);
  pushReviewedText(lines, 'Target label', target.label);
  lines.push(`Selector path: ${target.selectorPath.map(inlineCode).join(' → ')}`,
    `Target viewport: ${target.viewport.width} × ${target.viewport.height}`,
    `Target scroll: x ${target.scroll.x}, y ${target.scroll.y}`);
  if (target.point) lines.push(`Target point: x ${target.point.x}, y ${target.point.y}`);
}

function pushEnteredValue(lines: string[], value: ReviewedFieldValue): void {
  if (value.kind === 'checked') {
    lines.push(`Entered checked state: ${yesNo(value.checked)}`);
    return;
  }
  if (value.kind === 'text') {
    pushReviewedText(lines, 'Entered text', value.value);
    lines.push(`Entered text truncated: ${yesNo(value.truncated)}`);
    return;
  }
  lines.push(`Entered selection allows multiple: ${yesNo(value.multiple)}`,
    `Entered selection truncated: ${yesNo(value.truncated)}`);
  value.values.forEach((item, index) => pushReviewedText(lines, `Entered selection value ${index + 1}`, item));
}

function stepKind(step: JourneyStep): string {
  if (step.kind === 'initial') return 'Initial capture';
  if (step.kind === 'field-change') return 'Field change';
  return step.kind === 'click' ? 'Click' : 'Navigation';
}

function pushImage(lines: string[], manifest: JourneyManifestV1, step: JourneyStep): void {
  if (step.image.status === 'removed') {
    lines.push('Screenshot: removed during review');
    return;
  }
  if (step.image.status === 'unavailable') {
    lines.push(`Screenshot: unavailable (${inlineCode(step.image.reason)})`);
    return;
  }
  const image = manifest.images[step.image.imageId];
  lines.push(`Screenshot: ${inlineCode(journeyImageFilename(manifest.id, step.image.imageId))}`);
  pushReviewedText(lines, 'Screenshot URL', image.captureUrl);
  lines.push(
    `Image captured: ${inlineCode(image.capturedAt)} · ${relativeTime(Date.parse(image.capturedAt) - Date.parse(manifest.startedAt))}`,
    `Image redacted: ${yesNo(image.redacted)}`,
    `Image dimensions: ${image.width} × ${image.height}`,
    `Image viewport: ${image.viewport.width} × ${image.viewport.height}`,
    `Image scroll: x ${image.scroll.x}, y ${image.scroll.y}`,
    `Shared navigation result: ${yesNo(step.image.sharedNavigationResult === true)}`,
  );
}

export function journeyImageFilename(journeyId: string, imageId: string): string {
  if (!validId(journeyId) || !validId(imageId)) throw new TypeError('Journey image IDs are invalid.');
  return `journey-${journeyId.length}-${journeyId}-image-${imageId.length}-${imageId}.png`;
}

const reviewedText = (text: string, edited: boolean, redacted: boolean): ReviewedText => ({ text, edited, redacted });

function manifestFieldValue(value: DraftFieldValue): ReviewedFieldValue {
  if (value.kind === 'checked') return { kind: 'checked', checked: value.checked };
  const edited = value.edited === true;
  if (value.kind === 'text') {
    return {
      kind: 'text',
      value: reviewedText(value.value, edited, edited && value.value === ''),
      truncated: value.truncated,
    };
  }
  return {
    kind: 'selection',
    values: value.values.map(item => reviewedText(item, edited, edited && item === '')),
    multiple: value.multiple,
    truncated: value.truncated,
  };
}

function manifestTarget(step: Extract<JourneyDraftStep, { kind: 'click' | 'field-change' }>): SafeTarget {
  return {
    tag: step.target.tag,
    ...(step.target.role ? { role: step.target.role } : {}),
    selectorPath: [...step.target.selectorPath],
    label: reviewedText(step.target.label, false, false),
    editable: step.target.editable,
    viewport: { ...step.target.viewport },
    scroll: { ...step.target.scroll },
    ...(step.target.point ? { point: { ...step.target.point } } : {}),
  };
}

export function journeyDraftToManifest(draft: JourneyDraftV1): JourneyManifestV1 {
  const checked = validateJourneyDraft(draft);
  if (!checked.ok) throw new TypeError('Journey draft cannot be exported as a reviewed manifest.');
  const source = checked.value;
  const { stoppedAt, stopReason } = source;
  if (typeof stoppedAt !== 'string' || typeof stopReason !== 'string') {
    throw new TypeError('Journey draft cannot be exported as a reviewed manifest.');
  }
  const redactedUrl = (text: string): ReviewedText => {
    const redacted = text === JOURNEY_REDACTED_URL;
    return reviewedText(text, redacted, redacted);
  };
  const steps: JourneyStep[] = source.steps.map(step => {
    if (step.image.status === 'pending') {
      throw new TypeError('Journey draft cannot be exported with a pending screenshot.');
    }
    const base = {
      id: step.id, seq: step.seq, observedAt: step.observedAt, elapsedMs: step.elapsedMs,
      sourceUrl: redactedUrl(step.sourceUrl),
      image: step.image.status === 'retained'
        ? {
          status: 'retained' as const, imageId: step.image.imageId,
          ...(step.image.sharedNavigationResult === true ? { sharedNavigationResult: true as const } : {}),
        }
        : step.image,
    };
    if (step.kind === 'initial') return { ...base, kind: 'initial' as const };
    if (step.kind === 'navigation') {
      return {
        ...base, kind: 'navigation' as const,
        navigation: {
          toUrl: redactedUrl(step.navigation.toUrl),
          ...(step.navigation.causedByStepId ? { causedByStepId: step.navigation.causedByStepId } : {}),
        },
      };
    }
    const withTarget = { ...base, kind: step.kind, target: manifestTarget(step) };
    if (step.kind === 'field-change') return { ...withTarget, kind: 'field-change' as const, enteredValue: manifestFieldValue(step.enteredValue) };
    return { ...withTarget, kind: 'click' as const };
  });
  const images = Object.fromEntries(Object.entries(source.images).map(([imageId, image]) => [imageId, {
    capturedAt: image.capturedAt,
    captureUrl: redactedUrl(image.captureUrl),
    width: image.width,
    height: image.height,
    byteLength: image.byteLength,
    viewport: { ...image.viewport },
    scroll: { ...image.scroll },
    redacted: image.redacted ?? false,
  }]));
  const manifest: JourneyManifestV1 = {
    schemaVersion: 1, id: source.id, revision: source.revision,
    createdAt: source.createdAt, updatedAt: source.updatedAt,
    startedAt: source.startedAt, stoppedAt,
    includeEnteredValues: source.includeEnteredValues, stopReason,
    expected: source.expected, actual: source.actual, steps, images,
    limitations: [...source.limitations],
  };
  const result = validateJourneyManifest(manifest);
  if (!result.ok) throw new TypeError('Journey draft cannot be exported as a reviewed manifest.');
  return result.value;
}

export function journeyPromptSection(manifests: JourneyManifestV1[]): string {
  for (const manifest of manifests) {
    if (!validateJourneyManifest(manifest).ok) throw new TypeError('Journey export requires valid reviewed manifests.');
  }
  const lines = ['## Recorded journeys', ''];
  manifests.forEach((manifest, index) => {
    // Every redacted URL counts as the same opaque page, so the scope never
    // depends on a hidden value.
    const page = (url: ReviewedText) => url.redacted ? JOURNEY_REDACTED_URL : url.text;
    const pages = new Set(manifest.steps.flatMap(step => step.kind === 'navigation'
      ? [page(step.sourceUrl), page(step.navigation.toUrl)]
      : [page(step.sourceUrl)]));
    lines.push(
      `### Journey ${index + 1} · ${inlineCode(manifest.id)}`, '',
      `- **Revision:** ${manifest.revision}`,
      `- **Steps:** ${manifest.steps.length}`,
      `- **Scope:** ${pages.size > 1 ? 'Spans pages (full sequence in journeys.md)' : 'Single page'}`,
      `- **Full sequence and screenshots:** journeys.md, Journey ${index + 1}`, '',
      'Expected:', literalBlock(manifest.expected), '',
      'Actual:', literalBlock(manifest.actual), '',
    );
  });
  return `${lines.join('\n')}\n`;
}

export interface JourneyArchiveDraft {
  draft: JourneyDraftV1;
}

export interface JourneyArchiveFile {
  name: string;
  data: Uint8Array;
}

function pngBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(',');
  if (!dataUrl.startsWith('data:image/png;base64,') || comma < 0) {
    throw new TypeError('Journey export requires PNG data URLs.');
  }
  return Uint8Array.from(atob(dataUrl.slice(comma + 1)), character => character.charCodeAt(0));
}

function pngByteLength(dataUrl: string): number {
  const comma = dataUrl.indexOf(',');
  if (!dataUrl.startsWith('data:image/png;base64,') || comma < 0) {
    throw new TypeError('Journey export requires PNG data URLs.');
  }
  const payload = dataUrl.length - comma - 1;
  const padding = dataUrl.endsWith('==') ? 2 : dataUrl.endsWith('=') ? 1 : 0;
  return Math.floor(payload * 3 / 4) - padding;
}

export function journeyArchiveFiles(drafts: JourneyDraftV1[]): JourneyArchiveFile[] {
  const manifests = drafts.map(draft => journeyDraftToManifest(draft));
  const files: JourneyArchiveFile[] = [];
  if (manifests.length > 0) {
    const sections = manifests.map((manifest, index) => formatJourneyMarkdown(manifest, index + 1));
    files.push({
      name: 'journeys.md',
      data: new TextEncoder().encode(`# Recorded journeys\n\n${sections.join('\n---\n\n')}`),
    });
  }
  const seen = new Set<string>();
  for (const manifest of manifests) {
    const draft = drafts.find(candidate => candidate.id === manifest.id);
    for (const step of manifest.steps) {
      if (step.image.status !== 'retained') continue;
      const name = journeyImageFilename(manifest.id, step.image.imageId);
      if (seen.has(name)) continue;
      seen.add(name);
      const record = draft?.images[step.image.imageId];
      if (!record?.dataUrl) throw new TypeError('Journey export requires PNG data URLs.');
      files.push({ name, data: pngBytes(record.dataUrl) });
    }
  }
  return files;
}

export function journeyExportByteLength(drafts: JourneyDraftV1[], markdownBytes: number): number {
  let total = markdownBytes;
  for (const draft of drafts) {
    const manifest = journeyDraftToManifest(draft);
    const seen = new Set<string>();
    for (const step of manifest.steps) {
      if (step.image.status !== 'retained' || seen.has(step.image.imageId)) continue;
      seen.add(step.image.imageId);
      const record = draft.images[step.image.imageId];
      if (typeof record?.dataUrl !== 'string') throw new TypeError('Journey export requires PNG data URLs.');
      total += pngByteLength(record.dataUrl);
    }
  }
  return total;
}

export function formatJourneyMarkdown(manifest: JourneyManifestV1, index = 1): string {
  if (!Number.isSafeInteger(index) || index < 1) throw new TypeError('Journey index must be a positive integer.');
  const result = validateJourneyManifest(manifest);
  if (!result.ok) throw new TypeError('Journey export requires a valid reviewed manifest.');
  const reviewed = result.value;
  const lines = [
    `## Journey ${index}`, '',
    `Journey ID: ${inlineCode(reviewed.id)}`,
    `Revision: ${reviewed.revision}`,
    `Created: ${inlineCode(reviewed.createdAt)}`,
    `Started: ${inlineCode(reviewed.startedAt)}`,
    `Stopped: ${inlineCode(reviewed.stoppedAt)}`,
    `Stop reason: ${inlineCode(reviewed.stopReason)}`,
    `Entered values: ${reviewed.includeEnteredValues ? 'On' : 'Off'}`,
    `Retained steps: ${reviewed.steps.length}`, '',
    'Expected:', literalBlock(reviewed.expected), '',
    'Actual:', literalBlock(reviewed.actual), '',
  ];

  for (const step of reviewed.steps) {
    lines.push(`### Step ${step.seq} · ${stepKind(step)} · ${relativeTime(step.elapsedMs)}`, '',
      `Step ID: ${inlineCode(step.id)}`,
      `Kind: ${inlineCode(step.kind)}`,
      `Observed at: ${inlineCode(step.observedAt)}`);
    pushReviewedText(lines, 'Source URL', step.sourceUrl);
    if (step.kind === 'click' || step.kind === 'field-change') pushTarget(lines, step.target);
    if (step.kind === 'navigation') {
      pushReviewedText(lines, 'Destination URL', step.navigation.toUrl);
      if (step.navigation.causedByStepId) lines.push(`Caused by step ID: ${inlineCode(step.navigation.causedByStepId)}`);
    }
    if (step.kind === 'field-change') pushEnteredValue(lines, step.enteredValue);
    pushImage(lines, reviewed, step);
    lines.push('');
  }

  lines.push('### Limitations', '');
  if (!reviewed.limitations.length) lines.push('None recorded.', '');
  else reviewed.limitations.forEach((limitation, limitationIndex) => {
    lines.push(`Limitation ${limitationIndex + 1}:`, literalBlock(limitation), '');
  });
  lines.push('Observation only: no network timing, raw keyboard stream, or replay state.');
  return `${lines.join('\n')}\n`;
}
