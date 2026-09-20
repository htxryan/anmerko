import { mount } from './content';
import { extensionRuntime } from './extension-runtime';
import type { Controller } from './runtime';
import { ensureJourneyPage } from './journey-observer';

const global = globalThis as typeof globalThis & { __anmerko?: Controller };
ensureJourneyPage();
if (!global.__anmerko) {
  global.__anmerko = mount(extensionRuntime(() => { delete global.__anmerko; }));
}
