import { createJourneyClient } from './journey-client';
import { targetJourneys } from './journey-feature';
import { journeySurfaceStyles } from './journey-styles';
import { mountJourneyUI } from './journey-ui';

const root = document.querySelector<HTMLElement>('#journey');
if (!root) throw new Error('Journey page root is missing.');

function launchIntent(hash: string): string | undefined {
  const match = /^#launch=([A-Za-z0-9_-]{16,128})$/.exec(hash);
  return match?.[1];
}

if (!targetJourneys) {
  const section = document.createElement('section');
  const heading = document.createElement('h1');
  const explanation = document.createElement('p');
  heading.textContent = 'Journey recording unavailable';
  explanation.textContent = 'This build does not include journey recording.';
  section.append(heading, explanation);
  root.append(section);
} else {
  const style = document.createElement('style');
  style.textContent = journeySurfaceStyles;
  document.head.append(style);
  const intent = launchIntent(location.hash);
  // Each launch link starts one journey: the background consumes it on the
  // first Start, even one that fails. A review tab opened from the toolbar has
  // no link at all. Either way this tab then offers guidance instead of Start.
  let launchUsed = intent === undefined;
  // Start and Cancel start stay until the one start this link allows settles.
  let startInFlight = false;
  const base = createJourneyClient(undefined, intent);
  const client = {
    ...base,
    read: async () => {
      const session = await base.read();
      if (session.phase !== 'idle') launchUsed = true;
      return session;
    },
    canStart: () => !launchUsed || startInFlight,
    start: async (includeEnteredValues: boolean): Promise<void> => {
      launchUsed = true;
      startInFlight = true;
      try {
        await base.start(includeEnteredValues);
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code === 'launch-expired') showLaunchExpired();
        throw error;
      } finally {
        startInFlight = false;
      }
    },
  };
  const unmount = mountJourneyUI(root, client);
  function showLaunchExpired(): void {
    unmount();
    if (!root) return;
    root.replaceChildren();
    const section = document.createElement('section');
    section.className = 'journey-view';
    const brand = document.createElement('p');
    brand.className = 'journey-brand';
    brand.textContent = 'anmerko';
    const heading = document.createElement('h1');
    heading.tabIndex = -1;
    const explanation = document.createElement('p');
    explanation.className = 'journey-help';
    heading.textContent = 'This journey link already opened';
    explanation.textContent = 'Each journey link works once. Return to the website tab and choose Record journey to start a fresh journey.';
    section.append(brand, heading, explanation);
    root.append(section);
    heading.focus();
  }
}
