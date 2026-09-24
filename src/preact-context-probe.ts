import type { ComponentContextProbeTarget } from './component-context-bridge';

export function preactComponentContextProbe(target: ComponentContextProbeTarget): string | null {
  const failureToken = 'ANMERKO_COMPONENT_CONTEXT_PROBE_FAILED';

  try {
    const startedAt = performance.now();
    if (!Number.isFinite(startedAt)) throw new Error(failureToken);
    const maxDurationMs = /\bAndroid\b/iu.test(navigator.userAgent) ? 25 : 10;
    let visits = 0;

    function fail(): never { throw new Error(failureToken); }
    function checkClock(): void {
      const now = performance.now();
      if (!Number.isFinite(now) || now < startedAt || now - startedAt > maxDurationMs) fail();
    }
    function data(object: object, key: PropertyKey): unknown {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (!descriptor || !('value' in descriptor)) fail();
      return descriptor.value;
    }
    function optionalData(object: object, key: PropertyKey): unknown {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (!descriptor || !('value' in descriptor)) return undefined;
      return descriptor.value;
    }
    function resolveExactTarget(): Element | null {
      if (!target || typeof target !== 'object' || !Array.isArray(target.selectorPath)
        || target.selectorPath.length < 1 || target.selectorPath.length > 8
        || typeof target.expectedTag !== 'string' || target.expectedTag.length < 1
        || !/^[a-z][a-z0-9._:-]{0,127}$/u.test(target.expectedTag)
        || typeof target.markerName !== 'string'
        || !/^data-anmerko-context-[0-9a-f]{32}$/u.test(target.markerName)) fail();
      let combinedLength = 0;
      let root: Document | ShadowRoot = document;
      let selected: Element | null = null;
      for (let index = 0; index < target.selectorPath.length; index += 1) {
        const segment = target.selectorPath[index];
        if (typeof segment !== 'string' || segment.length < 1 || segment.length > 1_024) fail();
        combinedLength += segment.length;
        if (combinedLength > 4_096) fail();
        checkClock();
        const matches: NodeListOf<Element> = root.querySelectorAll(segment);
        checkClock();
        if (matches.length !== 1) return null;
        selected = matches.item(0);
        if (!selected) fail();
        if (index < target.selectorPath.length - 1) {
          if (!selected.shadowRoot) return null;
          root = selected.shadowRoot;
        }
      }
      if (!selected || !selected.isConnected || selected.ownerDocument !== document
        || selected.localName !== target.expectedTag || selected.getAttribute(target.markerName) !== '') return null;
      return selected;
    }
    function usableName(value: unknown, explicit: boolean): string | null {
      if (typeof value !== 'string' || value.length > 128 || !/\S/u.test(value)
        || /[\p{Cc}\p{Bidi_Control}\p{Zl}\p{Zp}]/u.test(value)) return null;
      const length = Array.from(value).length;
      if (length > 64 || (!explicit && length < 2)) return null;
      return value;
    }
    function functionName(value: unknown): string | null {
      if (typeof value !== 'function') return null;
      const displayName = optionalData(value, 'displayName');
      const explicit = usableName(displayName, true);
      if (displayName !== undefined && !explicit) return null;
      if (explicit) return explicit;
      const name = data(value, 'name');
      if (typeof name !== 'string' || name === 'Fragment') return null;
      return usableName(name, false);
    }
    // Preact vnode shape: constructor explicitly undefined (anti-JSON-injection
    // marker), a type slot, and the minified child/parent/dom links.
    function asVNode(value: unknown): Record<PropertyKey, unknown> | null {
      if (!value || typeof value !== 'object') return null;
      const properties = value as Record<PropertyKey, unknown>;
      const constructorDescriptor = Object.getOwnPropertyDescriptor(properties, 'constructor');
      if (!constructorDescriptor || !('value' in constructorDescriptor)
        || constructorDescriptor.value !== undefined) return null;
      if (!('type' in properties) || !(('__k' in properties) || ('_children' in properties))) return null;
      return properties;
    }
    // VNode classification: 'skip' for structural plumbing (the container's
    // own root vnode, a render-internal Fragment alias; text markers),
    // 'host' for plain elements, a name record for real components, and
    // undefined for anything unnameable (abort the whole probe, never guess).
    function vnodeKind(type: unknown): 'skip' | 'host' | { name: string; identity: unknown } | undefined {
      if (type === null || type === undefined) return 'skip';
      if (typeof type === 'string') return 'host';
      if (typeof type !== 'function') return undefined;
      const factoryName = optionalData(type, 'name');
      if (factoryName === 'S') return 'skip';
      const direct = functionName(type);
      return direct ? { name: direct, identity: type } : undefined;
    }
    function childLinks(vnode: Record<PropertyKey, unknown>): unknown[] | null {
      const minified = optionalData(vnode, '__k');
      if (minified === null) return [];
      if (Array.isArray(minified)) return minified;
      const development = optionalData(vnode, '_children');
      if (development === null) return [];
      if (Array.isArray(development)) return development;
      return null;
    }
    function domOf(vnode: Record<PropertyKey, unknown>): unknown {
      const minified = optionalData(vnode, '__e');
      if (minified !== undefined) return minified;
      return optionalData(vnode, '_dom');
    }

    const selected = resolveExactTarget();
    if (!selected) return null;
    checkClock();

    // Preact keeps no per-node back-pointer: climb to the nearest ancestor
    // (or self) carrying a render-container root vnode, then DFS for the
    // deepest vnode whose first-DOM-descendant is the exact target.
    let rootVNode: Record<PropertyKey, unknown> | null = null;
    let cursor: Element | null = selected;
    let levels = 0;
    while (cursor && levels < 16) {
      checkClock();
      for (const key of ['__k', '_children'] as const) {
        const descriptor = Object.getOwnPropertyDescriptor(cursor, key);
        if (descriptor && 'value' in descriptor) {
          const candidate = asVNode(descriptor.value);
          if (candidate) { rootVNode = candidate; break; }
        }
      }
      if (rootVNode) break;
      cursor = cursor.parentElement;
      levels += 1;
    }
    // React containers never carry Preact roots; an explicit React fiber on
    // the target with no Preact root above is a fast, honest none.
    if (!rootVNode) return null;

    const innerToOuterNames: string[] = [];
    const seen = new Set<object>();
    let bestDepth = -1;
    // Stack order is outermost-first by construction (ancestors push before
    // descendants are visited); the deepest matching component frame wins.
    function visit(vnode: unknown, stack: Array<{ name: string; identity: unknown }>, depth: number): void {
      checkClock();
      visits += 1;
      if (visits > 2_000) fail();
      const node = asVNode(vnode);
      if (!node || seen.has(node)) return;
      seen.add(node);
      const kind = vnodeKind(optionalData(node, 'type'));
      if (kind === undefined) fail();
      if (kind === 'skip' || kind === 'host') {
        const children = childLinks(node);
        if (!children) return;
        for (const child of children) visit(child, stack, depth + 1);
        return;
      }
      stack.push(kind);
      try {
        // A component vnode's _dom is its first DOM descendant, so wrappers
        // share the target with their host child. Record the deepest
        // *component* frame; the host element itself contributes no name.
        if (domOf(node) === selected && stack.length > 0 && depth > bestDepth) {
          bestDepth = depth;
          innerToOuterNames.length = 0;
          for (const entry of stack) innerToOuterNames.push(entry.name);
        }
        const children = childLinks(node);
        if (!children) return;
        for (const child of children) visit(child, stack, depth + 1);
      } finally {
        stack.pop();
      }
    }
    visit(rootVNode, [], 0);
    if (bestDepth < 0 || innerToOuterNames.length === 0) return null;
    if (resolveExactTarget() !== selected) return null;

    checkClock();
    const path = innerToOuterNames.slice();
    let totalCodePoints = path.reduce((total, name) => total + Array.from(name).length, 0);
    let truncated = false;
    checkClock();
    while (path.length > 8 || totalCodePoints > 384) {
      checkClock();
      const removed = path.shift();
      if (!removed) fail();
      totalCodePoints -= Array.from(removed).length;
      truncated = true;
      checkClock();
    }
    function serialize(): string {
      checkClock();
      const value = JSON.stringify({
        version: 1, framework: 'preact', provenance: 'preact-vnode-prod', path, truncated,
      });
      checkClock();
      return value;
    }
    function wireBytes(value: string): number {
      checkClock();
      const length = new TextEncoder().encode(value).byteLength;
      checkClock();
      return length;
    }
    let serialized = serialize();
    while (wireBytes(serialized) > 2_048) {
      checkClock();
      const removed = path.shift();
      if (!removed || path.length === 0) fail();
      truncated = true;
      checkClock();
      serialized = serialize();
    }
    checkClock();
    return serialized;
  } catch {
    throw new Error(failureToken);
  }
}
