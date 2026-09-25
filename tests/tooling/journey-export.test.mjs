import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { assertFeedbackArchive, assertJourneyArchive } from '../shared/expected-feedback.ts';

const bundlePath = join(tmpdir(), `anmerko-journey-export-${process.pid}.cjs`);
writeFileSync(bundlePath, buildSync({
  stdin: {
    contents: `export { buildPrompt } from './src/core';
      export { feedbackArchive } from './src/export';
      export { journeyArchive, journeyArchiveName, journeyDraftToManifest, journeyPrompt } from './src/journey-export';`,
    resolveDir: process.cwd(),
  },
  bundle: true, write: false, format: 'cjs', platform: 'node',
}).outputFiles[0].text);
const { buildPrompt, feedbackArchive, journeyArchive, journeyArchiveName, journeyDraftToManifest, journeyPrompt } =
  createRequire(import.meta.url)(bundlePath);

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

test('comment archives hold only comments.md and their screenshots', () => {
  assert.equal(feedbackArchive.length, 2);
  const zip = Buffer.from(feedbackArchive([note], 'preamble'));
  const prompt = buildPrompt([note], 'preamble');
  assert.ok(prompt.includes('1 comment across 1 page.'));
  assert.ok(!prompt.includes('journey'));
  assertFeedbackArchive(zip, prompt, MINIMAL_PNG_BYTES);
});

test('journey archives hold the copied prompt, journeys document, and PNG bytes, and nothing comment-related', () => {
  const first = Buffer.from(journeyArchive(draft()));
  const second = Buffer.from(journeyArchive(draft()));
  assert.deepEqual(first, second);
  assert.equal(journeyArchiveName(draft().id, draft().revision), 'anmerko-journey-9f8a-r2.zip');

  const texts = readTexts(first);
  assert.deepEqual([...texts.keys()], ['prompt.md', 'journeys.md', 'journey-9f8a-step-01.png']);
  const promptMd = texts.get('prompt.md');
  const journeysMd = texts.get('journeys.md');
  assert.equal(promptMd, journeyPrompt(journeyDraftToManifest(draft())));
  assert.ok(promptMd.startsWith('# Recorded journey\n'));
  assert.ok(promptMd.includes('The cart keeps its item.'));
  assert.ok(promptMd.includes('- **Step 2 · Navigation** from `https://shop.example/items?q=green` to `https://shop.example/pay?q=green`, caused by step 1 · screenshot `journey-9f8a-step-01.png`'));
  assert.ok(promptMd.includes('- **Step 4 · Click** `Pay` (`button`) on `https://shop.example/pay?q=green` · no screenshot (removed during review)'));
  for (const text of [promptMd, journeysMd]) {
    assert.ok(!/comment/i.test(text));
    assert.ok(!text.includes('data:image/png'));
  }
  assert.ok(journeysMd.includes('## Journey 1'));
  assert.ok(journeysMd.includes('### Step 1'));
  assert.ok(journeysMd.includes('### Step 2'));
  assert.ok(!journeysMd.includes('### Step 3'));
  assert.ok(journeysMd.includes('Screenshot: removed during review'));
  assert.ok(journeysMd.includes('https://shop.example/pay?q=green'));

  assertJourneyArchive(first, {
    promptMd,
    journeysMd,
    pngs: new Map([['journey-9f8a-step-01.png', MINIMAL_PNG_BYTES]]),
  });
});
