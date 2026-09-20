const reactPath = ['App', 'PricingPage', 'PlanCard', 'FeedbackButton'];
const angularPath = ['_AppComponent', '_PricingPageComponent', '_PlanCardComponent'];

const scenario = (id, route, framework, version, selectorPath, expectedPath, extra = {}) => Object.freeze({
  id,
  route,
  framework,
  version,
  target: Object.freeze({
    selectorPath: Object.freeze(selectorPath),
    expectedTag: extra.expectedTag || 'button',
    ...(extra.clickPosition ? { clickPosition: Object.freeze(extra.clickPosition) } : {}),
    ...(extra.dispatchTarget ? { dispatchTarget: true } : {}),
  }),
  expectedPath: expectedPath === null ? null : Object.freeze(expectedPath),
  csp: 'strict',
  transport: 'http',
  ...extra,
});

export const componentContextPositiveScenarios = Object.freeze([
  ...['18.3.1', '19.2.7', '19.3.0'].map(version => scenario(
    `react-${version}-development`,
    `/react/${version}/development`,
    'react',
    version,
    ['#react-nested-button'],
    reactPath,
    { provenance: 'react-dom-fiber-dev', privacy: true },
  )),
  scenario('react-19.3.0-open-shadow', '/react/19.3.0/development', 'react', '19.3.0',
    ['#react-shadow-host', '#react-shadow-button'], ['App', 'PricingPage', 'ShadowPanel', 'FeedbackButton'],
    { provenance: 'react-dom-fiber-dev', openShadow: true }),
  scenario('vue-3.5.43-development', '/vue/3.5.43/development', 'vue', '3.5.43',
    ['#vue-options-button'], ['App', 'OptionsCard'], { provenance: 'vue3-instance-debug' }),
  scenario('vue-3.5.43-production-devtools', '/vue/3.5.43/production-devtools', 'vue', '3.5.43',
    ['#vue-sensitive-button'], ['App', 'SensitiveLeaf'], { provenance: 'vue3-instance-debug', privacy: true }),
  scenario('angular-22.1.7-host', '/angular/22.1.7/development', 'angular', '22.1.7',
    ['[data-fixture-id="angular-plan-card-host"]'], angularPath,
    { expectedTag: 'plan-card', provenance: 'angular-debug-ownership', targetKind: 'component-host', privacy: true,
      clickPosition: { x: 1, y: 1 } }),
  scenario('angular-22.1.7-inner', '/angular/22.1.7/development', 'angular', '22.1.7',
    ['[data-fixture-id="angular-app-inner"]'], ['_AppComponent'],
    { expectedTag: 'main', provenance: 'angular-debug-ownership', targetKind: 'inner-element', dispatchTarget: true }),
  scenario('angular-22.1.7-secondary-root', '/angular/22.1.7/development', 'angular', '22.1.7',
    ['[data-fixture-id="angular-secondary-plan-card-host"]'], angularPath,
    { expectedTag: 'plan-card', provenance: 'angular-debug-ownership', targetKind: 'second-root-host',
      clickPosition: { x: 1, y: 1 } }),
  scenario('angular-22.1.7-open-shadow', '/angular/22.1.7/development', 'angular', '22.1.7',
    ['[data-fixture-id="angular-plan-card-host"]', '[data-fixture-id="angular-plan-card-leaf"]'], angularPath,
    { provenance: 'angular-debug-ownership', openShadow: true }),
]);

export const componentContextFallbackScenarios = Object.freeze([
  ...['18.3.1', '19.2.7', '19.3.0'].flatMap(version => ['production', 'profiling'].map(mode => scenario(
    `react-${version}-${mode}`,
    `/react/${version}/${mode}`,
    'react',
    version,
    ['#react-nested-button'],
    null,
    { mode },
  ))),
  scenario('vue-3.5.43-production', '/vue/3.5.43/production', 'vue', '3.5.43',
    ['#vue-options-button'], null, { mode: 'production' }),
  scenario('angular-22.1.7-production', '/angular/22.1.7/production', 'angular', '22.1.7',
    ['[data-fixture-id="angular-plan-card-host"]'], null,
    { expectedTag: 'plan-card', mode: 'production', clickPosition: { x: 1, y: 1 } }),
  scenario('plain-dom', '/plain', 'none', null, ['#plain-target'], null),
  scenario('unsupported-shape', '/unsupported', 'unknown', null, ['#unsupported-target'], null,
    { malformedPage: true, privacy: true }),
]);

export const componentContextMixedScenarios = Object.freeze([
  scenario('mixed-react-island', '/mixed/islands', 'react', null, ['#mixed-react-button'], ['MixedReactApp'],
    { provenance: 'react-dom-fiber-dev', mixed: 'islands', runtimeVersions: { react: '19.3.0', vue: '3.5.43', angular: '22.1.7' } }),
  scenario('mixed-vue-island', '/mixed/islands', 'vue', null, ['#mixed-vue-button'], ['MixedVueApp'],
    { provenance: 'vue3-instance-debug', mixed: 'islands', runtimeVersions: { react: '19.3.0', vue: '3.5.43', angular: '22.1.7' } }),
  scenario('mixed-angular-island', '/mixed/islands', 'angular', null,
    ['[data-fixture-id="angular-plan-card-host"]', '[data-fixture-id="angular-plan-card-leaf"]'], angularPath,
    { provenance: 'angular-debug-ownership', mixed: 'islands', openShadow: true,
      runtimeVersions: { react: '19.3.0', vue: '3.5.43', angular: '22.1.7' } }),
  scenario('mixed-dual-association', '/mixed/dual-association', 'mixed', null, ['#mixed-dual-button'], null,
    { mixed: 'dual-association', ambiguous: true, runtimeVersions: { react: '19.3.0', vue: '3.5.43', angular: '22.1.7' } }),
  scenario('mixed-react-angular-association', '/mixed/react-angular-association', 'mixed', null,
    ['#mixed-react-angular-button'], null,
    { mixed: 'react-angular-association', ambiguous: true,
      runtimeVersions: { react: '19.3.0', vue: '3.5.43', angular: '22.1.7' } }),
  scenario('mixed-vue-angular-association', '/mixed/vue-angular-association', 'mixed', null,
    ['#mixed-vue-angular-button'], null,
    { mixed: 'vue-angular-association', ambiguous: true,
      runtimeVersions: { react: '19.3.0', vue: '3.5.43', angular: '22.1.7' } }),
  scenario('mixed-triple-association', '/mixed/triple-association', 'mixed', null, ['#mixed-triple-button'], null,
    { mixed: 'triple-association', ambiguous: true,
      runtimeVersions: { react: '19.3.0', vue: '3.5.43', angular: '22.1.7' } }),
]);

export const componentContextScenarios = Object.freeze([
  ...componentContextPositiveScenarios,
  ...componentContextFallbackScenarios,
  ...componentContextMixedScenarios,
]);

export function componentFixtureUrl(origin, item) {
  return `${origin}${item.route}`;
}
