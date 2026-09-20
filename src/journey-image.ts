import { JOURNEY_LIMITS } from './journey-limits';

export type JourneyImageErrorReason = 'capture-error' | 'too-large';

export class JourneyImageError extends Error {
  readonly reason: JourneyImageErrorReason;

  constructor(reason: JourneyImageErrorReason, message: string) {
    super(message);
    this.name = 'JourneyImageError';
    this.reason = reason;
  }
}

export interface NormalizedJourneyPng {
  dataUrl: string;
  width: number;
  height: number;
  byteLength: number;
}

const PNG_DATA_URL_PREFIX = 'data:image/png;base64,';
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;
const MAX_SOURCE_SIDE = JOURNEY_LIMITS.maxImageLongestSide * 8;
const MAX_SOURCE_PIXELS = JOURNEY_LIMITS.maxImageLongestSide ** 2 * 16;

function captureError(message: string): JourneyImageError {
  return new JourneyImageError('capture-error', message);
}

function decodedLength(base64: string): number {
  if (!base64.length || base64.length % 4 !== 0) throw captureError('Screenshot data is not valid base64.');
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return base64.length / 4 * 3 - padding;
}

function decodeBoundedPng(dataUrl: string): Uint8Array<ArrayBuffer> {
  if (!dataUrl.startsWith(PNG_DATA_URL_PREFIX)) throw captureError('Screenshot must be a PNG data URL.');
  const payload = dataUrl.slice(PNG_DATA_URL_PREFIX.length);
  const maxEncodedLength = Math.ceil(JOURNEY_LIMITS.maxSessionBytes / 3) * 4;
  if (payload.length > maxEncodedLength) throw captureError('Screenshot input exceeds the capture limit.');
  const byteLength = decodedLength(payload);
  if (byteLength > JOURNEY_LIMITS.maxSessionBytes) throw captureError('Screenshot input exceeds the capture limit.');
  if (!/^[A-Za-z\d+/]*={0,2}$/.test(payload)) throw captureError('Screenshot data is not valid base64.');

  let binary: string;
  try {
    binary = atob(payload);
  } catch {
    throw captureError('Screenshot data is not valid base64.');
  }
  if (binary.length !== byteLength) throw captureError('Screenshot data has an invalid length.');
  const bytes = new Uint8Array(byteLength);
  for (let index = 0; index < byteLength; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function readPngDimensions(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.length < 24 || PNG_SIGNATURE.some((byte, index) => bytes[index] !== byte)) {
    throw captureError('Screenshot data is not a PNG.');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const isIhdr = view.getUint32(8) === 13
    && bytes[12] === 73 && bytes[13] === 72 && bytes[14] === 68 && bytes[15] === 82;
  if (!isIhdr) throw captureError('Screenshot PNG is missing its image header.');
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (!width || !height || width > MAX_SOURCE_SIDE || height > MAX_SOURCE_SIDE
    || width * height > MAX_SOURCE_PIXELS) {
    throw captureError('Screenshot dimensions exceed the decoder limit.');
  }
  return { width, height };
}

function destinationSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, JOURNEY_LIMITS.maxImageLongestSide / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

async function pngDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunkSize = 32_768;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return `${PNG_DATA_URL_PREFIX}${btoa(binary)}`;
}

export async function normalizeJourneyPng(dataUrl: string): Promise<NormalizedJourneyPng> {
  if (typeof dataUrl !== 'string') throw captureError('Screenshot must be a PNG data URL.');
  const bytes = decodeBoundedPng(dataUrl);
  const source = readPngDimensions(bytes);
  let bitmap: ImageBitmap | undefined;

  try {
    bitmap = await createImageBitmap(new Blob([bytes.buffer], { type: 'image/png' }));
    if (bitmap.width !== source.width || bitmap.height !== source.height) {
      throw captureError('Screenshot dimensions do not match its PNG header.');
    }
    const size = destinationSize(bitmap.width, bitmap.height);
    const canvas = new OffscreenCanvas(size.width, size.height);
    const context = canvas.getContext('2d');
    if (!context) throw captureError('Screenshot canvas is unavailable.');
    context.drawImage(bitmap, 0, 0, size.width, size.height);
    const output = await canvas.convertToBlob({ type: 'image/png' });
    if (output.type !== 'image/png' || output.size < PNG_SIGNATURE.length) {
      throw captureError('Screenshot encoder did not return a PNG.');
    }
    if (output.size > JOURNEY_LIMITS.maxImageBytes) {
      throw new JourneyImageError('too-large', 'Normalized screenshot exceeds the 768 KiB image limit.');
    }
    return {
      dataUrl: await pngDataUrl(output),
      width: size.width,
      height: size.height,
      byteLength: output.size,
    };
  } catch (error) {
    if (error instanceof JourneyImageError) throw error;
    throw captureError('Screenshot could not be decoded or normalized.');
  } finally {
    bitmap?.close();
  }
}
