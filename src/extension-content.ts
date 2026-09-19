import { mount } from './content';
import { extensionRuntime } from './extension-runtime';
import type { Controller } from './runtime';

const global = globalThis as typeof globalThis & { __anmerko?: Controller };
if (!global.__anmerko) {
  global.__anmerko = mount(extensionRuntime(() => { delete global.__anmerko; }));
}
