import type { JourneyDraftImage, JourneyDraftStep, JourneyDraftV1, JourneySession, JourneyUrlRedactionTarget } from './journey-core';
import type { NormalizedJourneyPng } from './journey-image';
import { JOURNEY_LIMITATIONS, JOURNEY_LIMITS, storageFailedAfterRecording, type CaptureFailure, type StopReason } from './journey-limits';
import { downloadFile } from './export';
import { journeyArchive, journeyArchiveName, journeyDraftToManifest, journeyPrompt } from './journey-export';
import { reviewJourneyImage, viewJourneyImage } from './journey-image-review';
import { privateImage } from './screenshot';

// maskedFrom is the screenshot the mask was drawn on, so a replacement never
// overwrites pixels that changed while the editor was open.
export type JourneyImageChange =
  | { operation: 'replace'; image: NormalizedJourneyPng; maskedFrom: string }
  | { operation: 'remove' };

// expected and startPage only label the list; stores that predate them omit them.
export interface JourneySavedSummary {
  journeyId: string;
  revision: number;
  updatedAt: string;
  stepCount: number;
  spansPages: boolean;
  expected?: string;
  startPage?: string;
}

// The review a control was rendered for: its journey and the session that
// recorded or reopened it. A click can arrive after another surface closed
// that review, even to reopen the same saved journey, so every review command
// names it and the background refuses one meant for any other as stale.
export interface JourneyReviewTarget {
  journeyId: string;
  sessionId: string;
}

// The view a discard was pressed in. A review sends its revision when it
// offered discard without confirmation because that revision was saved; a
// journey's saved confirmation names only the journey, if it knows it. An
// already-closed journey is not refused: nothing of it is left to discard.
export type JourneyDiscardTarget =
  | ({ phase: 'reviewing'; revision?: number } & JourneyReviewTarget)
  | { phase: 'saved'; journeyId?: string };

// Review edits refused because a save holds the review reject with an error
// whose code is JOURNEY_SAVE_IN_PROGRESS, so the view can await its outcome.
// Each edit names the review it was made in (see JourneyReviewTarget).
export interface JourneyClient {
  read(): Promise<JourneySession>;
  // Called directly from the Start click, so the adapter can request optional
  // permissions before crossing an asynchronous boundary.
  start(includeEnteredValues: boolean): Promise<void>;
  stop(): Promise<void>;
  // Without a target, discards whatever journey is current: the storage reset.
  discard(expected?: JourneyDiscardTarget): Promise<void>;
  // An autosave can land after the review moved on, so it names the review
  // the text was typed in; a different review refuses it.
  updateSummary(expected: string, actual: string, review?: JourneyReviewTarget): Promise<void>;
  removeStep(stepId: string, review?: JourneyReviewTarget): Promise<void>;
  editValue(stepId: string, value: unknown, review?: JourneyReviewTarget): Promise<void>;
  redactUrl(stepId: string, url: JourneyUrlRedactionTarget, review?: JourneyReviewTarget): Promise<void>;
  redactLabel(stepId: string, review?: JourneyReviewTarget): Promise<void>;
  reviewImage(imageId: string, change: JourneyImageChange, review?: JourneyReviewTarget): Promise<void>;
  save(acknowledged: boolean, review?: JourneyReviewTarget): Promise<{ journeyId: string; revision: number }>;
  openSnapshot(journeyId: string): Promise<{ draft: JourneyDraftV1; images: Record<string, JourneyDraftImage> }>;
  reopen(journeyId: string): Promise<void>;
  deleteSnapshot(journeyId: string, revision?: number): Promise<void>;
  list(): Promise<JourneySavedSummary[]>;
  subscribe(changed: () => void): () => void;
  supportsEnteredValues?: boolean;
  // Firefox withdraws page access on every document load, so a reload or a
  // link to another page ends the journey there.
  pageLoadsEndJourney?: boolean;
  // A launch tab starts at most one journey. Without this, Start stays available.
  canStart?(): boolean;
}

export const JOURNEY_SAVE_IN_PROGRESS = 'save-in-progress';
export const JOURNEY_SAVE_IN_PROGRESS_ERROR = 'This journey is being saved. Wait for the save to finish, then try again.';
const JOURNEY_STORAGE_ERROR = 'Journey storage failed. Reset journey storage to continue. A previous draft or the latest action may be lost.';
const SAVE_NOT_FINISHED = 'The save did not finish, and your change was not applied while it ran. Try the change again.';
// Replaces the save-first note while a change here is on its way to the draft.
const FINISHING_CHANGE = 'Finishing your change…';
const LAST_STEP = 'A journey keeps at least one step. To remove this one, discard the journey.';
// A tap's click can follow its pointerup in a later task; a press that makes
// no click stops holding re-renders after this long.
const PRESS_CLICK_WAIT_MS = 500;
// A press whose release never arrives holds re-renders at most this long.
const PRESS_LIMIT_MS = 10_000;
const EXPORT_SIZE_ERROR = 'Journey export exceeds the export size limit.';
const REDACTED = '[redacted]';
// Previews fit this height so a tall phone capture is shown whole, never cropped.
const IMAGE_FIT_HEIGHT = 440;
const TITLE_CHARACTERS = 60;
// An alert stays in the hidden live region long enough to be announced, then
// clears, so a reader moving through the page meets it once, beside its control.
const ALERT_CLEAR_MS = 5_000;
// A repeated alert is emptied first and set again after this pause, since
// setting the same text again announces nothing.
const ALERT_REPEAT_MS = 100;
// Timers stall while the computer sleeps, so the deadline is re-read at least
// this often in case the warning fell due meanwhile.
const DEADLINE_RECHECK_MS = 60_000;

// Whether a review's deadline warning is due, or its deadline has passed.
type DeadlineStage = 'none' | 'warning' | 'expired';

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
// starting origin, so copy spells out what counts as leaving it. A stop that
// loses what was being recorded says what is missing here, so Limitations
// lists only other losses (see stopLimitations).
const stopNotices: Record<StopReason, string> = {
  user: 'You stopped the recording.',
  'duration-limit': `Recording stopped at the ${JOURNEY_LIMITS.maxDurationMs / 60_000}-minute limit. ${KEPT}`,
  'step-limit': `Recording stopped at the ${JOURNEY_LIMITS.maxSteps}-step limit. ${KEPT}`,
  'image-budget': `Recording stopped because the journey's screenshots reached their ${JOURNEY_LIMITS.maxJourneyImageBytes / (1_024 * 1_024)} MB storage limit, so the last screenshot was not kept. ${KEPT}`,
  // Storage can also fail after recording finished: nothing is missing then.
  'session-storage-limit': 'Journey storage failed while recording. Review this draft now because the latest action or the draft may be lost if the extension closes.',
  'left-site': `Recording ended because the page left the website you started on. A different domain, subdomain, or port, or a switch between http and https, counts as leaving. ${KEPT} To record the other website, save or discard this review first, then open anmerko from the toolbar there.`,
  'focus-lost': `Recording ended because the recorded tab lost focus: another tab, window, or app became active. ${KEPT}`,
  'tab-lost': `Recording ended because the recorded tab was closed, replaced, or moved to another window. ${KEPT}`,
  'protected-page': `Recording ended because the tab opened a page anmerko cannot record, such as a browser page or a non-web address. ${KEPT}`,
  'capture-failed': `Recording ended because anmerko lost track of the page after it changed and could not keep recording reliably, so the latest page change or action may be missing. ${KEPT}`,
  'page-access-lost': `Recording ended because the browser withdrew anmerko's access when the page reloaded or opened another page. Firefox does this on every page load, even on the same website. ${KEPT} The new page has no screenshot, and nothing done on it was recorded. To record more, save or discard this review first, then open anmerko from the toolbar on the current page and start a new journey.`,
};
// The storage stop that cut recording short says what that cost.
const STORAGE_LOSS_NOTICE = 'Journey storage filled up or failed while recording, so recording stopped early and the latest action or screenshot may be missing. Review this draft now because the draft may be lost if the extension closes.';

// The limitation each stop adds to the draft (journey-core), which its notice
// already states. journeys.md still lists it; review shows it once.
const stopLimitations: Partial<Record<StopReason, string>> = {
  'session-storage-limit': JOURNEY_LIMITATIONS.sessionStorage,
  'page-access-lost': JOURNEY_LIMITATIONS.pageAccessLost,
  'image-budget': JOURNEY_LIMITATIONS.imageBudget,
  'capture-failed': JOURNEY_LIMITATIONS.captureFailed,
};
// Storage that failed after recording stopped lost nothing recorded; only
// this unsaved draft is at risk.
const REVIEW_STORAGE_NOTICE = 'Journey storage failed after recording stopped. Nothing recorded is missing, but save this draft now because it may be lost if the extension closes.';

const PAGE_LOAD_NOTICE = 'In Firefox, reloading the page or opening another page ends the journey there. Navigation inside the page, such as a single-page app route change, keeps recording.';
const START_ELSEWHERE = 'To record a new journey, go to the website tab, click anmerko in the browser toolbar or Extensions menu, and choose Record journey from More Comment Options.';
// An unsaved review lives in session storage until it goes this long without
// a change, so the browser also drops it on restart.
const REVIEW_IDLE = `${JOURNEY_LIMITS.maxReviewIdleMs / 60_000} minutes`;
// Rows lay their buttons out side by side; an error shows below the row.
const ACTION_ROWS = '.journey-actions, .journey-step-actions, .journey-saved-actions, .journey-export-actions, .journey-url-actions, .journey-image-controls';

function node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

// The redaction flag, not the label text, marks a redacted click label.
function labelRedacted(step: JourneyDraftStep, draft: JourneyDraftV1): boolean {
  return step.kind === 'click' && draft.redactions?.steps[step.id]?.label === true;
}

function count(value: number, singular: string, plural = `${singular}s`): string {
  return `${value} ${value === 1 ? singular : plural}`;
}

function elapsed(ms: number): string {
  const seconds = Math.floor(ms / 1_000);
  return `+${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}.${String(ms % 1_000).padStart(3, '0')}`;
}

function message(caught: unknown, fallback: string): string {
  return caught instanceof Error && caught.message ? caught.message : fallback;
}

function heldBySave(caught: unknown): boolean {
  return caught instanceof Error && (caught as { code?: unknown }).code === JOURNEY_SAVE_IN_PROGRESS;
}

// Which journey a view's controls act on: one journey's session from its start
// or reopening through review and saving, then its saved screen, or the
// launch view. Reopening the same saved journey starts a new session.
function viewKey(session: JourneySession): string {
  if (session.phase === 'idle') return 'idle';
  if (session.phase === 'saved') return `saved:${session.journeyId}`;
  return `journey:${session.journeyId}:${session.sessionId}`;
}

// The review a session holds, if it holds one.
function reviewOf(session: JourneySession): JourneyReviewTarget | undefined {
  return session.phase === 'reviewing' || session.phase === 'saving'
    ? { journeyId: session.journeyId, sessionId: session.sessionId }
    : undefined;
}

