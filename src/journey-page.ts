import journeyStyles from './journey.css';
import { createJourneyClient } from './journey-client';
import { journeysEnabled } from './journey-feature';
import { mountJourneyUI } from './journey-ui';

const root = document.querySelector<HTMLElement>('#journey');
if (!root) throw new Error('Journey page root is missing.');

function launchIntent(hash: string): string | undefined {
  const match = /^#launch=([A-Za-z0-9_-]{16,128})$/.exec(hash);
  return match?.[1];
}

if (!journeysEnabled) {
  const section = document.createElement('section');
  const heading = document.createElement('h1');
  const explanation = document.createElement('p');
  heading.textContent = 'Journey recording unavailable';
  explanation.textContent = 'This build does not include journey recording.';
  section.append(heading, explanation);
  root.append(section);
} else {
  const style = document.createElement('style');
  style.textContent = journeyStyles;
  document.head.append(style);
  const base = createJourneyClient(undefined, launchIntent(location.hash));
  const client = {
    ...base,
    start: async (includeEnteredValues: boolean): Promise<void> => {
      try {
        await base.start(includeEnteredValues);
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code === 'launch-expired') showLaunchExpired();
        throw error;
      }
    },
  };
  const unmount = mountJourneyUI(root, client);
  function showLaunchExpired(): void {
    unmount();
    if (!root) return;
    root.replaceChildren();
    const section = document.createElement('section');
    const heading = document.createElement('h1');
    const explanation = document.createElement('p');
    heading.textContent = 'This journey link already opened';
    explanation.textContent = 'Each journey link works once. Return to the website tab and choose Record journey to start a fresh journey.';
    section.append(heading, explanation);
    root.append(section);
  }
}
