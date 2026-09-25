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
    inspectNormalizedJourneyPng(dataUrl: string): {
      width: number;
      height: number;
      byteLength: number;
    };
    maskJourneyPng(
      dataUrl: string,
      rect: { x: number; y: number; width: number; height: number },
    ): Promise<NormalizedImage>;
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

test('inspects bounded normalized PNG metadata without decoding image pixels', async ({ page }) => {
  await loadHelper(page);

  const result = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 37;
    canvas.height = 19;
    const dataUrl = canvas.toDataURL('image/png');
    const payload = dataUrl.slice(dataUrl.indexOf(',') + 1);
    const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
    const expectedBytes = payload.length / 4 * 3 - padding;
    const originalCreateImageBitmap = globalThis.createImageBitmap;
    let decodeCalls = 0;
    globalThis.createImageBitmap = (() => {
      decodeCalls += 1;
      throw new Error('Unexpected decode');
    }) as typeof createImageBitmap;
    try {
      return {
        inspected: (globalThis as JourneyImageWindow).anmerkoJourneyImage.inspectNormalizedJourneyPng(dataUrl),
        expectedBytes,
        decodeCalls,
      };
    } finally {
      globalThis.createImageBitmap = originalCreateImageBitmap;
    }
  });

  expect(result.inspected).toEqual({ width: 37, height: 19, byteLength: result.expectedBytes });
  expect(result.decodeCalls).toBe(0);
});

test('inspector rejects external, oversized, and over-dimensioned inputs before image decode', async ({ page }) => {
  await loadHelper(page);

  const result = await page.evaluate(maxImageBytes => {
    const api = (globalThis as JourneyImageWindow).anmerkoJourneyImage;
    const originalCreateImageBitmap = globalThis.createImageBitmap;
    let decodeCalls = 0;
    globalThis.createImageBitmap = (() => {
      decodeCalls += 1;
      throw new Error('Unexpected decode');
    }) as typeof createImageBitmap;
    const header = (width: number, height: number) => {
      const bytes = new Uint8Array([
        137, 80, 78, 71, 13, 10, 26, 10,
        0, 0, 0, 13, 73, 72, 68, 82,
        width >>> 24, width >>> 16, width >>> 8, width,
        height >>> 24, height >>> 16, height >>> 8, height,
      ]);
      return `data:image/png;base64,${btoa(String.fromCharCode(...bytes))}`;
    };
    const inspect = (dataUrl: string) => {
      try {
        api.inspectNormalizedJourneyPng(dataUrl);
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
        external: inspect('https://example.test/private.png'),
        oversized: inspect(`data:image/png;base64,${'A'.repeat(Math.ceil((maxImageBytes + 1) / 3) * 4)}`),
        tooWide: inspect(header(1_921, 1)),
        decodeCalls,
      };
    } finally {
      globalThis.createImageBitmap = originalCreateImageBitmap;
    }
  }, JOURNEY_LIMITS.maxImageBytes);

  for (const item of [result.external, result.oversized, result.tooWide]) {
    expect(item).toEqual({ accepted: false, name: 'JourneyImageError', reason: 'capture-error' });
  }
  expect(result.decodeCalls).toBe(0);
});

test('masks every fractionally covered pixel with opaque black and preserves the rest', async ({ page }) => {
  await loadHelper(page);

  const result = await page.evaluate(async () => {
    const source = document.createElement('canvas');
    source.width = 4;
    source.height = 3;
    const sourceContext = source.getContext('2d')!;
    const pixels = sourceContext.createImageData(4, 3);
    for (let index = 0; index < 12; index++) {
      pixels.data[index * 4] = 10 + index;
      pixels.data[index * 4 + 1] = 40 + index;
      pixels.data[index * 4 + 2] = 80 + index;
      pixels.data[index * 4 + 3] = 255;
    }
    sourceContext.putImageData(pixels, 0, 0);

    const masked = await (globalThis as JourneyImageWindow).anmerkoJourneyImage.maskJourneyPng(
      source.toDataURL('image/png'),
      { x: 1.2, y: 0.8, width: 1.1, height: 1.2 },
    );
    const bitmap = await createImageBitmap(await (await fetch(masked.dataUrl)).blob());
    const decoded = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = decoded.getContext('2d')!;
    context.drawImage(bitmap, 0, 0);
    const output = [...context.getImageData(0, 0, bitmap.width, bitmap.height).data];
    bitmap.close();
    return { masked, output };
  });

  expect(result.masked).toMatchObject({ width: 4, height: 3 });
  expect(result.masked.dataUrl).toMatch(/^data:image\/png;base64,/);
  expect(result.masked.byteLength).toBeLessThanOrEqual(JOURNEY_LIMITS.maxImageBytes);
  const pixel = (x: number, y: number) => result.output.slice((y * 4 + x) * 4, (y * 4 + x + 1) * 4);
  for (const [x, y] of [[1, 0], [2, 0], [1, 1], [2, 1]]) {
    expect(pixel(x, y)).toEqual([0, 0, 0, 255]);
  }
  expect(pixel(0, 0)).toEqual([10, 40, 80, 255]);
  expect(pixel(3, 1)).toEqual([17, 47, 87, 255]);
  expect(pixel(2, 2)).toEqual([20, 50, 90, 255]);
});

