import { createUuid } from './uuid';
import {
  stripUrlCredentials, type JourneyClickEvent, type JourneyEventBatchV1, type JourneyFieldChangeEvent, type JourneyInputEvent,
} from './journey-events';
import { JOURNEY_LIMITS } from './journey-limits';
import { journeySelectorPath, journeyTagName, parentAcrossShadow } from './journey-selector';

export type JourneyRecorderOptions = {
  sessionId: string;
  epoch: number;
  documentToken: string;
  startedAt: string;
  onBatch(batch: JourneyEventBatchV1): void | Promise<void>;
  drainFieldCommits?: () => JourneyFieldChangeEvent[];
  ignore?: (target: Element, event: MouseEvent) => boolean;
};

const EDITABLE_TAGS = new Set(['input', 'select', 'textarea']);
const LABEL_CHARACTERS = JOURNEY_LIMITS.maxTargetTextCharacters;
// Text boxes a page renders itself hold typed text just like native fields.
const TEXT_BOX_ROLES = new Set(['textbox', 'searchbox']);
const EDITABLE_SELECTOR = 'input, select, textarea, [contenteditable]:not([contenteditable="false"]), [role~="textbox" i], [role~="searchbox" i]';
const PRIVATE_TEXT_TAGS = new Set(['script', 'style', 'noscript']);
const UI_HOSTS = new Set(['anmerko-overlay', 'anmerko-journey-strip']);
const SEMANTIC_ROLES = new Set([
  'alert', 'alertdialog', 'application', 'article', 'banner', 'button', 'cell', 'checkbox', 'columnheader',
  'combobox', 'complementary', 'contentinfo', 'definition', 'dialog', 'document', 'feed', 'figure', 'form',
  'grid', 'gridcell', 'group', 'heading', 'img', 'link', 'list', 'listbox', 'listitem', 'log', 'main', 'marquee',
  'math', 'menu', 'menubar', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'meter', 'navigation', 'none',
  'note', 'option', 'paragraph', 'presentation', 'progressbar', 'radio', 'radiogroup', 'region', 'row', 'rowgroup',
  'rowheader', 'scrollbar', 'search', 'searchbox', 'separator', 'slider', 'spinbutton', 'status', 'switch', 'tab',
  'table', 'tablist', 'tabpanel', 'term', 'textbox', 'timer', 'toolbar', 'tooltip', 'tree', 'treegrid', 'treeitem',
]);
const ROLE_BY_TAG = new Map([['a', 'link'], ['button', 'button'], ['select', 'combobox'], ['textarea', 'textbox']]);
// Input types that act when clicked rather than take typed text: an image
// input is a submit button drawn as a picture.
const BUTTON_INPUT_TYPES = new Set(['button', 'image', 'reset', 'submit']);

// `isContentEditable` also covers design-mode documents, where every element
// shows what the user typed.
function isEditableElement(element: Element): boolean {
  return EDITABLE_TAGS.has(element.localName)
    || (element.hasAttribute('contenteditable') && element.getAttribute('contenteditable') !== 'false')
    || (element instanceof HTMLElement && element.isContentEditable)
    || (element.getAttribute('role') ?? '').toLowerCase().split(/\s+/).some(role => TEXT_BOX_ROLES.has(role));
}

function editableAncestor(element: Element): Element | null {
  let current: Element | null = element;
  while (current) {
    if (isEditableElement(current)) return current;
    current = parentAcrossShadow(current);
  }
  return null;
}

function roleFor(element: Element): string | undefined {
  const explicit = element.getAttribute('role')?.split(/\s+/)[0].toLowerCase();
  if (explicit && SEMANTIC_ROLES.has(explicit)) return explicit;
  if (element.localName === 'a' && !element.hasAttribute('href')) return undefined;
  if (element.localName === 'input') {
    const type = (element.getAttribute('type') || 'text').toLowerCase();
    if (BUTTON_INPUT_TYPES.has(type)) return 'button';
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'range') return 'slider';
    return 'textbox';
  }
  if (element.hasAttribute('contenteditable') && element.getAttribute('contenteditable') !== 'false') return 'textbox';
  return ROLE_BY_TAG.get(element.localName);
}

function genericLabel(element: Element): string {
  if (element.localName === 'input') {
    const type = (element.getAttribute('type') || 'text').toLowerCase();
    if (BUTTON_INPUT_TYPES.has(type)) return 'button';
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio button';
    if (type === 'range') return 'range field';
    return 'text field';
  }
  if (element.localName === 'select') return 'select field';
  if (isEditableElement(element)) return 'text field';
  // A custom element's name can be longer than any label may be.
  return Array.from(element.localName.replace(/-/g, ' ')).slice(0, LABEL_CHARACTERS).join('').trim() || 'element';
}

