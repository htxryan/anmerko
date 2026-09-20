import { test, expect } from '@playwright/test';
import {
  COMPONENT_CONTEXT_DEFAULT,
  COMPONENT_CONTEXT_KEY,
  COMPONENT_CONTEXT_MAX_NAME_CODE_POINTS,
  COMPONENT_CONTEXT_MAX_PATH_LENGTH,
  COMPONENT_CONTEXT_MAX_TOTAL_NAME_CODE_POINTS,
  COMPONENT_CONTEXT_MAX_TRAVERSAL_LINKS,
  COMPONENT_CONTEXT_MAX_WIRE_BYTES,
  normalizeComponentContext,
  type ComponentContextV1,
} from '../../src/component-context';

const contexts: ComponentContextV1[] = [
  { version: 1, framework: 'react', provenance: 'react-dom-fiber-dev', path: ['App', 'Button'], truncated: false },
  { version: 1, framework: 'vue', provenance: 'vue3-instance-debug', path: ['App', 'PlanCard'], truncated: true },
  { version: 1, framework: 'angular', provenance: 'angular-debug-ownership', path: ['AppComponent'], truncated: false },
];

test('exports the shared preference and component traversal budgets', () => {
  expect(COMPONENT_CONTEXT_KEY).toBe('anmerko:capture-component-context');
  expect(COMPONENT_CONTEXT_DEFAULT).toBe(false);
  expect(COMPONENT_CONTEXT_MAX_PATH_LENGTH).toBe(8);
  expect(COMPONENT_CONTEXT_MAX_NAME_CODE_POINTS).toBe(64);
  expect(COMPONENT_CONTEXT_MAX_TOTAL_NAME_CODE_POINTS).toBe(384);
  expect(COMPONENT_CONTEXT_MAX_WIRE_BYTES).toBe(2_048);
  expect(COMPONENT_CONTEXT_MAX_TRAVERSAL_LINKS).toBe(64);
});

test('normalizes each exact version 1 framework and provenance pair into fresh data', () => {
  for (const context of contexts) {
    const normalized = normalizeComponentContext(context);
    expect(normalized).toEqual(context);
    expect(normalized).not.toBe(context);
    expect(normalized?.path).not.toBe(context.path);
  }
});

test('rejects mismatched pairs, future versions, extra keys, and malformed fields', () => {
  expect(normalizeComponentContext({ ...contexts[0], provenance: 'vue3-instance-debug' })).toBeUndefined();
  expect(normalizeComponentContext({ ...contexts[0], version: 2 })).toBeUndefined();
  expect(normalizeComponentContext({ ...contexts[0], source: '/private/Button.tsx' })).toBeUndefined();
  expect(normalizeComponentContext({ ...contexts[0], truncated: 0 })).toBeUndefined();
  expect(normalizeComponentContext(null)).toBeUndefined();
});

test('accepts meaningful hostile Markdown as data but rejects empty and control-containing names', () => {
  const hostile = '<b>**[Button](javascript:alert(1))** `code`';
  expect(normalizeComponentContext({ ...contexts[0], path: [hostile] })?.path).toEqual([hostile]);
  expect(normalizeComponentContext({ ...contexts[0], path: [''] })).toBeUndefined();
  expect(normalizeComponentContext({ ...contexts[0], path: ['   '] })).toBeUndefined();
  expect(normalizeComponentContext({ ...contexts[0], path: ['Button\nInjected'] })).toBeUndefined();
  expect(normalizeComponentContext({ ...contexts[0], path: ['Button\u0000Injected'] })).toBeUndefined();
});

test('counts Unicode code points and enforces path, total-name, and wire bounds', () => {
  const sixtyFourEmoji = '🦊'.repeat(COMPONENT_CONTEXT_MAX_NAME_CODE_POINTS);
  expect(normalizeComponentContext({ ...contexts[0], path: [sixtyFourEmoji] })).toEqual({ ...contexts[0], path: [sixtyFourEmoji] });
  expect(normalizeComponentContext({ ...contexts[0], path: [`${sixtyFourEmoji}🦊`] })).toBeUndefined();
  expect(normalizeComponentContext({ ...contexts[0], path: Array(COMPONENT_CONTEXT_MAX_PATH_LENGTH + 1).fill('Name') })).toBeUndefined();
  expect(normalizeComponentContext({ ...contexts[0], path: Array(7).fill('x'.repeat(55)) })).toBeUndefined();

  const wireHeavy = { ...contexts[0], path: Array(8).fill('\ud800'.repeat(48)) };
  expect(Array.from(wireHeavy.path.join(''))).toHaveLength(COMPONENT_CONTEXT_MAX_TOTAL_NAME_CODE_POINTS);
  expect(new TextEncoder().encode(JSON.stringify(wireHeavy)).byteLength).toBeGreaterThan(COMPONENT_CONTEXT_MAX_WIRE_BYTES);
  expect(normalizeComponentContext(wireHeavy)).toBeUndefined();
});

test('returns absence without invoking getters or leaking proxy failures', () => {
  let reads = 0;
  const getter = { ...contexts[0] } as Record<string, unknown>;
  Object.defineProperty(getter, 'path', { enumerable: true, get() { reads++; return ['Secret']; } });
  expect(normalizeComponentContext(getter)).toBeUndefined();
  expect(reads).toBe(0);

  const throwingProxy = new Proxy({}, { ownKeys() { throw new Error('page trap'); } });
  expect(() => normalizeComponentContext(throwingProxy)).not.toThrow();
  expect(normalizeComponentContext(throwingProxy)).toBeUndefined();

  const pathWithGetter: unknown[] = ['App'];
  Object.defineProperty(pathWithGetter, '0', { enumerable: true, get() { reads++; return 'Secret'; } });
  expect(normalizeComponentContext({ ...contexts[0], path: pathWithGetter })).toBeUndefined();
  expect(reads).toBe(0);

  const pathProxy = new Proxy(['App'], { getOwnPropertyDescriptor() { throw new Error('path trap'); } });
  expect(() => normalizeComponentContext({ ...contexts[0], path: pathProxy })).not.toThrow();
  expect(normalizeComponentContext({ ...contexts[0], path: pathProxy })).toBeUndefined();
});
