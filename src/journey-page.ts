import { createJourneyClient } from './journey-client';
import { currentPlatform, journeysAvailable } from './journey-feature';
import { journeySurfaceStyles } from './journey-styles';
import { mountJourneyUI } from './journey-ui';
import { extensionApi } from './platform';

const root = document.querySelector<HTMLElement>('#journey');
if (!root) throw new Error('Journey page root is missing.');

function launchIntent(hash: string): string | undefined {
  const match = /^#launch=([A-Za-z0-9_-]{16,128})$/.exec(hash);
  return match?.[1];
}

// The tab follows the panel's Appearance setting (content.ts), light unless
// Dark is stored, and changes with it while open. The stored setting is read
// asynchronously, so the tab keeps a copy of the theme it last resolved and
// paints with it at once, and mounts its content only once the stored setting
// is known: a Dark reader never sees the tab in light first. The root element
// carries the color scheme too, so the canvas and scrollbars match.
const THEME_KEY = 'anmerko:theme';
const THEME_COPY_KEY = 'anmerko:journey-theme';
// Storage normally answers within milliseconds; the tab never waits longer.
const THEME_WAIT_MS = 500;

function applyTheme(value: unknown): 'dark' | 'light' {
  const theme = value === 'dark' ? 'dark' : 'light';
  document.documentElement.style.colorScheme = theme;
  document.body.dataset.theme = theme;
  return theme;
}

function followTheme(ready: () => void): void {
  let copy: string | null = null;
  try { copy = localStorage.getItem(THEME_COPY_KEY); } catch { /* Painted light until the stored theme is read. */ }
  applyTheme(copy);
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    ready();
  };
  const resolve = (value: unknown) => {
    const theme = applyTheme(value);
    try { localStorage.setItem(THEME_COPY_KEY, theme); } catch { /* The next tab waits for storage instead. */ }
  };
  let changed = false;
  try {
    const storage = extensionApi().storage;
    storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[THEME_KEY]) return;
      changed = true;
      resolve(changes[THEME_KEY].newValue);
      settle();
    });
    setTimeout(settle, THEME_WAIT_MS);
    void storage.local.get(THEME_KEY).then(stored => { if (!changed) resolve(stored[THEME_KEY]); }, () => {}).finally(settle);
  } catch {
    // Without readable storage the tab keeps the default theme.
    settle();
  }
}

const style = document.createElement('style');
style.textContent = journeySurfaceStyles;
document.head.append(style);

followTheme(() => {
  if (!journeysAvailable({ platform: currentPlatform(), api: extensionApi() })) {
    const section = document.createElement('section');
    section.className = 'journey-view';
    const brand = document.createElement('p');
    brand.className = 'journey-brand';
    brand.textContent = 'anmerko';
    const heading = document.createElement('h1');
    const explanation = document.createElement('p');
    explanation.className = 'journey-help';
    heading.textContent = 'Journey recording unavailable';
    explanation.textContent = 'Journeys are not available in this browser. They work in Chrome, Edge, and Firefox on computers and in Edge and Firefox on Android, but not on iPhone or iPad. Comments still work on the website tab.';
    section.append(brand, heading, explanation);
    root.append(section);
  } else {
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
});
