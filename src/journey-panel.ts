import { icon } from './icons';
import { mountJourneyUI, savedJourneyTime, savedJourneyTitle, type JourneySavedSummary } from './journey-ui';
import type { Runtime } from './runtime';

// Record journey from a page panel asks the background for a journey tab.
// Each refusal says what to do next on this page.
const OPEN_GUIDANCE: Record<string, string> = {
  busy: 'A journey is already recording in another tab. Stop it there, then try again.',
  'owner-unavailable': 'anmerko could not use this page for a journey. Keep this tab in front and try again. If it still fails, reload the page.',
  'initial-capture-failed': 'The first journey screenshot failed. Keep this tab in front and try again.',
  'launch-expired': 'That journey tab expired. Choose Record journey again.',
  'session-storage-failed': 'Journey storage failed. Choose Record journey again to open the journey tab and reset journey storage.',
  'stale-review': 'The journey changed in another anmerko view. Choose Review journey to see the latest version.',
  unreachable: 'anmerko could not reach the extension. Reload this page, then try again.',
};
const OPEN_ERROR = 'Could not open the journey tab. Try again.';
const REOPEN_BUSY = 'Finish or discard the current journey before reopening a saved one.';
const REOPEN_ERROR = 'Could not reopen the journey. Try again.';

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

export interface JourneyPanelHost {
  runtime: Runtime;
  app: HTMLElement;
  shadow: ShadowRoot;
  signal: AbortSignal;
  state(): { alive: boolean; draft: boolean; capturing: boolean; settings: boolean };
  status(text: string, error: boolean): void;
  closeMenu(): void;
  commentsChanged(): void;
}

export interface JourneyPanel {
  render(): void;
  refreshReview(): void;
  loadSaved(): Promise<JourneySavedSummary[] | null>;
  savedSection(items: JourneySavedSummary[]): HTMLElement;
}

