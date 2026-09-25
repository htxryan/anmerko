import { JOURNEY_LIMITS } from './journey-limits';

// Marker entries in a journey target's selector path. Neither can be a
// structural segment, so they stay unambiguous in stored drafts.
export const JOURNEY_SELECTOR_TRUNCATED = '…';
export const JOURNEY_SELECTOR_SHADOW_ROOT = '#shadow-root';

const SEGMENT_PATTERN = /^[a-z][a-z0-9-]*(?::nth-of-type\([1-9]\d*\))?$/;

export function parentAcrossShadow(element: Element): Element | null {
  if (element.parentElement) return element.parentElement;
  const root = element.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

function selectorSegment(element: Element): string {
  const tag = element.localName;
  const parent = element.parentElement ?? (element.getRootNode() instanceof ShadowRoot ? element.getRootNode() as ShadowRoot : null);
  if (!parent) return tag;
  const siblings = Array.from(parent.children).filter(candidate => candidate.localName === tag);
  return siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(element) + 1})` : tag;
}

// Structural path from the document to `element`, one entry per element,
// with a shadow-root marker between a host and the tree inside it. A path
// deeper than the segment limit keeps its innermost entries after a leading
// truncation marker, so the limit always holds.
export function journeySelectorPath(element: Element): string[] {
  const limit = JOURNEY_LIMITS.maxTargetSegments;
  const path: string[] = [];
  let current: Element | null = element;
  while (current && path.length <= limit) {
    path.push(selectorSegment(current));
    const parent = parentAcrossShadow(current);
    if (parent && !current.parentElement) path.push(JOURNEY_SELECTOR_SHADOW_ROOT);
    current = parent;
  }
  if (path.length > limit) path.splice(limit - 1, Infinity, JOURNEY_SELECTOR_TRUNCATED);
  return path.reverse();
}

export function validJourneySelectorPath(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > JOURNEY_LIMITS.maxTargetSegments) return false;
  const last = value[value.length - 1];
  if (last === JOURNEY_SELECTOR_TRUNCATED || last === JOURNEY_SELECTOR_SHADOW_ROOT) return false;
  return value.every((segment, index) => {
    if (segment === JOURNEY_SELECTOR_TRUNCATED) return index === 0;
    if (segment === JOURNEY_SELECTOR_SHADOW_ROOT) return index > 0 && value[index - 1] !== JOURNEY_SELECTOR_SHADOW_ROOT;
    return typeof segment === 'string' && Array.from(segment).length <= JOURNEY_LIMITS.maxSelectorSegmentCharacters
      && SEGMENT_PATTERN.test(segment);
  });
}

// Markdown form shared with the comments export: ' → shadow root → ' between
// trees and a leading '… → ' when outer segments were dropped.
export function formatJourneySelectorPath(path: readonly string[], code: (segment: string) => string): string {
  return path.map(segment => segment === JOURNEY_SELECTOR_TRUNCATED ? '…'
    : segment === JOURNEY_SELECTOR_SHADOW_ROOT ? 'shadow root' : code(segment)).join(' → ');
}
