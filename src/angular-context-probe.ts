import type { ComponentContextProbeTarget } from './component-context-bridge';

export function angularComponentContextProbe(target: ComponentContextProbeTarget): string | null {
  const failureToken = 'ANMERKO_COMPONENT_CONTEXT_PROBE_FAILED';

  try {
    const startedAt = performance.now();
    const maxDurationMs = /\bAndroid\b/iu.test(navigator.userAgent) ? 25 : 10;
    let frameworkCalls = 0;

    function fail(): never {
      throw new Error(failureToken);
    }

    function checkClock(): void {
      const now = performance.now();
      if (!Number.isFinite(now) || now < startedAt || now - startedAt > maxDurationMs) fail();
    }

    if (!Number.isFinite(startedAt)) fail();

    function resolveExactTarget(): Element | null {
      if (!target || typeof target !== 'object'
        || !Array.isArray(target.selectorPath)
        || target.selectorPath.length < 1
        || target.selectorPath.length > 8
        || typeof target.expectedTag !== 'string'
        || target.expectedTag.length < 1
        || target.expectedTag.length > 128
        || !/^[a-z][a-z0-9._:-]*$/u.test(target.expectedTag)
        || typeof target.markerName !== 'string'
        || !/^data-anmerko-context-[0-9a-f]{32}$/u.test(target.markerName)) fail();

      let combinedLength = 0;
      let root: Document | ShadowRoot = document;
      let selected: Element | null = null;
      for (let index = 0; index < target.selectorPath.length; index += 1) {
        const segment = target.selectorPath[index];
        if (typeof segment !== 'string' || segment.length < 1 || segment.length > 1_024 || /\p{Cc}/u.test(segment)) fail();
        combinedLength += segment.length;
        if (combinedLength > 4_096) fail();
        checkClock();
        const matches: NodeListOf<Element> = root.querySelectorAll(segment);
        checkClock();
        if (matches.length !== 1) return null;
        const match = matches.item(0);
        if (!match) fail();
        selected = match;
        if (index < target.selectorPath.length - 1) {
          if (!match.shadowRoot) return null;
          root = match.shadowRoot;
        }
      }

      if (!selected
        || !selected.isConnected
        || selected.ownerDocument !== document
        || selected.localName !== target.expectedTag
        || selected.getAttribute(target.markerName) !== '') return null;
      return selected;
    }

    const selected = resolveExactTarget();
    if (!selected) return null;

    const ngDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'ng');
    if (!ngDescriptor) return null;
    if (!('value' in ngDescriptor)) fail();
    const ng = ngDescriptor.value;
    if ((!ng || typeof ng !== 'object') && typeof ng !== 'function') fail();

    const methodNames = ['getComponent', 'getOwningComponent', 'getHostElement'] as const;
    const methods: Function[] = [];
    for (const methodName of methodNames) {
      const descriptor = Object.getOwnPropertyDescriptor(ng, methodName);
      if (!descriptor) return null;
      if (!('value' in descriptor) || typeof descriptor.value !== 'function') fail();
      methods.push(descriptor.value);
    }
    const [getComponent, getOwningComponent, getHostElement] = methods;

    function callFramework(method: Function, value: unknown): unknown {
      checkClock();
      if (frameworkCalls >= 194) fail();
      frameworkCalls += 1;
      const result = method(value);
      checkClock();
      return result;
    }

    function componentName(component: unknown): string | null {
      if ((!component || typeof component !== 'object') && typeof component !== 'function') fail();
      const prototype = Object.getPrototypeOf(component);
      if (!prototype || (typeof prototype !== 'object' && typeof prototype !== 'function')) fail();
      const constructorDescriptor = Object.getOwnPropertyDescriptor(prototype, 'constructor');
      if (!constructorDescriptor || !('value' in constructorDescriptor)
        || typeof constructorDescriptor.value !== 'function') fail();
      const nameDescriptor = Object.getOwnPropertyDescriptor(constructorDescriptor.value, 'name');
      if (!nameDescriptor || !('value' in nameDescriptor) || typeof nameDescriptor.value !== 'string') fail();
      const name = nameDescriptor.value;
      if (name.length > 128) return null;
      const codePointLength = Array.from(name).length;
      if (codePointLength < 2 || codePointLength > 64 || !/\S/u.test(name)
        || /[\p{Cc}\p{Bidi_Control}\p{Zl}\p{Zp}]/u.test(name)) return null;
      return name;
    }

    const directComponent = callFramework(getComponent, selected);
    const selectedOwner = callFramework(getOwningComponent, selected);
    if (directComponent === null && selectedOwner === null) return null;
    if (directComponent === undefined || selectedOwner === undefined) fail();

    let current = directComponent === null ? selectedOwner : directComponent;
    const seen = new Set<unknown>();
    const innerToOuterNames: string[] = [];
    let linkCount = 0;

    while (current !== null && linkCount < 64) {
      if (seen.has(current)) fail();
      seen.add(current);
      const name = componentName(current);
      if (!name) return null;
      innerToOuterNames.push(name);

      const host = callFramework(getHostElement, current);
      if (!(host instanceof Element) || !host.isConnected || host.ownerDocument !== document) fail();
      if (linkCount === 0 && directComponent !== null && host !== selected) fail();
      if (callFramework(getComponent, host) !== current) fail();
      const owner = callFramework(getOwningComponent, host);
      if (owner === undefined) fail();
      if (linkCount === 0 && directComponent !== null && owner !== selectedOwner) fail();
      current = owner;
      linkCount += 1;
    }
    if (current !== null || innerToOuterNames.length === 0) fail();
    if (resolveExactTarget() !== selected) return null;

    const path = innerToOuterNames.reverse();
    let totalCodePoints = path.reduce((total, name) => total + Array.from(name).length, 0);
    let truncated = false;
    while (path.length > 8 || totalCodePoints > 384) {
      checkClock();
      const removed = path.shift();
      if (!removed) fail();
      totalCodePoints -= Array.from(removed).length;
      truncated = true;
    }

    const encoder = new TextEncoder();
    function serializeResult(): string {
      checkClock();
      return JSON.stringify({
        version: 1,
        framework: 'angular',
        provenance: 'angular-debug-ownership',
        path,
        truncated,
      });
    }
    let result = serializeResult();
    while (encoder.encode(result).byteLength > 2_048) {
      checkClock();
      if (!path.shift()) fail();
      truncated = true;
      result = serializeResult();
    }
    checkClock();
    return result;
  } catch {
    // Chrome reports a thrown injected function as a null result, which
    // reads as "no component". Return the token so failure stays explicit.
    return failureToken;
  }
}
