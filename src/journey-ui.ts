import type { JourneyDraftV1, JourneySession } from './journey-core';
import type { CaptureFailure } from './journey-limits';
import { privateImage } from './screenshot';

export interface JourneyClient {
  read(): Promise<JourneySession>;
  // Called directly from the Start click, so the adapter can request optional
  // permissions before crossing an asynchronous boundary.
  start(includeEnteredValues: boolean): Promise<void>;
  stop(): Promise<void>;
  discard(): Promise<void>;
  updateSummary(expected: string, actual: string): Promise<void>;
  removeStep(stepId: string): Promise<void>;
  editValue(stepId: string, value: unknown): Promise<void>;
  redactUrl(stepId: string, url: 'source' | 'capture'): Promise<void>;
  save(acknowledged: boolean): Promise<{ journeyId: string; revision: number }>;
  list(): Promise<Array<{ journeyId: string; revision: number; updatedAt: string; stepCount: number }>>;
  subscribe(changed: () => void): () => void;
  supportsEnteredValues?: boolean;
}

const JOURNEY_STORAGE_ERROR = 'Journey storage failed. Reset journey storage to continue. A previous draft or the latest action may be lost.';

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
  let loadFailed = false;
  let summaryPending: { expected: string; actual: string } | null = null;
  let summaryTimer: ReturnType<typeof setTimeout> | undefined;
  let summarySaving = false;
  let confirmingRemove: string | null = null;
  let removing = false;
  let acknowledged = false;
  let acknowledgedFor = '';
  let rendering = false;

  async function refresh() {
    const current = ++version;
    try {
      const next = await client.read();
      if (!alive || current !== version) return;
      if (next.phase === 'idle' && state.phase !== 'idle') includeEnteredValues = false;
      state = next;
      if (next.phase === 'reviewing') {
        if (acknowledgedFor !== '' && acknowledgedFor !== next.draft.id) acknowledged = false;
        acknowledgedFor = next.draft.id;
        if (confirmingRemove !== null && !next.draft.steps.some(step => step.id === confirmingRemove)) confirmingRemove = null;
      } else {
        acknowledged = false;
        acknowledgedFor = '';
        summaryPending = null;
        confirmingRemove = null;
      }
      loadFailed = false;
      render();
    } catch (caught) {
      if (alive && current === version) {
        loadFailed = true;
        error = caught instanceof Error && caught.message === JOURNEY_STORAGE_ERROR
          ? JOURNEY_STORAGE_ERROR
          : 'Could not load the journey. Reopen anmerko and try again.';
        render();
      }
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

  function codePoints(value: string): number {
    return Array.from(value).length;
  }

  function scheduleSummarySave(): void {
    if (summaryTimer !== undefined) clearTimeout(summaryTimer);
    summaryTimer = setTimeout(() => { void flushSummary(); }, 400);
  }

  async function flushSummary(): Promise<void> {
    if (summaryTimer !== undefined) { clearTimeout(summaryTimer); summaryTimer = undefined; }
    if (!summaryPending || summarySaving || !alive) return;
    if (state.phase !== 'reviewing') { summaryPending = null; return; }
    const wanted = summaryPending;
    summarySaving = true;
    try {
      await client.updateSummary(wanted.expected, wanted.actual);
      if (summaryPending === wanted) summaryPending = null;
      error = '';
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'Could not update the journey. Try again.';
    } finally {
      summarySaving = false;
    }
    if (summaryPending && summaryPending !== wanted) scheduleSummarySave();
    else if (alive) void refresh();
  }

  function renderSummaries(draft: JourneyDraftV1): HTMLElement {
    const section = node('section', undefined, 'journey-summary');
    section.setAttribute('aria-label', 'Expected and actual summaries');
    const areas = {} as Record<'expected' | 'actual', HTMLTextAreaElement>;
    const fields: Array<{ key: 'expected' | 'actual'; id: string; label: string; value: string }> = [
      { key: 'expected', id: 'journey-expected', label: 'Expected result', value: summaryPending?.expected ?? draft.expected ?? '' },
      { key: 'actual', id: 'journey-actual', label: 'Actual result', value: summaryPending?.actual ?? draft.actual ?? '' },
    ];
    for (const field of fields) {
      const wrapper = node('div', undefined, 'journey-field');
      const label = node('label', field.label, 'journey-field-label');
      label.setAttribute('for', field.id);
      const area = document.createElement('textarea');
      area.id = field.id;
      area.className = 'journey-textarea';
      area.maxLength = 4_000;
      area.rows = 3;
      area.value = field.value;
      area.disabled = busy;
      area.setAttribute('aria-describedby', `${field.id}-count`);
      area.setAttribute('data-focus-id', field.id);
      const count = node('p', `${codePoints(field.value)} / 4000 characters`, 'journey-count');
      count.id = `${field.id}-count`;
      area.addEventListener('input', () => {
        count.textContent = `${codePoints(area.value)} / 4000 characters`;
        summaryPending = { expected: areas.expected.value, actual: areas.actual.value };
        scheduleSummarySave();
      });
      area.addEventListener('blur', () => {
        // Re-renders detach the focused field, which fires blur synchronously
        // mid-render; only a user leaving a settled field should flush an edit.
        if (rendering || !area.isConnected) return;
        const wanted = { expected: areas.expected.value, actual: areas.actual.value };
        if (wanted.expected !== (draft.expected ?? '') || wanted.actual !== (draft.actual ?? '') || summaryPending) {
          summaryPending = wanted;
          void flushSummary();
        }
      });
      areas[field.key] = area;
      wrapper.append(label, area, count);
      section.append(wrapper);
    }
    return section;
  }

  function renderRemove(step: { id: string; seq: number }): HTMLElement {
    const wrap = node('div', undefined, 'journey-step-actions');
    if (confirmingRemove === step.id) {
      const confirm = node('button', `Confirm remove step ${step.seq}`, 'journey-danger');
      confirm.type = 'button';
      confirm.disabled = busy || removing;
      confirm.setAttribute('data-focus-id', `remove-${step.id}`);
      confirm.addEventListener('click', () => {
        if (busy || removing) return;
        confirmingRemove = null;
        removing = true;
        error = '';
        render();
        void client.removeStep(step.id).then(() => { error = ''; }).catch(caught => {
          error = caught instanceof Error ? caught.message : 'Could not remove this step. Try again.';
        }).finally(() => {
          removing = false;
          if (alive) void refresh();
        });
      });
      confirm.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); confirmingRemove = null; render(); }
      });
      const keep = node('button', `Keep step ${step.seq}`, 'journey-secondary');
      keep.type = 'button';
      keep.disabled = busy || removing;
      keep.addEventListener('click', () => { confirmingRemove = null; render(); });
      wrap.append(confirm, keep);
    } else {
      const remove = node('button', `Remove step ${step.seq}`, 'journey-secondary');
      remove.type = 'button';
      remove.disabled = busy || removing;
      remove.setAttribute('data-focus-id', `remove-${step.id}`);
      remove.addEventListener('click', () => { confirmingRemove = step.id; render(); });
      wrap.append(remove);
    }
    return wrap;
  }

  function renderSave(draft: JourneyDraftV1): HTMLElement {
    const section = node('section', undefined, 'journey-save');
    section.setAttribute('aria-label', 'Save journey');
    section.append(node('h2', 'Save journey'));
    const ackLabel = node('label', undefined, 'journey-option');
    const ack = node('input');
    ack.type = 'checkbox';
    ack.checked = acknowledged;
    ack.disabled = busy;
    ack.addEventListener('change', () => { acknowledged = ack.checked; render(); });
    ackLabel.append(ack, node('span', 'I understand this journey retains full URLs and any entered values.'));
    section.append(ackLabel);
    const expected = (summaryPending?.expected ?? draft.expected ?? '').trim();
    const actual = (summaryPending?.actual ?? draft.actual ?? '').trim();
    const reasons: string[] = [];
    if (!expected || !actual) reasons.push('Enter both an expected and an actual summary.');
    if (!draft.steps.some(step => step.image.status === 'retained')) reasons.push('Keep at least one step with its screenshot.');
    if (draft.steps.some(step => step.image.status === 'pending')) reasons.push('Wait for pending screenshots to finish.');
    if (!acknowledged) reasons.push('Acknowledge that full URLs and entered values are retained.');
    let describedBy = 'journey-save-note';
    if (reasons.length > 0) {
      section.append(node('p', 'Before saving, complete the following:', 'journey-help'));
      const list = node('ul', undefined, 'journey-reasons');
      list.id = 'journey-save-reasons';
      list.setAttribute('role', 'status');
      for (const reason of reasons) list.append(node('li', reason));
      section.append(list);
      describedBy += ' journey-save-reasons';
    } else {
      section.append(node('p', 'This review is ready to save. Saving unlocks in the next update.', 'journey-help'));
    }
    const save = node('button', 'Save journey', 'journey-primary');
    save.type = 'button';
    save.disabled = true;
    save.setAttribute('aria-describedby', describedBy);
    section.append(save);
    const note = node('p', 'Saving is not available in this build. Review saving arrives next; your draft stays in this tab until then.', 'journey-help');
    note.id = 'journey-save-note';
    section.append(note);
    return section;
  }

  function render() {
    if (!alive) return;
    const scope = view.getRootNode();
    const activeElement = scope instanceof ShadowRoot ? scope.activeElement : document.activeElement;
    const inView = activeElement instanceof HTMLElement && view.contains(activeElement);
    const focusId = inView ? activeElement.getAttribute('data-focus-id') : null;
    const selection = activeElement instanceof HTMLTextAreaElement && inView
      ? [activeElement.selectionStart, activeElement.selectionEnd] as const
      : null;
    const oldFocus = view.contains(activeElement) ? activeElement?.textContent : null;
    rendering = true;
    try { view.replaceChildren(); } finally { rendering = false; }
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
    } else if (state.phase === 'reviewing') {
      view.append(node('h1', 'Review journey'));
      view.append(node('p', `${state.draft.steps.length} retained steps · Entered values: ${state.draft.includeEnteredValues ? 'On' : 'Off'}`, 'journey-help'));
      if (state.draft.stopReason === 'session-storage-limit') {
        const notice = node('p', 'Journey storage failed while recording. Review this draft now because the latest action or the draft may be lost if the extension closes.', 'journey-error');
        notice.setAttribute('role', 'alert');
        view.append(notice);
      }
      view.append(renderSummaries(state.draft));
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
            item.append(node('p', 'Keep, mask, or remove this screenshot during full image review.', 'journey-help'));
          }
        } else {
          const reason = step.image.status === 'unavailable' ? failures[step.image.reason]
            : step.image.status === 'removed' ? 'removed during review' : 'capture pending';
          item.append(node('p', `Screenshot unavailable: ${reason}.`, 'journey-help'));
        }
        item.append(renderRemove(step));
        list.append(item);
      }
      view.append(list, renderSave(state.draft), action('Discard journey', () => client.discard()));
    } else {
      view.append(node('h1', 'Saving journey'));
      const saving = node('p', 'Saving your reviewed journey…', 'journey-help');
      saving.setAttribute('role', 'status');
      view.append(saving);
    }
    if (loadFailed) view.append(action('Reset journey storage', () => client.discard()));
    if (error) {
      const alert = node('p', error, 'journey-error'); alert.setAttribute('role', 'alert'); view.append(alert);
    }
    if (focusId) {
      const restore = view.querySelector(`[data-focus-id="${CSS.escape(focusId)}"]`);
      if (restore instanceof HTMLElement) {
        restore.focus();
        if (restore instanceof HTMLTextAreaElement && selection) {
          try { restore.setSelectionRange(selection[0], selection[1]); } catch { /* Keep focus without caret restore. */ }
        }
      }
    } else if (oldFocus) Array.from(view.querySelectorAll('button')).find(button => button.textContent === oldFocus && !button.disabled)?.focus();
  }

  const unsubscribe = client.subscribe(() => { void refresh(); });
  void refresh();
  return () => { alive = false; ++version; if (summaryTimer !== undefined) clearTimeout(summaryTimer); unsubscribe(); view.remove(); };
}