test('rejects invalid mask geometry before decoding pixels', async ({ page }) => {
  await loadHelper(page);

  const result = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 4;
    canvas.height = 3;
    const dataUrl = canvas.toDataURL('image/png');
    const api = (globalThis as JourneyImageWindow).anmerkoJourneyImage;
    const originalCreateImageBitmap = globalThis.createImageBitmap;
    let decodeCalls = 0;
    globalThis.createImageBitmap = (() => {
      decodeCalls += 1;
      throw new Error('Unexpected decode');
    }) as typeof createImageBitmap;
    const reject = async (rect: { x: number; y: number; width: number; height: number }) => {
      try {
        await api.maskJourneyPng(dataUrl, rect);
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
        results: await Promise.all([
          reject({ x: -0.01, y: 0, width: 1, height: 1 }),
          reject({ x: 0, y: 0, width: 0, height: 1 }),
          reject({ x: 0, y: 0, width: 1, height: Number.NaN }),
          reject({ x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 1 }),
          reject({ x: 1, y: 0, width: Number.MIN_VALUE, height: 1 }),
          reject({ x: 0, y: 1, width: 1, height: Number.MIN_VALUE }),
          reject({ x: 3.5, y: 0, width: 0.6, height: 1 }),
          reject({ x: 0, y: 2.5, width: 1, height: 0.6 }),
        ]),
        decodeCalls,
      };
    } finally {
      globalThis.createImageBitmap = originalCreateImageBitmap;
    }
  });

  for (const item of result.results) {
    expect(item).toEqual({ accepted: false, name: 'JourneyImageError', reason: 'capture-error' });
  }
  expect(result.decodeCalls).toBe(0);
});

test('rejects malformed, oversized, and non-normalized PNG inputs before decoding', async ({ page }) => {
  await loadHelper(page);

  const result = await page.evaluate(async maxImageBytes => {
    const api = (globalThis as JourneyImageWindow).anmerkoJourneyImage;
    const originalCreateImageBitmap = globalThis.createImageBitmap;
    let decodeCalls = 0;
    globalThis.createImageBitmap = (() => {
      decodeCalls += 1;
      throw new Error('Unexpected decode');
    }) as typeof createImageBitmap;
    const header = (width: number, height: number) => {
      const bytes = new Uint8Array([
        137, 80, 78, 71, 13, 10, 26, 10,
        0, 0, 0, 13, 73, 72, 68, 82,
        width >>> 24, width >>> 16, width >>> 8, width,
        height >>> 24, height >>> 16, height >>> 8, height,
      ]);
      return `data:image/png;base64,${btoa(String.fromCharCode(...bytes))}`;
    };
    const reject = async (dataUrl: string) => {
      try {
        await api.maskJourneyPng(dataUrl, { x: 0, y: 0, width: 1, height: 1 });
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
        malformed: await reject('data:image/png;base64,not-valid!'),
        oversized: await reject(`data:image/png;base64,${'A'.repeat(Math.ceil((maxImageBytes + 1) / 3) * 4)}`),
        tooWide: await reject(header(1_921, 1)),
        decodeCalls,
      };
    } finally {
      globalThis.createImageBitmap = originalCreateImageBitmap;
    }
  }, JOURNEY_LIMITS.maxImageBytes);

  for (const item of [result.malformed, result.oversized, result.tooWide]) {
    expect(item).toEqual({ accepted: false, name: 'JourneyImageError', reason: 'capture-error' });
  }
  expect(result.decodeCalls).toBe(0);
});

