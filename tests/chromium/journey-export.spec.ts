import { expect, test } from '@playwright/test';
import type { JourneyDraftV1, JourneyManifestV1, ReviewedText, SafeTarget } from '../../src/journey-core';
import { JOURNEY_LIMITS } from '../../src/journey-limits';
import { feedbackArchive } from '../../src/export';
import {
  formatJourneyMarkdown,
  journeyArchiveFiles,
  journeyDraftToManifest,
  journeyExportByteLength,
  journeyImageFilename,
  journeyPromptSection,
} from '../../src/journey-export';

const reviewed = (text: string, edited = false, redacted = false): ReviewedText => ({ text, edited, redacted });

const target = (label: ReviewedText): SafeTarget => ({
  tag: 'button', role: 'button', selectorPath: ['main', 'button:nth-of-type(2)'],
  label, editable: false, viewport: { width: 1_280, height: 720 },
  scroll: { x: 0, y: 300 }, point: { x: 1_010, y: 650 },
});

function manifest(): JourneyManifestV1 {
  const source = 'https://shop.example/items/%E2%9C%93?q=green&q=large&empty=&encoded=a%2Fb%20c#list%2Fone';
  const destination = 'https://checkout.example/pay/%E2%9C%93?cart=7&cart=8&empty=&encoded=x%2Fy%20z#details%2Ftwo';
  return {
    schemaVersion: 1, id: 'J1', revision: 3,
    createdAt: '2026-09-20T12:00:00.000Z', updatedAt: '2026-09-20T12:00:04.000Z',
    startedAt: '2026-09-20T12:00:00.000Z', stoppedAt: '2026-09-20T12:00:04.000Z',
    includeEnteredValues: true, stopReason: 'user',
    expected: 'The selected item remains in the cart.', actual: 'Checkout is empty after navigation.',
    steps: [
      {
        kind: 'initial', id: 'S1', seq: 1, observedAt: '2026-09-20T12:00:00.100Z', elapsedMs: 100,
        sourceUrl: reviewed(source), image: { status: 'retained', imageId: 'I1' },
      },
      {
        kind: 'click', id: 'S2', seq: 2, observedAt: '2026-09-20T12:00:01.210Z', elapsedMs: 1_210,
        sourceUrl: reviewed(source), target: target(reviewed('Checkout')),
        image: { status: 'retained', imageId: 'I2', sharedNavigationResult: true },
      },
      {
        kind: 'navigation', id: 'S3', seq: 5, observedAt: '2026-09-20T12:00:01.300Z', elapsedMs: 1_300,
        sourceUrl: reviewed(source), navigation: { toUrl: reviewed(destination), causedByStepId: 'S2' },
        image: { status: 'retained', imageId: 'I2', sharedNavigationResult: true },
      },
      {
        kind: 'field-change', id: 'S4', seq: 7, observedAt: '2026-09-20T12:00:02.000Z', elapsedMs: 2_000,
        sourceUrl: reviewed(destination), target: { ...target(reviewed('Email')), tag: 'input', role: 'textbox', editable: true },
        enteredValue: { kind: 'text', value: reviewed('test@example.invalid', true, true), truncated: false },
        image: { status: 'unavailable', reason: 'superseded' },
      },
      {
        kind: 'click', id: 'S5', seq: 9, observedAt: '2026-09-20T12:00:03.000Z', elapsedMs: 3_000,
        sourceUrl: reviewed(destination, true, true), target: target(reviewed('Continue', true, false)),
        image: { status: 'removed' },
      },
    ],
    images: {
      I1: {
        capturedAt: '2026-09-20T12:00:00.150Z', captureUrl: reviewed(source),
        width: 1_280, height: 720, byteLength: 100_000,
        viewport: { width: 1_280, height: 720 }, scroll: { x: 0, y: 300 }, redacted: false,
      },
      I2: {
        capturedAt: '2026-09-20T12:00:01.600Z', captureUrl: reviewed(destination, true, false),
        width: 1_280, height: 720, byteLength: 120_000,
        viewport: { width: 1_280, height: 720 }, scroll: { x: 0, y: 0 }, redacted: true,
      },
    },
    limitations: ['Animated content may be intermediate.'],
  };
}

