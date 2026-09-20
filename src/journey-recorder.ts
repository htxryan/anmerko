import { createUuid } from './uuid';
import { stripUrlCredentials, type JourneyClickEvent, type JourneyEventBatchV1 } from './journey-events';

export type JourneyRecorderOptions = {
  sessionId: string;
  epoch: number;
  documentToken: string;
  startedAt: string;
  onBatch(batch: JourneyEventBatchV1): void | Promise<void>;
  ignore?: (target: Element, event: MouseEvent) => boolean;
};

const EDITABLE_TAGS = new Set(['input', 'select', 'textarea']);
const PRIVATE_TEXT_TAGS = new Set(['script', 'style', 'noscript']);
const UI_HOSTS = new Set(['anmerko-overlay', 'anmerko-journey-strip']);
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
  if (explicit && /^[a-z][a-z-]{0,39}$/.test(explicit)) return explicit;
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
  const chunks: string[] = [];
  const visit = (node: Node) => {
    if (node instanceof Text) { chunks.push(node.data); return; }
    if (!(node instanceof Element) && node !== element) return;
    if (node instanceof Element && node !== element) {
      if (isEditableElement(node) || PRIVATE_TEXT_TAGS.has(node.localName)
        || node.hasAttribute('hidden') || node.getAttribute('aria-hidden') === 'true') return;
    }
    for (const child of node.childNodes) visit(child);
  };
  visit(element);
  const text = chunks.join(' ').replace(/\s+/g, ' ').trim();
  return Array.from(text || genericLabel(element)).slice(0, 120).join('');
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
  while (current) {
    segments.unshift(selectorSegment(current));
    current = parentAcrossShadow(current);
  }
  return segments.slice(-12);
}

function eventTarget(event: MouseEvent): Element | null {
  return event.composedPath().find(candidate => candidate instanceof Element) as Element | undefined ?? null;
}

function ignored(event: MouseEvent, target: Element, custom?: JourneyRecorderOptions['ignore']): boolean {
  if (event.composedPath().some(candidate => candidate instanceof Element && UI_HOSTS.has(candidate.localName))) return true;
  try { return custom?.(target, event) ?? false; } catch { return true; }
}

export function attachJourneyRecorder(options: JourneyRecorderOptions): () => void {
  if (window.top !== window) return () => {};
  const startedAt = Date.parse(options.startedAt);
  let localCounter = 0;
  let disposed = false;
  const click = (event: MouseEvent) => {
    if (disposed || !event.isTrusted || event.button !== 0) return;
    const target = eventTarget(event);
    if (!target || ignored(event, target, options.ignore)) return;
    const now = new Date();
    const role = roleFor(target);
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
        viewport: { width: innerWidth, height: innerHeight },
        scroll: { x: scrollX, y: scrollY },
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
      events: [input],
    };
    try {
      const delivered = options.onBatch(batch);
      if (delivered && typeof delivered.catch === 'function') void delivered.catch(() => {});
    } catch { /* Recording must remain passive when its consumer rejects a batch. */ }
  };
  document.addEventListener('click', click, { capture: true, passive: true });
  return () => {
    if (disposed) return;
    disposed = true;
    document.removeEventListener('click', click, true);
  };
}