function safeText(element: Element): string {
  const editable = editableAncestor(element);
  if (editable) return genericLabel(editable);
  if (element.querySelector(EDITABLE_SELECTOR)) return genericLabel(element);
  const characters: string[] = [];
  let nodes = 0;
  let pendingSpace = false;
  const append = (text: string) => {
    for (const character of text) {
      if (/\s/u.test(character)) { pendingSpace = characters.length > 0; continue; }
      if (pendingSpace && characters.length < 120) characters.push(' ');
      pendingSpace = false;
      if (characters.length < 120) characters.push(character);
      if (characters.length === 120) return;
    }
  };
  const visit = (node: Node) => {
    if (++nodes > 256 || characters.length === 120) return;
    if (node instanceof Text) { append(node.data); return; }
    if (!(node instanceof Element) && node !== element) return;
    if (node instanceof Element && node !== element) {
      if (isEditableElement(node) || PRIVATE_TEXT_TAGS.has(node.localName)
        || node.hasAttribute('hidden') || node.getAttribute('aria-hidden') === 'true') return;
    }
    for (let child = node.firstChild; child && nodes < 256 && characters.length < 120; child = child.nextSibling) visit(child);
  };
  visit(element);
  return characters.join('') || genericLabel(element);
}

function eventTarget(event: MouseEvent): Element | null {
  return event.composedPath().find(candidate => candidate instanceof Element) as Element | undefined ?? null;
}

function visibleViewport(): { width: number; height: number } {
  const visual = window.visualViewport;
  return { width: Math.round(visual?.width ?? innerWidth), height: Math.round(visual?.height ?? innerHeight) };
}

function visibleScroll(): { x: number; y: number } {
  const visual = window.visualViewport;
  return { x: scrollX + (visual?.offsetLeft ?? 0), y: scrollY + (visual?.offsetTop ?? 0) };
}

// Mouse coordinates are relative to the layout viewport, but the recorded
// viewport is the visible one: pinch zoom, or a soft keyboard raised by the
// last field, shrinks and pans it. A layout-relative point below a panned
// visible viewport failed validation and the background dropped the whole
// click batch, so measure from the visible corner, matching the screenshot.
// A point that still falls outside (edge rounding) is omitted, not fatal.
function visiblePoint(event: MouseEvent, viewport: { width: number; height: number }): { x: number; y: number } | undefined {
  const visual = window.visualViewport;
  const x = event.clientX - (visual?.offsetLeft ?? 0);
  const y = event.clientY - (visual?.offsetTop ?? 0);
  return x >= 0 && y >= 0 && x <= viewport.width && y <= viewport.height ? { x, y } : undefined;
}

function ignored(event: MouseEvent, target: Element, custom?: JourneyRecorderOptions['ignore']): boolean {
  if (event.composedPath().some(candidate => candidate instanceof Element && UI_HOSTS.has(candidate.localName))) return true;
  try { return custom?.(target, event) ?? false; } catch { return true; }
}

export interface JourneyRecorder {
  dispose(): void;
  flushFieldCommits(): void;
}

const encoder = new TextEncoder();
function jsonBytes(value: unknown): number { return encoder.encode(JSON.stringify(value)).byteLength }

// A value too large to travel even in a batch of its own keeps what fits,
// marked truncated; the journey could not have kept more of it anyway.
function fitEventAlone(event: JourneyInputEvent, room: number): JourneyInputEvent {
  let fitted = event;
  let overflow = jsonBytes(fitted) - room;
  while (overflow > 0 && fitted.kind === 'field-change') {
    const value = fitted.enteredValue;
    if (value.kind === 'text' && value.value) {
      // Every character costs at least one byte, so this cut always suffices.
      const characters = Array.from(value.value);
      const text = characters.slice(0, Math.max(0, characters.length - overflow)).join('');
      fitted = { ...fitted, enteredValue: { ...value, value: text, truncated: true } };
    } else if (value.kind === 'selection' && value.values.length > 0) {
      fitted = { ...fitted, enteredValue: { ...value, values: value.values.slice(0, -1), truncated: true } };
    } else break;
    overflow = jsonBytes(fitted) - room;
  }
  return fitted;
}

