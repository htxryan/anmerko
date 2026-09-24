import { normalizeComponentContext, type ComponentContextV1 } from './component-context';
import type { ComponentContextProbeOutcome, ComponentContextProbeTuple } from './component-context-bridge';
import { reactComponentContextProbe } from './react-context-probe';
import { vueComponentContextProbe } from './vue-context-probe';
import { angularComponentContextProbe } from './angular-context-probe';
import { preactComponentContextProbe } from './preact-context-probe';

// Only this bundled registry can choose page-world code. Request data never can.
export const COMPONENT_CONTEXT_PROBES: ComponentContextProbeTuple = /* @__PURE__ */ Object.freeze([
  reactComponentContextProbe,
  vueComponentContextProbe,
  angularComponentContextProbe,
  preactComponentContextProbe,
]);

export function selectComponentContext(outcomes: readonly ComponentContextProbeOutcome[]): ComponentContextV1 | null {
  if (outcomes.length !== 4) return null;
  const frameworks = ['react', 'vue', 'angular', 'preact'] as const;
  let selected: ComponentContextV1 | null = null;
  for (const [index, outcome] of outcomes.entries()) {
    if (outcome.kind === 'indeterminate') return null;
    if (outcome.kind === 'none') continue;
    const value = normalizeComponentContext(outcome.value);
    if (!value || value.framework !== frameworks[index] || selected) return null;
    selected = value;
  }
  return selected;
}
