import { test, expect } from '@playwright/test';
import { COMPONENT_CONTEXT_PROBES, selectComponentContext } from '../../src/component-context-dispatch';
import type { ComponentContextProbeOutcome } from '../../src/component-context-bridge';
import type { ComponentContextV1 } from '../../src/component-context';
import { reactComponentContextProbe } from '../../src/react-context-probe';
import { vueComponentContextProbe } from '../../src/vue-context-probe';
import { angularComponentContextProbe } from '../../src/angular-context-probe';

const values: ComponentContextV1[] = [
  { version: 1, framework: 'react', provenance: 'react-dom-fiber-dev', path: ['App'], truncated: false },
  { version: 1, framework: 'vue', provenance: 'vue3-instance-debug', path: ['App'], truncated: false },
  { version: 1, framework: 'angular', provenance: 'angular-debug-ownership', path: ['App'], truncated: false },
];

test('the immutable registry contains only the three bundled adapters in protocol order', () => {
  expect(COMPONENT_CONTEXT_PROBES).toEqual([reactComponentContextProbe, vueComponentContextProbe, angularComponentContextProbe]);
  expect(Object.isFrozen(COMPONENT_CONTEXT_PROBES)).toBe(true);
});

test('every combination requires one valid framework and two clean no-matches', () => {
  const kinds = ['none', 'valid', 'indeterminate'] as const;
  for (const a of kinds) for (const b of kinds) for (const c of kinds) {
    const combination = [a, b, c];
    const outcomes: ComponentContextProbeOutcome[] = combination.map((kind, index) => kind === 'valid'
      ? { kind, value: values[index] } : { kind });
    const expected = !combination.includes('indeterminate') && combination.filter(kind => kind === 'valid').length === 1
      ? values[combination.indexOf('valid')] : null;
    expect(selectComponentContext(outcomes), combination.join('/')).toEqual(expected);
  }
});

test('incomplete inspection and a valid DTO from the wrong adapter remain unavailable', () => {
  expect(selectComponentContext([{ kind: 'valid', value: values[0] }, { kind: 'none' }])).toBe(null);
  expect(selectComponentContext([{ kind: 'none' }, { kind: 'valid', value: values[0] }, { kind: 'none' }])).toBe(null);
  expect(selectComponentContext([{ kind: 'valid', value: { ...values[0], path: [] } }, { kind: 'none' }, { kind: 'none' }])).toBe(null);
});