// The panel's journey entry points: More Comment Options with Record journey,
// the offer of a pending review, and the comments view's Saved journeys.
export function attachJourneyPanel(host: JourneyPanelHost): JourneyPanel {
  const { runtime, app, shadow, signal } = host;
  const client = runtime.journeys;
  const $ = <T extends HTMLElement = HTMLElement>(selector: string) => shadow.querySelector<T>(selector)!;
  // Built with DOM APIs: Firefox's add-on linter rejects interpolated innerHTML.
  const options = document.createElement('button');
  options.className = 'primary comment-action comment-options';
  for (const [name, value] of [['aria-label', 'More Comment Options'], ['title', 'More Comment Options'], ['aria-haspopup', 'menu'],
    ['aria-expanded', 'false'], ['aria-controls', 'comment-menu']]) options.setAttribute(name, value);
  const chevron = document.createElement('span');
  chevron.dataset.icon = 'chevron';
  chevron.append(icon('chevron'));
  options.append(chevron);
  const menu = document.createElement('div');
  menu.className = 'comment-menu split-menu';
  menu.id = 'comment-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'Comment Options');
  menu.hidden = true;
  $('.intro').append(options, menu);
  const record = document.createElement('button');
  record.className = 'menu-action journey-record';
  record.setAttribute('role', 'menuitem'); record.tabIndex = -1;
  record.textContent = 'Record journey';
  menu.append(record);
  const entry = document.createElement('div');
  entry.className = 'journey-pending';
  entry.hidden = true;
  const entryText = document.createElement('p');
  entryText.textContent = 'A recorded journey is waiting for review.';
  const review = document.createElement('button');
  review.className = 'secondary journey-review';
  review.type = 'button';
  review.textContent = 'Review journey';
  entry.append(entryText, review);
  $('.content').prepend(entry);

  let reviewPending = false;
  let reviewVersion = 0;
  let disposeView: (() => void) | undefined;
  let stopFocusWait: (() => void) | undefined;

  // A draft or a capture in progress holds the panel.
  const busy = () => { const { draft, capturing } = host.state(); return draft || capturing; };

  function render() {
    const { draft, capturing, settings } = host.state();
    record.textContent = reviewPending ? 'Review journey' : 'Record journey';
    entry.hidden = !reviewPending || settings || draft;
    review.disabled = capturing;
  }

  function refreshReview() {
    const version = ++reviewVersion;
    const pending = client
      ? typeof client.read === 'function' ? client.read().then(state => state.phase === 'reviewing' || state.phase === 'saving') : Promise.resolve(false)
      : runtime.journeyReviewPending?.() ?? Promise.resolve(false);
    void pending.catch(() => false).then(value => {
      if (!host.state().alive || version !== reviewVersion) return;
      reviewPending = value;
      render();
    });
  }

  // The journey view lives in a trusted surface: this panel when it is the
  // native side panel, otherwise a journey tab the background opens.
  function openJourney(focusId?: string) {
    if (!client) {
      void runtime.openJourney?.().then(refreshReview, error => {
        host.status(OPEN_GUIDANCE[errorCode(error) ?? ''] ?? OPEN_ERROR, true);
        refreshReview();
      });
      return;
    }
    disposeView?.();
    const container = document.createElement('div'); container.className = 'journey-container';
    const back = document.createElement('button'); back.className = 'journey-return secondary';
    back.textContent = 'Back to comments'; back.type = 'button';
    container.append(back); app.append(container);
    $('.panel').inert = true;
    const unmount = mountJourneyUI(container, client);
    disposeView = () => { stopFocusWait?.(); unmount(); container.remove(); $('.panel').inert = false; disposeView = undefined; };
    back.addEventListener('click', () => {
      disposeView?.();
      // Return to the control that opened the journey, or the first usable one.
      ['.comment-options', '.select', '.settings-button'].map(selector => $<HTMLButtonElement>(selector))
        .find(control => !control.disabled)?.focus();
      host.commentsChanged();
      refreshReview();
    });
    back.focus();
    if (!focusId) return;
    // The view renders once the background answers. Its requested control
    // takes focus when it appears, unless the reader has moved on.
    const focus = () => {
      const target = container.querySelector<HTMLElement>(`[data-focus-id="${CSS.escape(focusId)}"]`);
      if (!target) return false;
      if (shadow.activeElement === back || shadow.activeElement === null) {
        target.focus();
        target.scrollIntoView({ block: 'nearest' });
      }
      return true;
    };
    if (focus()) return;
    const observer = new MutationObserver(() => { if (focus()) stopFocusWait?.(); });
    const timeout = setTimeout(() => stopFocusWait?.(), 5_000);
    stopFocusWait = () => { observer.disconnect(); clearTimeout(timeout); stopFocusWait = undefined; };
    observer.observe(container, { childList: true, subtree: true });
  }

  const start = (event: Event) => {
    if (!event.isTrusted || busy()) return;
    host.closeMenu();
    openJourney();
  };
  record.addEventListener('click', start, { signal });
  review.addEventListener('click', start, { signal });
  const unsubscribe = client && typeof client.subscribe === 'function' ? client.subscribe(refreshReview) : undefined;
  // A page panel hears nothing from the background, so it asks again when
  // the reader returns to it or opens its menu.
  if (!client) {
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshReview(); }, { signal });
    window.addEventListener('focus', refreshReview, { signal });
    options.addEventListener('click', refreshReview, { signal });
  }
  signal.addEventListener('abort', () => { disposeView?.(); unsubscribe?.(); }, { once: true });

  async function loadSaved(): Promise<JourneySavedSummary[] | null> {
    if (!client || typeof client.list !== 'function') return null;
    try {
      const items = await client.list();
      if (!Array.isArray(items)) return null;
      const seen = new Set<string>();
      const unique: JourneySavedSummary[] = [];
      for (const item of items) {
        if (!item || typeof item.journeyId !== 'string' || seen.has(item.journeyId)) continue;
        seen.add(item.journeyId);
        unique.push(item);
      }
      return unique;
    } catch {
      // A missing or unreadable journey list never blocks the comments list.
      return null;
    }
  }

  function savedSection(items: JourneySavedSummary[]): HTMLElement {
    const held = busy();
    const section = document.createElement('section');
    section.className = 'saved-journeys';
    section.setAttribute('aria-label', 'Saved journeys');
    const heading = document.createElement('h2');
    heading.className = 'saved-journeys-title';
    heading.textContent = 'Saved journeys';
    section.append(heading);
    const list = document.createElement('ul');
    list.className = 'saved-journeys-list';
    for (const journey of items) {
      const row = document.createElement('li');
      row.className = 'saved-journey';
      const text = document.createElement('div');
      text.className = 'saved-journey-text';
      const title = document.createElement('span');
      title.className = 'saved-journey-title';
      title.textContent = savedJourneyTitle(journey);
      const meta = document.createElement('span');
      meta.className = 'saved-journey-meta';
      const time = document.createElement('time');
      time.dateTime = journey.updatedAt;
      time.textContent = savedJourneyTime(journey.updatedAt);
      meta.append('Saved ', time, ` · ${journey.stepCount} ${journey.stepCount === 1 ? 'step' : 'steps'}`);
      if (journey.spansPages === true) {
        const spans = document.createElement('span');
        spans.className = 'saved-journey-spans';
        spans.textContent = 'Spans pages';
        meta.append(' · ', spans);
      }
      text.append(title, meta);
      row.append(text);
      // Reopening loads the journey into review, where it can be shared.
      if (client && typeof client.reopen === 'function') {
        const reopen = document.createElement('button');
        reopen.className = 'secondary saved-journey-reopen';
        reopen.type = 'button';
        reopen.textContent = 'Reopen';
        reopen.setAttribute('aria-label', `Reopen journey: ${title.textContent}, saved ${time.textContent}`);
        reopen.disabled = held;
        reopen.addEventListener('click', () => {
          if (reopen.disabled) return;
          reopen.disabled = true;
          client.reopen(journey.journeyId).then(() => { if (host.state().alive) openJourney(); }, error => {
            if (!host.state().alive) return;
            reopen.disabled = false;
            host.status(errorCode(error) === 'busy' ? REOPEN_BUSY
              : error instanceof Error && error.message ? error.message : REOPEN_ERROR, true);
          });
        });
        row.append(reopen);
      }
      list.append(row);
    }
    section.append(list);
    // Deleting, and every other saved journey action, live in the journey view.
    if (client && typeof client.read === 'function' && typeof client.subscribe === 'function') {
      const manage = document.createElement('button');
      manage.className = 'text-button saved-journeys-manage';
      manage.type = 'button';
      manage.textContent = 'Manage saved journeys';
      manage.disabled = held;
      manage.addEventListener('click', () => { if (!manage.disabled) openJourney('journey-saved-heading'); });
      section.append(manage);
    }
    return section;
  }

  return { render, refreshReview, loadSaved, savedSection };
}
