import type { Store } from './runtime';
import { normalizeComponentContext, type ComponentContextV1 } from './component-context';

export interface ElementContext {
  selectorPath: string[];
  hierarchy?: string[];
  tag: string;
  text: string;
  label: string;
  viewport: { width: number; height: number };
  componentContext?: ComponentContextV1;
}

export interface ScreenshotContext {
  dataUrl: string;
  width: number;
  height: number;
  region: { x: number; y: number; width: number; height: number };
  viewport: { width: number; height: number };
  scroll: { x: number; y: number };
}

interface NoteBase {
  id: string;
  pageUrl: string;
  pageTitle: string;
  comment: string;
  createdAt: string;
  updatedAt: string;
}
export type Note = NoteBase & (
  { element: ElementContext; screenshot?: never; kind?: never }
  | { element?: never; screenshot: ScreenshotContext; kind?: never }
  | { kind: 'page'; element?: never; screenshot?: never }
);

export const STORAGE_PREFIX = 'anmerko:note:v1:';
export const shorten = (text: string, max = 240) => text.replace(/\s+/g, ' ').trim().slice(0, max);

export function pageUrl(url = location.href): string {
  const parsed = new URL(url);
  parsed.username = '';
  parsed.password = '';
  return parsed.href;
}

function pageIdentity(url: string): string {
  try {
    const parsed = new URL(pageUrl(url));
    // Google's homepage changes this cache-busting token on refresh. Match
    // existing saved URLs too, without rewriting their records or losing the
    // original URL in exports. Other query parameters and hash routes matter.
    if (['google.com', 'www.google.com'].includes(parsed.hostname) && parsed.pathname === '/') {
      parsed.searchParams.delete('zx');
    }
    return parsed.href;
  } catch { return url; }
}

export function samePage(first: string, second: string): boolean {
  return pageIdentity(first) === pageIdentity(second);
}

