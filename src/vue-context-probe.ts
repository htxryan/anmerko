import type { ComponentContextProbeTarget } from './component-context-bridge';

export function vueComponentContextProbe(target: ComponentContextProbeTarget): string | null {
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
    function optionalData(object: object, key: PropertyKey): unknown {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (!descriptor) return undefined;
      if (!('value' in descriptor)) fail();
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
      if (typeof value !== 'string' || value.length > 128 || !/\S/u.test(value) || /\p{Cc}/u.test(value)) return null;
      const length = Array.from(value).length;
      if (length > 64 || (!explicit && length < 2)) return null;
      return value;
    }
    function typeName(type: unknown): string | null {
      if (typeof type === 'function') {
        const displayNameDescriptor = Object.getOwnPropertyDescriptor(type, 'displayName');
        if (displayNameDescriptor && !('value' in displayNameDescriptor)) return null;
        const displayName = displayNameDescriptor?.value;
        const explicit = usableName(displayName, true);
        if (displayName !== undefined && !explicit) return null;
        if (explicit) return explicit;
        return usableName(data(type, 'name'), false);
      }
      if (!type || typeof type !== 'object') return null;
      const explicitNameDescriptor = Object.getOwnPropertyDescriptor(type, 'name');
      if (explicitNameDescriptor && !('value' in explicitNameDescriptor)) return null;
      const explicitName = explicitNameDescriptor?.value;
      if (explicitName !== undefined) return usableName(explicitName, true);
      const inferredNameDescriptor = Object.getOwnPropertyDescriptor(type, '__name');
      if (inferredNameDescriptor && !('value' in inferredNameDescriptor)) return null;
      const inferredName = inferredNameDescriptor?.value;
      return inferredName === undefined ? null : usableName(inferredName, false);
    }

    const selected = resolveExactTarget();
    if (!selected) return null;
    const markerDescriptor = Object.getOwnPropertyDescriptor(selected, '__vueParentComponent');
    if (!markerDescriptor) return null;
    if (!('value' in markerDescriptor)) fail();
    let instance: unknown = markerDescriptor.value;
    if (!instance || typeof instance !== 'object') fail();

    const innerToOuterNames: string[] = [];
    const seen = new Set<object>();
    let links = 0;
    while (instance !== null && links < 64) {
      checkClock();
      if (!instance || typeof instance !== 'object' || seen.has(instance)) fail();
      seen.add(instance);
      const isUnmounted = data(instance, 'isUnmounted');
      if (typeof isUnmounted !== 'boolean') fail();
      if (isUnmounted) return null;
      const type = data(instance, 'type');
      let plumbing = false;
      if (type && typeof type === 'object') {
        const keepAlive = optionalData(type, '__isKeepAlive');
        if (keepAlive !== undefined && keepAlive !== true) fail();
        plumbing = keepAlive === true;
      }
      if (!plumbing) {
        const name = typeName(type);
        if (!name) return null;
        innerToOuterNames.push(name);
      }
      instance = data(instance, 'parent');
      links += 1;
    }
    if (instance !== null || innerToOuterNames.length === 0) fail();
    if (resolveExactTarget() !== selected) return null;

    checkClock();
    const path = innerToOuterNames.reverse();
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
        version: 1, framework: 'vue', provenance: 'vue3-instance-debug', path, truncated,
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
