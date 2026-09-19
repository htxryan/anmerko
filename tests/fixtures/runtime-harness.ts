import { mount } from '../../src/content';
import styles from '../../src/panel.css';
import type { Store, StoreChanges } from '../../src/runtime';

const records: Record<string, unknown> = {};
const listeners = new Set<(changes: StoreChanges) => void>();
let failReads = false;
let failWrites = false;
let releaseWrite: (() => void) | undefined;
let delayWrites = false;
const store: Store = {
  async read(key) { if (failReads) throw new Error('Injected read failure'); return structuredClone(records[key]); },
  async readAll() { if (failReads) throw new Error('Injected read failure'); return structuredClone(records); },
  async write(key, value) {
    if (failWrites) throw new Error('Injected write failure');
    if (delayWrites) await new Promise<void>(resolve => { releaseWrite = resolve; });
    records[key] = structuredClone(value);
    listeners.forEach(listener => listener({ [key]: { newValue: structuredClone(value) } }));
  },
  async remove(key) { delete records[key]; listeners.forEach(listener => listener({ [key]: {} })); },
  subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
};
let controller: ReturnType<typeof mount>;
let disposed = 0;
function open() {
  controller = mount({ store, settingsLabel: 'Feedback settings',
    storageError: 'Could not save or load comments. Keep your draft and try again.',
    attachStyles(shadow) { const sheet = document.createElement('style'); sheet.textContent = styles; shadow.prepend(sheet); },
    onDispose() { ++disposed; },
  });
}
const harness = { open, dispose: () => controller.dispose(), close: () => controller.close(),
  controller: () => controller,
  failures(reads: boolean, writes: boolean) { failReads = reads; failWrites = writes; },
  delay() { delayWrites = true; },
  release() { delayWrites = false; releaseWrite?.(); },
  stats: () => ({ subscribers: listeners.size, disposed }),
};
(globalThis as typeof globalThis & { harness: typeof harness }).harness = harness;