function selectorWithinRoot(element: Element): string {
  const root = element.getRootNode() as Document | ShadowRoot;
  const unique = (selector: string) => root.querySelectorAll(selector).length === 1;
  const segments: string[] = [];
  let node: Element | null = element;
  while (node) {
    if (node.id && unique(`#${CSS.escape(node.id)}`)) {
      segments.unshift(`#${CSS.escape(node.id)}`);
      break;
    }
    const testId = node.getAttribute('data-testid');
    if (testId) {
      const selector = `[data-testid="${CSS.escape(testId)}"]`;
      if (unique(selector)) {
        segments.unshift(selector);
        break;
      }
    }
    const tag = CSS.escape(node.localName);
    const parent = node.parentNode as ParentNode | null;
    const siblings = parent ? Array.from(parent.children).filter(s => s.localName === node!.localName) : [];
    segments.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(node) + 1})` : tag);
    node = node.parentElement;
  }
  return segments.join(' > ');
}

export function selectorPath(element: Element): string[] {
  const path = [selectorWithinRoot(element)];
  let root = element.getRootNode();
  while (root instanceof ShadowRoot) {
    path.unshift(selectorWithinRoot(root.host));
    root = root.host.getRootNode();
  }
  return path;
}

const PRIVATE_FIELDS = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), script, style, noscript, [hidden], [aria-hidden="true"]';

export function elementText(element: Element): string {
  if (element.closest(PRIVATE_FIELDS)) return '';
  const clone = element.cloneNode(true) as Element;
  clone.querySelectorAll(PRIVATE_FIELDS).forEach(node => node.remove());
  clone.querySelectorAll('br').forEach(node => node.replaceWith(' '));
  return shorten(clone.textContent || '');
}

export function captureElement(element: Element): ElementContext {
  return {
    selectorPath: selectorPath(element),
    hierarchy: elementHierarchy(element),
    tag: element.localName,
    text: elementText(element),
    label: shorten(element.getAttribute('aria-label') || element.getAttribute('alt') || '', 120),
    viewport: { width: innerWidth, height: innerHeight },
  };
}

// Display the ancestry independently of the shortest selector used to locate it.
// IDs and field values are unnecessary for recognizing the selected element.
export function elementHierarchy(element: Element): string[] {
  const path: string[] = [];
  let node: Element | null = element;
  while (node) {
    const parent = node.parentNode as ParentNode | null;
    const siblings = parent ? Array.from(parent.children).filter(sibling => sibling.localName === node!.localName) : [];
    path.unshift(siblings.length > 1 ? `${node.localName}:nth-of-type(${siblings.indexOf(node) + 1})` : node.localName);
    const root = node.getRootNode();
    node = node.parentElement;
    if (!node && root instanceof ShadowRoot) { path.unshift('#shadow-root'); node = root.host; }
  }
  return path;
}

export function resolveElement(context: ElementContext): Element | null {
  let root: Document | ShadowRoot = document;
  let element: Element | null = null;
  try {
    for (let i = 0; i < context.selectorPath.length; i++) {
      element = root.querySelector(context.selectorPath[i]);
      if (!element) return null;
      if (i < context.selectorPath.length - 1) {
        if (!element.shadowRoot) return null;
        root = element.shadowRoot;
      }
    }
  } catch { return null; }
  // Do not silently highlight a different element after a page redesign.
  if (element?.localName !== context.tag || (context.text && elementText(element) !== context.text)) return null;
  return element;
}

function isBaseNote(value: unknown): value is Note {
  try {
    if (!value || typeof value !== 'object') return false;
    const note = value as Note;
    const validBase = typeof note.id === 'string' && typeof note.pageUrl === 'string'
      && typeof note.pageTitle === 'string' && typeof note.comment === 'string'
      && typeof note.createdAt === 'string' && typeof note.updatedAt === 'string';
    if (!validBase) return false;
    if (note.kind !== undefined) return note.kind === 'page' && !('element' in note) && !('screenshot' in note);
    return (note.screenshot ? isScreenshot(note.screenshot) : !!note.element && typeof note.element.tag === 'string'
      && typeof note.element.text === 'string' && typeof note.element.label === 'string'
      && Array.isArray(note.element.selectorPath) && note.element.selectorPath.length > 0
      && note.element.selectorPath.every(s => typeof s === 'string')
      && (note.element.hierarchy === undefined || (Array.isArray(note.element.hierarchy)
        && note.element.hierarchy.every(segment => typeof segment === 'string')))
      && Number.isFinite(note.element.viewport?.width) && Number.isFinite(note.element.viewport?.height));
  } catch { return false; }
}

function ownDataValue(value: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch { return undefined; }
}

function normalizeNote(value: unknown): Note | undefined {
  try {
    if (!isBaseNote(value)) return undefined;
    const base = {
      id: value.id,
      pageUrl: value.pageUrl,
      pageTitle: value.pageTitle,
      comment: value.comment,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
    };
    if (value.kind === 'page') return { ...base, kind: 'page' };
    if (value.screenshot) {
      const { dataUrl, width, height, region, viewport, scroll } = value.screenshot;
      return {
        ...base,
        screenshot: {
          dataUrl, width, height,
          region: { x: region.x, y: region.y, width: region.width, height: region.height },
          viewport: { width: viewport.width, height: viewport.height },
          scroll: { x: scroll.x, y: scroll.y },
        },
      };
    }
    const { selectorPath, hierarchy, tag, text, label, viewport } = value.element;
    const componentContext = normalizeComponentContext(ownDataValue(value.element, 'componentContext'));
    return {
      ...base,
      element: {
        selectorPath: [...selectorPath],
        ...(hierarchy === undefined ? {} : { hierarchy: [...hierarchy] }),
        tag,
        text,
        label,
        viewport: { width: viewport.width, height: viewport.height },
        ...(componentContext ? { componentContext } : {}),
      },
    };
  } catch { return undefined; }
}

export function isNote(value: unknown): value is Note {
  if (!isBaseNote(value)) return false;
  if (!value.element) return true;
  const rawContext = ownDataValue(value.element, 'componentContext');
  return rawContext === undefined || normalizeComponentContext(rawContext) !== undefined;
}

function isScreenshot(image: ScreenshotContext): boolean {
  return typeof image.dataUrl === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(image.dataUrl)
    && image.dataUrl.length <= 2_800_000
    && [image.width, image.height, image.region?.width, image.region?.height, image.viewport?.width, image.viewport?.height].every(n => Number.isFinite(n) && n > 0)
    && [image.region?.x, image.region?.y, image.scroll?.x, image.scroll?.y].every(Number.isFinite);
}

export function screenshotFilename(note: Note): string {
  const id = /^[a-zA-Z0-9_-]{1,80}$/.test(note.id) ? note.id
    : Array.from(new TextEncoder().encode(note.id), byte => byte.toString(16).padStart(2, '0')).join('');
  return `screenshot-${id}.png`;
}

export async function readNotes(store: Store): Promise<Note[]> {
  const records = await store.readAll();
  return Object.entries(records)
    .filter(([key]) => key.startsWith(STORAGE_PREFIX))
    .map(([, value]) => normalizeNote(value))
    .filter((value): value is Note => value !== undefined)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

export async function saveNote(store: Store, note: Note): Promise<void> {
  // A key per comment avoids overwriting unrelated notes from another tab.
  const normalized = normalizeNote(note);
  if (!normalized) throw new TypeError('Invalid note');
  await store.write(STORAGE_PREFIX + normalized.id, normalized);
}

export async function removeNote(store: Store, id: string): Promise<void> {
  await store.remove(STORAGE_PREFIX + id);
}

export const DEFAULT_PROMPT_PREAMBLE = 'Comments collected with anmerko. Page URLs and captured context are listed with each comment.';

export function buildPrompt(notes: Note[], preamble = DEFAULT_PROMPT_PREAMBLE): string {
  notes = notes.map(note => normalizeNote(note)).filter((note): note is Note => note !== undefined);
  const pages = new Map<string, Note[]>();
  notes.forEach(note => {
    const key = pageIdentity(note.pageUrl);
    pages.set(key, [...(pages.get(key) || []), note]);
  });
  const lines = [
    '# Website feedback', '',
    ...(preamble.trim() ? [preamble, ''] : []),
    `${notes.length} comment${notes.length === 1 ? '' : 's'} across ${pages.size} page${pages.size === 1 ? '' : 's'}.`, '',
  ];
  let index = 0;
  let pageIndex = 0;
  for (const pageNotes of pages.values()) {
    lines.push(`## Page ${++pageIndex}`, '',
      `- **Title:** ${inlineCode(pageNotes[0].pageTitle)}`,
      `- **URL:** ${inlineCode(pageNotes[0].pageUrl)}`, '');
    for (const note of pageNotes) {
      lines.push(`### Comment ${++index}`, '', quote(note.comment), '');
      if (note.kind === 'page') {
        lines.push('- **Scope:** Entire page (global comment)', '');
        continue;
      }
      if (note.screenshot) {
        const { region, viewport, scroll, width, height } = note.screenshot;
        lines.push(`- **Screenshot file:** ${inlineCode(screenshotFilename(note))}`,
          `- **Image size:** ${width} × ${height} pixels`,
          `- **Region:** x ${region.x}, y ${region.y}, width ${region.width}, height ${region.height} (CSS pixels within the visible viewport)`,
          `- **Viewport:** ${viewport.width} × ${viewport.height}`,
          `- **Page scroll:** x ${scroll.x}, y ${scroll.y}`, '');
        continue;
      }
      const { element } = note;
      lines.push(
        `- **Element:** ${inlineCode(element.tag)}`,
        element.selectorPath.length === 1
          ? `- **Selector:** ${inlineCode(element.selectorPath[0])}`
          : `- **Selector path:** ${element.selectorPath.map(inlineCode).join(' → shadow root → ')}`,
        ...(element.text ? [`- **Text excerpt:** ${inlineCode(element.text)}`] : []),
        ...(element.label ? [`- **Accessible label:** ${inlineCode(element.label)}`] : []),
        `- **Viewport:** ${element.viewport.width} × ${element.viewport.height}`, '');
    }
  }
  return lines.join('\n');
}

function inlineCode(value: string): string {
  const text = value.replace(/\r\n?|\n/g, ' ');
  if (!text) return '*(empty)*';
  const longest = Math.max(0, ...(text.match(/`+/g) || []).map(run => run.length));
  const delimiter = '`'.repeat(longest + 1);
  // Padding keeps literal boundary backticks and spaces inside the code span.
  const pad = /^`|`$/.test(text) || (/^ .* $/.test(text) && !/^ +$/.test(text));
  return `${delimiter}${pad ? ' ' : ''}${text}${pad ? ' ' : ''}${delimiter}`;
}

function quote(value: string): string {
  // Quote every line, including blank lines. Escape Markdown/HTML delimiters so
  // supplied text cannot insert images, links, HTML, or new prompt sections.
  return value.replace(/[\\`*_[\]<>#!|]/g, '\\$&')
    .split(/\r\n?|\n/).map(line => `> ${line}`).join('\n');
}
