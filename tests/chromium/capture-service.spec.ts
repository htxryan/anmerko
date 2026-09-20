import { expect, test } from '@playwright/test';
import { createCaptureService } from '../../src/capture-service';

test('all screenshot clients share a 600 ms minimum between API starts', async () => {
  let now = 1_000;
  const starts: number[] = [];
  const service = createCaptureService(async windowId => {
    starts.push(now);
    return `image:${windowId}`;
  }, () => now);

  expect(await service.capture(1)).toBe('image:1');
  now = 1_599;
  expect(service.waitMs()).toBe(1);
  await expect(service.capture(2)).rejects.toThrow('Wait a moment');
  now = 1_600;
  expect(await service.capture(2)).toBe('image:2');
  expect(starts).toEqual([1_000, 1_600]);
});

test('a pending screenshot has no competing API call or unbounded queue', async () => {
  let resolve!: (value: string) => void;
  let now = 1_000;
  const service = createCaptureService(() => new Promise<string>(done => { resolve = done; }), () => now);
  const first = service.capture(1);
  now = 2_000;
  await expect(service.capture(2)).rejects.toThrow('Wait a moment');
  resolve('first');
  expect(await first).toBe('first');
  expect(service.waitMs()).toBe(0);
});

test('failed capture releases the lock but preserves the rate limit', async () => {
  let now = 1_000;
  let fails = true;
  const service = createCaptureService(async () => {
    if (fails) throw new Error('Capture denied');
    return 'second';
  }, () => now);
  await expect(service.capture(1)).rejects.toThrow('Capture denied');
  fails = false;
  await expect(service.capture(1)).rejects.toThrow('Wait a moment');
  now += 600;
  expect(await service.capture(1)).toBe('second');
});
