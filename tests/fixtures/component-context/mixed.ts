import React from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import { createApp, h, nextTick, version as vueVersion } from 'vue';

const fixtureCase = document.body.dataset.fixtureCase;
const mixedFixture: Record<string, unknown> = {
  ready: false,
  framework: 'mixed',
  version: null,
  mode: fixtureCase,
};
Object.defineProperty(globalThis, '__ANMERKO_FIXTURE__', {
  configurable: false,
  value: mixedFixture,
  writable: false,
});
let resolveAngularTargets!: (ids: readonly string[]) => void;
const angularTargetsReady = new Promise<readonly string[]>(resolve => { resolveAngularTargets = resolve; });
Object.defineProperty(globalThis, '__BRIEFMARK_MIXED_TARGETS_READY__', {
  configurable: false,
  value: angularTargetsReady,
  writable: false,
});

function reactMarker(element: Element | null) {
  return element ? Object.getOwnPropertyNames(element).find(name => name.startsWith('__reactFiber$')) : undefined;
}

async function waitFor(condition: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (condition()) return;
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  }
  throw new Error(message);
}

async function finish(mode: string, targets: Record<string, object>, angularTargetIds: readonly string[]) {
  resolveAngularTargets(angularTargetIds);
  await waitFor(
    () => (globalThis as any).__BRIEFMARK_ANGULAR_FIXTURE__?.ready === true,
    'Angular mixed fixture did not become ready',
  );
  Object.assign(mixedFixture, {
    ready: true,
    mode,
    runtimeVersion: `react:${React.version};vue:${vueVersion};angular:${(globalThis as any).__BRIEFMARK_ANGULAR_FIXTURE__.runtime.angularVersion}`,
    targets: Object.freeze(targets),
    privacyReads: Object.freeze({ props: 0, state: 0, source: 0, file: 0 }),
  });
  Object.freeze(mixedFixture);
}

function MixedReactApp() {
  return React.createElement('button', { id: 'mixed-react-button', 'data-angular-overlap': '' }, 'MixedReactApp');
}
function DualReactApp() {
  return React.createElement('button', { id: 'mixed-dual-button', 'data-angular-overlap': '' }, 'DualReactApp/DualVueApp');
}
function ReactAngularApp() {
  return React.createElement('button', { id: 'mixed-react-angular-button', 'data-angular-overlap': '' }, 'ReactAngularApp');
}
function TripleReactApp() {
  return React.createElement('button', { id: 'mixed-triple-button', 'data-angular-overlap': '' }, 'TripleReactApp/TripleVueApp');
}

function mountReact(rootSelector: string, Component: () => React.ReactElement): void {
  createRoot(document.querySelector(rootSelector)!).render(React.createElement(Component));
}

function mountVue(id: string, rootSelector: string, componentName: string): void {
  const Component = {
    name: componentName,
    setup: () => () => h('button', { id, 'data-angular-overlap': '' }, componentName),
  };
  createApp(Component).mount(rootSelector);
}

async function mountReactVue(
  id: string,
  rootSelector: string,
  ReactComponent: () => React.ReactElement,
  vueName: string,
): Promise<void> {
  const VueComponent = {
    name: vueName,
    setup: () => () => h('button', { id, 'data-angular-overlap': '' }, `${ReactComponent.name}/${vueName}`),
  };
  createApp(VueComponent).mount(rootSelector);
  await nextTick();
  const before = document.getElementById(id);
  hydrateRoot(document.querySelector(rootSelector)!, React.createElement(ReactComponent));
  await waitFor(() => !!reactMarker(document.getElementById(id)), `React hydration marker missing for ${id}`);
  const after = document.getElementById(id);
  if (before !== after || !Object.hasOwn(after!, '__vueParentComponent')) {
    throw new Error(`React/Vue hydration did not retain the exact target: ${id}`);
  }
}

