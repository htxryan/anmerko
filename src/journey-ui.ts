import type { JourneyDraftImage, JourneyDraftStep, JourneyDraftV1, JourneySession, JourneyUrlRedactionTarget } from './journey-core';
import type { NormalizedJourneyPng } from './journey-image';
import { JOURNEY_LIMITS, type CaptureFailure, type StopReason } from './journey-limits';
import { downloadFile, feedbackArchive } from './export';
import { journeyDraftToManifest, journeyPromptSection } from './journey-export';
import { reviewJourneyImage } from './journey-image-review';
import { privateImage } from './screenshot';

// maskedFrom is the screenshot the mask was drawn on, so a replacement never
// overwrites pixels that changed while the editor was open.
export type JourneyImageChange =
  | { operation: 'replace'; image: NormalizedJourneyPng; maskedFrom: string }
  | { operation: 'remove' };

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
  redactUrl(stepId: string, url: JourneyUrlRedactionTarget): Promise<void>;
  reviewImage(imageId: string, change: JourneyImageChange): Promise<void>;
  save(acknowledged: boolean): Promise<{ journeyId: string; revision: number }>;
  openSnapshot(journeyId: string): Promise<{ draft: JourneyDraftV1; images: Record<string, JourneyDraftImage> }>;
  reopen(journeyId: string): Promise<void>;
  deleteSnapshot(journeyId: string, revision?: number): Promise<void>;
  list(): Promise<Array<{ journeyId: string; revision: number; updatedAt: string; stepCount: number; spansPages: boolean }>>;
  subscribe(changed: () => void): () => void;
  supportsEnteredValues?: boolean;
}

const JOURNEY_STORAGE_ERROR = 'Journey storage failed. Reset journey storage to continue. A previous draft or the latest action may be lost.';
const EXPORT_SIZE_ERROR = 'Journey export exceeds the export size limit.';

// Preamble for journey-only archives. Static notes keep their own product
// preamble in core.ts; journeys export without static notes here.
export const JOURNEY_EXPORT_PREAMBLE = 'Recorded journey brief.';

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