function sameReview(session: JourneySession, review: JourneyReviewTarget | undefined): boolean {
  const current = reviewOf(session);
  return current !== undefined && review !== undefined
    && current.journeyId === review.journeyId && current.sessionId === review.sessionId;
}

// "a", "a and b", "a, b, and c".
function listed(items: string[]): string {
  return items.length <= 2 ? items.join(' and ') : `${items.slice(0, -1).join(', ')}, and ${items.at(-1)}`;
}

// What this view had not yet sent to a review when another surface saved or
// closed it, named item by item so the reader knows exactly what to redo.
function lostEditsNotice(lost: string[], saved: boolean): string {
  const redo = lost.length === 1 ? 'that change' : 'those changes';
  return saved
    ? `This journey was saved without ${listed(lost)}. Reopen it from Saved journeys to make ${redo} again.`
    : `The journey you were reviewing was saved or closed elsewhere, so ${listed(lost)} ${lost.length === 1 ? 'was' : 'were'} not applied. If it was saved, reopen it from Saved journeys to make ${redo} again.`;
}

// A saved journey is named by what its reporter expected, then by the page it
// started on. Visible text never shows raw journey IDs.
export function savedJourneyTitle(item: Pick<JourneySavedSummary, 'expected' | 'startPage'>): string {
  const expected = typeof item.expected === 'string' ? item.expected.replace(/\s+/g, ' ').trim() : '';
  const startPage = typeof item.startPage === 'string' ? item.startPage.trim() : '';
  const title = expected || (startPage ? `Journey on ${startPage}` : 'Untitled journey');
  const characters = Array.from(title);
  return characters.length > TITLE_CHARACTERS ? `${characters.slice(0, TITLE_CHARACTERS - 1).join('').trimEnd()}…` : title;
}

export function savedJourneyTime(updatedAt: string): string {
  const time = Date.parse(updatedAt);
  if (!Number.isFinite(time)) return 'at an unknown time';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(time);
}

// Captures a second apart stay distinguishable, in the same local style as saved times.
function capturedTime(capturedAt: string): string {
  const time = Date.parse(capturedAt);
  if (!Number.isFinite(time)) return 'at an unknown time';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' }).format(time);
}

// "at 3:45 PM" today, or "on Sep 24, 2026 at 3:45 PM" on another day, as
// after the computer slept past midnight.
function deadlineTime(ms: number): string {
  const time = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(ms);
  if (new Date(ms).toDateString() === new Date(Date.now()).toDateString()) return `at ${time}`;
  return `on ${new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(ms)} at ${time}`;
}

// Accessible names repeat the title and time; identical ones gain an ordinal.
function savedJourneyNames(items: JourneySavedSummary[]): Map<string, string> {
  const names = items.map(item => `${savedJourneyTitle(item)}, saved ${savedJourneyTime(item.updatedAt)}`);
  const totals = new Map<string, number>();
  for (const name of names) totals.set(name, (totals.get(name) ?? 0) + 1);
  const seen = new Map<string, number>();
  return new Map(items.map((item, index) => {
    const name = names[index];
    const total = totals.get(name) ?? 1;
    if (total === 1) return [item.journeyId, name];
    const ordinal = (seen.get(name) ?? 0) + 1;
    seen.set(name, ordinal);
    return [item.journeyId, `${name} (${ordinal} of ${total})`];
  }));
}

