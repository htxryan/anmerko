import { mount } from './content';
import { extensionRuntime } from './extension-runtime';
import type { Controller } from './runtime';
import { journeysEnabled } from './journey-feature';
import { bindJourneyPage } from './journey-page-bridge';

const global = globalThis as typeof globalThis & { __anmerko?: Controller; __anmerkoJourneyPage?: () => void };
if (journeysEnabled && !global.__anmerkoJourneyPage) global.__anmerkoJourneyPage = bindJourneyPage();
if (!global.__anmerko) {
  global.__anmerko = mount(extensionRuntime(() => { delete global.__anmerko; }));
}
