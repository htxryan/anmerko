import { test, expect } from '@playwright/test';
import { buildPrompt, readNotes, saveNote, removeNote, STORAGE_PREFIX, type Note } from '../../src/core';

function store() {
  const records: Record<string, unknown> = {};
  return {
    read: async (key: string) => structuredClone(records[key]),
    readAll: async () => structuredClone(records),
    write: async (key: string, value: unknown) => { records[key] = structuredClone(value); },
    remove: async (key: string) => { delete records[key]; },
    subscribe: () => () => {},
  };
}
const note: Note = {
  id: 'sample', pageUrl: 'https://example.com/', pageTitle: 'Example', comment: 'Clarify this heading',
  createdAt: '2026-09-12T00:00:00Z', updatedAt: '2026-09-12T00:00:00Z',
  element: { selectorPath: ['h1'], tag: 'h1', text: 'Example', label: '', viewport: { width: 1280, height: 720 } },
};

function inspectingStore() {
  const records: Record<string, unknown> = {};
  let writes = 0;
  return {
    records,
    get writes() { return writes; },
    read: async (key: string) => records[key],
    readAll: async () => records,
    write: async (key: string, value: unknown) => { writes++; records[key] = structuredClone(value); },
    remove: async (key: string) => { delete records[key]; },
    subscribe: () => () => {},
  };
}

const componentContext = {
  version: 1 as const, framework: 'react' as const, provenance: 'react-dom-fiber-dev' as const,
  path: ['App', 'SaveButton'], truncated: false,
};

test('fresh anmerko storage ignores the retired preview namespace', async () => {
  const memory = store();
  await memory.write('retired-product:note:v1:legacy', { ...note, id: 'legacy' });
  await saveNote(memory, note);
  expect(STORAGE_PREFIX).toBe('anmerko:note:v1:');
  expect(await readNotes(memory)).toEqual([note]);
  expect(await memory.read('retired-product:note:v1:legacy')).toMatchObject({ id: 'legacy' });
});

test('notes use only their supplied store, preserve concurrent notes, and reject invalid records', async () => {
  const first = store(); const second = store();
  await Promise.all([saveNote(first, note), saveNote(first, { ...note, id: 'another' })]);
  await first.write(STORAGE_PREFIX + 'invalid', { id: 'invalid' });
  await first.write(STORAGE_PREFIX + 'invalid-hierarchy', { ...note, id: 'invalid-hierarchy', element: { ...note.element, hierarchy: [false] } });
  await first.write('unrelated', note);
  expect((await readNotes(first)).map(note => note.id)).toEqual(['another', 'sample']);
  expect(await readNotes(second)).toEqual([]);
  await removeNote(first, note.id);
  expect((await readNotes(first)).map(note => note.id)).toEqual(['another']);
});

test('failed note writes reject and retain the caller’s draft', async () => {
  const draft = structuredClone(note);
  const failing = { ...store(), write: async () => { throw new Error('Storage unavailable'); } };
  await expect(saveNote(failing, draft)).rejects.toThrow('Storage unavailable');
  expect(draft).toEqual(note);
});

test('explicit page comments persist without accepting damaged annotations as global comments', async () => {
  const memory = store();
  const { element, ...base } = note;
  const global = { ...base, id: 'global', kind: 'page' };
  await memory.write(STORAGE_PREFIX + global.id, global);
  await memory.write(STORAGE_PREFIX + 'missing-context', base);
  await memory.write(STORAGE_PREFIX + 'mixed-context', { ...global, element });
  expect(await readNotes(memory)).toEqual([global]);
});

test('memory sessions clone records and notifications and unsubscribe on close', async () => {
  const { createMemoryStore } = await import('../../site/src/scripts/memory-store');
  const memory = createMemoryStore();
  const other = createMemoryStore();
  const original = structuredClone(note);
  let notifications = 0;
  memory.subscribe(changes => { (changes[STORAGE_PREFIX + note.id]?.newValue as Note | undefined)?.element?.selectorPath.push('mutated'); });
  const unsubscribe = memory.subscribe(() => { notifications++; });
  await saveNote(memory, original);
  original.comment = 'mutated caller';
  const loaded = await readNotes(memory);
  expect(loaded).toEqual([note]);
  loaded[0].comment = 'mutated read';
  expect(await readNotes(memory)).toEqual([note]);
  expect(await readNotes(other)).toEqual([]);
  unsubscribe();
  memory.clear();
  expect(await memory.readAll()).toEqual({});
  expect(notifications).toBe(1);
});

test('valid component context round-trips as a fresh normalized snapshot', async () => {
  const memory = inspectingStore();
  const enriched: Note = { ...note, element: { ...note.element!, componentContext } };
  await saveNote(memory, enriched);
  const [loaded] = await readNotes(memory);
  expect(loaded).toEqual(enriched);
  expect(loaded).not.toBe(enriched);
  expect(loaded.element?.componentContext).not.toBe(componentContext);
});

test('read strips only invalid optional enrichment without rewriting the stored legacy note', async () => {
  const memory = inspectingStore();
  const stored = { ...note, element: { ...note.element, componentContext: { ...componentContext, version: 2, secret: 'do not leak' } } };
  memory.records[STORAGE_PREFIX + note.id] = stored;
  const writesBeforeRead = memory.writes;

  expect(await readNotes(memory)).toEqual([note]);
  expect(memory.writes).toBe(writesBeforeRead);
  expect(memory.records[STORAGE_PREFIX + note.id]).toBe(stored);
});

test('save omits malformed or extra context fields instead of persisting raw enrichment', async () => {
  const memory = inspectingStore();
  const raw = {
    ...note,
    element: {
      ...note.element,
      componentContext: { ...componentContext, props: { password: 'secret' } },
      runtimeObject: { state: 'excluded' },
    },
  } as unknown as Note;

  await saveNote(memory, raw);
  const saved = memory.records[STORAGE_PREFIX + note.id] as Note & { element: Record<string, unknown> };
  expect(saved.element.componentContext).toBeUndefined();
  expect(JSON.stringify(saved)).not.toContain('secret');
  expect(JSON.stringify(saved)).not.toContain('runtimeObject');
  expect(JSON.stringify(saved)).not.toContain('excluded');
});

test('page and screenshot notes cannot persist component context', async () => {
  const memory = inspectingStore();
  const { element: _element, ...base } = note;
  const page = { ...base, id: 'page', kind: 'page', componentContext } as unknown as Note;
  const screenshot = {
    ...base,
    id: 'shot',
    screenshot: {
      dataUrl: 'data:image/png;base64,QQ==', width: 1, height: 1,
      region: { x: 0, y: 0, width: 1, height: 1 }, viewport: { width: 1, height: 1 }, scroll: { x: 0, y: 0 },
      componentContext,
    },
  } as unknown as Note;

  await saveNote(memory, page);
  await saveNote(memory, screenshot);
  expect(JSON.stringify(memory.records[STORAGE_PREFIX + 'page'])).not.toContain('componentContext');
  expect(JSON.stringify(memory.records[STORAGE_PREFIX + 'shot'])).not.toContain('componentContext');
});

test('prompt preparation preserves absent-context output and cannot leak excluded context fields', () => {
  const baseline = buildPrompt([note]);
  const raw = {
    ...note,
    element: { ...note.element, componentContext: { ...componentContext, source: 'TOP-SECRET-SOURCE' } },
  } as unknown as Note;
  expect(buildPrompt([raw])).toBe(baseline);
  expect(buildPrompt([raw])).not.toContain('TOP-SECRET-SOURCE');
});
