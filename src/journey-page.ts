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
  mountJourneyUI(root, createJourneyClient(undefined, launchIntent(location.hash)));
}