test('maps decoder, encoder, and oversized output failures to typed errors', async ({ page }) => {
  await loadHelper(page);

  const result = await page.evaluate(async maxImageBytes => {
    const canvas = document.createElement('canvas');
    canvas.width = 2;
    canvas.height = 2;
    const dataUrl = canvas.toDataURL('image/png');
    const api = (globalThis as JourneyImageWindow).anmerkoJourneyImage;
    const originalCreateImageBitmap = globalThis.createImageBitmap;
    const originalConvertToBlob = OffscreenCanvas.prototype.convertToBlob;
    const reject = async () => {
      try {
        await api.maskJourneyPng(dataUrl, { x: 0, y: 0, width: 1, height: 1 });
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
      globalThis.createImageBitmap = (() => Promise.reject(new Error('decode failed'))) as typeof createImageBitmap;
      const decode = await reject();
      globalThis.createImageBitmap = originalCreateImageBitmap;
      OffscreenCanvas.prototype.convertToBlob = (() => Promise.reject(new Error('encode failed'))) as typeof originalConvertToBlob;
      const encode = await reject();
      OffscreenCanvas.prototype.convertToBlob = (() => Promise.resolve(
        new Blob([new Uint8Array(maxImageBytes + 1)], { type: 'image/png' }),
      )) as typeof originalConvertToBlob;
      const oversizedOutput = await reject();
      return { decode, encode, oversizedOutput };
    } finally {
      globalThis.createImageBitmap = originalCreateImageBitmap;
      OffscreenCanvas.prototype.convertToBlob = originalConvertToBlob;
    }
  }, JOURNEY_LIMITS.maxImageBytes);

  expect(result.decode).toEqual({ accepted: false, name: 'JourneyImageError', reason: 'capture-error' });
  expect(result.encode).toEqual({ accepted: false, name: 'JourneyImageError', reason: 'capture-error' });
  expect(result.oversizedOutput).toEqual({ accepted: false, name: 'JourneyImageError', reason: 'too-large' });
});

test('closes decoded bitmaps and releases canvases after success and encoder failure', async ({ page }) => {
  await loadHelper(page);

  const result = await page.evaluate(async () => {
    const source = document.createElement('canvas');
    source.width = 3;
    source.height = 2;
    const dataUrl = source.toDataURL('image/png');
    const api = (globalThis as JourneyImageWindow).anmerkoJourneyImage;
    const NativeOffscreenCanvas = globalThis.OffscreenCanvas;
    const nativeClose = ImageBitmap.prototype.close;
    const nativeConvertToBlob = OffscreenCanvas.prototype.convertToBlob;
    const canvases: OffscreenCanvas[] = [];
    let closeCalls = 0;
    const TrackingCanvas = function(width: number, height: number) {
      const canvas = new NativeOffscreenCanvas(width, height);
      canvases.push(canvas);
      return canvas;
    } as unknown as typeof OffscreenCanvas;
    TrackingCanvas.prototype = NativeOffscreenCanvas.prototype;
    globalThis.OffscreenCanvas = TrackingCanvas;
    ImageBitmap.prototype.close = function() {
      closeCalls += 1;
      return nativeClose.call(this);
    };
    try {
      await api.maskJourneyPng(dataUrl, { x: 0, y: 0, width: 1, height: 1 });
      const afterSuccess = {
        closeCalls,
        canvas: { width: canvases[0]?.width, height: canvases[0]?.height },
      };
      NativeOffscreenCanvas.prototype.convertToBlob = (() => Promise.reject(new Error('encode failed'))) as typeof nativeConvertToBlob;
      try { await api.maskJourneyPng(dataUrl, { x: 1, y: 0, width: 1, height: 1 }); } catch { /* Expected. */ }
      return {
        afterSuccess,
        afterFailure: {
          closeCalls,
          canvas: { width: canvases[1]?.width, height: canvases[1]?.height },
        },
      };
    } finally {
      globalThis.OffscreenCanvas = NativeOffscreenCanvas;
      ImageBitmap.prototype.close = nativeClose;
      NativeOffscreenCanvas.prototype.convertToBlob = nativeConvertToBlob;
    }
  });

  expect(result.afterSuccess).toEqual({ closeCalls: 1, canvas: { width: 0, height: 0 } });
  expect(result.afterFailure).toEqual({ closeCalls: 2, canvas: { width: 0, height: 0 } });
});