test('formats only a strict reviewed manifest and rejects drafts or unknown fields', () => {
  expect(formatJourneyMarkdown(manifest())).toContain('## Journey 1');

  const draft: JourneyDraftV1 = {
    schemaVersion: 1, status: 'draft', id: 'J1', revision: 0,
    createdAt: '2026-09-20T12:00:00.000Z', updatedAt: '2026-09-20T12:00:00.000Z',
    startedAt: '2026-09-20T12:00:00.000Z', includeEnteredValues: false,
    expected: '', actual: '', steps: [], images: {}, limitations: [],
  };
  expect(() => formatJourneyMarkdown(draft as unknown as JourneyManifestV1)).toThrow(TypeError);
  expect(() => formatJourneyMarkdown({ ...manifest(), status: 'saved' } as unknown as JourneyManifestV1)).toThrow(TypeError);
  expect(() => formatJourneyMarkdown(manifest(), 0)).toThrow(TypeError);
});

test('preserves full URL text, step order, sequence gaps, and explicit image states', () => {
  const markdown = formatJourneyMarkdown(manifest(), 4);
  const source = 'https://shop.example/items/%E2%9C%93?q=green&q=large&empty=&encoded=a%2Fb%20c#list%2Fone';
  const destination = 'https://checkout.example/pay/%E2%9C%93?cart=7&cart=8&empty=&encoded=x%2Fy%20z#details%2Ftwo';

  expect(markdown).toContain('## Journey 4');
  expect(markdown).toContain(source);
  expect(markdown).toContain(destination);
  expect(markdown.indexOf('### Step 2')).toBeLessThan(markdown.indexOf('### Step 5'));
  expect(markdown.indexOf('### Step 5')).toBeLessThan(markdown.indexOf('### Step 7'));
  expect(markdown).not.toContain('### Step 3');
  expect(markdown).toContain('Screenshot: unavailable (`superseded`)');
  expect(markdown).toContain('Screenshot: removed during review');
  expect(markdown).toContain('Observation only: no network timing, raw keyboard stream, or replay state.');
});

test('uses one deterministic image filename per identity across shared references', () => {
  const markdown = formatJourneyMarkdown(manifest());
  const shared = 'journey-2-J1-image-2-I2.png';

  expect(journeyImageFilename('J1', 'I2')).toBe(shared);
  expect(markdown.split(shared)).toHaveLength(3);
  expect(markdown).toContain('Shared navigation result: Yes');
  expect(markdown).not.toContain('journey-2-J1-image-2-S2.png');
  expect(journeyImageFilename('a-image-b', 'c')).not.toBe(journeyImageFilename('a', 'b-image-c'));
  expect(journeyImageFilename('a-image-b', 'c')).toBe('journey-9-a-image-b-image-1-c.png');
  expect(journeyImageFilename('a', 'b-image-c')).toBe('journey-1-a-image-9-b-image-c.png');
  for (const invalid of ['', '../private', 'https://example.com/x', 'a/b', `x${'y'.repeat(128)}`]) {
    expect(() => journeyImageFilename(invalid, 'I2')).toThrow(TypeError);
    expect(() => journeyImageFilename('J1', invalid)).toThrow(TypeError);
  }
});

