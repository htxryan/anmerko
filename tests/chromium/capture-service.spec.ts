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

test('restores the 600 ms API-start spacing across a worker restart from session storage', async () => {
  let now = 1_000;
  let stored: number | undefined;
  const store = {
    async loadLastStart(): Promise<number | undefined> { return stored; },
    async saveLastStart(value: number): Promise<void> { stored = value; },
  };
  const beforeRestart = createCaptureService(async () => 'first', () => now, store);
  expect(await beforeRestart.capture(1)).toBe('first');
  expect(stored).toBe(1_000);

  // A new service instance shares the same session store after a worker wake.
  now = 1_599;
  const afterRestart = createCaptureService(async () => 'second', () => now, store);
  await expect(afterRestart.capture(2)).rejects.toThrow('Wait a moment');
  now = 1_600;
  expect(await afterRestart.capture(2)).toBe('second');
});

test('ignores missing, corrupt, or future-dated stored spacing without blocking captures', async () => {
  const now = 5_000;
  for (const value of [undefined, Number.NaN, Number.POSITIVE_INFINITY, '1000', now + 60_000, -1]) {
    const service = createCaptureService(async () => 'image', () => now, {
      async loadLastStart(): Promise<number | undefined> { return value as number | undefined; },
      async saveLastStart(): Promise<void> {},
    });
    expect(await service.capture(1)).toBe('image');
  }
});

test('a failed spacing-store write never blocks the in-memory rate limit', async () => {
  let now = 1_000;
  const service = createCaptureService(async () => 'image', () => now, {
    async loadLastStart(): Promise<number | undefined> { return undefined; },
    async saveLastStart(): Promise<void> { throw new Error('session storage unavailable'); },
  });
  expect(await service.capture(1)).toBe('image');
  now = 1_001;
  await expect(service.capture(1)).rejects.toThrow('Wait a moment');
});