// Mount only in a trusted extension surface (or an isolated demo adapter).
// The website recording strip never receives this client or its draft.
export function mountJourneyUI(root: HTMLElement, client: JourneyClient): () => void {
  const view = node('section', undefined, 'journey-view');
  view.setAttribute('aria-label', 'Journey recording and review');
  // Live regions sit outside the re-rendered view, so each notice is read once.
  const live = node('div', undefined, 'journey-live');
  const politeLive = node('p');
  politeLive.setAttribute('aria-live', 'polite');
  const urgentLive = node('p');
  urgentLive.setAttribute('aria-live', 'assertive');
  // Errors are announced here once each, not by the copy that every re-render
  // rebuilds beside the control that failed.
  const alertLive = node('p');
  alertLive.setAttribute('role', 'alert');
  live.append(politeLive, urgentLive, alertLive);
  // Which error the alert region holds, so clearing one never withdraws another.
  let alerting: 'start' | 'action' | null = null;
  let alertTimer: ReturnType<typeof setTimeout> | undefined;
  // Counts failures, so each is announced once and a repeated message again.
  let failureCount = 0;
  let announcedFailure = 0;
  // The mask and full-size dialogs live beside the view so review re-renders never remove them.
  const imageDialog = node('div', undefined, 'journey-image-dialog');
  const viewerDialog = node('div', undefined, 'journey-image-dialog');
  root.append(view, live, imageDialog, viewerDialog);
  let state: JourneySession = { phase: 'idle', epoch: 0 };
  let busy = false;
  let alive = true;
  let version = 0;
  let actionVersion = 0;
  let includeEnteredValues = false;
  let error = '';
  // The controls, by focus ID, whose action set the error: it shows below the
  // first one still rendered, or below the heading when none is.
  let errorAt: string[] = [];
  let startError = '';
  // Seen: shown while this surface was visible. A start error that arrives
  // while the reader is on the website tab waits for them, focus included.
  let startErrorSeen = false;
  let startErrorFocus = false;
  let startInFlight = false;
  let loadFailed = false;
  // Summaries typed into one review, not yet in its draft.
  let summaryPending: { review: JourneyReviewTarget; expected: string; actual: string } | null = null;
  let summaryTimer: ReturnType<typeof setTimeout> | undefined;
  let summarySaving = false;
  let summaryFlight: Promise<boolean> | undefined;
  // Whether the rendered Save gating counted both summaries as entered.
  let renderedSummaryReady = false;
  // An autosave or screenshot change refused while a save holds the review
  // waits for it: a failed save returns to review and the change is retried.
  let summaryHeld = false;
  let heldImageChange: {
    review: JourneyReviewTarget; step: { id: string }; imageId: string;
    change: JourneyImageChange; returnTo: string; subject: string;
  } | null = null;
  // The journey whose other edits a save refused. Once the save ends, the
  // reader learns whether the saved copy lacks them or they can be tried again.
  let refusedBySave: string | null = null;
  // What the refused edits were, and where the last one's control is, for that later report.
  let refusedEdits: string[] = [];
  let refusedAt: string[] = [];
  // Whether the rendered review offers export for a saved revision.
  let renderedSaved = false;
  let confirmingRemove: string | null = null;
  let removing = false;
  let confirmingDiscard: string | null = null;
  let confirmingDelete: string | null = null;
  let deletingJourney: string | null = null;
  let confirmingDeleteAll = false;
  let deletingAll = false;
  let deleteStatus = '';
  // A save refused for lack of room lists the other saved journeys under
  // Save, so the reader can delete some and save again without losing this one.
  let makingRoom = false;
  let acknowledged = false;
  // The review (journey and session) this view holds local state for: the
  // acknowledgement, unsent edits, confirmations and open editors. Another
  // review, even of the same journey reopened, never inherits any of it.
  let reviewFor = '';
  let reviewSession = '';
  let rendering = false;
  let renderedPhase: JourneySession['phase'] | undefined;
  let renderedKey = '';
  // The review the rendered controls act on; every review command names it.
  let renderedReview: JourneyReviewTarget | undefined;
  // Whether the rendered review shows its deadline warning, or its expiry.
  let renderedDeadline: DeadlineStage = 'none';
  let announcedNotice = '';
  let announcedDeadline = '';
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  // Set when an unsaved review this surface showed reaches its deadline, so
  // the launch view says it was deleted instead of silently replacing it.
  let expiredNotice = '';
  let expiredAnnounced = false;
  let savedJourneys: JourneySavedSummary[] | null = null;
  let editingStepId: string | null = null;
  let editingText = '';
  let editingChecked = false;
  // Whether the open value editor holds input its Save has not sent.
  let editingChanged = false;
  let valueBusy: string | null = null;
  let redactBusy: string | null = null;
  let saveBusy = false;
  let copyBusy = false;
  let downloadBusy = false;
  let exportStatus = '';
  let exportStatusFor: string | null = null;
  // regionChosen: a mask region is drawn or entered but not applied yet.
  // subject names the steps whose screenshot it masks.
  let imageEditor: { review: JourneyReviewTarget; imageId: string; subject: string; abort: AbortController; regionChosen: boolean } | null = null;
  let imageViewer: { review: JourneyReviewTarget; imageId: string; dataUrl: string; returnTo: string[]; abort: AbortController } | null = null;
  let imageBusy: string | null = null;
  let confirmingImageRemove: string | null = null;
  // Focus targets, in order, for a change that removes or disables the
  // focused control. Applied once the change settles, only if focus was lost.
  let pendingFocus: string[] | null = null;
  let imageStatus: { stepId: string; text: string } | null = null;
  const enlargedImages = new Set<string>();
  // A re-render replaces every control. One landing while a pointer or Space
  // is pressed (an autosave finishing on blur, another tab's change, a list
  // refresh) would move the click off the pressed control and lose it, so
  // those updates wait until the press has delivered its click.
  let pressed = false;
  let pressRender = false;
  let pressTimer: ReturnType<typeof setTimeout> | undefined;

  function update(): void {
    if (pressed) pressRender = true;
    else render();
  }

  function endPress(): void {
    if (pressTimer !== undefined) { clearTimeout(pressTimer); pressTimer = undefined; }
    if (!pressed) return;
    pressed = false;
    if (pressRender) { pressRender = false; render(); }
  }

  function endPressAfter(ms: number): void {
    if (!pressed) return;
    if (pressTimer !== undefined) clearTimeout(pressTimer);
    pressTimer = setTimeout(endPress, ms);
  }

  const pressStarted = (event: Event) => {
    if (event instanceof KeyboardEvent && (event.key !== ' ' || event.repeat
      || !(event.target instanceof HTMLElement) || !event.target.matches('button, input[type="checkbox"]'))) return;
    pressed = true;
    endPressAfter(PRESS_LIMIT_MS);
  };
  const pressReleased = (event: Event) => {
    if (event instanceof KeyboardEvent && event.key !== ' ') return;
    endPressAfter(PRESS_CLICK_WAIT_MS);
  };
  // The click is dispatched after its capture listeners, so a zero delay ends
  // the press once the control has handled it. A click on controls rendered
  // for a journey that is no longer the one in view (its update held for the
  // press, or still reading the saved list) is dropped: acting on it could
  // discard or change another journey. The current view replaces it. Only
  // Cancel start is live while this surface's own start begins a journey.
  const pressClicked = (event: Event) => {
    if (renderedKey !== viewKey(state) && !startInFlight && event.composedPath().includes(view)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
    endPressAfter(0);
  };

  async function refresh() {
    const current = ++version;
    try {
      const next = await client.read();
      if (!alive || current !== version) return;
      if ((next.phase === 'idle' || next.phase === 'saved')
        && state.phase !== 'idle' && state.phase !== 'saved') includeEnteredValues = false;
      if (next.phase !== 'idle') expiredNotice = '';
      else if (state.phase === 'reviewing' && Date.now() >= Date.parse(state.expiresAt)) {
        expiredNotice = expiryNotice(state.draft, Date.parse(state.expiresAt));
        expiredAnnounced = false;
      }
      const previous = state;
      state = next;
      // A start error belongs to the launch view it failed in. Any other view
      // makes it stale, except the brief "starting" of the start it reports.
      if (next.phase !== 'idle' && !startInFlight) clearStartError();
      const exportKey = next.phase === 'reviewing' ? `${next.draft.id}@${next.draft.revision}`
        : next.phase === 'saved' ? `${next.journeyId}@${next.revision}` : null;
      if (exportStatusFor !== exportKey) { exportStatus = ''; exportStatusFor = null; }
      // A save holds the review in its saving phase. What this surface has not
      // sent yet (typed summaries, the acknowledgement, an open editor) stays:
      // a failed save returns to review with it. Any other view ends the
      // review it belongs to, so it is dropped, never sent to another review,
      // and the reader learns which edits did not make it.
      const reviewDraft = next.phase === 'reviewing' || next.phase === 'saving' ? next.draft : undefined;
      const ownReview = reviewDraft !== undefined
        && ((reviewDraft.id === reviewFor && sameReview(next, { journeyId: reviewFor, sessionId: reviewSession }))
          || (reviewFor === '' && next.phase === 'reviewing'));
      if (!ownReview) {
        const lost = reviewFor !== '' ? unsentEdits(previous) : [];
        if (error === JOURNEY_SAVE_IN_PROGRESS_ERROR) error = '';
        // A discarded journey takes its edits with it; there is nothing to report.
        if (lost.length > 0 && next.phase === 'saved' && next.journeyId === reviewFor) fail(lostEditsNotice(lost, true));
        else if (lost.length > 0 && next.phase !== 'idle') fail(lostEditsNotice(lost, false));
        acknowledged = false;
        reviewFor = '';
        reviewSession = '';
        makingRoom = false;
        if (summaryTimer !== undefined) { clearTimeout(summaryTimer); summaryTimer = undefined; }
        summaryPending = null;
        summaryHeld = false;
        heldImageChange = null;
        refusedBySave = null;
        refusedEdits = [];
        confirmingRemove = null;
        confirmingDiscard = null;
        confirmingImageRemove = null;
        imageBusy = null;
        imageStatus = null;
        editingStepId = null;
        valueBusy = null;
        redactBusy = null;
        saveBusy = false;
        enlargedImages.clear();
        if (next.phase !== 'saved') {
          copyBusy = false;
          downloadBusy = false;
        }
      }
      if (next.phase === 'reviewing') {
        reviewFor = next.draft.id;
        reviewSession = next.sessionId;
        // The save that refused an edit here failed and handed the review back.
        if (refusedBySave === next.draft.id) { refusedBySave = null; refusedEdits = []; fail(SAVE_NOT_FINISHED, ...refusedAt); }
        if (confirmingDiscard !== null && confirmingDiscard !== next.draft.id) confirmingDiscard = null;
        if (confirmingRemove !== null && !next.draft.steps.some(step => step.id === confirmingRemove)) confirmingRemove = null;
        if (confirmingImageRemove !== null && !next.draft.steps.some(step => step.id === confirmingImageRemove
          && step.image.status === 'retained')) confirmingImageRemove = null;
        if (editingStepId !== null && !next.draft.steps.some(step => step.id === editingStepId)) {
          editingStepId = null;
        }
      }
      const retained = (imageId: string) => reviewDraft?.steps.some(step => step.image.status === 'retained'
        && step.image.imageId === imageId) === true;
      const editor = imageEditor;
      if (editor && (!sameReview(next, editor.review) || !retained(editor.imageId))) editor.abort.abort();
      // The full-size view closes once its pixels are no longer the retained screenshot.
      const viewer = imageViewer;
      if (viewer && (!sameReview(next, viewer.review) || !retained(viewer.imageId)
        || reviewDraft?.images[viewer.imageId]?.dataUrl !== viewer.dataUrl)) {
        // Its opener may be re-rendered away; focus follows once the view settles.
        pendingFocus = viewer.returnTo;
        viewer.abort.abort();
      }
      if (next.phase !== 'idle' && !(next.phase === 'reviewing' && makingRoom)) {
        confirmingDelete = null;
        deletingJourney = null;
        confirmingDeleteAll = false;
        deletingAll = false;
        deleteStatus = '';
      } else if (confirmingDelete !== null && savedJourneys?.some(item => item.journeyId === confirmingDelete) !== true) {
        confirmingDelete = null;
      }
      // Review reads the list too: export and discard depend on whether this
      // exact revision is already stored, which survives leaving the view.
      if (next.phase === 'idle' || next.phase === 'reviewing' || next.phase === 'saved') {
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
      update();
      resumeHeldChanges();
    } catch (caught) {
      if (alive && current === version) {
        const text = caught instanceof Error && caught.message === JOURNEY_STORAGE_ERROR
          ? JOURNEY_STORAGE_ERROR
          : 'Could not load the journey. Reopen anmerko and try again.';
        // Each change notice re-reads the journey; a load that keeps failing is announced once.
        if (!loadFailed || error !== text) fail(text);
        loadFailed = true;
        update();
      }
    }
  }

  // What was made or typed here for the review this view held and has not
  // reached its draft, in words that say what to redo. A mask editor left
  // open with nothing drawn, or a value editor left unchanged, lost nothing.
  function unsentEdits(held: JourneySession): string[] {
    const draft = held.phase === 'reviewing' || held.phase === 'saving' ? held.draft : undefined;
    const seq = (stepId: string) => draft?.steps.find(step => step.id === stepId)?.seq;
    const lost: string[] = [];
    if (summaryPending !== null) lost.push('the summary text you typed');
    if (editingStepId !== null && editingChanged) {
      const step = seq(editingStepId);
      lost.push(step === undefined ? 'the new value you entered' : newValue(step));
    }
    if (imageEditor?.regionChosen === true) lost.push(`the mask you were drawing on the screenshot for ${imageEditor.subject}`);
    if (heldImageChange !== null) {
      lost.push(heldImageChange.change.operation === 'remove'
        ? `your removal of the screenshot for ${heldImageChange.subject}`
        : `the mask you applied to the screenshot for ${heldImageChange.subject}`);
    }
    if (refusedBySave !== null) lost.push(...refusedEdits);
    // A value whose Save the save refused is still in its open editor.
    return [...new Set(lost)];
  }

  function newValue(seq: number): string {
    return `the new value you entered for step ${seq}`;
  }

  // An edit a save refused is reported again once that save ends, below the
  // control it was made with. what names the edit for that report.
  function editFailed(caught: unknown, journeyId: string, what: string, fallback: string, ...at: string[]): void {
    if (heldBySave(caught)) {
      if (refusedBySave !== journeyId) refusedEdits = [];
      refusedBySave = journeyId;
      if (!refusedEdits.includes(what)) refusedEdits.push(what);
      refusedAt = at;
    }
    fail(message(caught, fallback), ...at);
  }

  // Changes held while a save owned the review go out once it is back.
  function resumeHeldChanges(): void {
    if (state.phase !== 'reviewing') return;
    if (summaryHeld && !summarySaving) {
      summaryHeld = false;
      void flushSummary();
    }
    const held = heldImageChange;
    if (held && imageBusy === null) {
      heldImageChange = null;
      if (sameReview(state, held.review)) void changeImage(held.step, held.imageId, held.change, held.returnTo, held.subject, held.review);
    }
  }

  // The review the rendered controls act on, read when a control is used.
  function renderedTarget(): JourneyReviewTarget {
    return renderedReview ?? { journeyId: reviewFor, sessionId: reviewSession };
  }

  type Variant = 'primary' | 'secondary' | 'danger';

  function action(label: string, operation: () => Promise<void>, variant: Variant = 'secondary', canCancel = false, focusId?: string) {
    const button = node('button', label, `journey-${variant}`);
    button.type = 'button';
    button.disabled = busy && !canCancel;
    if (focusId) button.setAttribute('data-focus-id', focusId);
    button.addEventListener('click', () => {
      if (busy && !canCancel) return;
      const current = ++actionVersion;
      error = '';
      let request: Promise<void>;
      const at = focusId ? [focusId] : [];
      try { request = operation(); }
      catch (caught) { fail(message(caught, 'Could not complete this action.'), ...at); render(); return; }
      busy = true;
      render();
      void request.catch(caught => {
        if (current === actionVersion) fail(message(caught, 'Could not complete this action. Try again.'), ...at);
      }).finally(() => {
        if (current !== actionVersion) return;
        busy = false;
        if (alive) void refresh();
      });
    });
    return button;
  }

  function heading(text: string): HTMLHeadingElement {
    const title = node('h1', text);
    title.tabIndex = -1;
    title.setAttribute('data-focus-id', 'journey-heading');
    return title;
  }

  function isStaleReview(caught: unknown): boolean {
    return caught instanceof Error && (caught as { code?: unknown }).code === 'stale-review';
  }

  function fail(text: string, ...at: string[]): void {
    error = text;
    errorAt = at;
    failureCount += 1;
  }

  // The hidden alert region announces an error once, then empties, so a
  // screen reader's virtual cursor finds it only beside the control it names.
  function announceAlert(kind: 'start' | 'action', text: string): void {
    if (alertTimer !== undefined) clearTimeout(alertTimer);
    alerting = kind;
    const show = () => {
      alertLive.textContent = text;
      alertTimer = setTimeout(() => {
        alertTimer = undefined;
        alertLive.textContent = '';
        alerting = null;
      }, ALERT_CLEAR_MS);
    };
    // The same text set again is not announced, so the region empties first.
    if (alertLive.textContent === text) {
      alertLive.textContent = '';
      alertTimer = setTimeout(show, ALERT_REPEAT_MS);
    } else show();
  }

  function silenceAlert(kind: 'start' | 'action'): void {
    if (alerting !== kind) return;
    if (alertTimer !== undefined) { clearTimeout(alertTimer); alertTimer = undefined; }
    alertLive.textContent = '';
    alerting = null;
  }

  // A mask, redaction, removal or value edit on its way to the draft. Save and
  // export wait for it, so neither acts on the review it is about to replace.
  function reviewMutating(): boolean {
    return removing || valueBusy !== null || redactBusy !== null || imageBusy !== null;
  }

  function expiryNotice(draft: JourneyDraftV1, expiresAt: number): string {
    const saved = savedRevision(draft);
    const when = `${deadlineTime(expiresAt)}, ${REVIEW_IDLE} after the last change`;
    if (saved?.revision === draft.revision) return `The review closed ${when}. The saved copy is still in Saved journeys.`;
    if (saved) return `Your unsaved changes were deleted ${when}. The last saved copy is still in Saved journeys.`;
    return `Your unsaved journey review was deleted ${when}.`;
  }

  function settling(): boolean {
    return busy || removing || saveBusy || copyBusy || downloadBusy || deletingAll
      || valueBusy !== null || redactBusy !== null || imageBusy !== null || deletingJourney !== null;
  }

  function scopeActiveElement(): Element | null {
    const scope = view.getRootNode();
    return scope instanceof ShadowRoot ? scope.activeElement : document.activeElement;
  }

  // Focus is lost when it fell back to the document, not when the reader moved on,
  // including to the web page beside a sidebar.
  function focusLost(): boolean {
    if (!document.hasFocus()) return false;
    const scope = view.getRootNode();
    const documentLost = document.activeElement === null || document.activeElement === document.body;
    return scope instanceof ShadowRoot ? scope.activeElement === null && documentLost : documentLost;
  }

  // Never pull focus into this surface from the page or another window: Firefox
  // reports that as a window focus change and drops the screenshot in progress.
  function focusControl(...focusIds: string[]): boolean {
    if (!document.hasFocus()) return false;
    for (const focusId of focusIds) {
      const target = view.querySelector(`[data-focus-id="${CSS.escape(focusId)}"]`);
      if (target instanceof HTMLElement && !target.matches(':disabled')) { target.focus(); return true; }
    }
    return false;
  }

  function clearStartError(): void {
    startError = '';
    startErrorSeen = false;
    startErrorFocus = false;
    silenceAlert('start');
  }

  // Focus follows a failed start back to Start once this surface has focus, so
  // a start that failed while the reader was on the website waits for them.
  function focusStartError(): void {
    if (!startErrorFocus || !startError || !alive || !document.hasFocus()) return;
    startErrorFocus = false;
    // A start that briefly reached "starting" moved focus to that heading.
    const active = scopeActiveElement();
    if (focusLost() || active?.getAttribute('data-focus-id') === 'journey-heading') focusControl('journey-start', 'journey-start-error');
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
    if (alive) update();
  }

  function codePoints(value: string): number {
    return Array.from(value).length;
  }

  function scheduleSummarySave(): void {
    if (summaryTimer !== undefined) clearTimeout(summaryTimer);
    summaryTimer = setTimeout(() => { void flushSummary(); }, 400);
  }

  // Resolves true once nothing typed is left unsent, or false when the write
  // failed or waits for a save that holds the review.
  function flushSummary(): Promise<boolean> {
    if (summaryTimer !== undefined) { clearTimeout(summaryTimer); summaryTimer = undefined; }
    if (summaryFlight) return summaryFlight;
    if (!alive) return Promise.resolve(false);
    if (!summaryPending) return Promise.resolve(true);
    // Text typed in one review never goes to another one.
    const typedIn = sameReview(state, summaryPending.review);
    if (typedIn && state.phase === 'saving') { summaryHeld = true; return Promise.resolve(false); }
    if (!typedIn) { summaryPending = null; return Promise.resolve(true); }
    const wanted = summaryPending;
    summarySaving = true;
    const flight = (async () => {
      let written = false;
      try {
        await client.updateSummary(wanted.expected, wanted.actual, wanted.review);
        if (summaryPending === wanted) summaryPending = null;
        error = '';
        written = true;
      } catch (caught) {
        if (heldBySave(caught)) summaryHeld = true;
        else fail(message(caught, 'Could not update the journey. Try again.'), 'journey-summaries');
      } finally {
        summarySaving = false;
        summaryFlight = undefined;
      }
      if (!summaryHeld && summaryPending && summaryPending !== wanted) scheduleSummarySave();
      else if (alive) void refresh();
      return written;
    })();
    summaryFlight = flight;
    return flight;
  }

  // Saving waits for typed summaries to reach the draft, so a Save pressed
  // straight after typing never stores the text it replaced.
  async function summaryWritten(): Promise<void> {
    while (summaryPending || summarySaving) {
      if (!await flushSummary()) throw new Error(error || JOURNEY_SAVE_IN_PROGRESS_ERROR);
    }
  }

  function savedRevision(draft: JourneyDraftV1): JourneySavedSummary | undefined {
    return savedJourneys?.find(item => item.journeyId === draft.id);
  }

  // Exporting needs the exact revision in storage; raw drafts never export.
  // A typed summary that has not reached the draft yet makes it unsaved too.
  function draftIsSaved(draft: JourneyDraftV1): boolean {
    const saved = savedRevision(draft);
    return summaryPending === null && !summarySaving && saved !== undefined && saved.revision === draft.revision;
  }

  function renderSummaries(draft: JourneyDraftV1): HTMLElement {
    const review = renderedTarget();
    const section = node('section', undefined, 'journey-summary');
    section.setAttribute('aria-label', 'Expected and actual summaries');
    section.setAttribute('data-error-slot', 'journey-summaries');
    const areas = {} as Record<'expected' | 'actual', HTMLTextAreaElement>;
    const pending = pendingSummary(draft);
    const fields: Array<{ key: 'expected' | 'actual'; id: string; label: string; value: string }> = [
      { key: 'expected', id: 'journey-expected', label: 'Expected result', value: pending?.expected ?? draft.expected ?? '' },
      { key: 'actual', id: 'journey-actual', label: 'Actual result', value: pending?.actual ?? draft.actual ?? '' },
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
      const counter = node('p', `${codePoints(field.value)} / 4000 characters`, 'journey-count');
      counter.id = `${field.id}-count`;
      area.addEventListener('input', event => {
        counter.textContent = `${codePoints(area.value)} / 4000 characters`;
        summaryPending = { review, expected: areas.expected.value, actual: areas.actual.value };
        scheduleSummarySave();
        // The first edit of a saved revision withdraws export and one-step
        // discard at once, without interrupting an IME composition.
        if ((event as InputEvent).isComposing) return;
        if (renderedSaved) render();
        else refreshSaveGating();
      });
      area.addEventListener('compositionend', () => {
        if (renderedSaved && summaryPending) render();
        else refreshSaveGating();
      });
      area.addEventListener('blur', () => {
        // Re-renders detach the focused field, which fires blur synchronously
        // mid-render; only a user leaving a settled field should flush an edit.
        if (rendering || !area.isConnected) return;
        const wanted = { review, expected: areas.expected.value, actual: areas.actual.value };
        if (wanted.expected !== (draft.expected ?? '') || wanted.actual !== (draft.actual ?? '') || summaryPending) {
          summaryPending = wanted;
          void flushSummary();
        }
      });
      areas[field.key] = area;
      wrapper.append(label, area, counter);
      section.append(wrapper);
    }
    return section;
  }

  function pendingSummary(draft: JourneyDraftV1): { expected: string; actual: string } | null {
    return summaryPending?.review.journeyId === draft.id && sameReview(state, summaryPending.review) ? summaryPending : null;
  }

  function summariesEntered(draft: JourneyDraftV1): boolean {
    const pending = pendingSummary(draft);
    return (pending?.expected ?? draft.expected ?? '').trim() !== ''
      && (pending?.actual ?? draft.actual ?? '').trim() !== '';
  }

  // Save's gating follows the summaries as they are typed, before the autosave
  // lands. Only its section is rebuilt, so the field being typed in is untouched.
  function refreshSaveGating(): void {
    if (state.phase !== 'reviewing' || summariesEntered(state.draft) === renderedSummaryReady) return;
    view.querySelector('.journey-save')?.replaceWith(renderSave(state.draft));
    placeError();
  }

  function renderRemove(step: { id: string; seq: number }, steps: JourneyDraftStep[]): HTMLElement {
    const wrap = node('div', undefined, 'journey-step-actions');
    // The background refuses to remove a journey's only step; discard ends it.
    if (steps.length <= 1) {
      wrap.append(node('p', LAST_STEP, 'journey-help'));
      return wrap;
    }
    if (confirmingRemove === step.id) {
      const confirm = node('button', `Confirm remove step ${step.seq}`, 'journey-danger');
      confirm.type = 'button';
      confirm.disabled = busy || removing;
      confirm.setAttribute('data-focus-id', `remove-${step.id}`);
      const disarm = () => {
        confirmingRemove = null;
        render();
        focusControl(`remove-${step.id}`);
      };
      confirm.addEventListener('click', () => {
        if (busy || removing) return;
        const review = renderedTarget();
        // A removed step takes its controls with it; land on its neighbour.
        const index = steps.findIndex(candidate => candidate.id === step.id);
        const neighbour = steps[index + 1] ?? steps[index - 1];
        pendingFocus = [`remove-${step.id}`, ...(neighbour ? [`step-${neighbour.id}`] : []), 'journey-heading'];
        confirmingRemove = null;
        removing = true;
        error = '';
        render();
        void client.removeStep(step.id, review).then(() => { error = ''; }).catch(caught => {
          editFailed(caught, review.journeyId, `your removal of step ${step.seq}`,
            'Could not remove this step. Try again.', `remove-${step.id}`, `step-${step.id}`);
        }).finally(() => {
          removing = false;
          if (alive) void refresh();
        });
      });
      confirm.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); disarm(); }
      });
      const keep = node('button', `Keep step ${step.seq}`, 'journey-secondary');
      keep.type = 'button';
      keep.disabled = busy || removing;
      keep.addEventListener('click', disarm);
      wrap.append(confirm, keep);
    } else {
      const remove = node('button', `Remove step ${step.seq}`, 'journey-secondary');
      remove.type = 'button';
      remove.disabled = busy || removing;
      remove.setAttribute('data-focus-id', `remove-${step.id}`);
      remove.addEventListener('click', () => {
        confirmingRemove = step.id;
        confirmingImageRemove = null;
        render();
        focusControl(`remove-${step.id}`);
      });
      wrap.append(remove);
    }
    return wrap;
  }

  function stepList(seqs: number[]): string {
    return listed(seqs.map(String));
  }

  async function changeImage(
    step: { id: string },
    imageId: string,
    change: JourneyImageChange,
    returnTo: string,
    subject: string,
    // The review the change was begun in, even from an editor kept open through another surface's save.
    review: JourneyReviewTarget,
  ): Promise<void> {
    imageBusy = step.id;
    imageStatus = null;
    error = '';
    update();
    // A removed screenshot takes its controls with it; keep the reader on its step.
    pendingFocus = [returnTo, `step-${step.id}`];
    try {
      await client.reviewImage(imageId, change, review);
      error = '';
      imageStatus = { stepId: step.id, text: `Screenshot for ${subject} ${change.operation === 'remove' ? 'removed' : 'masked'}.` };
      if (change.operation === 'remove') pendingFocus = [`step-${step.id}`];
    } catch (caught) {
      // A mask drawn while another surface saves is applied once the review is back.
      if (heldBySave(caught)) heldImageChange = { review, step, imageId, change, returnTo, subject };
      else fail(message(caught, 'Could not update the screenshot. Try again.'), returnTo, `mask-image-${step.id}`, `step-${step.id}`);
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
    review: JourneyReviewTarget,
  ): Promise<void> {
    if (busy || saveBusy || imageBusy !== null || imageEditor || state.phase !== 'reviewing' || !image.dataUrl) return;
    const maskedFrom = image.dataUrl;
    const abort = new AbortController();
    const editor = { review, imageId, subject, abort, regionChosen: false };
    imageEditor = editor;
    confirmingImageRemove = null;
    imageStatus = null;
    error = '';
    render();
    const returnTo = `mask-image-${step.id}`;
    const result = await reviewJourneyImage(imageDialog, {
      dataUrl: maskedFrom, width: image.width, height: image.height, ...(note ? { note } : {}),
      regionChanged: chosen => { editor.regionChosen = chosen; },
    }, abort.signal);
    if (imageEditor?.abort === abort) imageEditor = null;
    if (!alive) return;
    if (result.kind === 'cancelled') {
      focusControl(returnTo, `step-${step.id}`);
      return;
    }
    await changeImage(step, imageId, result.kind === 'applied'
      ? { operation: 'replace', image: result.image, maskedFrom }
      : { operation: 'remove' }, returnTo, subject, review);
  }

  // The full-size view is modal; it closes itself if another surface changes
  // or removes the screenshot, and focus returns to the control that opened it.
  async function openImageViewer(step: { id: string; seq: number }, imageId: string, image: JourneyDraftImage & { dataUrl: string }): Promise<void> {
    if (imageViewer || imageEditor || state.phase !== 'reviewing') return;
    const abort = new AbortController();
    const returnTo = [`view-image-${step.id}`, `step-${step.id}`];
    imageViewer = { review: renderedTarget(), imageId, dataUrl: image.dataUrl, returnTo, abort };
    await viewJourneyImage(viewerDialog, {
      dataUrl: image.dataUrl, width: image.width, height: image.height, label: `Screenshot for step ${step.seq}`,
    }, abort.signal);
    if (imageViewer?.abort === abort) imageViewer = null;
    if (alive && focusLost()) focusControl(...returnTo);
  }

  // The preview keeps the capture's aspect ratio and fits a bounded height, so
  // reviewers always see the whole image they will share. Tall captures can
  // switch to the full column width, and any capture opens at full size, to
  // read small text in a narrow sidebar or on a phone.
  function renderPreview(step: { id: string; seq: number }, imageId: string, image: JourneyDraftImage & { dataUrl: string }): HTMLElement[] {
    const preview = privateImage(image.dataUrl, `Screenshot for step ${step.seq}`);
    preview.className = 'journey-image';
    const width = image.width > 0 ? image.width : 16;
    const height = image.height > 0 ? image.height : 9;
    const enlarged = enlargedImages.has(step.id);
    preview.style.aspectRatio = `${width} / ${height}`;
    preview.style.width = enlarged
      ? `min(100%, ${width}px)`
      : `min(100%, ${Math.round(IMAGE_FIT_HEIGHT * width / height * 100) / 100}px)`;
    const controls = node('div', undefined, 'journey-image-controls');
    // A capture that already fits at full size has nothing to enlarge.
    if (height > width && height > IMAGE_FIT_HEIGHT) {
      const size = node('button', `${enlarged ? 'Fit' : 'Enlarge'} screenshot for step ${step.seq}`, 'journey-secondary');
      size.type = 'button';
      size.setAttribute('data-focus-id', `size-image-${step.id}`);
      size.addEventListener('click', () => {
        if (enlargedImages.has(step.id)) enlargedImages.delete(step.id);
        else enlargedImages.add(step.id);
        render();
      });
      controls.append(size);
    }
    const full = node('button', `View full-size screenshot for step ${step.seq}`, 'journey-secondary');
    full.type = 'button';
    full.setAttribute('data-focus-id', `view-image-${step.id}`);
    full.addEventListener('click', () => { void openImageViewer(step, imageId, image); });
    controls.append(full);
    return [preview, controls];
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
        void changeImage(step, imageId, { operation: 'remove' }, `remove-image-${step.id}`, subject, renderedTarget());
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
        mask.addEventListener('click', () => { void openImageEditor(step, imageId, image, shared, subject, renderedTarget()); });
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
    const cancelEditing = () => {
      editingStepId = null;
      render();
      focusControl(`edit-value-${step.id}`);
    };
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
      input.addEventListener('change', () => { editingChecked = input.checked; editingChanged = true; });
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
      area.addEventListener('input', () => { editingText = area.value; editingChanged = true; });
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
      input.addEventListener('input', () => { editingText = input.value; editingChanged = true; });
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
        area.addEventListener('input', () => { editingText = area.value; editingChanged = true; });
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
      const review = renderedTarget();
      valueBusy = step.id;
      error = '';
      pendingFocus = [`edit-value-${step.id}`, `save-value-${step.id}`];
      render();
      const wanted = editedValueFor(step.enteredValue, editingText, editingChecked);
      void client.editValue(step.id, wanted, review).then(() => { error = ''; }).catch(caught => {
        editFailed(caught, review.journeyId, newValue(step.seq),
          'Could not update the journey. Try again.', `save-value-${step.id}`, `edit-value-${step.id}`, `step-${step.id}`);
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
    cancel.addEventListener('click', cancelEditing);
    cancel.addEventListener('keydown', onEscape);
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
        editingChanged = false;
        render();
        focusControl(`value-${step.id}`);
      });
      const remove = node('button', `Remove value for step ${step.seq}`, 'journey-secondary');
      remove.type = 'button';
      remove.disabled = busy || valueBusy !== null;
      remove.setAttribute('data-focus-id', `remove-value-${step.id}`);
      remove.addEventListener('click', () => {
        if (busy || valueBusy !== null) return;
        const review = renderedTarget();
        valueBusy = step.id;
        error = '';
        render();
        void client.editValue(step.id, emptyValueFor(entered as { kind: string; multiple?: boolean }), review).then(() => { error = ''; }).catch(caught => {
          editFailed(caught, review.journeyId, `your removal of the value for step ${step.seq}`,
            'Could not update the journey. Try again.', `remove-value-${step.id}`, `step-${step.id}`);
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

  // A redacted URL names itself beside the field it replaced; the marker also
  // takes focus from the Redact button it replaces.
  function renderUrl(step: { id: string }, label: string, url: string, target: JourneyUrlRedactionTarget): HTMLElement[] {
    const parts: HTMLElement[] = [node('p', label, 'journey-meta-label'), node('p', String(url), 'journey-url')];
    if (url === REDACTED) {
      const marker = node('p', `${label} redacted during review.`, 'journey-edited');
      marker.tabIndex = -1;
      marker.setAttribute('data-focus-id', `redacted-${target}-${step.id}`);
      parts.push(marker);
    }
    return parts;
  }

  // A click label can echo what the user typed, so it is redacted like a URL.
  function renderUrlRedact(step: JourneyDraftStep, draft: JourneyDraftV1): HTMLElement | null {
    const wrap = node('div', undefined, 'journey-url-actions');
    const redactControl = (
      target: JourneyUrlRedactionTarget | 'label',
      text: string,
      what: string,
      redactIt: (review: JourneyReviewTarget) => Promise<void>,
    ) => {
      const redact = node('button', text, 'journey-secondary');
      redact.type = 'button';
      redact.disabled = busy || redactBusy !== null;
      redact.setAttribute('data-focus-id', `redact-${target}-${step.id}`);
      redact.addEventListener('click', () => {
        if (busy || redactBusy !== null) return;
        const review = renderedTarget();
        redactBusy = `${step.id}:${target}`;
        error = '';
        pendingFocus = [`redact-${target}-${step.id}`, `redacted-${target}-${step.id}`, `step-${step.id}`];
        render();
        void redactIt(review).then(() => { error = ''; }).catch(caught => {
          editFailed(caught, review.journeyId, `your redaction of the ${what} for step ${step.seq}`,
            'Could not update the journey. Try again.', `redact-${target}-${step.id}`, `step-${step.id}`);
        }).finally(() => {
          redactBusy = null;
          if (alive) void refresh();
        });
      });
      wrap.append(redact);
    };
    const urlControl = (url: string, target: JourneyUrlRedactionTarget, label: string) => {
      if (url !== REDACTED) {
        redactControl(target, `Redact ${label} URL for step ${step.seq}`, `${label} URL`, review => client.redactUrl(step.id, target, review));
      }
    };
    urlControl(step.sourceUrl, 'source', 'source');
    if (step.kind === 'navigation') urlControl(step.navigation.toUrl, 'destination', 'destination');
    if (step.image.status === 'retained') {
      const image = draft.images[step.image.imageId];
      if (image) urlControl(image.captureUrl, 'capture', 'screenshot');
    }
    // An editable target's label is only its generic kind, such as "text field".
    if (step.kind === 'click' && !step.target.editable && !labelRedacted(step, draft)) {
      redactControl('label', `Redact click label for step ${step.seq}`, 'click label', review => client.redactLabel(step.id, review));
    }
    return wrap.childElementCount > 0 ? wrap : null;
  }

  function renderSave(draft: JourneyDraftV1): HTMLElement {
    const section = node('section', undefined, 'journey-save');
    const title = node('h2', 'Save journey');
    title.id = 'journey-save-heading';
    section.setAttribute('aria-labelledby', title.id);
    title.tabIndex = -1;
    title.setAttribute('data-focus-id', 'journey-save-heading');
    section.append(title);
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
    renderedSummaryReady = summariesEntered(draft);
    const reasons: string[] = [];
    if (!renderedSummaryReady) reasons.push('Enter both an expected and an actual summary.');
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
    save.disabled = reasons.length > 0 || busy || saveBusy || reviewMutating();
    save.setAttribute('aria-describedby', describedBy);
    save.setAttribute('data-focus-id', 'journey-save');
    save.addEventListener('click', () => {
      if (save.disabled) return;
      const review = renderedTarget();
      saveBusy = true;
      error = '';
      render();
      // A review that moved on to another review meanwhile is never saved from here.
      void summaryWritten().then(async () => {
        if (state.phase !== 'reviewing' || !sameReview(state, review)) return;
        await client.save(acknowledged, review);
        error = '';
      }).catch(caught => {
        fail(message(caught, 'Could not save this journey. Try again.'), 'journey-save');
        if ((caught as { code?: unknown }).code === 'saved-journeys-full') makingRoom = true;
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

  // finishing: a change here is on its way to the draft, so whether it must be
  // saved first is not known yet.
  function renderExport(target: { journeyId: string; revision: number }, exportable: boolean, primary = false, finishing = false): HTMLElement | null {
    if (typeof (client as Partial<JourneyClient>).openSnapshot !== 'function') return null;
    const section = node('section', undefined, 'journey-export');
    const title = node('h2', 'Share journey');
    title.id = 'journey-export-heading';
    section.setAttribute('aria-labelledby', title.id);
    section.append(title);
    if (!exportable) {
      const note = node('p', finishing ? FINISHING_CHANGE : 'Save first to copy or download this journey.', 'journey-help');
      note.id = 'journey-export-note';
      section.append(note);
    }
    const actions = node('div', undefined, 'journey-export-actions');
    const copy = node('button', 'Copy Prompt', primary ? 'journey-primary' : 'journey-secondary');
    copy.type = 'button';
    copy.disabled = !exportable || copyBusy || downloadBusy;
    copy.setAttribute('data-focus-id', 'journey-copy');
    if (!exportable) copy.setAttribute('aria-describedby', 'journey-export-note');
    copy.addEventListener('click', () => { void copyJourney(target); });
    const download = node('button', 'Download Markdown + Images', 'journey-secondary');
    download.type = 'button';
    download.disabled = !exportable || copyBusy || downloadBusy;
    download.setAttribute('data-focus-id', 'journey-download');
    if (!exportable) download.setAttribute('aria-describedby', 'journey-export-note');
    download.addEventListener('click', () => { void downloadJourney(target); });
    actions.append(copy, download);
    section.append(actions);
    if (exportStatus) {
      const status = node('p', exportStatus, 'journey-status');
      status.setAttribute('role', 'status');
      section.append(status);
    }
    return section;
  }

  async function copyJourney(target: { journeyId: string; revision: number }): Promise<void> {
    if (copyBusy || downloadBusy) return;
    copyBusy = true;
    exportStatus = '';
    exportStatusFor = null;
    error = '';
    render();
    try {
      const snapshot = await client.openSnapshot(target.journeyId);
      const text = journeyPrompt(journeyDraftToManifest(snapshot.draft));
      await navigator.clipboard.writeText(text);
      exportStatus = 'Journey prompt copied. Paste it into your agent chat, then use Download Markdown + Images for the screenshots; its journeys.md has full step detail.';
      exportStatusFor = `${target.journeyId}@${target.revision}`;
      error = '';
    } catch {
      fail('Could not copy the journey prompt. Use Download Markdown + Images to export this journey.', 'journey-copy');
    } finally {
      copyBusy = false;
    }
    if (alive) update();
  }

  async function downloadJourney(target: { journeyId: string; revision: number }): Promise<void> {
    if (copyBusy || downloadBusy) return;
    downloadBusy = true;
    exportStatus = '';
    exportStatusFor = null;
    error = '';
    render();
    try {
      const snapshot = await client.openSnapshot(target.journeyId);
      const archive = journeyArchive(snapshot.draft);
      downloadFile(new Blob([archive], { type: 'application/zip' }), journeyArchiveName(snapshot.draft.id));
      exportStatus = 'Journey download started. Extract the ZIP and give your agent prompt.md with the screenshots it names; add journeys.md for full step detail.';
      exportStatusFor = `${target.journeyId}@${target.revision}`;
      error = '';
    } catch (caught) {
      fail(message(caught, '') === EXPORT_SIZE_ERROR
        ? EXPORT_SIZE_ERROR
        : 'Could not download the journey. Try again.', 'journey-download');
    } finally {
      downloadBusy = false;
    }
    if (alive) update();
  }

  // An unchanged reopened journey stays saved, so closing it needs no
  // confirmation. Anything unsaved is confirmed like Remove step, including a
  // saved one a change here is about to alter. The discard names the review,
  // and the one-step discard the saved revision it offered to close.
  function renderDiscard(draft: JourneyDraftV1): HTMLElement {
    const section = node('div', undefined, 'journey-discard');
    const saved = savedRevision(draft);
    const review = renderedTarget();
    if (draftIsSaved(draft) && !reviewMutating()) {
      const note = node('p', 'Discarding closes this review. The saved copy stays in Saved journeys.', 'journey-help');
      note.id = 'journey-discard-note';
      const discard = action('Discard journey', () => client.discard({ phase: 'reviewing', ...review, revision: draft.revision }),
        'secondary', false, 'journey-discard');
      discard.setAttribute('aria-describedby', note.id);
      section.append(note, discard);
    } else if (confirmingDiscard === draft.id) {
      const scope = node('p', saved
        ? 'Discard your unsaved changes? The last saved copy stays in Saved journeys.'
        : 'Discard this journey? Its steps and screenshots are deleted and cannot be recovered.', 'journey-help');
      scope.id = 'journey-discard-scope';
      const actions = node('div', undefined, 'journey-step-actions');
      const confirm = action('Confirm discard journey', () => client.discard({ phase: 'reviewing', ...review }),
        'danger', false, 'journey-confirm-discard');
      confirm.setAttribute('aria-describedby', scope.id);
      const disarm = () => {
        confirmingDiscard = null;
        render();
        focusControl('journey-discard');
      };
      confirm.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); disarm(); }
      });
      const keep = node('button', 'Keep reviewing', 'journey-secondary');
      keep.type = 'button';
      keep.disabled = busy;
      keep.addEventListener('click', disarm);
      actions.append(confirm, keep);
      section.append(scope, actions);
    } else {
      const discard = node('button', 'Discard journey', 'journey-secondary');
      discard.type = 'button';
      discard.disabled = busy;
      discard.setAttribute('data-focus-id', 'journey-discard');
      discard.addEventListener('click', () => {
        if (busy) return;
        confirmingDiscard = draft.id;
        confirmingRemove = null;
        confirmingImageRemove = null;
        render();
        focusControl('journey-confirm-discard');
      });
      section.append(discard);
    }
    return section;
  }

  function renderDelete(item: JourneySavedSummary, name: string, next: JourneySavedSummary | undefined): HTMLElement[] {
    const idle = deletingJourney === null && !deletingAll && !busy;
    if (confirmingDelete === item.journeyId) {
      const confirm = node('button', 'Confirm delete', 'journey-danger');
      confirm.type = 'button';
      confirm.disabled = !idle;
      confirm.setAttribute('aria-label', `Confirm delete journey: ${name}`);
      confirm.setAttribute('data-focus-id', `confirm-delete-${item.journeyId}`);
      const disarm = () => {
        confirmingDelete = null;
        render();
        focusControl(`delete-${item.journeyId}`);
      };
      confirm.addEventListener('click', () => {
        if (!idle) return;
        confirmingDelete = null;
        deletingJourney = item.journeyId;
        deleteStatus = '';
        error = '';
        // A stale delete keeps the row; otherwise land on the next one.
        pendingFocus = [`delete-${item.journeyId}`, ...(next ? [`reopen-${next.journeyId}`, `delete-${next.journeyId}`] : []), 'journey-saved-heading'];
        render();
        void client.deleteSnapshot(item.journeyId, item.revision).then(() => {
          error = '';
        }).catch(caught => {
          fail(isStaleReview(caught)
            ? 'A saved journey changed. The list was reloaded; try again.'
            : 'Could not delete this journey. Try again.', `delete-${item.journeyId}`, 'journey-saved-heading');
        }).finally(() => {
          deletingJourney = null;
          if (alive) void refreshSavedList();
          else render();
        });
      });
      confirm.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); disarm(); }
      });
      const keep = node('button', 'Keep', 'journey-secondary');
      keep.type = 'button';
      keep.disabled = !idle;
      keep.setAttribute('aria-label', `Keep journey: ${name}`);
      keep.addEventListener('click', disarm);
      return [confirm, keep];
    }
    const remove = node('button', 'Delete', 'journey-danger-outline');
    remove.type = 'button';
    remove.disabled = !idle;
    remove.setAttribute('aria-label', `Delete journey: ${name}`);
    remove.setAttribute('data-focus-id', `delete-${item.journeyId}`);
    remove.addEventListener('click', () => {
      confirmingDelete = item.journeyId;
      confirmingDeleteAll = false;
      render();
      focusControl(`confirm-delete-${item.journeyId}`);
    });
    return [remove];
  }

  function renderDeleteAll(items: JourneySavedSummary[]): HTMLElement {
    const total = items.length;
    const wrap = node('div', undefined, 'journey-saved-delete-all');
    const idle = deletingJourney === null && !deletingAll && !busy;
    if (confirmingDeleteAll) {
      const scope = node(
        'p',
        `Delete ${count(total, 'saved journey')}? This cannot be undone.`,
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
      const disarm = () => {
        confirmingDeleteAll = false;
        render();
        focusControl('delete-all');
      };
      confirm.addEventListener('click', () => {
        if (!idle) return;
        confirmingDeleteAll = false;
        deletingAll = true;
        deleteStatus = '';
        error = '';
        pendingFocus = ['delete-all', 'journey-saved-heading'];
        render();
        const snapshot = items.map(item => ({ journeyId: item.journeyId, revision: item.revision, title: savedJourneyTitle(item) }));
        const failed: string[] = [];
        let deleted = 0;
        void (async () => {
          for (const item of snapshot) {
            try {
              await client.deleteSnapshot(item.journeyId, item.revision);
              deleted += 1;
            } catch {
              failed.push(item.title);
            }
          }
          deleteStatus = `Deleted ${deleted} of ${count(snapshot.length, 'journey')}.`;
          fail(failed.map(title => `Could not delete “${title}”.`).join(' '), 'delete-all', 'journey-saved-heading');
        })().finally(() => {
          deletingAll = false;
          if (alive) void refreshSavedList();
          else render();
        });
      });
      confirm.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); disarm(); }
      });
      const cancel = node('button', 'Cancel', 'journey-secondary');
      cancel.type = 'button';
      cancel.disabled = !idle;
      cancel.addEventListener('click', disarm);
      actions.append(confirm, cancel);
      wrap.append(actions);
    } else {
      const remove = node('button', 'Delete all journeys', 'journey-danger-outline');
      remove.type = 'button';
      remove.disabled = !idle;
      remove.setAttribute('data-focus-id', 'delete-all');
      remove.addEventListener('click', () => {
        confirmingDeleteAll = true;
        confirmingDelete = null;
        render();
        focusControl('confirm-delete-all');
      });
      wrap.append(remove);
    }
    return wrap;
  }

  // While reviewing, the list only makes room: the reviewed journey replaces
  // its own saved copy, so it is left out, and Reopen would leave the review.
  function renderSavedList(reviewing?: JourneyDraftV1): HTMLElement | null {
    if (savedJourneys === null) return null;
    const saved = reviewing ? savedJourneys.filter(item => item.journeyId !== reviewing.id) : savedJourneys;
    const section = node('section', undefined, 'journey-saved-list');
    const title = node('h2', 'Saved journeys');
    title.id = 'journey-saved-heading';
    section.setAttribute('aria-labelledby', title.id);
    title.tabIndex = -1;
    title.setAttribute('data-focus-id', 'journey-saved-heading');
    section.append(title);
    if (saved.length === 0) {
      section.append(node('p', reviewing ? 'No other saved journeys.' : 'No saved journeys yet.', 'journey-help'));
    } else {
      if (reviewing) section.append(node('p', 'Delete journeys you no longer need, then save this one again.', 'journey-help'));
      const names = savedJourneyNames(saved);
      const list = node('ul', undefined, 'journey-saved-items');
      saved.forEach((item, index, items) => {
        const name = names.get(item.journeyId) ?? savedJourneyTitle(item);
        const row = node('li', undefined, 'journey-saved-item');
        row.append(node('p', savedJourneyTitle(item), 'journey-saved-title'));
        const meta = node('p', undefined, 'journey-saved-meta');
        const time = node('time', savedJourneyTime(item.updatedAt));
        time.dateTime = item.updatedAt;
        meta.append('Saved ', time, ` · ${count(item.stepCount, 'step')}`);
        if (item.spansPages === true) meta.append(' · ', node('span', 'Spans pages', 'journey-saved-spans'));
        row.append(meta);
        const actions = node('div', undefined, 'journey-saved-actions');
        if (!reviewing && typeof (client as Partial<JourneyClient>).reopen === 'function') {
          const reopen = action('Reopen', () => client.reopen(item.journeyId), 'secondary', false, `reopen-${item.journeyId}`);
          reopen.setAttribute('aria-label', `Reopen journey: ${name}`);
          actions.append(reopen);
        }
        if (typeof (client as Partial<JourneyClient>).deleteSnapshot === 'function') {
          actions.append(...renderDelete(item, name, items[index + 1] ?? items[index - 1]));
        }
        if (actions.childElementCount > 0) row.append(actions);
        list.append(row);
      });
      section.append(list);
      if (typeof (client as Partial<JourneyClient>).deleteSnapshot === 'function') {
        section.append(renderDeleteAll(saved));
      }
    }
    if (deleteStatus) {
      const status = node('p', deleteStatus, 'journey-status');
      status.setAttribute('role', 'status');
      section.append(status);
    }
    return section;
  }

  // The error sits next to Start so it is seen and announced where the reader acted.
  function renderStart(): HTMLElement {
    const wrap = node('div', undefined, 'journey-start');
    if (client.canStart?.() === false) {
      wrap.append(node('p', START_ELSEWHERE, 'journey-notice'));
    } else {
      const buttons = node('div', undefined, 'journey-actions');
      const start = node('button', 'Start journey', 'journey-primary');
      start.type = 'button';
      start.disabled = busy;
      start.setAttribute('data-focus-id', 'journey-start');
      if (startError) start.setAttribute('aria-describedby', 'journey-start-error');
      start.addEventListener('click', () => {
        if (busy) return;
        const current = ++actionVersion;
        clearStartError();
        error = '';
        pendingFocus = ['journey-start', 'journey-start-error'];
        // Focus waits for a hidden surface, not for a visible sidebar whose reader moved to the page.
        const failed = (caught: unknown) => {
          startError = message(caught, 'Could not start the journey. Try again.');
          startErrorFocus = document.hasFocus() || document.visibilityState !== 'visible';
        };
        let request: Promise<void>;
        try { request = client.start(includeEnteredValues); }
        catch (caught) {
          failed(caught);
          render();
          focusStartError();
          return;
        }
        busy = true;
        startInFlight = true;
        render();
        void request.catch(caught => {
          if (current === actionVersion) failed(caught);
        }).finally(async () => {
          startInFlight = false;
          if (current !== actionVersion) return;
          busy = false;
          if (!alive) return;
          await refresh();
          focusStartError();
        });
      });
      buttons.append(start);
      if (busy) buttons.append(action('Cancel start', () => client.stop(), 'secondary', true, 'journey-cancel-start'));
      wrap.append(buttons);
    }
    if (startError) {
      const shown = node('p', startError, 'journey-error');
      shown.id = 'journey-start-error';
      shown.tabIndex = -1;
      shown.setAttribute('data-focus-id', 'journey-start-error');
      wrap.append(shown);
    }
    return wrap;
  }

  function renderStep(step: JourneyDraftStep, draft: JourneyDraftV1, sharedSteps: Map<string, number[]>): HTMLElement {
    const item = node('li'); item.value = step.seq;
    const targetLabel = step.kind === 'field-change' || step.kind === 'click'
      ? (typeof step.target.label === 'string' ? step.target.label : 'text field')
      : '';
    const label = step.kind === 'initial' ? 'Initial view'
      : step.kind === 'navigation' ? 'Navigation'
      : `${step.kind === 'click' ? 'Click' : 'Entered value'}: ${targetLabel}`;
    const title = node('h2', `Step ${step.seq} · ${label}`);
    title.tabIndex = -1;
    title.setAttribute('data-focus-id', `step-${step.id}`);
    item.append(title, node('p', elapsed(step.elapsedMs), 'journey-time'));
    if (labelRedacted(step, draft)) {
      const marker = node('p', 'Click label redacted during review.', 'journey-edited');
      marker.tabIndex = -1;
      marker.setAttribute('data-focus-id', `redacted-label-${step.id}`);
      item.append(marker);
    }
    item.append(...renderUrl(step, 'Source URL', step.sourceUrl, 'source'));
    if (step.kind === 'navigation') item.append(...renderUrl(step, 'Destination URL', step.navigation.toUrl, 'destination'));
    if (step.image.status === 'retained') {
      const image = draft.images[step.image.imageId];
      if (image) {
        item.append(...renderUrl(step, 'Screenshot URL', image.captureUrl, 'capture'));
        const captured = node('time', capturedTime(image.capturedAt));
        captured.dateTime = image.capturedAt;
        const time = node('p', 'Captured ', 'journey-time');
        time.append(captured);
        item.append(time);
        if (image.dataUrl) item.append(...renderPreview(step, step.image.imageId, image as JourneyDraftImage & { dataUrl: string }));
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
    const redact = renderUrlRedact(step, draft);
    if (redact) item.append(redact);
    item.append(renderRemove(step, draft.steps));
    return item;
  }

  // Whether the draft records the loss its own stop caused, which the stop
  // notice then states in place of the Limitations list.
  function stopLimitation(draft: JourneyDraftV1): string | undefined {
    const limitation = storageFailedAfterRecording(draft) ? JOURNEY_LIMITATIONS.reviewStorage
      : draft.stopReason ? stopLimitations[draft.stopReason] : undefined;
    const limitations: unknown = draft.limitations;
    return limitation && Array.isArray(limitations) && limitations.includes(limitation) ? limitation : undefined;
  }

  function announceStop(draft: JourneyDraftV1): HTMLElement | null {
    const reason = draft.stopReason;
    const text = !reason ? undefined
      : storageFailedAfterRecording(draft) ? REVIEW_STORAGE_NOTICE
        : reason === 'session-storage-limit' && stopLimitation(draft) ? STORAGE_LOSS_NOTICE
          : stopNotices[reason];
    if (!reason || !text) return null;
    // A storage failure can still lose the draft, so it interrupts.
    const storage = reason === 'session-storage-limit';
    const key = `${draft.id}:${reason}:${text}`;
    if (announcedNotice !== key) {
      announcedNotice = key;
      (storage ? urgentLive : politeLive).textContent = text;
      (storage ? politeLive : urgentLive).textContent = '';
    }
    return node('p', text, `journey-notice journey-stop-reason${storage ? ' journey-notice-error' : ''}`);
  }

  // What recording lost, shown before the steps so no one shares the journey
  // believing it complete. journeys.md lists the same limitations. The stop
  // notice above already says what the stop itself lost, so each loss shows once.
  function renderLimitations(draft: JourneyDraftV1): HTMLElement | null {
    const all: unknown = draft.limitations;
    const stated = stopLimitation(draft);
    const limitations = Array.isArray(all) ? all.filter(limitation => limitation !== stated) : [];
    if (limitations.length === 0) return null;
    const section = node('section', undefined, 'journey-notice journey-limitations');
    const title = node('h2', 'Limitations');
    title.id = 'journey-limitations-heading';
    section.setAttribute('aria-labelledby', title.id);
    const list = node('ul');
    for (const limitation of limitations) list.append(node('li', String(limitation)));
    section.append(title, list);
    return section;
  }

  // Every review says up front how long unsaved work lasts. Once its deadline
  // nears, a warning stays in view and is announced once per deadline; a
  // change here moves the deadline and withdraws it.
  function deadlineStage(now: number): DeadlineStage {
    if (state.phase !== 'reviewing' || draftIsSaved(state.draft)) return 'none';
    const warningAt = Date.parse(state.warningAt);
    const expiresAt = Date.parse(state.expiresAt);
    if (!Number.isFinite(warningAt) || !Number.isFinite(expiresAt) || now < warningAt) return 'none';
    return now >= expiresAt ? 'expired' : 'warning';
  }

  function renderDeadline(draft: JourneyDraftV1, expiresAt: number): HTMLElement[] {
    const saved = savedRevision(draft);
    const unchanged = draftIsSaved(draft);
    const standing = node('p', unchanged
      ? `This review closes after ${REVIEW_IDLE} without changes, and when the browser restarts. The saved copy stays in Saved journeys.`
      : `Unsaved ${saved ? 'changes are' : 'reviews are'} deleted after ${REVIEW_IDLE} without changes, and when the browser restarts.`,
    'journey-help journey-deadline-note');
    const now = Date.now();
    const stage = deadlineStage(now);
    renderedDeadline = stage;
    if (stage === 'none') return [standing];
    const warning = node('div', undefined, 'journey-notice journey-notice-error journey-deadline');
    const subject = saved ? 'Your unsaved changes' : 'This unsaved review';
    const text = stage === 'expired'
      ? `${subject} went ${REVIEW_IDLE} without changes and ${saved ? 'are' : 'is'} being deleted.`
      : `${subject} will be deleted ${deadlineTime(expiresAt)}. Save now, or make any change to keep reviewing.`;
    warning.append(node('p', text));
    if (stage === 'warning') {
      const go = node('button', 'Go to Save', 'journey-secondary');
      go.type = 'button';
      go.setAttribute('data-focus-id', 'journey-go-to-save');
      go.addEventListener('click', () => {
        const save = view.querySelector<HTMLButtonElement>('[data-focus-id="journey-save"]');
        const target = save && !save.disabled ? save : view.querySelector<HTMLElement>('[data-focus-id="journey-save-heading"]');
        target?.focus({ preventScroll: true });
        target?.scrollIntoView({ block: 'center' });
      });
      warning.append(go);
    }
    const key = `${draft.id}@${expiresAt}:${stage}`;
    if (announcedDeadline !== key) {
      announcedDeadline = key;
      urgentLive.textContent = text;
    }
    return [standing, warning];
  }

  // Wakes the review when its warning is due, and re-reads it at its deadline
  // in case the background's notice is late. The timer never runs longer than
  // DEADLINE_RECHECK_MS, since timers stall while the computer sleeps.
  function scheduleDeadline(): void {
    if (deadlineTimer !== undefined) { clearTimeout(deadlineTimer); deadlineTimer = undefined; }
    if (state.phase !== 'reviewing' || !alive) return;
    const now = Date.now();
    const next = [Date.parse(state.warningAt), Date.parse(state.expiresAt)].filter(at => Number.isFinite(at) && at > now);
    if (next.length === 0) return;
    deadlineTimer = setTimeout(() => {
      deadlineTimer = undefined;
      recheckDeadline();
    }, Math.min(Math.min(...next) - now + 50, DEADLINE_RECHECK_MS));
  }

  // Shows a warning that fell due, or re-reads a review whose deadline passed,
  // after a timer or when the reader returns to this surface (after sleep, say).
  function recheckDeadline(): void {
    if (!alive || state.phase !== 'reviewing') return;
    const now = Date.now();
    if (now >= Date.parse(state.expiresAt)) void refresh();
    else if (deadlineStage(now) !== renderedDeadline) update();
    else scheduleDeadline();
  }

  function describedBy(element: Element, add: string | undefined, remove?: string): void {
    const ids = (element.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(id => id && id !== remove);
    if (add && !ids.includes(add)) ids.push(add);
    if (ids.length > 0) element.setAttribute('aria-describedby', ids.join(' '));
    else element.removeAttribute('aria-describedby');
  }

  // The error shows below the first rendered control it names, below that
  // control's row of buttons, or below the heading, and describes that control
  // (or the fields of the section it names, or the heading) for screen readers.
  function placeError(): void {
    view.querySelector('#journey-error')?.remove();
    for (const described of view.querySelectorAll('[aria-describedby~="journey-error"]')) describedBy(described, undefined, 'journey-error');
    if (!error) return;
    const shown = node('p', error, 'journey-error');
    shown.id = 'journey-error';
    let anchor: Element | null = null;
    for (const at of errorAt) {
      const escaped = CSS.escape(at);
      anchor = view.querySelector(`[data-focus-id="${escaped}"], [data-error-slot="${escaped}"]`);
      if (anchor) break;
    }
    anchor ??= view.querySelector('[data-focus-id="journey-heading"]');
    const controls = anchor?.hasAttribute('data-error-slot') ? Array.from(anchor.querySelectorAll('[data-focus-id]')) : anchor ? [anchor] : [];
    for (const control of controls) describedBy(control, shown.id);
    anchor = anchor ? anchor.closest(ACTION_ROWS) ?? anchor : null;
    if (anchor) anchor.after(shown);
    else view.append(shown);
  }

  function render() {
    if (!alive) return;
    const activeElement = scopeActiveElement();
    const inView = document.hasFocus() && activeElement instanceof HTMLElement && view.contains(activeElement);
    const focusId = inView ? activeElement.getAttribute('data-focus-id') : null;
    const selection = activeElement instanceof HTMLTextAreaElement && inView
      ? [activeElement.selectionStart, activeElement.selectionEnd] as const
      : activeElement instanceof HTMLInputElement && activeElement.type === 'text' && inView
        ? [activeElement.selectionStart ?? 0, activeElement.selectionEnd ?? 0] as const
        : null;
    const oldFocus = inView ? activeElement.textContent : null;
    const phaseChanged = renderedPhase !== undefined && renderedPhase !== state.phase;
    renderedPhase = state.phase;
    renderedKey = viewKey(state);
    renderedReview = state.phase === 'reviewing' ? reviewOf(state) : undefined;
    renderedDeadline = 'none';
    if (state.phase !== 'reviewing' && (announcedNotice || announcedDeadline)) {
      announcedNotice = '';
      announcedDeadline = '';
      politeLive.textContent = '';
      urgentLive.textContent = '';
    }
    rendering = true;
    try { view.replaceChildren(); } finally { rendering = false; }
    renderedSaved = false;
    view.append(node('p', 'anmerko', 'journey-brand'));
    if (state.phase === 'idle') {
      view.append(heading('Record a journey'));
      if (expiredNotice) {
        const expired = node('p', expiredNotice, 'journey-notice journey-notice-error');
        expired.tabIndex = -1;
        expired.setAttribute('data-focus-id', 'journey-expired');
        view.append(expired);
      }
      view.append(node('p', 'Record clicks and screenshots on the website you start from. Stop whenever you are ready to review.', 'journey-help'));
      view.append(node('p', 'Screenshots and full URLs can contain personal information, even when entered values are off. Review and remove sensitive details before sharing.', 'journey-notice'));
      if (client.pageLoadsEndJourney) view.append(node('p', PAGE_LOAD_NOTICE, 'journey-notice'));
      if (client.canStart?.() !== false) {
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
      }
      view.append(renderStart());
      const saved = renderSavedList();
      if (saved) view.append(saved);
    } else if (state.phase === 'saved') {
      const journeyId = state.journeyId;
      const entry = savedJourneys?.find(item => item.journeyId === journeyId);
      view.append(heading('Journey saved'));
      view.append(node('p', entry
        ? `“${savedJourneyTitle(entry)}” is saved. Reopen, share, or delete it any time from Saved journeys.`
        : 'Your journey is saved. Reopen, share, or delete it any time from Saved journeys.', 'journey-help'));
      const sharing = renderExport({ journeyId, revision: state.revision }, true, true);
      if (sharing) view.append(sharing);
      const buttons = node('div', undefined, 'journey-actions');
      // A surface that cannot start again closes the confirmation instead.
      const next = client.canStart?.() === false ? 'Done' : 'Record another journey';
      buttons.append(action(next, () => client.discard({ phase: 'saved', journeyId }), 'secondary', false, 'journey-record-another'));
      view.append(buttons);
    } else if (state.phase === 'starting' || state.phase === 'recording') {
      const recording = state.phase === 'recording';
      view.append(heading(recording ? 'Recording journey' : 'Taking the first screenshot…'));
      const status = node('p', recording ? `${count(state.draft.steps.length, 'step')} recorded. Continue in the original tab.` : 'Recording begins after the first screenshot succeeds.', 'journey-help');
      status.setAttribute('role', 'status');
      view.append(status, action(recording ? 'Stop journey' : 'Cancel start', () => client.stop(), 'primary', true, 'journey-stop'));
    } else if (state.phase === 'reviewing') {
      const draft = state.draft;
      view.append(heading('Review journey'));
      view.append(node('p', `${count(draft.steps.length, 'retained step')} · Entered values: ${draft.includeEnteredValues ? 'On' : 'Off'}`, 'journey-help'));
      // The stop notice announces first, so a due deadline warning is not cleared by it.
      const notice = announceStop(draft);
      view.append(...renderDeadline(draft, Date.parse(state.expiresAt)));
      if (notice) view.append(notice);
      const limitations = renderLimitations(draft);
      if (limitations) view.append(limitations);
      view.append(renderSummaries(draft));
      const sharedSteps = new Map<string, number[]>();
      for (const step of draft.steps) {
        if (step.image.status === 'retained') sharedSteps.set(step.image.imageId, [...(sharedSteps.get(step.image.imageId) ?? []), step.seq]);
      }
      const list = node('ol', undefined, 'journey-steps');
      for (const step of draft.steps) list.append(renderStep(step, draft, sharedSteps));
      view.append(list, renderSave(draft));
      const room = makingRoom ? renderSavedList(draft) : null;
      if (room) view.append(room);
      renderedSaved = draftIsSaved(draft);
      const mutating = reviewMutating();
      const sharing = renderExport({ journeyId: draft.id, revision: draft.revision }, renderedSaved && !mutating, false, mutating);
      if (sharing) view.append(sharing);
      view.append(renderDiscard(draft));
    } else {
      view.append(heading('Saving journey'));
      const saving = node('p', 'Saving your reviewed journey…', 'journey-help');
      saving.setAttribute('role', 'status');
      view.append(saving);
    }
    // The storage reset follows the load error that explains it.
    if (loadFailed) view.querySelector('[data-focus-id="journey-heading"]')
      ?.after(action('Reset journey storage', () => client.discard(), 'secondary', false, 'journey-reset-storage'));
    placeError();
    // Each failure is announced once, a repeated message included; re-renders
    // that keep an error in view leave the alert region alone.
    if (error && announcedFailure !== failureCount) {
      announcedFailure = failureCount;
      announceAlert('action', error);
    } else if (!error) silenceAlert('action');
    if (startError && !startErrorSeen && state.phase === 'idle' && document.visibilityState === 'visible') {
      startErrorSeen = true;
      announceAlert('start', startError);
    }
    let restored = false;
    if (focusId) {
      const restore = view.querySelector(`[data-focus-id="${CSS.escape(focusId)}"]`);
      if (restore instanceof HTMLElement && !restore.matches(':disabled')) {
        restore.focus();
        restored = true;
        if ((restore instanceof HTMLTextAreaElement || (restore instanceof HTMLInputElement && restore.type === 'text')) && selection) {
          try { restore.setSelectionRange(selection[0], selection[1]); } catch { /* Keep focus without caret restore. */ }
        }
      } else if (restore instanceof HTMLElement) {
        // A busy control cannot hold focus; reclaim it once the change settles.
        pendingFocus = [focusId, ...(pendingFocus ?? []).filter(id => id !== focusId)];
      }
    } else if (oldFocus) {
      const button = Array.from(view.querySelectorAll('button')).find(candidate => candidate.textContent === oldFocus && !candidate.disabled);
      if (button) { button.focus(); restored = true; }
    }
    if (phaseChanged) {
      // A new view announces itself through its heading unless focus survived.
      // Focus waits for recording to begin so it cannot disturb the first screenshot.
      pendingFocus = null;
      if (!restored && state.phase !== 'starting' && (inView || focusLost())) focusControl('journey-expired', 'journey-heading');
    } else if (pendingFocus !== null && !settling()) {
      // Reclaim only focus the change dropped; a reader who moved on keeps their place.
      if (!restored && focusLost()) focusControl(...pendingFocus);
      pendingFocus = null;
    }
    // A reader whose focus did not land on the expiry notice hears it instead.
    if (expiredNotice && !expiredAnnounced) {
      expiredAnnounced = true;
      if (scopeActiveElement()?.getAttribute('data-focus-id') !== 'journey-expired') politeLive.textContent = expiredNotice;
    }
    scheduleDeadline();
  }

  // Returning to this surface clears a start error the reader already saw here.
  // One that arrived while the surface was hidden is shown and announced now.
  // A review's deadline is read again too: the computer may have slept.
  const reactivated = () => {
    if (document.visibilityState !== 'visible' || !alive) return;
    recheckDeadline();
    if (!startError) return;
    if (startErrorSeen) { clearStartError(); void refresh(); return; }
    render();
    focusStartError();
  };
  const refocused = () => {
    recheckDeadline();
    focusStartError();
  };
  document.addEventListener('visibilitychange', reactivated);
  window.addEventListener('focus', refocused);
  root.addEventListener('pointerdown', pressStarted, true);
  root.addEventListener('keydown', pressStarted, true);
  root.addEventListener('click', pressClicked, true);
  window.addEventListener('pointerup', pressReleased, true);
  window.addEventListener('keyup', pressReleased, true);
  window.addEventListener('pointercancel', endPress, true);
  window.addEventListener('blur', endPress);
  const unsubscribe = client.subscribe(() => { void refresh(); });
  void refresh();
  return () => {
    alive = false; ++version;
    if (summaryTimer !== undefined) clearTimeout(summaryTimer);
    if (pressTimer !== undefined) clearTimeout(pressTimer);
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    if (alertTimer !== undefined) clearTimeout(alertTimer);
    imageEditor?.abort.abort();
    imageViewer?.abort.abort();
    document.removeEventListener('visibilitychange', reactivated);
    window.removeEventListener('focus', refocused);
    root.removeEventListener('pointerdown', pressStarted, true);
    root.removeEventListener('keydown', pressStarted, true);
    root.removeEventListener('click', pressClicked, true);
    window.removeEventListener('pointerup', pressReleased, true);
    window.removeEventListener('keyup', pressReleased, true);
    window.removeEventListener('pointercancel', endPress, true);
    window.removeEventListener('blur', endPress);
    unsubscribe(); view.remove(); live.remove(); imageDialog.remove(); viewerDialog.remove();
  };
}
