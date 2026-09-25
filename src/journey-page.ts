import { createJourneyClient } from './journey-client';
import { currentPlatform, journeysAvailable } from './journey-feature';
import { journeySurfaceStyles } from './journey-styles';
import { mountJourneyUI } from './journey-ui';
import { extensionApi } from './platform';

const root = document.querySelector<HTMLElement>('#journey');
if (!root) throw new Error('Journey page root is missing.');

// The tab's title names its view first, so tab strips show what differs.
function setTitle(view: string): void {
  document.title = `${view} – anmerko`;
}

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

function showUnavailable(text: string): void {
  if (!root) return;
  const section = document.createElement('section');
  section.className = 'journey-view';
  const brand = document.createElement('p');
  brand.className = 'journey-brand';
  brand.textContent = 'anmerko';
  const heading = document.createElement('h1');
  const explanation = document.createElement('p');
  explanation.className = 'journey-help';
  heading.textContent = 'Journey recording unavailable';
  setTitle(heading.textContent);
  explanation.textContent = text;
  section.append(brand, heading, explanation);
  root.append(section);
}

// Journeys are unavailable in private windows, so a journey tab there shows
// no journey, neither a regular window's nor its own.
async function privateWindow(): Promise<boolean> {
  try {
    const api = extensionApi();
    if (api.extension?.inIncognitoContext) return true;
    return (await api.tabs.getCurrent())?.incognito === true;
  } catch {
    return false;
  }
}

followTheme(() => {
  if (!journeysAvailable({ platform: currentPlatform(), api: extensionApi() })) {
    showUnavailable('Journeys are not available in this browser. They work in Chrome, Edge, and Firefox on computers and in Edge and Firefox on Android, but not on iPhone or iPad. Comments still work on the website tab.');
    return;
  }
  void privateWindow().then(isPrivate => {
    if (isPrivate) showUnavailable("Journeys aren't available in private windows. Comments still work on the website tab.");
    else mountJourney();
  });
});

function mountJourney(): void {
  const container = root as HTMLElement;
  // The next Record journey reuses a spent journey tab by giving it a new
  // launch link. The link changes only the hash, so the tab loads afresh for it.
  window.addEventListener('hashchange', () => location.reload());
  const intent = launchIntent(location.hash);
  // Each launch link starts one journey: the background consumes it on the
  // first Start, even one that fails. A review tab opened from the toolbar has
  // no link at all. Either way this tab then offers guidance instead of Start.
  let launchUsed = intent === undefined;
  // Start and Cancel start stay until the one start this link allows settles.
  let startInFlight = false;
  // Back can reload a link the next Record journey replaced, or one already
  // used, so the tab asks once whether its link can still start a journey
  // before offering Start. Only a clear no withholds it; the background
  // refuses a spent link either way.
  const linkChecked = intent === undefined ? Promise.resolve() : Promise.resolve()
    .then(() => extensionApi().runtime.sendMessage({ type: 'ANMERKO_JOURNEY_LAUNCH_PENDING', intent }))
    .then((response: unknown) => {
      const answer = response as { ok?: unknown; value?: unknown } | undefined;
      if (answer?.ok === true && answer.value === false) launchUsed = true;
    }, () => {});
  const base = createJourneyClient(undefined, intent);
  const client = {
    ...base,
    read: async () => {
      const [session] = await Promise.all([base.read(), linkChecked]);
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
  const unmount = mountJourneyUI(container, client, { title: setTitle });
  function showLaunchExpired(): void {
    unmount();
    container.replaceChildren();
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
    setTitle('Journey link already used');
    explanation.textContent = 'Each journey link works once. Return to the website tab and choose Record journey to start a fresh journey.';
    section.append(brand, heading, explanation);
    container.append(section);
    heading.focus();
  }
}
