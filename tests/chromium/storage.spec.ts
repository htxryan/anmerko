import { test, expect } from '@playwright/test';
import { readNotes, saveNote, removeNote, STORAGE_PREFIX, type Note } from '../../src/core';

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

test('fresh anmerko storage ignores the retired preview namespace', async () => {
  const memory = store();
  await memory.write('pagebrief:note:v1:legacy', { ...note, id: 'legacy' });
  await saveNote(memory, note);
  expect(STORAGE_PREFIX).toBe('anmerko:note:v1:');
  expect(await readNotes(memory)).toEqual([note]);
  expect(await memory.read('pagebrief:note:v1:legacy')).toMatchObject({ id: 'legacy' });
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
