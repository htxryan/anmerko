import { createUuid } from './uuid';
import { stripUrlCredentials, type JourneyClickEvent, type JourneyEventBatchV1, type JourneyFieldChangeEvent } from './journey-events';

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
const EDITABLE_SELECTOR = 'input, select, textarea, [contenteditable]:not([contenteditable="false"])';
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
const ROLE_BY_TAG: Record<string, string> = {
  a: 'link', button: 'button', select: 'combobox', textarea: 'textbox',
};

function parentAcrossShadow(element: Element): Element | null {
  if (element.parentElement) return element.parentElement;
  const root = element.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

function isEditableElement(element: Element): boolean {
  return EDITABLE_TAGS.has(element.localName)
    || (element.hasAttribute('contenteditable') && element.getAttribute('contenteditable') !== 'false');
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
    if (['button', 'reset', 'submit'].includes(type)) return 'button';
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'range') return 'slider';
    return 'textbox';
  }
  if (element.hasAttribute('contenteditable') && element.getAttribute('contenteditable') !== 'false') return 'textbox';
  return ROLE_BY_TAG[element.localName];
}

function genericLabel(element: Element): string {
  if (element.localName === 'input') {
    const type = (element.getAttribute('type') || 'text').toLowerCase();
    if (['button', 'reset', 'submit'].includes(type)) return 'button';
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio button';
    if (type === 'range') return 'range field';
    return 'text field';
  }
  if (element.localName === 'select') return 'select field';
  if (element.localName === 'textarea' || element.hasAttribute('contenteditable')) return 'text field';
  return element.localName.replace(/-/g, ' ');
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

function selectorSegment(element: Element): string {
  const tag = element.localName;
  const parent = element.parentElement ?? (element.getRootNode() instanceof ShadowRoot ? element.getRootNode() as ShadowRoot : null);
  if (!parent) return tag;
  const siblings = Array.from(parent.children).filter(candidate => candidate.localName === tag);
  return siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(element) + 1})` : tag;
}

function structuralSelector(element: Element): string[] {
  const segments: string[] = [];
  let current: Element | null = element;
  while (current && segments.length < 12) {
    segments.push(selectorSegment(current));
    current = parentAcrossShadow(current);
  }
  return segments.reverse();
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

function ignored(event: MouseEvent, target: Element, custom?: JourneyRecorderOptions['ignore']): boolean {
  if (event.composedPath().some(candidate => candidate instanceof Element && UI_HOSTS.has(candidate.localName))) return true;
  try { return custom?.(target, event) ?? false; } catch { return true; }
}

export interface JourneyRecorder {
  dispose(): void;
  flushFieldCommits(): void;
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
  const currentUrl = (): string | undefined => {
    try { return stripUrlCredentials(location.href); }
    catch { return undefined; }
  };
  const drainFieldCommits = (): JourneyFieldChangeEvent[] => {
    const here = currentUrl();
    if (here === undefined) return [];
    let pending: JourneyFieldChangeEvent[] = [];
    try {
      pending = options.drainFieldCommits?.() ?? [];
    } catch { return []; }
    return pending.filter(commit => {
      try { return stripUrlCredentials(commit.sourceUrl) === here; }
      catch { return false; }
    });
  };
  const flushFieldCommits = () => {
    if (disposed) return;
    const pending = drainFieldCommits();
    if (pending.length === 0) return;
    postBatch({
      schemaVersion: 1,
      sessionId: options.sessionId,
      epoch: options.epoch,
      documentToken: options.documentToken,
      localCounter: ++localCounter,
      events: pending,
    });
  };
  const click = (event: MouseEvent) => {
    if (disposed || !event.isTrusted || event.button !== 0) return;
    const target = eventTarget(event);
    if (!target || ignored(event, target, options.ignore)) return;
    const now = new Date();
    const role = roleFor(target);
    const viewport = visibleViewport();
    const scroll = visibleScroll();
    const input: JourneyClickEvent = {
      kind: 'click',
      id: createUuid(),
      observedAt: now.toISOString(),
      elapsedMs: Number.isFinite(startedAt) ? Math.max(0, now.getTime() - startedAt) : 0,
      sourceUrl: stripUrlCredentials(location.href),
      target: {
        tag: target.localName,
        ...(role ? { role } : {}),
        selectorPath: structuralSelector(target),
        label: safeText(target),
        editable: !!editableAncestor(target),
        viewport,
        scroll,
        ...(event.detail === 0 ? {} : { point: { x: event.clientX, y: event.clientY } }),
      },
      image: { status: 'pending', captureId: createUuid() },
    };
    const batch: JourneyEventBatchV1 = {
      schemaVersion: 1,
      sessionId: options.sessionId,
      epoch: options.epoch,
      documentToken: options.documentToken,
      localCounter: ++localCounter,
      events: [...drainFieldCommits(), input],
    };
    postBatch(batch);
  };
  document.addEventListener('click', click, { capture: true, passive: true });
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    document.removeEventListener('click', click, true);
  };
  return { dispose, flushFieldCommits };
}
