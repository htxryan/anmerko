import { expect, test, type Page } from '@playwright/test';
import { buildSync } from 'esbuild';
import { JOURNEY_LIMITS } from '../../src/journey-limits';

type NormalizedImage = {
  dataUrl: string;
  width: number;
  height: number;
  byteLength: number;
};

type JourneyImageWindow = typeof globalThis & {
  anmerkoJourneyImage: {
    normalizeJourneyPng(dataUrl: string): Promise<NormalizedImage>;
  };
};

const bundle = buildSync({
  entryPoints: ['src/journey-image.ts'],
  bundle: true,
  write: false,
  format: 'iife',
  globalName: 'anmerkoJourneyImage',
}).outputFiles[0].text;

async function loadHelper(page: Page) {
  await page.goto('http://127.0.0.1:4173');
  await page.addScriptTag({ content: bundle });
}

test('normalizes solid PNGs to the longest-side limit without upscaling', async ({ page }) => {
  await loadHelper(page);

  const results = await page.evaluate(async () => {
    const createPng = (width: number, height: number, color: string) => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d')!;
      context.fillStyle = color;
      context.fillRect(0, 0, width, height);
      return canvas.toDataURL('image/png');
    };
    const inspect = async (image: NormalizedImage) => {
      const blob = await (await fetch(image.dataUrl)).blob();
      const bitmap = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(1, 1);
      const context = canvas.getContext('2d')!;
      context.drawImage(bitmap, 0, 0, 1, 1);
      const decodedWidth = bitmap.width;
      const decodedHeight = bitmap.height;
      bitmap.close();
      return {
        ...image,
        decodedWidth,
        decodedHeight,
        pixel: [...context.getImageData(0, 0, 1, 1).data],
      };
    };
    const api = (globalThis as JourneyImageWindow).anmerkoJourneyImage;
    return {
      small: await inspect(await api.normalizeJourneyPng(createPng(320, 180, '#ff0000'))),
      landscape: await inspect(await api.normalizeJourneyPng(createPng(3_000, 1_500, '#0000ff'))),
      portrait: await inspect(await api.normalizeJourneyPng(createPng(1_000, 2_500, '#00ff00'))),
    };
  });

  expect(results.small).toMatchObject({ width: 320, height: 180, decodedWidth: 320, decodedHeight: 180 });
  expect(results.landscape).toMatchObject({ width: 1_920, height: 960, decodedWidth: 1_920, decodedHeight: 960 });
  expect(results.portrait).toMatchObject({ width: 768, height: 1_920, decodedWidth: 768, decodedHeight: 1_920 });
  expect(results.small.pixel).toEqual([255, 0, 0, 255]);
  expect(results.landscape.pixel).toEqual([0, 0, 255, 255]);
  expect(results.portrait.pixel).toEqual([0, 255, 0, 255]);
  for (const image of Object.values(results)) {
    expect(image.dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(image.byteLength).toBeLessThanOrEqual(JOURNEY_LIMITS.maxImageBytes);
    expect(image.byteLength).toBe(Math.floor(image.dataUrl.slice(image.dataUrl.indexOf(',') + 1).length * 3 / 4) - Number(image.dataUrl.endsWith('=')) - Number(image.dataUrl.endsWith('==')));
  }
});

test('rejects malformed, non-PNG, and clearly unbounded inputs before decoding', async ({ page }) => {
  await loadHelper(page);

  const results = await page.evaluate(async maxSessionBytes => {
    const api = (globalThis as JourneyImageWindow).anmerkoJourneyImage;
    const originalCreateImageBitmap = globalThis.createImageBitmap;
    let decodeCalls = 0;
    globalThis.createImageBitmap = (() => {
      decodeCalls++;
      throw new Error('Unexpected image decode');
    }) as typeof createImageBitmap;
    const reject = async (dataUrl: string) => {
      try {
        await api.normalizeJourneyPng(dataUrl);
        return { accepted: true };
      } catch (error) {
        return {
          accepted: false,
          name: error instanceof Error ? error.name : '',
          reason: error && typeof error === 'object' && 'reason' in error ? error.reason : undefined,
        };
      }
    };
    try {
      return {
        malformed: await reject('data:image/png;base64,not-valid-base64!'),
        wrongType: await reject('data:text/plain;base64,aGVsbG8='),
        truncatedPng: await reject('data:image/png;base64,iVBORw0KGgo='),
        unbounded: await reject(`data:image/png;base64,${'A'.repeat(Math.ceil((maxSessionBytes + 1) / 3) * 4)}`),
        decodeCalls,
      };
    } finally {
      globalThis.createImageBitmap = originalCreateImageBitmap;
    }
  }, JOURNEY_LIMITS.maxSessionBytes);

  for (const result of [results.malformed, results.wrongType, results.truncatedPng, results.unbounded]) {
    expect(result).toEqual({ accepted: false, name: 'JourneyImageError', reason: 'capture-error' });
  }
  expect(results.decodeCalls).toBe(0);
});

test('maps a PNG decoder rejection to a typed capture error', async ({ page }) => {
  await loadHelper(page);

  const result = await page.evaluate(async () => {
    const truncatedPngWithHeader = new Uint8Array([
      137, 80, 78, 71, 13, 10, 26, 10,
      0, 0, 0, 13, 73, 72, 68, 82,
      0, 0, 0, 1, 0, 0, 0, 1,
    ]);
    const dataUrl = `data:image/png;base64,${btoa(String.fromCharCode(...truncatedPngWithHeader))}`;
    try {
      await (globalThis as JourneyImageWindow).anmerkoJourneyImage.normalizeJourneyPng(dataUrl);
      return { accepted: true };
    } catch (error) {
      return {
        accepted: false,
        name: error instanceof Error ? error.name : '',
        reason: error && typeof error === 'object' && 'reason' in error ? error.reason : undefined,
      };
    }
  });

  expect(result).toEqual({ accepted: false, name: 'JourneyImageError', reason: 'capture-error' });
});

test('rejects a valid detailed PNG when normalized output exceeds the image budget', async ({ page }) => {
  await loadHelper(page);

  const result = await page.evaluate(async () => {
    const size = 1_000;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d')!;
    const pixels = context.createImageData(size, size);
    let state = 0x9e3779b9;
    for (let index = 0; index < pixels.data.length; index += 4) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      pixels.data[index] = state & 0xff;
      pixels.data[index + 1] = (state >>> 8) & 0xff;
      pixels.data[index + 2] = (state >>> 16) & 0xff;
      pixels.data[index + 3] = 255;
    }
    context.putImageData(pixels, 0, 0);
    try {
      await (globalThis as JourneyImageWindow).anmerkoJourneyImage.normalizeJourneyPng(canvas.toDataURL('image/png'));
      return { accepted: true };
    } catch (error) {
      return {
        accepted: false,
        name: error instanceof Error ? error.name : '',
        reason: error && typeof error === 'object' && 'reason' in error ? error.reason : undefined,
      };
    }
  });

  expect(result).toEqual({ accepted: false, name: 'JourneyImageError', reason: 'too-large' });
});
