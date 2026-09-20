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
import { angularComponentContextProbe } from '../../src/angular-context-probe';
import { buildPrompt, readNotes, STORAGE_PREFIX, type Note } from '../../src/core';
import { reactComponentContextProbe } from '../../src/react-context-probe';
import { vueComponentContextProbe } from '../../src/vue-context-probe';

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

test('accepts meaningful hostile Markdown and ZWJ names but rejects spoofing and separator controls', () => {
  const hostile = '<b>**[Button](javascript:alert(1))** `code`';
  expect(normalizeComponentContext({ ...contexts[0], path: [hostile] })?.path).toEqual([hostile]);
  expect(normalizeComponentContext({ ...contexts[0], path: ['Editor\u200dPanel', '👩‍💻'] })?.path)
    .toEqual(['Editor\u200dPanel', '👩‍💻']);
  expect(normalizeComponentContext({ ...contexts[0], path: [''] })).toBeUndefined();
  expect(normalizeComponentContext({ ...contexts[0], path: ['   '] })).toBeUndefined();
  expect(normalizeComponentContext({ ...contexts[0], path: ['Button\nInjected'] })).toBeUndefined();
  expect(normalizeComponentContext({ ...contexts[0], path: ['Button\u0000Injected'] })).toBeUndefined();
  for (const unsafe of ['Button\u202eexe', 'Button\u2066hidden', 'Button\u2028Injected', 'Button\u2029Injected']) {
    expect(normalizeComponentContext({ ...contexts[0], path: [unsafe] })).toBeUndefined();
  }
});

test('storage strips a spoofed component hint without dropping the note or exporting the name', async () => {
  const cleanNote: Note = {
    id: 'spoofed-context', pageUrl: 'https://example.com/', pageTitle: 'Example', comment: 'Keep this note',
    createdAt: '2026-09-20T00:00:00.000Z', updatedAt: '2026-09-20T00:00:00.000Z',
    element: {
      selectorPath: ['#save'], tag: 'button', text: 'Save', label: '',
      viewport: { width: 1280, height: 720 },
    },
  };
  const spoofedName = 'TrustedButton\u202eexe';
  const storedNote = {
    ...cleanNote,
    element: { ...cleanNote.element, componentContext: { ...contexts[0], path: [spoofedName] } },
  } as unknown as Note;
  const records: Record<string, unknown> = {
    [STORAGE_PREFIX + cleanNote.id]: storedNote,
  };
  const memory = {
    read: async (key: string) => records[key],
    readAll: async () => records,
    write: async (key: string, value: unknown) => { records[key] = value; },
    remove: async (key: string) => { delete records[key]; },
    subscribe: () => () => {},
  };

  const loaded = await readNotes(memory);
  expect(loaded).toEqual([cleanNote]);
  for (const prompt of [buildPrompt(loaded), buildPrompt([storedNote])]) {
    expect(prompt).toContain('Keep this note');
    expect(prompt).not.toContain('Component hint');
    expect(prompt).not.toContain(spoofedName);
    expect(prompt).not.toContain('\u202e');
  }
});

test('framework probes reject spoofing controls while preserving legitimate ZWJ names', async ({ page }) => {
  await page.setContent('<button id="selected">Selected</button>');
  const target = {
    selectorPath: ['#selected'], expectedTag: 'button',
    markerName: 'data-anmerko-context-0123456789abcdef0123456789abcdef',
  };
  await page.evaluate(({ markerName }) => {
    const selected = document.querySelector('#selected')! as any;
    selected.setAttribute(markerName, '');
    function ReactComponent() {}
    Object.defineProperty(selected, '__reactFiber$security', { value: {
      tag: 5, stateNode: selected,
      return: { tag: 0, type: ReactComponent, return: { tag: 3, return: null } },
      _debugStack: null, _debugOwner: null, _debugInfo: null,
    } });
    Object.defineProperty(selected, '__vueParentComponent', { value: {
      type: { name: 'VueComponent' }, parent: null, isUnmounted: false,
    } });
    class AngularComponent {}
    const angularComponent = new AngularComponent();
    Object.defineProperty(globalThis, 'ng', { configurable: true, value: {
      getComponent: (value: unknown) => value === selected ? angularComponent : null,
      getOwningComponent: () => null,
      getHostElement: (value: unknown) => value === angularComponent ? selected : null,
    } });
  }, target);

  for (const unsafe of ['Component\u202eexe', 'Component\u2066hidden', 'Component\u2028Injected', 'Component\u2029Injected']) {
    await page.evaluate(name => {
      const selected = document.querySelector('#selected')! as any;
      Object.defineProperty(selected.__reactFiber$security.return.type, 'displayName', {
        configurable: true, value: name,
      });
      selected.__vueParentComponent.type.name = name;
      const angularComponent = (globalThis as any).ng.getComponent(selected);
      Object.defineProperty(Object.getPrototypeOf(angularComponent).constructor, 'name', {
        configurable: true, value: name,
      });
    }, unsafe);
    expect(await page.evaluate(reactComponentContextProbe, target)).toBeNull();
    expect(await page.evaluate(vueComponentContextProbe, target)).toBeNull();
    expect(await page.evaluate(angularComponentContextProbe, target)).toBeNull();
  }

  for (const safe of ['Editor\u200dPanel', '👩‍💻']) {
    await page.evaluate(name => {
      const selected = document.querySelector('#selected')! as any;
      Object.defineProperty(selected.__reactFiber$security.return.type, 'displayName', {
        configurable: true, value: name,
      });
      selected.__vueParentComponent.type.name = name;
      const angularComponent = (globalThis as any).ng.getComponent(selected);
      Object.defineProperty(Object.getPrototypeOf(angularComponent).constructor, 'name', {
        configurable: true, value: name,
      });
    }, safe);
    expect(JSON.parse((await page.evaluate(reactComponentContextProbe, target))!).path).toEqual([safe]);
    expect(JSON.parse((await page.evaluate(vueComponentContextProbe, target))!).path).toEqual([safe]);
    expect(JSON.parse((await page.evaluate(angularComponentContextProbe, target))!).path).toEqual([safe]);
  }
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