const KEPT = 'Steps recorded before then are kept.';
// Review explains every stop in plain language. A journey is bound to its
// starting origin, so copy spells out what counts as leaving it.
const stopNotices: Record<StopReason, string> = {
  user: 'You stopped the recording.',
  'duration-limit': `Recording stopped at the ${JOURNEY_LIMITS.maxDurationMs / 60_000}-minute limit. ${KEPT}`,
  'step-limit': `Recording stopped at the ${JOURNEY_LIMITS.maxSteps}-step limit. ${KEPT}`,
  'image-budget': `Recording stopped because the journey's screenshots reached their storage limit. ${KEPT}`,
  'session-storage-limit': 'Journey storage failed while recording. Review this draft now because the latest action or the draft may be lost if the extension closes.',
  'left-site': `Recording ended because the page left the website you started on. A different domain, subdomain, or port, or a switch between http and https, counts as leaving. ${KEPT} To record the other website, save or discard this review first, then open anmerko from the toolbar there.`,
  'focus-lost': `Recording ended because the recorded tab lost focus: another tab, window, or app became active. ${KEPT}`,
  'tab-lost': `Recording ended because the recorded tab was closed, replaced, or moved to another window. ${KEPT}`,
  'protected-page': `Recording ended because the tab opened a page anmerko cannot record, such as a browser page or a non-web address. ${KEPT}`,
  'capture-failed': `Recording ended because anmerko lost track of the page after it changed and could not keep recording reliably. ${KEPT}`,
  'page-access-lost': `Recording ended because the browser withdrew anmerko's access when the page reloaded or opened another page. Firefox does this on every page load, even on the same website. ${KEPT} The new page has no screenshot. To record more, save or discard this review first, then open anmerko from the toolbar on the current page and start a new journey.`,
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
  // The mask dialog lives beside the view so review re-renders never remove it.
  const imageDialog = node('div', undefined, 'journey-image-dialog');
  root.append(view, imageDialog);
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
  let confirmingDelete: string | null = null;
  let deletingJourney: string | null = null;
  let confirmingDeleteAll = false;
  let deletingAll = false;
  let deleteStatus = '';
  let acknowledged = false;
  let acknowledgedFor = '';
  let rendering = false;
  let savedJourneys: Array<{ journeyId: string; revision: number; updatedAt: string; stepCount: number; spansPages: boolean }> | null = null;
  let editingStepId: string | null = null;
  let editingText = '';
  let editingChecked = false;
  let valueBusy: string | null = null;
  let redactBusy: string | null = null;
  let saveBusy = false;
  let copyBusy = false;
  let downloadBusy = false;
  let exportStatus = '';
  let exportStatusFor: string | null = null;
  let lastSaved: { journeyId: string; revision: number } | null = null;
  let imageEditor: { journeyId: string; imageId: string; abort: AbortController } | null = null;
  let imageBusy: string | null = null;
  let confirmingImageRemove: string | null = null;
  let pendingFocus: string[] | null = null;
  let imageStatus: { stepId: string; text: string } | null = null;

  async function refresh() {
    const current = ++version;
    try {
      const next = await client.read();
      if (!alive || current !== version) return;
      if ((next.phase === 'idle' || next.phase === 'saved')
        && state.phase !== 'idle' && state.phase !== 'saved') includeEnteredValues = false;
      state = next;
      if (next.phase === 'reviewing') {
        if (acknowledgedFor !== '' && acknowledgedFor !== next.draft.id) acknowledged = false;
        acknowledgedFor = next.draft.id;
        const draftKey = `${next.draft.id}@${next.draft.revision}`;
        if (exportStatusFor !== draftKey) { exportStatus = ''; exportStatusFor = null; }
        if (confirmingRemove !== null && !next.draft.steps.some(step => step.id === confirmingRemove)) confirmingRemove = null;
        if (confirmingImageRemove !== null && !next.draft.steps.some(step => step.id === confirmingImageRemove
          && step.image.status === 'retained')) confirmingImageRemove = null;
        if (editingStepId !== null && !next.draft.steps.some(step => step.id === editingStepId)) {
          editingStepId = null;
        }
      } else {
        acknowledged = false;
        acknowledgedFor = '';
        summaryPending = null;
        confirmingRemove = null;
        confirmingImageRemove = null;
        imageBusy = null;
        imageStatus = null;
        pendingFocus = null;
        editingStepId = null;
        valueBusy = null;
        redactBusy = null;
        saveBusy = false;
        copyBusy = false;
        downloadBusy = false;
        exportStatus = '';
        exportStatusFor = null;
      }
      const editor = imageEditor;
      if (editor && (next.phase !== 'reviewing' || next.draft.id !== editor.journeyId
        || !next.draft.steps.some(step => step.image.status === 'retained' && step.image.imageId === editor.imageId))) {
        editor.abort.abort();
      }
      if (next.phase !== 'idle') {
        confirmingDelete = null;
        deletingJourney = null;
        confirmingDeleteAll = false;
        deletingAll = false;
        deleteStatus = '';
      } else if (confirmingDelete !== null && savedJourneys?.some(item => item.journeyId === confirmingDelete) !== true) {
        confirmingDelete = null;
      }
      if (next.phase === 'idle') {
        try {
          const list = typeof (client as Partial<JourneyClient>).list === 'function'
            ? await client.list()
            : null;
          if (!alive || current !== version) return;
          savedJourneys = list;
        } catch {
          if (!alive || current !== version) return;
          savedJourneys = null;
        }
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

  function isStaleReview(caught: unknown): boolean {
    return caught instanceof Error && (caught as { code?: unknown }).code === 'stale-review';
  }

  async function refreshSavedList(): Promise<void> {
    try {
      const list = typeof (client as Partial<JourneyClient>).list === 'function'
        ? await client.list()
        : null;
      if (!alive) return;
      savedJourneys = list;
      if (confirmingDelete !== null && !savedJourneys?.some(item => item.journeyId === confirmingDelete)) {
        confirmingDelete = null;
      }
    } catch {
      if (!alive) return;
      savedJourneys = null;
      confirmingDelete = null;
      confirmingDeleteAll = false;
    }
    if (alive) render();
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
      remove.addEventListener('click', () => { confirmingRemove = step.id; confirmingImageRemove = null; render(); });
      wrap.append(remove);
    }
    return wrap;
  }

  function focusControl(...focusIds: string[]): void {
    for (const focusId of focusIds) {
      const target = view.querySelector(`[data-focus-id="${CSS.escape(focusId)}"]`);
      if (target instanceof HTMLElement) { target.focus(); return; }
    }
  }

  function stepList(seqs: number[]): string {
    return seqs.length <= 2 ? seqs.join(' and ') : `${seqs.slice(0, -1).join(', ')}, and ${seqs.at(-1)}`;
  }

  async function changeImage(
    step: { id: string },
    imageId: string,
    change: JourneyImageChange,
    returnTo: string,
    subject: string,
  ): Promise<void> {
    imageBusy = step.id;
    imageStatus = null;
    error = '';
    render();
    // A removed screenshot takes its controls with it; keep the reader on its step.
    pendingFocus = [returnTo, `step-${step.id}`];
    try {
      await client.reviewImage(imageId, change);
      error = '';
      imageStatus = { stepId: step.id, text: `Screenshot for ${subject} ${change.operation === 'remove' ? 'removed' : 'masked'}.` };
      if (change.operation === 'remove') pendingFocus = [`step-${step.id}`];
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'Could not update the screenshot. Try again.';
    } finally {
      imageBusy = null;
      if (alive) void refresh();
    }
  }

  async function openImageEditor(
    step: { id: string },
    imageId: string,
    image: JourneyDraftImage,
    note: string | undefined,
    subject: string,
  ): Promise<void> {
    if (busy || saveBusy || imageBusy !== null || imageEditor || state.phase !== 'reviewing' || !image.dataUrl) return;
    const maskedFrom = image.dataUrl;
    const abort = new AbortController();
    imageEditor = { journeyId: state.draft.id, imageId, abort };
    confirmingImageRemove = null;
    imageStatus = null;
    error = '';
    render();
    const returnTo = `mask-image-${step.id}`;
    const result = await reviewJourneyImage(imageDialog, {
      dataUrl: maskedFrom, width: image.width, height: image.height, ...(note ? { note } : {}),
    }, abort.signal);
    if (imageEditor?.abort === abort) imageEditor = null;
    if (!alive) return;
    if (result.kind === 'cancelled') {
      focusControl(returnTo, `step-${step.id}`);
      return;
    }
    await changeImage(step, imageId, result.kind === 'applied'
      ? { operation: 'replace', image: result.image, maskedFrom }
      : { operation: 'remove' }, returnTo, subject);
  }

  function renderImageReview(
    step: { id: string; seq: number },
    imageId: string,
    image: JourneyDraftImage,
    sharedSteps: number[],
  ): HTMLElement {
    const wrap = node('div', undefined, 'journey-image-actions');
    const maskDescription: string[] = [];
    if (image.redacted === true) {
      const masked = node('p', 'Masked during review.', 'journey-edited');
      masked.id = `journey-image-masked-${step.id}`;
      maskDescription.push(masked.id);
      wrap.append(masked);
    }
    const help = node('p', 'Mask part of this screenshot or remove it before saving. Masks cannot be undone.', 'journey-help');
    help.id = `journey-image-help-${step.id}`;
    maskDescription.push(help.id);
    wrap.append(help);
    const shared = sharedSteps.length > 1
      ? `Steps ${stepList(sharedSteps)} share this screenshot. Masking or removing it changes all of them.`
      : undefined;
    const sharedId = `journey-image-shared-${step.id}`;
    if (shared) {
      const note = node('p', shared, 'journey-help');
      note.id = sharedId;
      maskDescription.push(sharedId);
      wrap.append(note);
    }
    const subject = sharedSteps.length > 1 ? `steps ${stepList(sharedSteps)}` : `step ${step.seq}`;
    if (typeof (client as Partial<JourneyClient>).reviewImage !== 'function') return wrap;
    const actions = node('div', undefined, 'journey-step-actions');
    const disabled = busy || saveBusy || imageBusy !== null;
    if (confirmingImageRemove === step.id) {
      const confirm = node('button', `Confirm remove screenshot for step ${step.seq}`, 'journey-danger');
      confirm.type = 'button';
      confirm.disabled = disabled;
      confirm.setAttribute('data-focus-id', `confirm-remove-image-${step.id}`);
      if (shared) confirm.setAttribute('aria-describedby', sharedId);
      const disarm = () => {
        confirmingImageRemove = null;
        render();
        focusControl(`remove-image-${step.id}`);
      };
      confirm.addEventListener('click', () => {
        if (busy || saveBusy || imageBusy !== null) return;
        confirmingImageRemove = null;
        void changeImage(step, imageId, { operation: 'remove' }, `remove-image-${step.id}`, subject);
      });
      confirm.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); disarm(); }
      });
      const keep = node('button', `Keep screenshot for step ${step.seq}`, 'journey-secondary');
      keep.type = 'button';
      keep.disabled = disabled;
      keep.addEventListener('click', disarm);
      actions.append(confirm, keep);
    } else {
      if (image.dataUrl) {
        const mask = node('button', `Mask screenshot for step ${step.seq}`, 'journey-secondary');
        mask.type = 'button';
        mask.disabled = disabled;
        mask.setAttribute('data-focus-id', `mask-image-${step.id}`);
        mask.setAttribute('aria-describedby', maskDescription.join(' '));
        mask.addEventListener('click', () => { void openImageEditor(step, imageId, image, shared, subject); });
        actions.append(mask);
      }
      const remove = node('button', `Remove screenshot for step ${step.seq}`, 'journey-secondary');
      remove.type = 'button';
      remove.disabled = disabled;
      remove.setAttribute('data-focus-id', `remove-image-${step.id}`);
      if (shared) remove.setAttribute('aria-describedby', sharedId);
      remove.addEventListener('click', () => {
        confirmingImageRemove = step.id;
        confirmingRemove = null;
        render();
        focusControl(`confirm-remove-image-${step.id}`);
      });
      actions.append(remove);
    }
    wrap.append(actions);
    return wrap;
  }

  function valueDisplay(value: { kind: string; value?: string; values?: string[]; checked?: boolean }): string {
    if (value.kind === 'text') return value.value === '' ? '(empty value)' : String(value.value ?? '');
    if (value.kind === 'selection') {
      const values = Array.isArray(value.values) ? value.values : [];
      return values.length === 0 ? '(empty value)' : values.join(', ');
    }
    if (value.kind === 'checked') return value.checked === true ? 'Checked' : 'Not checked';
    return '';
  }

  function emptyValueFor(enteredValue: { kind: string; multiple?: boolean }): { kind: string; value?: string; values?: string[]; multiple?: boolean; checked?: boolean; truncated?: boolean } {
    if (enteredValue.kind === 'text') return { kind: 'text', value: '', truncated: false };
    if (enteredValue.kind === 'selection') return { kind: 'selection', values: [], multiple: enteredValue.multiple === true, truncated: false };
    return { kind: 'checked', checked: false };
  }

  function editedValueFor(
    enteredValue: { kind: string; multiple?: boolean },
    text: string,
    checked: boolean,
  ): { kind: string; value?: string; values?: string[]; multiple?: boolean; checked?: boolean; truncated?: boolean } {
    if (enteredValue.kind === 'text') return { kind: 'text', value: text, truncated: false };
    if (enteredValue.kind === 'selection') {
      if (enteredValue.multiple === true) {
        const values = text === '' ? [] : text.split('\n');
        return { kind: 'selection', values, multiple: true, truncated: false };
      }
      return { kind: 'selection', values: text === '' ? [] : [text], multiple: false, truncated: false };
    }
    return { kind: 'checked', checked };
  }

  function renderValueEditor(step: { id: string; seq: number; enteredValue: { kind: string; value?: string; values?: string[]; multiple?: boolean; checked?: boolean } }): HTMLElement {
    const wrap = node('div', undefined, 'journey-value-editor');
    const labelText = `Edit entered value for step ${step.seq}`;
    const cancelEditing = () => { editingStepId = null; render(); };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); cancelEditing(); }
    };
    if (step.enteredValue.kind === 'checked') {
      const label = node('label', undefined, 'journey-option');
      const input = node('input');
      input.type = 'checkbox';
      input.checked = editingChecked;
      input.disabled = busy || valueBusy !== null;
      input.setAttribute('aria-label', labelText);
      input.setAttribute('data-focus-id', `value-${step.id}`);
      input.addEventListener('change', () => { editingChecked = input.checked; });
      input.addEventListener('keydown', onEscape);
      label.append(input, node('span', labelText));
      wrap.append(label);
    } else if (step.enteredValue.kind === 'selection' && step.enteredValue.multiple === true) {
      const label = node('label', labelText, 'journey-field-label');
      label.setAttribute('for', `journey-value-${step.id}`);
      const area = document.createElement('textarea');
      area.id = `journey-value-${step.id}`;
      area.className = 'journey-textarea';
      area.rows = 3;
      area.value = editingText;
      area.disabled = busy || valueBusy !== null;
      area.setAttribute('data-focus-id', `value-${step.id}`);
      area.addEventListener('input', () => { editingText = area.value; });
      area.addEventListener('keydown', onEscape);
      const help = node('p', 'One value per line.', 'journey-help');
      wrap.append(label, area, help);
    } else {
      const label = node('label', labelText, 'journey-field-label');
      label.setAttribute('for', `journey-value-${step.id}`);
      const input = document.createElement('input');
      input.id = `journey-value-${step.id}`;
      input.type = 'text';
      input.className = 'journey-input';
      input.value = editingText;
      input.disabled = busy || valueBusy !== null;
      input.setAttribute('data-focus-id', `value-${step.id}`);
      input.addEventListener('input', () => { editingText = input.value; });
      input.addEventListener('keydown', onEscape);
      // Text kinds with long values benefit from a textarea; keep single-line
      // input for selects and short text to stay keyboard-simple at 320px.
      if (step.enteredValue.kind === 'text' && editingText.length > 80) {
        const area = document.createElement('textarea');
        area.id = input.id;
        area.className = 'journey-textarea';
        area.rows = 3;
        area.value = editingText;
        area.disabled = input.disabled;
        area.setAttribute('aria-label', labelText);
        area.setAttribute('data-focus-id', `value-${step.id}`);
        area.addEventListener('input', () => { editingText = area.value; });
        area.addEventListener('keydown', onEscape);
        wrap.append(label, area);
      } else {
        wrap.append(label, input);
      }
    }
    const actions = node('div', undefined, 'journey-step-actions');
    const save = node('button', `Save value for step ${step.seq}`, 'journey-primary');
    save.type = 'button';
    save.disabled = busy || valueBusy !== null;
    save.setAttribute('data-focus-id', `save-value-${step.id}`);
    save.addEventListener('click', () => {
      if (busy || valueBusy !== null) return;
      valueBusy = step.id;
      error = '';
      render();
      const wanted = editedValueFor(step.enteredValue, editingText, editingChecked);
      void client.editValue(step.id, wanted).then(() => { error = ''; }).catch(caught => {
        error = caught instanceof Error ? caught.message : 'Could not update the journey. Try again.';
      }).finally(() => {
        valueBusy = null;
        if (error === '') editingStepId = null;
        if (alive) void refresh();
        else render();
      });
    });
    const cancel = node('button', `Cancel editing step ${step.seq}`, 'journey-secondary');
    cancel.type = 'button';
    cancel.disabled = busy || valueBusy !== null;
    cancel.addEventListener('click', () => { editingStepId = null; render(); });
    cancel.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); editingStepId = null; render(); }
    });
    actions.append(save, cancel);
    wrap.append(actions);
    return wrap;
  }

  function renderEnteredValue(step: { id: string; seq: number; kind: string; enteredValue?: { kind: string; value?: string; values?: string[]; multiple?: boolean; checked?: boolean; truncated?: boolean; edited?: true } }): HTMLElement | null {
    if (step.kind !== 'field-change' || !step.enteredValue) return null;
    const entered = step.enteredValue;
    const section = node('div', undefined, 'journey-entered-value');
    section.append(node('p', 'Entered value', 'journey-meta-label'));
    section.append(node('p', valueDisplay(entered as { kind: string; value?: string; values?: string[]; checked?: boolean }), 'journey-value'));
    if ((entered as { edited?: unknown }).edited === true) {
      section.append(node('p', 'Edited during review.', 'journey-edited'));
    }
    if ((entered as { truncated?: unknown }).truncated === true) {
      section.append(node('p', 'Value was truncated during capture.', 'journey-help'));
    }
    if (editingStepId === step.id) {
      section.append(renderValueEditor(step as { id: string; seq: number; enteredValue: { kind: string; value?: string; values?: string[]; multiple?: boolean; checked?: boolean } }));
    } else {
      const actions = node('div', undefined, 'journey-step-actions');
      const edit = node('button', `Edit value for step ${step.seq}`, 'journey-secondary');
      edit.type = 'button';
      edit.disabled = busy || valueBusy !== null;
      edit.setAttribute('data-focus-id', `edit-value-${step.id}`);
      edit.addEventListener('click', () => {
        const current = entered;
        if (current.kind === 'text') editingText = String(current.value ?? '');
        else if (current.kind === 'selection') {
          const values = Array.isArray(current.values) ? current.values : [];
          editingText = current.multiple === true ? values.join('\n') : String(values[0] ?? '');
        } else editingChecked = current.checked === true;
        editingStepId = step.id;
        render();
      });
      const remove = node('button', `Remove value for step ${step.seq}`, 'journey-secondary');
      remove.type = 'button';
      remove.disabled = busy || valueBusy !== null;
      remove.setAttribute('data-focus-id', `remove-value-${step.id}`);
      remove.addEventListener('click', () => {
        if (busy || valueBusy !== null) return;
        valueBusy = step.id;
        error = '';
        render();
        void client.editValue(step.id, emptyValueFor(entered as { kind: string; multiple?: boolean })).then(() => { error = ''; }).catch(caught => {
          error = caught instanceof Error ? caught.message : 'Could not update the journey. Try again.';
        }).finally(() => {
          valueBusy = null;
          if (alive) void refresh();
        });
      });
      actions.append(edit, remove);
      section.append(actions);
    }
    return section;
  }

  function renderUrlRedact(step: JourneyDraftStep, draft: JourneyDraftV1): HTMLElement {
    const wrap = node('div', undefined, 'journey-url-actions');
    const redactControl = (url: string, target: JourneyUrlRedactionTarget, label: string) => {
      if (url === '[redacted]') {
        wrap.append(node('p', 'Redacted during review.', 'journey-edited'));
        return;
      }
      const redact = node('button', `Redact ${label} URL for step ${step.seq}`, 'journey-secondary');
      redact.type = 'button';
      redact.disabled = busy || redactBusy !== null;
      redact.setAttribute('data-focus-id', `redact-${target}-${step.id}`);
      redact.addEventListener('click', () => {
        if (busy || redactBusy !== null) return;
        redactBusy = `${step.id}:${target}`;
        error = '';
        render();
        void client.redactUrl(step.id, target).then(() => { error = ''; }).catch(caught => {
          error = caught instanceof Error ? caught.message : 'Could not update the journey. Try again.';
        }).finally(() => {
          redactBusy = null;
          if (alive) void refresh();
        });
      });
      wrap.append(redact);
    };
    redactControl(step.sourceUrl, 'source', 'source');
    if (step.kind === 'navigation') redactControl(step.navigation.toUrl, 'destination', 'destination');
    if (step.image.status === 'retained') {
      const image = draft.images[step.image.imageId];
      if (image) redactControl(image.captureUrl, 'capture', 'image');
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
    // A pending mask or removal must land before the draft can be saved.
    ack.disabled = busy || saveBusy || imageBusy !== null;
    ack.setAttribute('data-focus-id', 'journey-ack');
    ack.setAttribute('aria-label', 'I understand this journey retains full URLs, any entered values, and its kept screenshots.');
    ack.addEventListener('change', () => { acknowledged = ack.checked; render(); });
    ackLabel.append(ack, node('span', 'I understand this journey retains full URLs, any entered values, and its kept screenshots.'));
    section.append(ackLabel);
    const expected = (summaryPending?.expected ?? draft.expected ?? '').trim();
    const actual = (summaryPending?.actual ?? draft.actual ?? '').trim();
    const reasons: string[] = [];
    if (!expected || !actual) reasons.push('Enter both an expected and an actual summary.');
    if (!draft.steps.some(step => step.image.status === 'retained')) reasons.push('Keep at least one step with its screenshot.');
    if (draft.steps.some(step => step.image.status === 'pending')) reasons.push('Wait for pending screenshots to finish.');
    if (!acknowledged) reasons.push('Acknowledge that full URLs, entered values, and kept screenshots are retained.');
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
      section.append(node('p', 'This review is ready to save.', 'journey-help'));
    }
    const save = node('button', 'Save journey', 'journey-primary');
    save.type = 'button';
    save.disabled = reasons.length > 0 || busy || saveBusy || imageBusy !== null;
    save.setAttribute('aria-describedby', describedBy);
    save.setAttribute('data-focus-id', 'journey-save');
    save.addEventListener('click', () => {
      if (save.disabled) return;
      saveBusy = true;
      error = '';
      render();
      void client.save(acknowledged).then(result => {
        lastSaved = { journeyId: result.journeyId, revision: result.revision };
        error = '';
      }).catch(caught => {
        error = caught instanceof Error ? caught.message : 'Could not save this journey. Try again.';
      }).finally(() => {
        saveBusy = false;
        if (alive) void refresh();
      });
    });
    section.append(save);
    const note = node('p', 'Saving stores a reviewed snapshot locally. Raw drafts are never exported.', 'journey-help');
    note.id = 'journey-save-note';
    section.append(note);
    return section;
  }

  function renderExport(draft: JourneyDraftV1): HTMLElement | null {
    if (typeof (client as Partial<JourneyClient>).openSnapshot !== 'function') return null;
    const section = node('section', undefined, 'journey-export');
    section.setAttribute('aria-label', 'Share journey');
    section.append(node('h2', 'Share journey'));
    const saved = lastSaved !== null
      && lastSaved.journeyId === draft.id
      && lastSaved.revision === draft.revision;
    if (!saved) {
      const note = node('p', 'Save first to copy or download this journey.', 'journey-help');
      note.id = 'journey-export-note';
      section.append(note);
    }
    const actions = node('div', undefined, 'journey-export-actions');
    const copy = node('button', 'Copy Prompt', 'journey-secondary');
    copy.type = 'button';
    copy.disabled = !saved || copyBusy || downloadBusy;
    copy.setAttribute('data-focus-id', 'journey-copy');
    if (!saved) copy.setAttribute('aria-describedby', 'journey-export-note');
    copy.addEventListener('click', () => { void copyJourney(draft); });
    const download = node('button', 'Download Markdown + Images', 'journey-secondary');
    download.type = 'button';
    download.disabled = !saved || copyBusy || downloadBusy;
    download.setAttribute('data-focus-id', 'journey-download');
    if (!saved) download.setAttribute('aria-describedby', 'journey-export-note');
    download.addEventListener('click', () => { void downloadJourney(draft); });
    actions.append(copy, download);
    section.append(actions);
    if (exportStatus) {
      const status = node('p', exportStatus, 'journey-status');
      status.setAttribute('role', 'status');
      section.append(status);
    }
    return section;
  }

  async function copyJourney(draft: JourneyDraftV1): Promise<void> {
    if (copyBusy || downloadBusy) return;
    copyBusy = true;
    exportStatus = '';
    exportStatusFor = null;
    error = '';
    render();
    try {
      const snapshot = await client.openSnapshot(draft.id);
      lastSaved = { journeyId: snapshot.draft.id, revision: snapshot.draft.revision };
      const text = journeyPromptSection([journeyDraftToManifest(snapshot.draft)]);
      await navigator.clipboard.writeText(text);
      exportStatus = 'Journey prompt copied. Download the images to attach them with the prompt.';
      exportStatusFor = `${draft.id}@${draft.revision}`;
      error = '';
    } catch {
      error = 'Could not copy the journey prompt. Use Download Markdown + Images to export this journey.';
    } finally {
      copyBusy = false;
    }
    if (alive) render();
  }

  async function downloadJourney(draft: JourneyDraftV1): Promise<void> {
    if (copyBusy || downloadBusy) return;
    downloadBusy = true;
    exportStatus = '';
    exportStatusFor = null;
    error = '';
    render();
    try {
      const snapshot = await client.openSnapshot(draft.id);
      lastSaved = { journeyId: snapshot.draft.id, revision: snapshot.draft.revision };
      const archive = feedbackArchive([], JOURNEY_EXPORT_PREAMBLE, [snapshot.draft]);
      downloadFile(new Blob([archive], { type: 'application/zip' }), `journey-${snapshot.draft.id}.zip`);
      exportStatus = 'Journey download started. Extract the ZIP and attach its images with the prompt.';
      exportStatusFor = `${draft.id}@${draft.revision}`;
      error = '';
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : '';
      error = message === EXPORT_SIZE_ERROR
        ? EXPORT_SIZE_ERROR
        : 'Could not download the journey. Try again.';
    } finally {
      downloadBusy = false;
    }
    if (alive) render();
  }

  function renderDelete(
    item: { journeyId: string; revision: number },
  ): HTMLElement {
    const wrap = node('div', undefined, 'journey-step-actions');
    const idle = deletingJourney === null && !deletingAll && !busy;
    if (confirmingDelete === item.journeyId) {
      const confirm = node('button', `Confirm delete journey ${item.journeyId}`, 'journey-danger');
      confirm.type = 'button';
      confirm.disabled = !idle;
      confirm.setAttribute('data-focus-id', `confirm-delete-${item.journeyId}`);
      const disarm = (focusTrigger: boolean) => {
        confirmingDelete = null;
        render();
        if (focusTrigger) {
          const trigger = view.querySelector(`[data-focus-id="${CSS.escape(`delete-${item.journeyId}`)}"]`);
          if (trigger instanceof HTMLElement) trigger.focus();
        }
      };
      confirm.addEventListener('click', () => {
        if (!idle) return;
        confirmingDelete = null;
        deletingJourney = item.journeyId;
        deleteStatus = '';
        error = '';
        render();
        void client.deleteSnapshot(item.journeyId, item.revision).then(() => {
          error = '';
        }).catch(caught => {
          error = isStaleReview(caught)
            ? 'A saved journey changed. The list was reloaded; try again.'
            : 'Could not delete this journey. Try again.';
        }).finally(() => {
          deletingJourney = null;
          if (alive) void refreshSavedList();
          else render();
        });
      });
      confirm.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); disarm(true); }
      });
      const keep = node('button', `Keep journey ${item.journeyId}`, 'journey-secondary');
      keep.type = 'button';
      keep.disabled = !idle;
      keep.addEventListener('click', () => { disarm(true); });
      wrap.append(confirm, keep);
    } else {
      const remove = node('button', `Delete journey ${item.journeyId}`, 'journey-secondary');
      remove.type = 'button';
      remove.disabled = !idle;
      remove.setAttribute('data-focus-id', `delete-${item.journeyId}`);
      remove.addEventListener('click', () => {
        confirmingDelete = item.journeyId;
        confirmingDeleteAll = false;
        render();
        const confirm = view.querySelector(`[data-focus-id="${CSS.escape(`confirm-delete-${item.journeyId}`)}"]`);
        if (confirm instanceof HTMLElement) confirm.focus();
      });
      wrap.append(remove);
    }
    return wrap;
  }

  function renderDeleteAll(count: number): HTMLElement {
    const wrap = node('div', undefined, 'journey-saved-delete-all');
    const idle = deletingJourney === null && !deletingAll && !busy;
    if (confirmingDeleteAll) {
      const scope = node(
        'p',
        `Delete ${count} saved ${count === 1 ? 'journey' : 'journeys'}? This cannot be undone.`,
        'journey-help',
      );
      scope.id = 'journey-delete-all-scope';
      wrap.append(scope);
      const actions = node('div', undefined, 'journey-step-actions');
      const confirm = node('button', 'Confirm delete all journeys', 'journey-danger');
      confirm.type = 'button';
      confirm.disabled = !idle;
      confirm.setAttribute('aria-describedby', 'journey-delete-all-scope');
      confirm.setAttribute('data-focus-id', 'confirm-delete-all');
      const disarm = (focusTrigger: boolean) => {
        confirmingDeleteAll = false;
        render();
        if (focusTrigger) {
          const trigger = view.querySelector('[data-focus-id="delete-all"]');
          if (trigger instanceof HTMLElement) trigger.focus();
        }
      };
      confirm.addEventListener('click', () => {
        if (!idle) return;
        confirmingDeleteAll = false;
        deletingAll = true;
        deleteStatus = '';
        error = '';
        render();
        const snapshot = (savedJourneys ?? []).map(item => ({ journeyId: item.journeyId, revision: item.revision }));
        const failures: string[] = [];
        let deleted = 0;
        void (async () => {
          for (const item of snapshot) {
            try {
              await client.deleteSnapshot(item.journeyId, item.revision);
              deleted += 1;
            } catch {
              failures.push(item.journeyId);
            }
          }
          deleteStatus = `Deleted ${deleted} of ${snapshot.length} journeys.`;
          error = failures.map(journeyId => `Could not delete journey ${journeyId}.`).join(' ');
        })().finally(() => {
          deletingAll = false;
          if (alive) void refreshSavedList();
          else render();
        });
      });
      confirm.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); disarm(true); }
      });
      const cancel = node('button', 'Cancel', 'journey-secondary');
      cancel.type = 'button';
      cancel.disabled = !idle;
      cancel.addEventListener('click', () => { disarm(true); });
      actions.append(confirm, cancel);
      wrap.append(actions);
    } else {
      const remove = node('button', 'Delete all journeys', 'journey-secondary');
      remove.type = 'button';
      remove.disabled = !idle;
      remove.setAttribute('data-focus-id', 'delete-all');
      remove.addEventListener('click', () => {
        confirmingDeleteAll = true;
        confirmingDelete = null;
        render();
        const confirm = view.querySelector('[data-focus-id="confirm-delete-all"]');
        if (confirm instanceof HTMLElement) confirm.focus();
      });
      wrap.append(remove);
    }
    return wrap;
  }

  function renderSavedList(): HTMLElement | null {
    if (savedJourneys === null) return null;
    const section = node('section', undefined, 'journey-saved-list');
    section.setAttribute('aria-label', 'Saved journeys');
    section.append(node('h2', 'Saved journeys'));
    if (savedJourneys.length === 0) {
      section.append(node('p', 'No saved journeys yet.', 'journey-help'));
    } else {
      const list = node('ul', undefined, 'journey-saved-items');
      for (const item of savedJourneys) {
        const row = node('li', undefined, 'journey-saved-item');
        const steps = `${item.stepCount} ${item.stepCount === 1 ? 'step' : 'steps'}`;
        row.append(node('span', `Journey ${item.journeyId} · revision ${item.revision} · ${steps} · updated ${item.updatedAt}`, 'journey-saved-label'));
        if (item.spansPages === true) {
          const spans = node('span', 'Spans pages', 'journey-saved-spans');
          row.append(' · ', spans);
        }
        if (typeof (client as Partial<JourneyClient>).reopen === 'function') {
          const reopen = action(`Reopen journey ${item.journeyId}`, () => client.reopen(item.journeyId));
          reopen.setAttribute('data-focus-id', `reopen-${item.journeyId}`);
          row.append(reopen);
        }
        if (typeof (client as Partial<JourneyClient>).deleteSnapshot === 'function') {
          row.append(renderDelete(item));
        }
        list.append(row);
      }
      section.append(list);
      if (typeof (client as Partial<JourneyClient>).deleteSnapshot === 'function') {
        section.append(renderDeleteAll(savedJourneys.length));
      }
    }
    if (deleteStatus) {
      const status = node('p', deleteStatus, 'journey-status');
      status.setAttribute('role', 'status');
      section.append(status);
    }
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
      : activeElement instanceof HTMLInputElement && activeElement.type === 'text' && inView
        ? [activeElement.selectionStart ?? 0, activeElement.selectionEnd ?? 0] as const
        : null;
    const oldFocus = view.contains(activeElement) ? activeElement?.textContent : null;
    rendering = true;
    try { view.replaceChildren(); } finally { rendering = false; }
    view.append(node('p', 'anmerko', 'journey-brand'));
    if (state.phase === 'idle') {
      view.append(node('h1', 'Record a journey'));
      view.append(node('p', 'Record clicks and screenshots on the website you start from. Stop whenever you are ready to review.', 'journey-help'));
      view.append(node('p', 'Screenshots and full URLs can contain personal information, even when entered values are off. Review and remove sensitive details before sharing.', 'journey-notice'));
      if (client.supportsEnteredValues) {
        const label = node('label', undefined, 'journey-option');
        const input = node('input');
        input.type = 'checkbox'; input.checked = includeEnteredValues; input.disabled = busy;
        input.setAttribute('data-focus-id', 'journey-include-values');
        input.setAttribute('aria-label', 'Include entered values');
        input.addEventListener('change', () => { includeEnteredValues = input.checked; });
        label.append(input, node('span', 'Include entered values'));
        view.append(label);
      } else view.append(node('p', 'Entered values: Off', 'journey-help'));
      view.append(node('p', 'Up to 5 minutes or 30 steps. Only the original website tab is recorded; a different domain, subdomain, or port, or a switch between http and https, ends recording.', 'journey-help'));
      const buttons = node('div', undefined, 'journey-actions');
      buttons.append(action('Start journey', () => client.start(includeEnteredValues), true));
      if (busy) buttons.append(action('Cancel start', () => client.stop(), false, true));
      view.append(buttons);
      const saved = renderSavedList();
      if (saved) view.append(saved);
    } else if (state.phase === 'saved') {
      view.append(node('h1', 'Journey saved'));
      view.append(node('p', `Journey ${state.journeyId} saved (revision ${state.revision}).`, 'journey-help'));
      view.append(action('Back to comments', () => client.discard(), true));
    } else if (state.phase === 'starting' || state.phase === 'recording') {
      const recording = state.phase === 'recording';
      view.append(node('h1', recording ? 'Recording journey' : 'Taking the first screenshot…'));
      const status = node('p', recording ? `${state.draft.steps.length} steps recorded. Continue in the original tab.` : 'Recording begins after the first screenshot succeeds.', 'journey-help');
      status.setAttribute('role', 'status');
      view.append(status, action(recording ? 'Stop journey' : 'Cancel start', () => client.stop(), true, true));
    } else if (state.phase === 'reviewing') {
      view.append(node('h1', 'Review journey'));
      view.append(node('p', `${state.draft.steps.length} retained steps · Entered values: ${state.draft.includeEnteredValues ? 'On' : 'Off'}`, 'journey-help'));
      const stopNotice = state.draft.stopReason ? stopNotices[state.draft.stopReason] : undefined;
      if (stopNotice) {
        // A storage failure can still lose the draft, so it interrupts.
        const storage = state.draft.stopReason === 'session-storage-limit';
        const notice = node('p', stopNotice, `${storage ? 'journey-error' : 'journey-help'} journey-stop-reason`);
        notice.setAttribute('role', storage ? 'alert' : 'status');
        view.append(notice);
      }
      view.append(renderSummaries(state.draft));
      const sharedSteps = new Map<string, number[]>();
      for (const step of state.draft.steps) {
        if (step.image.status === 'retained') sharedSteps.set(step.image.imageId, [...(sharedSteps.get(step.image.imageId) ?? []), step.seq]);
      }
      const list = node('ol', undefined, 'journey-steps');
      for (const step of state.draft.steps) {
        const item = node('li'); item.value = step.seq;
        const targetLabel = step.kind === 'field-change' || step.kind === 'click'
          ? (typeof step.target.label === 'string' ? step.target.label : 'text field')
          : '';
        const label = step.kind === 'initial' ? 'Initial view'
          : step.kind === 'navigation' ? 'Navigation'
          : `${step.kind === 'click' ? 'Click' : 'Entered value'}: ${targetLabel}`;
        const heading = node('h2', `Step ${step.seq} · ${label}`);
        heading.tabIndex = -1;
        heading.setAttribute('data-focus-id', `step-${step.id}`);
        item.append(heading, node('p', elapsed(step.elapsedMs), 'journey-time'));
        item.append(node('p', 'Source URL', 'journey-meta-label'), node('p', String(step.sourceUrl), 'journey-url'));
        if (step.kind === 'navigation') {
          item.append(node('p', 'Destination URL', 'journey-meta-label'), node('p', String(step.navigation.toUrl), 'journey-url'));
        }
        if (step.image.status === 'retained') {
          const image = state.draft.images[step.image.imageId];
          if (image) {
            item.append(node('p', 'Screenshot URL', 'journey-meta-label'), node('p', String(image.captureUrl), 'journey-url'));
            item.append(node('p', `Captured ${image.capturedAt}`, 'journey-time'));
            if (image.dataUrl) {
              const preview = privateImage(image.dataUrl, `Screenshot for step ${step.seq}`);
              preview.className = 'journey-image'; item.append(preview);
            }
            item.append(renderImageReview(step, step.image.imageId, image, sharedSteps.get(step.image.imageId) ?? []));
          }
        } else {
          const reason = step.image.status === 'unavailable' ? failures[step.image.reason]
            : step.image.status === 'removed' ? 'removed during review' : 'capture pending';
          item.append(node('p', `Screenshot unavailable: ${reason}.`, 'journey-help'));
        }
        if (imageStatus?.stepId === step.id) {
          const status = node('p', imageStatus.text, 'journey-status');
          status.setAttribute('role', 'status');
          item.append(status);
        }
        const entered = renderEnteredValue(step as { id: string; seq: number; kind: string; enteredValue?: { kind: string; value?: string; values?: string[]; checked?: boolean; truncated?: boolean; edited?: true } });
        if (entered) item.append(entered);
        item.append(renderUrlRedact(step, state.draft));
        item.append(renderRemove(step));
        list.append(item);
      }
      view.append(list, renderSave(state.draft));
      const sharing = renderExport(state.draft);
      if (sharing) view.append(sharing);
      view.append(action('Discard journey', () => client.discard()));
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
        if ((restore instanceof HTMLTextAreaElement || (restore instanceof HTMLInputElement && restore.type === 'text')) && selection) {
          try { restore.setSelectionRange(selection[0], selection[1]); } catch { /* Keep focus without caret restore. */ }
        }
      }
    } else if (oldFocus) Array.from(view.querySelectorAll('button')).find(button => button.textContent === oldFocus && !button.disabled)?.focus();
    if (pendingFocus !== null && imageBusy === null) {
      // Reclaim only focus the pending change dropped; a reader who moved on keeps their place.
      const settled = document.activeElement;
      if (settled === null || settled === document.body) focusControl(...pendingFocus);
      pendingFocus = null;
    }
  }

  const unsubscribe = client.subscribe(() => { void refresh(); });
  void refresh();
  return () => {
    alive = false; ++version;
    if (summaryTimer !== undefined) clearTimeout(summaryTimer);
    imageEditor?.abort.abort();
    unsubscribe(); view.remove(); imageDialog.remove();
  };
}