async function start(): Promise<void> {
  if (fixtureCase === 'islands') {
    mountReact('#mixed-react-root', MixedReactApp);
    mountVue('mixed-vue-button', '#mixed-vue-root', 'MixedVueApp');
    await nextTick();
    await waitFor(() => !!reactMarker(document.getElementById('mixed-react-button')), 'React island did not render');
    await finish('islands', {
      react: {
        id: 'mixed-react-button', selectorPath: ['#mixed-react-button'], expectedTag: 'button',
        expectedFrameworks: ['react'], expectedPaths: { react: ['MixedReactApp'] }, kind: 'react-island',
      },
      vue: {
        id: 'mixed-vue-button', selectorPath: ['#mixed-vue-button'], expectedTag: 'button',
        expectedFrameworks: ['vue'], expectedPaths: { vue: ['MixedVueApp'] }, kind: 'vue-island',
      },
      angular: {
        id: 'angular-plan-card-leaf',
        selectorPath: ['[data-fixture-id="angular-plan-card-host"]', '[data-fixture-id="angular-plan-card-leaf"]'],
        expectedTag: 'button', expectedFrameworks: ['angular'],
        expectedPaths: { angular: ['_AppComponent', '_PricingPageComponent', '_PlanCardComponent'] },
        kind: 'angular-island',
      },
    }, []);
    return;
  }

  if (fixtureCase === 'dual-association') {
    await mountReactVue('mixed-dual-button', '#mixed-dual-root', DualReactApp, 'DualVueApp');
    await finish('dual-association', {
      dual: {
        id: 'mixed-dual-button', selectorPath: ['#mixed-dual-button'], expectedTag: 'button',
        expectedFrameworks: ['react', 'vue'],
        expectedPaths: { react: ['DualReactApp'], vue: ['DualVueApp'] },
        kind: 'same-node-react-vue-association',
      },
    }, []);
    return;
  }

  if (fixtureCase === 'react-angular-association') {
    mountReact('#mixed-react-angular-root', ReactAngularApp);
    await waitFor(() => !!reactMarker(document.getElementById('mixed-react-angular-button')), 'React/Angular target did not render');
    await finish('react-angular-association', {
      overlap: {
        id: 'mixed-react-angular-button', selectorPath: ['#mixed-react-angular-button'], expectedTag: 'button',
        expectedFrameworks: ['react', 'angular'],
        expectedPaths: { react: ['ReactAngularApp'], angular: ['_MixedOverlapComponent'] },
        kind: 'same-node-react-angular-association',
      },
    }, ['mixed-react-angular-button']);
    return;
  }

  if (fixtureCase === 'vue-angular-association') {
    mountVue('mixed-vue-angular-button', '#mixed-vue-angular-root', 'VueAngularApp');
    await nextTick();
    await finish('vue-angular-association', {
      overlap: {
        id: 'mixed-vue-angular-button', selectorPath: ['#mixed-vue-angular-button'], expectedTag: 'button',
        expectedFrameworks: ['vue', 'angular'],
        expectedPaths: { vue: ['VueAngularApp'], angular: ['_MixedOverlapComponent'] },
        kind: 'same-node-vue-angular-association',
      },
    }, ['mixed-vue-angular-button']);
    return;
  }

  if (fixtureCase === 'triple-association') {
    await mountReactVue('mixed-triple-button', '#mixed-triple-root', TripleReactApp, 'TripleVueApp');
    await finish('triple-association', {
      overlap: {
        id: 'mixed-triple-button', selectorPath: ['#mixed-triple-button'], expectedTag: 'button',
        expectedFrameworks: ['react', 'vue', 'angular'],
        expectedPaths: {
          react: ['TripleReactApp'], vue: ['TripleVueApp'], angular: ['_MixedOverlapComponent'],
        },
        kind: 'same-node-triple-association',
      },
    }, ['mixed-triple-button']);
    return;
  }

  throw new Error(`Unknown mixed fixture case: ${fixtureCase}`);
}

void start();