test('renders reviewed value and redaction metadata without omitting retained eligible fields', () => {
  const markdown = formatJourneyMarkdown(manifest());

  expect(markdown).toContain('Entered values: On');
  expect(markdown).toContain('Entered text:');
  expect(markdown).toContain('test@example.invalid');
  expect(markdown).toContain('Entered text review: Edited: Yes · Redacted: Yes');
  expect(markdown).toContain('Source URL review: Edited: Yes · Redacted: Yes');
  expect(markdown).toContain('Target label review: Edited: Yes · Redacted: No');
  expect(markdown).toContain('Image redacted: Yes');
  expect(markdown).toContain('Stop reason: `user`');
  expect(markdown).toContain('Animated content may be intermediate.');

  const selection = manifest();
  const selectionStep = selection.steps.find(step => step.kind === 'field-change');
  if (!selectionStep || selectionStep.kind !== 'field-change') throw new Error('missing field fixture');
  selectionStep.enteredValue = {
    kind: 'selection', values: [reviewed('Large'), reviewed('Green', true, false)],
    multiple: true, truncated: true,
  };
  const selectionMarkdown = formatJourneyMarkdown(selection);
  expect(selectionMarkdown).toContain('Entered selection allows multiple: Yes');
  expect(selectionMarkdown).toContain('Entered selection truncated: Yes');
  expect(selectionMarkdown).toContain('Entered selection value 2 review: Edited: Yes · Redacted: No');

  const checked = manifest();
  const checkedStep = checked.steps.find(step => step.kind === 'field-change');
  if (!checkedStep || checkedStep.kind !== 'field-change') throw new Error('missing field fixture');
  checkedStep.enteredValue = { kind: 'checked', checked: true };
  expect(formatJourneyMarkdown(checked)).toContain('Entered checked state: Yes');

  const valuesOff = manifest();
  valuesOff.includeEnteredValues = false;
  valuesOff.steps = valuesOff.steps.filter(step => step.kind !== 'field-change');
  const withoutValues = formatJourneyMarkdown(valuesOff);
  expect(withoutValues).toContain('Entered values: Off');
  expect(withoutValues).not.toContain('Entered text:');
});

test('contains malicious Markdown, HTML, and fence runs as literal text', () => {
  const value = manifest();
  value.expected = '```\n# injected\n<img src=x onerror=alert(1)>\n[run](javascript:alert(1))';
  value.actual = '````\n## still literal';
  const click = value.steps[1];
  if (click.kind === 'click') click.target.label = reviewed('](`javascript:alert(1)`)\n# target', true, true);
  value.limitations = ['```\n# not a heading\n<iframe src=evil>'];

  const markdown = formatJourneyMarkdown(value);
  expect(markdown).toContain('`````\n````\n## still literal\n`````');
  expect(markdown).toContain('# injected');
  expect(markdown).toContain('<img src=x onerror=alert(1)>');
  expect(markdown).not.toContain('Expected: [');
  expect(markdown).toContain('Target label:\n```\n](`javascript:alert(1)`)\n# target\n```');
});

test('emits immutable step IDs so shared navigation correlation is resolvable', () => {
  const markdown = formatJourneyMarkdown(manifest());
  const click = markdown.indexOf('Step ID: `S2`');
  const navigation = markdown.indexOf('Step ID: `S3`');
  const cause = markdown.indexOf('Caused by step ID: `S2`');

  expect(click).toBeGreaterThan(-1);
  expect(navigation).toBeGreaterThan(click);
  expect(cause).toBeGreaterThan(navigation);
});

