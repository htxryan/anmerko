import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { assertJourneyArchive } from '../shared/expected-feedback.ts';

const bundlePath = join(tmpdir(), `anmerko-journey-export-${process.pid}.cjs`);
writeFileSync(
  bundlePath,
  buildSync({ entryPoints: ['src/export.ts'], bundle: true, write: false, format: 'cjs', platform: 'node' }).outputFiles[0].text,
);
const { feedbackArchive } = createRequire(import.meta.url)(bundlePath);

const MINIMAL_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+AvzvAAAAAElFTkSuQmCC';
const MINIMAL_PNG_DATA_URL = `data:image/png;base64,${MINIMAL_PNG_BASE64}`;
const MINIMAL_PNG_BYTES = Buffer.from(MINIMAL_PNG_BASE64, 'base64');

const note = {
  id: 'note-1',
  pageUrl: 'https://example.com/shop?item=green',
  pageTitle: 'Shop',
  comment: 'Make this headline clearer.',
  createdAt: '2026-09-20T12:00:00.000Z',
  updatedAt: '2026-09-20T12:00:00.000Z',
  element: {
    tag: 'h1',
    selectorPath: ['#hero-title'],
    text: 'Sale',
    viewport: { width: 1280, height: 720 },
  },
  screenshot: {
    dataUrl: MINIMAL_PNG_DATA_URL,
    width: 1,
    height: 1,
    region: { x: 0, y: 0, width: 1, height: 1 },
    viewport: { width: 1280, height: 720 },
    scroll: { x: 0, y: 0 },
  },
};

function draft() {
  return {
    schemaVersion: 1,
    status: 'draft',
    id: 'journey-9f8a',
    revision: 2,
    createdAt: '2026-09-20T12:00:00.000Z',
    updatedAt: '2026-09-20T12:00:04.000Z',
    startedAt: '2026-09-20T12:00:00.000Z',
    stoppedAt: '2026-09-20T12:00:04.000Z',
    includeEnteredValues: false,
    stopReason: 'user',
    expected: 'The cart keeps its item.',
    actual: 'Checkout is empty.',
    steps: [
      {
        kind: 'click', id: 'step-1', seq: 1, observedAt: '2026-09-20T12:00:01.000Z', elapsedMs: 1000,
        sourceUrl: 'https://shop.example/items?q=green',
        target: {
          tag: 'button', selectorPath: ['button'], label: 'Checkout', editable: false,
          viewport: { width: 1280, height: 720 }, scroll: { x: 0, y: 0 },
        },
        image: { status: 'retained', imageId: 'image-1', sharedNavigationResult: true },
      },
      {
        kind: 'navigation', id: 'step-2', seq: 2, observedAt: '2026-09-20T12:00:01.500Z', elapsedMs: 1500,
        sourceUrl: 'https://shop.example/items?q=green',
        navigation: { toUrl: 'https://shop.example/pay?q=green', causedByStepId: 'step-1' },
        image: { status: 'retained', imageId: 'image-1', sharedNavigationResult: true },
      },
      {
        kind: 'click', id: 'step-3', seq: 4, observedAt: '2026-09-20T12:00:03.000Z', elapsedMs: 3000,
        sourceUrl: 'https://shop.example/pay?q=green',
        target: {
          tag: 'button', selectorPath: ['button'], label: 'Pay', editable: false,
          viewport: { width: 1280, height: 720 }, scroll: { x: 0, y: 0 },
        },
        image: { status: 'removed' },
      },
    ],
    images: {
      'image-1': {
        capturedAt: '2026-09-20T12:00:01.600Z',
        captureUrl: 'https://shop.example/pay?q=green',
        width: 1,
        height: 1,
        byteLength: 69,
        dataUrl: MINIMAL_PNG_DATA_URL,
        viewport: { width: 1280, height: 720 },
        scroll: { x: 0, y: 0 },
      },
    },
    limitations: [],
  };
}

function readTexts(zip) {
  const end = zip.length - 22;
  const count = zip.readUInt16LE(end + 10);
  let offset = zip.readUInt32LE(end + 16);
  const texts = new Map();
  for (let i = 0; i < count; i++) {
    const nameLength = zip.readUInt16LE(offset + 28);
    const name = zip.toString('utf8', offset + 46, offset + 46 + nameLength);
    const local = zip.readUInt32LE(offset + 42);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const size = zip.readUInt32LE(offset + 20);
    texts.set(name, zip.subarray(start, start + size).toString('utf8'));
    offset += 46 + nameLength + zip.readUInt16LE(offset + 30) + zip.readUInt16LE(offset + 32);
  }
  return texts;
}

test('static-only archives are byte-identical with or without the journeys argument', () => {
  const without = Buffer.from(feedbackArchive([note], 'preamble'));
  const empty = Buffer.from(feedbackArchive([note], 'preamble', []));
  assert.deepEqual(without, empty);
});

test('mixed archives validate prompt, journeys document, and PNG bytes', () => {
  const first = Buffer.from(feedbackArchive([note], 'preamble', [draft()]));
  const second = Buffer.from(feedbackArchive([note], 'preamble', [draft()]));
  assert.deepEqual(first, second);

  const texts = readTexts(first);
  const commentsMd = texts.get('comments.md');
  const journeysMd = texts.get('journeys.md');
  assert.ok(commentsMd.includes('Make this headline clearer.'));
  assert.ok(commentsMd.includes('## Recorded journeys'));
  assert.ok(commentsMd.includes('### Journey 1'));
  assert.ok(commentsMd.includes('The cart keeps its item.'));
  assert.ok(!commentsMd.includes('data:image/png'));
  assert.ok(journeysMd.includes('## Journey 1'));
  assert.ok(journeysMd.includes('### Step 1'));
  assert.ok(journeysMd.includes('### Step 2'));
  assert.ok(!journeysMd.includes('### Step 3'));
  assert.ok(journeysMd.includes('Screenshot: removed during review'));
  assert.ok(journeysMd.includes('https://shop.example/pay?q=green'));

  const imageName = 'journey-12-journey-9f8a-image-7-image-1.png';
  assertJourneyArchive(first, {
    commentsMd,
    journeysMd,
    pngs: new Map([
      ['screenshot-note-1.png', MINIMAL_PNG_BYTES],
      [imageName, MINIMAL_PNG_BYTES],
    ]),
  });
});
