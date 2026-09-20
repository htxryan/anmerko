import type { JourneySession } from './journey-core';
import type { CaptureFailure } from './journey-limits';
import { privateImage } from './screenshot';

export interface JourneyClient {
  read(): Promise<JourneySession>;
  // Called directly from the Start click, so the adapter can request optional
  // permissions before crossing an asynchronous boundary.
  start(includeEnteredValues: boolean): Promise<void>;
  stop(): Promise<void>;
  discard(): Promise<void>;
  subscribe(changed: () => void): () => void;
  supportsEnteredValues?: boolean;
}

const failures: Record<CaptureFailure, string> = {
  superseded: 'superseded by a later action',
  'navigation-timeout': 'the destination did not become ready in time',
  'capture-denied': 'screenshot permission was denied',
  'protected-page': 'the browser protects this page',
  'page-document-changed': 'the page changed during capture',
  'viewport-changed': 'the viewport changed during capture',
  'too-large': 'the image exceeded the size limit',
  'storage-limit': 'the journey reached its storage limit',
  stopped: 'recording stopped before capture completed',
  'capture-error': 'the screenshot could not be captured',
};

function node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function elapsed(ms: number): string {
  const seconds = Math.floor(ms / 1_000);
  return `+${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}.${String(ms % 1_000).padStart(3, '0')}`;
}

// Mount only in a trusted extension surface (or an isolated demo adapter).
// The website recording strip never receives this client or its draft.
export function mountJourneyUI(root: HTMLElement, client: JourneyClient): () => void {
  const view = node('section', undefined, 'journey-view');
  view.setAttribute('aria-label', 'Journey recording and review');
  root.append(view);
  let state: JourneySession = { phase: 'idle', epoch: 0 };
  let busy = false;
  let alive = true;
  let version = 0;
  let actionVersion = 0;
  let includeEnteredValues = false;
  let error = '';

  async function refresh() {
    const current = ++version;
    try {
      const next = await client.read();
      if (!alive || current !== version) return;
      if (next.phase === 'idle' && state.phase !== 'idle') includeEnteredValues = false;
      state = next;
      render();
    } catch {
      if (alive && current === version) { error = 'Could not load the journey. Reopen anmerko and try again.'; render(); }
    }
  }

  function action(label: string, operation: () => Promise<void>, primary = false, canCancel = false) {
    const button = node('button', label, primary ? 'journey-primary' : 'journey-secondary');
    button.type = 'button';
    button.disabled = busy && !canCancel;
    button.addEventListener('click', () => {
      if (busy && !canCancel) return;
      const current = ++actionVersion;
      error = '';
      let request: Promise<void>;
      try { request = operation(); }
      catch (caught) { error = caught instanceof Error ? caught.message : 'Could not complete this action.'; render(); return; }
      busy = true;
      render();
      void request.catch(caught => {
        if (current === actionVersion) error = caught instanceof Error ? caught.message : 'Could not complete this action. Try again.';
      }).finally(() => {
        if (current !== actionVersion) return;
        busy = false;
        if (alive) void refresh();
      });
    });
    return button;
  }

  function render() {
    if (!alive) return;
    const scope = view.getRootNode();
    const activeElement = scope instanceof ShadowRoot ? scope.activeElement : document.activeElement;
    const oldFocus = view.contains(activeElement) ? activeElement?.textContent : null;
    view.replaceChildren();
    view.append(node('p', 'anmerko', 'journey-brand'));
    if (state.phase === 'idle' || state.phase === 'saved') {
      view.append(node('h1', 'Record a journey'));
      view.append(node('p', 'Record clicks and screenshots in the website tab you launched from as you move between websites. Stop whenever you are ready to review.', 'journey-help'));
      view.append(node('p', 'Screenshots and full URLs can contain personal information, even when entered values are off. Review and remove sensitive details before sharing.', 'journey-notice'));
      if (client.supportsEnteredValues) {
        const label = node('label', undefined, 'journey-option');
        const input = node('input');
        input.type = 'checkbox'; input.checked = includeEnteredValues; input.disabled = busy;
        input.addEventListener('change', () => { includeEnteredValues = input.checked; });
        label.append(input, node('span', 'Include entered values'));
        view.append(label);
      } else view.append(node('p', 'Entered values: Off', 'journey-help'));
      view.append(node('p', 'Up to 5 minutes or 30 steps. Only the original website tab is recorded.', 'journey-help'));
      const buttons = node('div', undefined, 'journey-actions');
      buttons.append(action('Start journey', () => client.start(includeEnteredValues), true));
      if (busy) buttons.append(action('Cancel start', () => client.stop(), false, true));
      view.append(buttons);
    } else if (state.phase === 'starting' || state.phase === 'recording') {
      const recording = state.phase === 'recording';
      view.append(node('h1', recording ? 'Recording journey' : 'Taking the first screenshot…'));
      const status = node('p', recording ? `${state.draft.steps.length} steps recorded. Continue in the original tab.` : 'Recording begins after the first screenshot succeeds.', 'journey-help');
      status.setAttribute('role', 'status');
      view.append(status, action(recording ? 'Stop journey' : 'Cancel start', () => client.stop(), true, true));
    } else {
      view.append(node('h1', 'Review journey'));
      view.append(node('p', `${state.draft.steps.length} retained steps · Entered values: ${state.draft.includeEnteredValues ? 'On' : 'Off'}`, 'journey-help'));
      const list = node('ol', undefined, 'journey-steps');
      for (const step of state.draft.steps) {
        const item = node('li'); item.value = step.seq;
        const label = step.kind === 'initial' ? 'Initial view'
          : step.kind === 'navigation' ? 'Navigation'
          : `${step.kind === 'click' ? 'Click' : 'Entered value'}: ${step.target.label}`;
        item.append(node('h2', `Step ${step.seq} · ${label}`), node('p', elapsed(step.elapsedMs), 'journey-time'));
        item.append(node('p', 'Source URL', 'journey-meta-label'), node('p', step.sourceUrl, 'journey-url'));
        if (step.image.status === 'retained') {
          const image = state.draft.images[step.image.imageId];
          if (image) {
            item.append(node('p', 'Screenshot URL', 'journey-meta-label'), node('p', image.captureUrl, 'journey-url'));
            item.append(node('p', `Captured ${image.capturedAt}`, 'journey-time'));
            if (image.dataUrl) {
              const preview = privateImage(image.dataUrl, `Screenshot for step ${step.seq}`);
              preview.className = 'journey-image'; item.append(preview);
            }
          }
        } else {
          const reason = step.image.status === 'unavailable' ? failures[step.image.reason]
            : step.image.status === 'removed' ? 'removed during review' : 'capture pending';
          item.append(node('p', `Screenshot unavailable: ${reason}.`, 'journey-help'));
        }
        list.append(item);
      }
      view.append(list, action('Discard journey', () => client.discard()));
    }
    if (error) {
      const alert = node('p', error, 'journey-error'); alert.setAttribute('role', 'alert'); view.append(alert);
    }
    if (oldFocus) Array.from(view.querySelectorAll('button')).find(button => button.textContent === oldFocus && !button.disabled)?.focus();
  }

  const unsubscribe = client.subscribe(() => { void refresh(); });
  void refresh();
  return () => { alive = false; ++version; unsubscribe(); view.remove(); };
}
