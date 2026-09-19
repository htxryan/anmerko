import { test, expect } from '@playwright/test';
import { createUuid } from '../src/uuid';

test('UUID generation retains the native secure-context implementation when available', () => {
  let calls = 0;
  const api = { randomUUID() { ++calls; return '00000000-0000-4000-8000-000000000000'; }, getRandomValues() { throw new Error('Unexpected fallback'); } } as unknown as Crypto;
  expect(createUuid(api)).toBe('00000000-0000-4000-8000-000000000000');
  expect(calls).toBe(1);
});

test('insecure-context UUIDs use 16 cryptographic bytes and preserve v4/variant bits', () => {
  let calls = 0;
  const api = { getRandomValues(bytes: Uint8Array) {
    ++calls; expect(bytes).toHaveLength(16); bytes.fill(255); return bytes;
  } } as unknown as Crypto;
  expect(createUuid(api)).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
  expect(calls).toBe(1);
});