export function attachJourneyRecorder(options: JourneyRecorderOptions): JourneyRecorder {
  if (window.top !== window) return { dispose: () => {}, flushFieldCommits: () => {} };
  const startedAt = Date.parse(options.startedAt);
  let localCounter = 0;
  let disposed = false;
  const postBatch = (batch: JourneyEventBatchV1) => {
    try {
      const delivered = options.onBatch(batch);
      if (delivered && typeof delivered.catch === 'function') void delivered.catch(() => {});
    } catch { /* Recording must remain passive when its consumer rejects a batch. */ }
  };
  // A value entered before an in-page route change keeps the URL it was
  // entered on: it travels ahead of the route's later events, and the
  // background places it before the navigation. Only a commit without a
  // usable URL, which the background would refuse along with its whole
  // batch, is left out.
  const drainFieldCommits = (): JourneyFieldChangeEvent[] => {
    let pending: JourneyFieldChangeEvent[] = [];
    try {
      pending = options.drainFieldCommits?.() ?? [];
    } catch { return []; }
    return pending.filter(commit => {
      try { return stripUrlCredentials(commit.sourceUrl) === commit.sourceUrl; }
      catch { return false; }
    });
  };
  const batchOf = (events: JourneyInputEvent[], counter: number): JourneyEventBatchV1 => ({
    schemaVersion: 1,
    sessionId: options.sessionId,
    epoch: options.epoch,
    documentToken: options.documentToken,
    localCounter: counter,
    events,
  });
  // The background refuses a batch past its payload or event-count limit
  // whole, click included. A long form's commits therefore travel in order,
  // in as many batches as they need, and the click that carried them last.
  // A batch also keeps to one URL: events from before a route change go in
  // their own batch, which the background can still place before it.
  const postEvents = (events: JourneyInputEvent[]) => {
    const envelope = jsonBytes(batchOf([], Number.MAX_SAFE_INTEGER));
    const room = JOURNEY_LIMITS.maxEventPayloadBytes - envelope;
    let chunk: JourneyInputEvent[] = [];
    let used = 0;
    for (const event of events) {
      const fitted = fitEventAlone(event, room);
      const size = jsonBytes(fitted);
      // Events after the first are joined by a comma inside the array.
      if (chunk.length > 0 && (used + 1 + size > room || chunk.length >= JOURNEY_LIMITS.maxSteps
        || fitted.sourceUrl !== chunk[0].sourceUrl)) {
        postBatch(batchOf(chunk, ++localCounter));
        chunk = [];
        used = 0;
      }
      used += (chunk.length > 0 ? 1 : 0) + size;
      chunk.push(fitted);
    }
    if (chunk.length > 0) postBatch(batchOf(chunk, ++localCounter));
  };
  const flushFieldCommits = () => {
    if (disposed) return;
    const pending = drainFieldCommits();
    if (pending.length === 0) return;
    postEvents(pending);
  };
  const click = (event: MouseEvent) => {
    if (disposed || !event.isTrusted || event.button !== 0) return;
    const target = eventTarget(event);
    if (!target || ignored(event, target, options.ignore)) return;
    const now = new Date();
    const role = roleFor(target);
    const viewport = visibleViewport();
    const scroll = visibleScroll();
    const point = event.detail === 0 ? undefined : visiblePoint(event, viewport);
    const input: JourneyClickEvent = {
      kind: 'click',
      id: createUuid(),
      observedAt: now.toISOString(),
      elapsedMs: Number.isFinite(startedAt) ? Math.max(0, now.getTime() - startedAt) : 0,
      sourceUrl: stripUrlCredentials(location.href),
      target: {
        tag: journeyTagName(target),
        ...(role ? { role } : {}),
        selectorPath: journeySelectorPath(target),
        label: safeText(target),
        editable: !!editableAncestor(target),
        viewport,
        scroll,
        ...(point ? { point } : {}),
      },
      image: { status: 'pending', captureId: createUuid() },
    };
    postEvents([...drainFieldCommits(), input]);
  };
  // Values committed before the page moves on are sent before it does, as
  // their own batch, rather than with the next click. A form submitted with
  // Enter in a single-page app changes the route in its submit handler, which
  // runs after this capture listener, while the URL is still the form's; the
  // field module, attached first, has already committed that form's values.
  // Where the Navigation API exists, its navigate event likewise precedes any
  // other change of URL: a route change, a traversal, or a page load. Without
  // it, a traversal or fragment change is seen just after the URL changed.
  const beforeNavigate = (event: Event) => {
    const destination = (event as Event & { destination?: { url?: unknown } }).destination?.url;
    if (typeof destination === 'string' && destination === location.href) return;
    flushFieldCommits();
  };
  const navigation = (window as Window & { navigation?: EventTarget }).navigation;
  document.addEventListener('click', click, { capture: true, passive: true });
  document.addEventListener('submit', flushFieldCommits, true);
  navigation?.addEventListener?.('navigate', beforeNavigate);
  window.addEventListener('popstate', flushFieldCommits);
  window.addEventListener('hashchange', flushFieldCommits);
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    document.removeEventListener('click', click, true);
    document.removeEventListener('submit', flushFieldCommits, true);
    navigation?.removeEventListener?.('navigate', beforeNavigate);
    window.removeEventListener('popstate', flushFieldCommits);
    window.removeEventListener('hashchange', flushFieldCommits);
  };
  return { dispose, flushFieldCommits };
}