function reviewedDraft(): JourneyDraftV1 {
  return {
    schemaVersion: 1, status: 'draft', id: 'J1', revision: 4,
    createdAt: '2026-09-20T12:00:00.000Z', updatedAt: '2026-09-20T12:00:04.000Z',
    startedAt: '2026-09-20T12:00:00.000Z', stoppedAt: '2026-09-20T12:00:04.000Z',
    includeEnteredValues: true, stopReason: 'user',
    expected: 'The selected item remains in the cart.', actual: 'Checkout is empty after navigation.',
    steps: [
      {
        kind: 'click', id: 'S2', seq: 2, observedAt: '2026-09-20T12:00:01.210Z', elapsedMs: 1210,
        sourceUrl: 'https://shop.example/items?q=green',
        target: {
          tag: 'button', role: 'button', selectorPath: ['main', 'button:nth-of-type(2)'],
          label: 'Checkout', editable: false, viewport: { width: 1280, height: 720 },
          scroll: { x: 0, y: 300 }, point: { x: 1010, y: 650 },
        },
        image: { status: 'retained', imageId: 'I2' },
      },
      {
        kind: 'field-change', id: 'S4', seq: 7, observedAt: '2026-09-20T12:00:02.000Z', elapsedMs: 2000,
        sourceUrl: '[redacted]',
        target: {
          tag: 'input', selectorPath: ['input'], label: 'text field', editable: true,
          viewport: { width: 1280, height: 720 }, scroll: { x: 0, y: 0 },
        },
        enteredValue: { kind: 'text', value: 'edited query', truncated: false, edited: true },
        image: { status: 'unavailable', reason: 'superseded' },
      },
    ],
    images: {
      I2: {
        capturedAt: '2026-09-20T12:00:01.600Z', captureUrl: 'https://shop.example/pay?q=green',
        width: 1, height: 1, byteLength: 69,
        dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+AvzvAAAAAElFTkSuQmCC',
        viewport: { width: 1280, height: 720 }, scroll: { x: 0, y: 0 },
      },
    },
    limitations: [],
    redactions: { steps: { S4: { sourceUrl: true } } },
  };
}

test('draft snapshots map to reviewed manifests with edit markers', () => {
  const manifest = journeyDraftToManifest(reviewedDraft());

  expect(manifest).toMatchObject({
    schemaVersion: 1, id: 'J1', revision: 4, stopReason: 'user',
    expected: 'The selected item remains in the cart.',
  });
  expect((manifest as unknown as Record<string, unknown>).status).toBeUndefined();
  expect(manifest.steps[0].sourceUrl).toEqual({ text: 'https://shop.example/items?q=green', edited: false, redacted: false });
  expect(manifest.steps[1].sourceUrl).toEqual({ text: '[redacted]', edited: true, redacted: true });
  const field = manifest.steps[1];
  if (field.kind !== 'field-change') throw new Error('missing field fixture');
  expect(field.enteredValue).toEqual({
    kind: 'text', value: { text: 'edited query', edited: true, redacted: false }, truncated: false,
  });
  expect(manifest.images.I2).toMatchObject({ width: 1, byteLength: 69, redacted: false });
  expect((manifest.images.I2 as unknown as Record<string, unknown>).dataUrl).toBeUndefined();

  const removed = journeyDraftToManifest({
    ...reviewedDraft(),
    steps: reviewedDraft().steps.map(step => step.kind === 'field-change' && step.enteredValue.kind === 'text'
      ? { ...step, enteredValue: { kind: 'text', value: '', truncated: false, edited: true } as const }
      : step),
  });
  const removedField = removed.steps[1];
  if (removedField.kind !== 'field-change' || removedField.enteredValue.kind !== 'text') {
    throw new Error('missing field fixture');
  }
  expect(removedField.enteredValue.value).toEqual({ text: '', edited: true, redacted: true });

  expect(() => journeyDraftToManifest({ ...reviewedDraft(), expected: '' })).toThrow(TypeError);
  expect(() => journeyDraftToManifest({ ...reviewedDraft(), stoppedAt: undefined })).toThrow(TypeError);

  const markdown = formatJourneyMarkdown(manifest);
  expect(markdown).toContain('Entered text review: Edited: Yes · Redacted: No');
  expect(markdown).toContain('Source URL review: Edited: Yes · Redacted: Yes');
});

