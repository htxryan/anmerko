import { journeysEnabled } from './journey-feature';
import { bindJourneyPage } from './journey-page-bridge';

type JourneyObserverGlobal = typeof globalThis & { __anmerkoJourneyPage?: () => void };

export function ensureJourneyPage(): (() => void) | undefined {
  if (!journeysEnabled || window.top !== window) return;
  const global = globalThis as JourneyObserverGlobal;
  if (global.__anmerkoJourneyPage) return global.__anmerkoJourneyPage;
  let dispose: () => void;
  dispose = bindJourneyPage(() => {
    if (global.__anmerkoJourneyPage === dispose) delete global.__anmerkoJourneyPage;
  });
  global.__anmerkoJourneyPage = dispose;
  return dispose;
}

ensureJourneyPage();
