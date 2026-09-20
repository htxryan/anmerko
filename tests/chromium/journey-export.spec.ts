import { expect, test } from '@playwright/test';
import type { JourneyDraftV1, JourneyManifestV1, ReviewedText, SafeTarget } from '../../src/journey-core';
import { formatJourneyMarkdown, journeyImageFilename } from '../../src/journey-export';

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
