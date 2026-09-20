import type { ComponentContextProbeTarget } from './component-context-bridge';

export function reactComponentContextProbe(target: ComponentContextProbeTarget): string | null {
  const failureToken = 'ANMERKO_COMPONENT_CONTEXT_PROBE_FAILED';

  try {
    const startedAt = performance.now();
    if (!Number.isFinite(startedAt)) throw new Error(failureToken);
    const maxDurationMs = /\bAndroid\b/iu.test(navigator.userAgent) ? 25 : 10;

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
    function optionalNameData(object: object, key: PropertyKey): unknown {
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
      const displayName = optionalNameData(value, 'displayName');
      const explicit = usableName(displayName, true);
      if (displayName !== undefined && !explicit) return null;
      if (explicit) return explicit;
      return usableName(data(value, 'name'), false);
    }
    function componentDetails(type: unknown, depth = 0): { name: string; identity: unknown } | null {
      if (typeof type === 'function') {
        const direct = functionName(type);
        return direct ? { name: direct, identity: type } : null;
      }
      if (!type || typeof type !== 'object' || depth >= 2) fail();
      const wrapperKind = data(type, '$$typeof');
      const forwardRefKind = Symbol.for('react.forward_ref');
      const memoKind = Symbol.for('react.memo');
      if (wrapperKind !== forwardRefKind && wrapperKind !== memoKind) fail();
      const inner = componentDetails(data(type, wrapperKind === memoKind ? 'type' : 'render'), depth + 1);
      if (!inner) return null;
      const displayName = optionalNameData(type, 'displayName');
      const explicit = usableName(displayName, true);
      if (displayName !== undefined && !explicit) return null;
      return explicit ? { name: explicit, identity: inner.identity } : inner;
    }

    const selected = resolveExactTarget();
    if (!selected) return null;
    checkClock();
    const markerKeys = Reflect.ownKeys(selected).filter(
      key => typeof key === 'string' && key.startsWith('__reactFiber$'),
    );
    if (markerKeys.length === 0) return null;
    if (markerKeys.length !== 1) fail();
    const markerDescriptor = Object.getOwnPropertyDescriptor(selected, markerKeys[0]);
    if (!markerDescriptor || !('value' in markerDescriptor)) fail();
    let fiber: unknown = markerDescriptor.value;
    if (!fiber || typeof fiber !== 'object') fail();
    if (data(fiber, 'tag') !== 5 || data(fiber, 'stateNode') !== selected) fail();

    const has18DebugShape = Object.hasOwn(fiber, '_debugSource') && Object.hasOwn(fiber, '_debugOwner');
    const has19DebugShape = Object.hasOwn(fiber, '_debugStack') && Object.hasOwn(fiber, '_debugOwner')
      && Object.hasOwn(fiber, '_debugInfo');
    if (!has18DebugShape && !has19DebugShape) return null;

    const innerToOuterComponents: Array<{ name: string; identity: unknown }> = [];
    const seen = new Set<object>();
    let links = 0;
    while (fiber !== null && links < 64) {
      checkClock();
      if (!fiber || typeof fiber !== 'object' || seen.has(fiber)) fail();
      seen.add(fiber);
      const tag = data(fiber, 'tag');
      if (!Number.isInteger(tag)) fail();
      if (tag === 0 || tag === 1 || tag === 11 || tag === 14 || tag === 15) {
        const type = tag === 14 || tag === 15 ? data(fiber, 'elementType') : data(fiber, 'type');
        const component = componentDetails(type);
        if (!component) return null;
        const inner = innerToOuterComponents.at(-1);
        if (!((tag === 14 || tag === 15) && inner
          && inner.identity === component.identity && inner.name === component.name)) {
          innerToOuterComponents.push(component);
        }
      } else if (![3, 4, 5, 6, 7, 8, 9, 10, 12, 13, 16, 19, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31].includes(tag as number)) fail();
      fiber = data(fiber, 'return');
      links += 1;
    }
    if (fiber !== null || innerToOuterComponents.length === 0) fail();
    if (resolveExactTarget() !== selected) return null;

    checkClock();
    const path = innerToOuterComponents.reverse().map(component => component.name);
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
        version: 1, framework: 'react', provenance: 'react-dom-fiber-dev', path, truncated,
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
