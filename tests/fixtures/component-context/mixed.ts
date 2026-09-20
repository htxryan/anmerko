import React from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import { createApp, h, nextTick, version as vueVersion } from 'vue';

const fixtureCase = document.body.dataset.fixtureCase;

function reactMarker(element: Element | null) {
  return element ? Object.getOwnPropertyNames(element).find(name => name.startsWith('__reactFiber$')) : undefined;
}

function finish(mode: string, targets: Record<string, object>) {
  Object.defineProperty(globalThis, '__ANMERKO_FIXTURE__', { value: Object.freeze({
    ready: true,
    framework: 'mixed',
    version: null,
    mode,
    runtimeVersion: `react:${React.version};vue:${vueVersion}`,
    targets: Object.freeze(targets),
    privacyReads: Object.freeze({ props: 0, state: 0, source: 0, file: 0 }),
  }) });
}

if (fixtureCase === 'islands') {
  function MixedReactApp() { return React.createElement('button', { id: 'mixed-react-button' }, 'React island'); }
  const MixedVueApp = { name: 'MixedVueApp', setup: () => () => h('button', { id: 'mixed-vue-button' }, 'Vue island') };
  createRoot(document.querySelector('#mixed-react-root')!).render(React.createElement(MixedReactApp));
  createApp(MixedVueApp).mount('#mixed-vue-root');
  nextTick(() => requestAnimationFrame(() => finish('islands', {
    react: { id: 'mixed-react-button', expectedPath: ['MixedReactApp'], kind: 'react-island' },
    vue: { id: 'mixed-vue-button', expectedPath: ['MixedVueApp'], kind: 'vue-island' },
  })));
} else if (fixtureCase === 'dual-association') {
  function DualReactApp() { return React.createElement('button', { id: 'mixed-dual-button' }, 'Dual association'); }
  const DualVueApp = { name: 'DualVueApp', setup: () => () => h('button', { id: 'mixed-dual-button' }, 'Dual association') };
  createApp(DualVueApp).mount('#mixed-dual-root');
  nextTick(() => {
    const before = document.querySelector('#mixed-dual-button');
    hydrateRoot(document.querySelector('#mixed-dual-root')!, React.createElement(DualReactApp));
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const after = document.querySelector('#mixed-dual-button');
      if (before !== after || !reactMarker(after) || !Object.hasOwn(after!, '__vueParentComponent')) {
        throw new Error('Real React/Vue dual association was not retained on one exact node');
      }
      finish('dual-association', {
        dual: { id: 'mixed-dual-button', expectedReactPath: ['DualReactApp'], expectedVuePath: ['DualVueApp'], kind: 'same-node-dual-association' },
      });
    }));
  });
} else {
  throw new Error(`Unknown mixed fixture case: ${fixtureCase}`);
}
