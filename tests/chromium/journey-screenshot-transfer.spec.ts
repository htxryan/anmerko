import { expect, test } from '@playwright/test';
import type { JourneyDraftImage, JourneySession } from '../../src/journey-core';
import { createJourneyScreenshotTokens } from '../../src/journey-screenshot-transfer';

const image = (dataUrl?: string): JourneyDraftImage => ({
  capturedAt: '2026-09-20T12:00:00.000Z', captureUrl: 'https://shop.example/', width: 1, height: 1, byteLength: 69,
  viewport: { width: 1280, height: 720 }, scroll: { x: 0, y: 0 }, ...dataUrl === undefined ? {} : { dataUrl },
});

const reviewing = (images: Record<string, JourneyDraftImage>): JourneySession => ({
  phase: 'reviewing', epoch: 2, sessionId: 'S', journeyId: 'J1', ownerTabId: 1, ownerWindowId: 1,
  warningAt: '2026-09-20T12:28:00.000Z', expiresAt: '2026-09-20T12:30:00.000Z',
  draft: {
    schemaVersion: 1, status: 'draft', id: 'J1', revision: 3, createdAt: '2026-09-20T12:00:00.000Z',
    updatedAt: '2026-09-20T12:00:00.000Z', startedAt: '2026-09-20T12:00:00.000Z', includeEnteredValues: false,
    expected: '', actual: '', steps: [], images, limitations: [],
  },
});

// Which screenshots a reply carries, by image ID, and the token it names each with.
function sent(reply: ReturnType<ReturnType<typeof createJourneyScreenshotTokens>>) {
  const images = 'draft' in reply.state ? reply.state.draft.images : {};
  return Object.fromEntries(Object.entries(images).map(([imageId, value]) => [imageId, { dataUrl: value.dataUrl ?? null, token: reply.tokens[imageId] ?? null }]));
}

test('a review read leaves out the screenshots its view holds and sends each one that changed', () => {
  let issued = 0;
  const read = createJourneyScreenshotTokens(() => `token-${++issued}`);
  const first = reviewing({ I1: image('data:image/png;base64,ONE'), I2: image('data:image/png;base64,TWO') });
  // A view that holds nothing gets every screenshot, each named by a token.
  expect(sent(read(first, []))).toEqual({
    I1: { dataUrl: 'data:image/png;base64,ONE', token: 'token-1' },
    I2: { dataUrl: 'data:image/png;base64,TWO', token: 'token-2' },
  });
  // Naming what it holds, the view gets their metadata alone.
  const again = read(first, ['token-1', 'token-2']);
  expect(sent(again)).toEqual({ I1: { dataUrl: null, token: 'token-1' }, I2: { dataUrl: null, token: 'token-2' } });
  expect(again.state).toMatchObject({ phase: 'reviewing', draft: { id: 'J1', images: { I1: { width: 1, byteLength: 69 } } } });
  // The session itself is never changed.
  expect(first.phase === 'reviewing' && first.draft.images.I1.dataUrl).toBe('data:image/png;base64,ONE');

  // A mask replaces one data URL: it gets a new token and is sent again;
  // the old token is never honoured for it.
  const masked = reviewing({ I1: image('data:image/png;base64,MASKED'), I2: image('data:image/png;base64,TWO') });
  expect(sent(read(masked, ['token-1', 'token-2']))).toEqual({
    I1: { dataUrl: 'data:image/png;base64,MASKED', token: 'token-3' },
    I2: { dataUrl: null, token: 'token-2' },
  });
  // A removed screenshot's token is forgotten, and so is every token once
  // the review ends: a new review sends its screenshots again.
  expect(sent(read(reviewing({ I2: image('data:image/png;base64,TWO') }), ['token-3', 'token-2']))).toEqual({
    I2: { dataUrl: null, token: 'token-2' },
  });
  expect(read({ phase: 'idle', epoch: 3 }, ['token-2'])).toEqual({ state: { phase: 'idle', epoch: 3 }, tokens: {} });
  expect(sent(read(reviewing({ I2: image('data:image/png;base64,TWO') }), ['token-2']))).toEqual({
    I2: { dataUrl: 'data:image/png;base64,TWO', token: 'token-4' },
  });
});

test('a review read ignores held tokens it never issued or cannot read, and names no screenshot it does not send', () => {
  const read = createJourneyScreenshotTokens(() => 'issued');
  const state = reviewing({ I1: image('data:image/png;base64,ONE'), I2: image() });
  for (const held of [undefined, null, 'issued', { issued: true }, [7, null], ['other']]) {
    expect(sent(read(state, held)), JSON.stringify(held)).toEqual({
      I1: { dataUrl: 'data:image/png;base64,ONE', token: 'issued' },
      // Metadata without pixels (a recording read) has nothing to hold.
      I2: { dataUrl: null, token: null },
    });
  }
});
