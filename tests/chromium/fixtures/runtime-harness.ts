import { mount } from '../../../src/content';
import styles from '../../../src/panel.css';
import type { JourneyClient } from '../../../src/journey-ui';
import type { Store, StoreChanges } from '../../../src/runtime';
import type { ComponentContextV1 } from '../../../src/component-context';

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
let journeyItems: Array<{ journeyId: string; revision: number; updatedAt: string; stepCount: number; spansPages: boolean }> = [];
let journeyListFails = false;
const journeys = {
  async list() {
    if (journeyListFails) throw new Error('Injected journeys failure');
    return structuredClone(journeyItems);
  },
} as unknown as JourneyClient;
const contextRequests: Array<{ element: Element; signal: AbortSignal; resolve(value: ComponentContextV1 | null): void }> = [];
function open(componentContext = false) {
  controller = mount({ store, settingsLabel: 'Feedback settings',
    captureComponentContext: componentContext ? (element, _path, signal) => new Promise(resolve => {
      contextRequests.push({ element, signal, resolve });
    }) : undefined,
    storageError: 'Could not save or load comments. Keep your draft and try again.',
    attachStyles(shadow) { const sheet = document.createElement('style'); sheet.textContent = styles; shadow.prepend(sheet); },
    onDispose() { ++disposed; },
    journeys,
  });
}
const harness = { open, dispose: () => controller.dispose(), close: () => controller.close(),
  controller: () => controller,
  read: store.read, write: store.write,
  failures(reads: boolean, writes: boolean) { failReads = reads; failWrites = writes; },
  delay() { delayWrites = true; },
  release() { delayWrites = false; releaseWrite?.(); },
  stats: () => ({ subscribers: listeners.size, disposed }),
  setJourneys(items: typeof journeyItems) { journeyItems = structuredClone(items); },
  failJourneys(fails: boolean) { journeyListFails = fails; },
  contextRequests: () => contextRequests.map(request => ({ tag: request.element.localName, aborted: request.signal.aborted })),
  resolveContext(index: number, value: ComponentContextV1 | null) { contextRequests[index]?.resolve(value); },
};
(globalThis as typeof globalThis & { harness: typeof harness }).harness = harness;