test('prompt section summarizes journeys with spans-pages scope', () => {
  const section = journeyPromptSection([journeyDraftToManifest(reviewedDraft())]);
  expect(section).toContain('## Recorded journeys');
  expect(section).toContain('### Journey 1 · `J1`');
  expect(section).toContain('- **Steps:** 2');
  expect(section).toContain('Full sequence and screenshots');
  expect(section).toContain('The selected item remains in the cart.');
  expect(section).toContain('Spans pages');

  const single: JourneyManifestV1 = {
    ...journeyDraftToManifest(reviewedDraft()),
    steps: [journeyDraftToManifest(reviewedDraft()).steps[0]],
  };
  expect(journeyPromptSection([single])).toContain('Single page');
  expect(journeyPromptSection([single, single])).toContain('### Journey 2');
  expect(() => journeyPromptSection([reviewedDraft() as unknown as JourneyManifestV1])).toThrow(TypeError);
});

const CART_URL = 'https://shop.example/cart';
const RESET_URL = 'https://shop.example/reset?token=private-token-9q';

function navigationDraft(toUrl: string): JourneyDraftV1 {
  return {
    schemaVersion: 1, status: 'draft', id: 'J2', revision: 2,
    createdAt: '2026-09-20T12:00:00.000Z', updatedAt: '2026-09-20T12:00:04.000Z',
    startedAt: '2026-09-20T12:00:00.000Z', stoppedAt: '2026-09-20T12:00:04.000Z',
    includeEnteredValues: false, stopReason: 'user',
    expected: 'The reset link opens.', actual: 'The reset link fails.',
    steps: [
      {
        kind: 'initial', id: 'S1', seq: 1, observedAt: '2026-09-20T12:00:00.100Z', elapsedMs: 100,
        sourceUrl: CART_URL, image: { status: 'retained', imageId: 'I1' },
      },
      {
        kind: 'click', id: 'S2', seq: 2, observedAt: '2026-09-20T12:00:01.000Z', elapsedMs: 1_000,
        sourceUrl: CART_URL,
        target: {
          tag: 'a', selectorPath: ['main', 'a'], label: 'Reset', editable: false,
          viewport: { width: 1280, height: 720 }, scroll: { x: 0, y: 0 }, point: { x: 10, y: 10 },
        },
        image: { status: 'unavailable', reason: 'superseded' },
      },
      {
        kind: 'navigation', id: 'S3', seq: 3, observedAt: '2026-09-20T12:00:01.100Z', elapsedMs: 1_100,
        sourceUrl: CART_URL, navigation: { toUrl, causedByStepId: 'S2' },
        image: { status: 'unavailable', reason: 'navigation-timeout' },
      },
    ],
    images: {
      I1: {
        capturedAt: '2026-09-20T12:00:00.100Z', captureUrl: CART_URL,
        width: 1, height: 1, byteLength: 69,
        dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+AvzvAAAAAElFTkSuQmCC',
        viewport: { width: 1280, height: 720 }, scroll: { x: 0, y: 0 },
      },
    },
    limitations: [],
  };
}

test('destination redaction removes the navigation URL from the manifest and Markdown', () => {
  // Redacting the next step's source URL alone leaves the destination visible.
  const sourceOnly = navigationDraft(RESET_URL);
  sourceOnly.steps.push({
    kind: 'click', id: 'S4', seq: 4, observedAt: '2026-09-20T12:00:02.000Z', elapsedMs: 2_000,
    sourceUrl: '[redacted]',
    target: {
      tag: 'button', selectorPath: ['button'], label: 'Save', editable: false,
      viewport: { width: 1280, height: 720 }, scroll: { x: 0, y: 0 }, point: { x: 10, y: 10 },
    },
    image: { status: 'unavailable', reason: 'superseded' },
  });
  sourceOnly.redactions = { steps: { S4: { sourceUrl: true } } };
  expect(formatJourneyMarkdown(journeyDraftToManifest(sourceOnly))).toContain('private-token-9q');

  const redacted: JourneyDraftV1 = {
    ...sourceOnly,
    steps: sourceOnly.steps.map(step => step.kind === 'navigation'
      ? { ...step, navigation: { ...step.navigation, toUrl: '[redacted]' } }
      : step),
    redactions: { steps: { S3: { toUrl: true }, S4: { sourceUrl: true } } },
  };
  const manifest = journeyDraftToManifest(redacted);
  const navigation = manifest.steps[2];
  if (navigation.kind !== 'navigation') throw new Error('missing navigation fixture');
  expect(navigation.navigation).toEqual({ toUrl: reviewed('[redacted]', true, true), causedByStepId: 'S2' });
  expect(navigation.sourceUrl).toEqual(reviewed(CART_URL));
  expect(JSON.stringify(manifest)).not.toContain('private-token-9q');

  const markdown = formatJourneyMarkdown(manifest);
  expect(markdown).toContain('Destination URL:\n```\n[redacted]\n```\nDestination URL review: Edited: Yes · Redacted: Yes');
  expect(markdown).not.toContain('private-token-9q');
  const archived = new TextDecoder().decode(journeyArchiveFiles([redacted])[0].data);
  expect(archived).toContain('Destination URL review: Edited: Yes · Redacted: Yes');
  expect(archived).not.toContain('private-token-9q');
  expect(journeyPromptSection([manifest])).not.toContain('private-token-9q');
});

