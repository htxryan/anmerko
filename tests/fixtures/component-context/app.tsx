import React, { Component, forwardRef, memo } from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom-entry';

declare const __FIXTURE_VERSION__: string;
declare const __FIXTURE_MODE__: string;
declare const __FIXTURE_RENDERER__: string;

type FixtureTarget = { id: string; expectedPath: string[]; kind: string };
type FixtureRecord = {
  ready: boolean;
  framework: string;
  version: string;
  mode: string;
  runtimeVersion: string;
  rendererEntry: string;
  targets: Record<string, FixtureTarget>;
  privacyReads: Record<string, number>;
};

const privacyReads = { props: 0, state: 0, source: 0, stack: 0 };

const Button = forwardRef<HTMLButtonElement, { id: string; children: React.ReactNode }>(function FeedbackButton(props, ref) {
  return <button id={props.id} ref={ref} type="button">{props.children}</button>;
});
Button.displayName = 'Button';

function PlanCard({ id = 'react-nested-button', label = 'Nested button' }) {
  return <article data-component="PlanCard"><Button id={id}>{label}</Button></article>;
}

const MemoPlanCard = memo(PlanCard, () => true);
MemoPlanCard.displayName = 'MemoPlanCard';

class ClassPanel extends Component {
  render() { return <Button id="react-class-button">Class button</Button>; }
}

function PortalPanel() {
  const target = document.querySelector('#react-portal');
  return target ? createPortal(<Button id="react-portal-button">Portal button</Button>, target) : null;
}

function ShadowPanel({ target }: { target: ShadowRoot }) {
  return createPortal(<Button id="react-shadow-button">Shadow button</Button>, target);
}

function PricingPage({ shadow }: { shadow: ShadowRoot }) {
  return <section data-component="PricingPage">
    <PlanCard />
    <MemoPlanCard id="react-memo-button" label="Memo button" />
    <ClassPanel />
    <PortalPanel />
    <ShadowPanel target={shadow} />
  </section>;
}

function App({ shadow }: { shadow: ShadowRoot }) {
  return <main data-component="App"><PricingPage shadow={shadow} /></main>;
}

const shadowHost = document.querySelector('#react-shadow-host');
if (!(shadowHost instanceof HTMLElement)) throw new Error('Missing React shadow host');
const shadow = shadowHost.attachShadow({ mode: 'open' });
const root = document.querySelector('#react-root');
if (!(root instanceof HTMLElement)) throw new Error('Missing React root');
createRoot(root).render(<App shadow={shadow} />);

function installPrivacyTraps(target: Element) {
  const sentinel = {};
  for (const key of Object.keys(privacyReads) as Array<keyof typeof privacyReads>) {
    Object.defineProperty(sentinel, key, { get() { privacyReads[key] += 1; throw new Error(`forbidden:${key}`); } });
  }
  Object.defineProperty(target, '__anmerkoPrivacySentinel', { value: sentinel });
  const fiberKey = Object.getOwnPropertyNames(target).find(name => name.startsWith('__reactFiber$'));
  if (!fiberKey) return;
  const fiber = (target as unknown as Record<string, object>)[fiberKey];
  const descriptor = Object.getOwnPropertyDescriptor(fiber, '_debugSource');
  if (descriptor?.configurable || (!descriptor && Object.isExtensible(fiber))) {
    Object.defineProperty(fiber, '_debugSource', {
      configurable: true,
      get() { privacyReads.source += 1; throw new Error('forbidden:source'); },
    });
  }
}

function finalizeFixture(attempt = 0) {
  const nested = document.querySelector('#react-nested-button');
  const portal = document.querySelector('#react-portal-button');
  const shadowButton = shadow.querySelector('#react-shadow-button');
  if (!(nested instanceof Element) || !(portal instanceof Element) || !(shadowButton instanceof Element)) {
    if (attempt < 120) { requestAnimationFrame(() => finalizeFixture(attempt + 1)); return; }
    throw new Error('React fixture did not render every target');
  }
  installPrivacyTraps(nested);
  const targets: Record<string, FixtureTarget> = {
    nested: { id: 'react-nested-button', expectedPath: ['App', 'PricingPage', 'PlanCard', 'FeedbackButton'], kind: 'nested' },
    memo: { id: 'react-memo-button', expectedPath: ['App', 'PricingPage', 'PlanCard', 'FeedbackButton'], kind: 'memo' },
    class: { id: 'react-class-button', expectedPath: ['App', 'PricingPage', 'ClassPanel', 'FeedbackButton'], kind: 'class' },
    portal: { id: 'react-portal-button', expectedPath: ['App', 'PricingPage', 'PortalPanel', 'FeedbackButton'], kind: 'portal' },
    shadow: { id: 'react-shadow-button', expectedPath: ['App', 'PricingPage', 'ShadowPanel', 'FeedbackButton'], kind: 'open-shadow-portal' },
  };
  const fixture: FixtureRecord = Object.freeze({
    ready: true,
    framework: 'react',
    version: __FIXTURE_VERSION__,
    mode: __FIXTURE_MODE__,
    runtimeVersion: React.version,
    rendererEntry: __FIXTURE_RENDERER__,
    targets: Object.freeze(targets),
    privacyReads,
  });
  Object.defineProperty(globalThis, '__ANMERKO_FIXTURE__', { value: fixture });
}
requestAnimationFrame(() => finalizeFixture());
