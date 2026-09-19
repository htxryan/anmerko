import type { Store, StoreChanges } from '../../../src/runtime';

/** A document-local session; no extension or web-storage access. */
export function createMemoryStore(): Store & { clear(): void } {
  const records = new Map<string, unknown>();
  const listeners = new Set<(changes: StoreChanges) => void>();
  const notify = (changes: StoreChanges) => {
    for (const listener of listeners) listener(structuredClone(changes));
  };
  return {
    async read(key) { return structuredClone(records.get(key)); },
    async readAll() { return structuredClone(Object.fromEntries(records)); },
    async write(key, value) {
      const stored = structuredClone(value);
      records.set(key, stored);
      notify({ [key]: { newValue: stored } });
    },
    async remove(key) { records.delete(key); notify({ [key]: {} }); },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    clear() {
      const changes = Object.fromEntries([...records.keys()].map(key => [key, {}]));
      records.clear();
      notify(changes);
    },
  };
}
