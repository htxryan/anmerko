import {
  validateJourneyManifest,
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
  return `journey-${journeyId}-image-${imageId}.png`;
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
