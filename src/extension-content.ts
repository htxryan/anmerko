import { mount } from './content';
import { extensionRuntime } from './extension-runtime';
import type { Controller } from './runtime';
import { ensureJourneyPage } from './journey-page-bridge';

declare const __TARGET_JOURNEYS__: boolean;

const global = globalThis as typeof globalThis & { __anmerko?: Controller };
// Orion builds define __TARGET_JOURNEYS__ false, which folds the journey page
// bridge out of their content script; esbuild folds the define only here.
if (typeof __TARGET_JOURNEYS__ === 'undefined' || __TARGET_JOURNEYS__) ensureJourneyPage();
if (!global.__anmerko) {
  global.__anmerko = mount(extensionRuntime(() => { delete global.__anmerko; }));
}
