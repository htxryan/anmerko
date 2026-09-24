import { h, render } from 'preact';
import { memo, forwardRef } from 'preact/compat';

declare const __FIXTURE_VERSION__: string;
declare const __FIXTURE_MODE__: string;

type FixtureTarget = { id: string; expectedPath: string[]; kind: string };
type FixtureRecord = {
  ready: boolean;
  framework: string;
  version: string;
  mode: string;
  runtimeVersion: string;
  targets: Record<string, FixtureTarget>;
  privacyReads: Record<string, number>;
};

const privacyReads = { props: 0, state: 0, source: 0, stack: 0 };

function FeedbackButton({ id, label }: { id: string; label: string }) {
  return <button id={id} type="button">{label}</button>;
}
FeedbackButton.displayName = 'FeedbackButton';

function PlanCard({ id = 'preact-nested-button', label = 'Nested button' }: { id?: string; label?: string }) {
  return <article data-component="PlanCard"><FeedbackButton id={id} label={label} /></article>;
}
PlanCard.displayName = 'PlanCard';

const MemoPlanCard = memo(PlanCard);
MemoPlanCard.displayName = 'MemoPlanCard';

const ForwardedPanel = forwardRef(function ForwardedPanel({ id = 'preact-forward-button', label = 'Forward button' }: { id?: string; label?: string }, _ref: unknown) {
  return <div data-component="ForwardedPanel"><FeedbackButton id={id} label={label} /></div>;
});
ForwardedPanel.displayName = 'ForwardedPanel';

function PricingPage() {
  return <section data-component="PricingPage">
    <PlanCard />
    <MemoPlanCard id="preact-memo-button" label="Memo button" />
    <ForwardedPanel />
  </section>;
}

function App() {
  return <main data-component="App"><PricingPage /></main>;
}

PricingPage.displayName = 'PricingPage';
App.displayName = 'App';

const root = document.querySelector('#preact-root');
if (!(root instanceof HTMLElement)) throw new Error('Missing Preact root');
render(<App />, root);

const targets: Record<string, FixtureTarget> = Object.freeze({
  nested: {
    id: 'preact-nested-button',
    expectedPath: ['App', 'PricingPage', 'PlanCard', 'FeedbackButton'],
    kind: 'nested',
  },
  memo: {
    id: 'preact-memo-button',
    expectedPath: ['App', 'PricingPage', 'MemoPlanCard', 'PlanCard', 'FeedbackButton'],
    kind: 'memo-wrapper',
  },
  forward: {
    id: 'preact-forward-button',
    expectedPath: ['App', 'PricingPage', 'ForwardedPanel', 'FeedbackButton'],
    kind: 'forward-ref-wrapper',
  },
  anonymous: { id: 'preact-anonymous-button', expectedPath: [], kind: 'anonymous-fallback' },
});

function mountAnonymous() {
  const host = document.querySelector('#preact-anonymous-host');
  if (!(host instanceof HTMLElement)) throw new Error('Missing Preact anonymous host');
  render(<button id="preact-anonymous-button" type="button">Anonymous button</button>, host);
}
mountAnonymous();

requestAnimationFrame(() => Object.defineProperty(globalThis, '__ANMERKO_FIXTURE__', {
  value: Object.freeze({
    ready: true,
    framework: 'preact',
    version: __FIXTURE_VERSION__,
    mode: __FIXTURE_MODE__,
    runtimeVersion: __FIXTURE_VERSION__,
    targets,
    privacyReads,
  }) as FixtureRecord,
}));