test('prompt scope counts navigation destinations and compares redacted URLs as one opaque page', () => {
  const scope = (draft: JourneyDraftV1) => {
    const line = journeyPromptSection([journeyDraftToManifest(draft)]).split('\n').find(text => text.startsWith('- **Scope:**'));
    return line?.slice('- **Scope:** '.length);
  };
  const checkout = navigationDraft('https://shop.example/checkout');
  expect(checkout.steps.every(step => step.sourceUrl === CART_URL)).toBe(true);
  expect(scope(checkout)).toBe('Spans pages (full sequence in journeys.md)');
  expect(scope({ ...checkout, steps: checkout.steps.filter(step => step.kind !== 'navigation') })).toBe('Single page');

  expect(scope({ ...navigationDraft('[redacted]'), redactions: { steps: { S3: { toUrl: true } } } }))
    .toBe('Spans pages (full sequence in journeys.md)');
  const allRedacted = navigationDraft('[redacted]');
  allRedacted.steps = allRedacted.steps.map(step => ({ ...step, sourceUrl: '[redacted]' }));
  allRedacted.redactions = {
    steps: { S1: { sourceUrl: true }, S2: { sourceUrl: true }, S3: { sourceUrl: true, toUrl: true } },
  };
  expect(scope(allRedacted)).toBe('Single page');

  // Reviewed manifests may carry any replacement text for a redacted URL.
  const replaced = journeyDraftToManifest(allRedacted);
  replaced.steps[0].sourceUrl = reviewed('', true, true);
  expect(journeyPromptSection([replaced])).toContain('- **Scope:** Single page');
});

test('archive files reference deterministic PNG identities', () => {
  const files = journeyArchiveFiles([reviewedDraft()]);
  expect(files.map(file => file.name)).toEqual(['journeys.md', 'journey-2-J1-image-2-I2.png']);
  expect(new TextDecoder().decode(files[0].data)).toContain('## Journey 1');
  expect(files[1].data.length).toBe(69);
  expect(journeyExportByteLength([reviewedDraft()], 100)).toBe(100 + 69);

  const empty = journeyArchiveFiles([]);
  expect(empty).toEqual([]);
  expect(journeyExportByteLength([], 100)).toBe(100);
});

test('archive preflight rejects oversized exports before allocating', () => {
  const limit = JOURNEY_LIMITS.maxExportBytes;
  (JOURNEY_LIMITS as unknown as Record<string, unknown>).maxExportBytes = 200;
  try {
    expect(() => feedbackArchive([], 'preamble', [reviewedDraft()])).toThrow('exceeds the export size limit');
    expect(() => feedbackArchive([], 'preamble', [])).not.toThrow();
  } finally {
    (JOURNEY_LIMITS as unknown as Record<string, unknown>).maxExportBytes = limit;
  }
});
