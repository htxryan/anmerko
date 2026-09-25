import type { ComponentContextProbeTarget } from './component-context-bridge';

// Astro island attribution. Unlike the framework probes, this reader does not
// walk a runtime component tree: Astro compiles .astro components to static
// HTML, so static output carries no recoverable component names. What Astro
// leaves behind is a literal <astro-island> custom element wrapping each
// hydrated island, with framework/export/strategy metadata as attributes.
// This probe reports that island frame honestly; island interiors remain
// ordinary framework trees for the runtime probes via delegation.
export function astroIslandContextProbe(target: ComponentContextProbeTarget): string | null {
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
    function usableText(value: unknown, maxLength: number): string | null {
      if (typeof value !== 'string' || value.length < 1 || value.length > maxLength
        || !/\S/u.test(value) || /[\p{Cc}\p{Bidi_Control}\p{Zl}\p{Zp}]/u.test(value)) return null;
      return value;
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

    const selected = resolveExactTarget();
    if (!selected) return null;
    checkClock();

    // Literal tag match only: astro-island is Astro-reserved and stable
    // across 4.x/5.x. Attribute-prefix sniffing would false-positive.
    let island: Element | null = null;
    let cursor: Element | null = selected;
    let levels = 0;
    while (cursor && levels < 16) {
      checkClock();
      if (cursor.localName === 'astro-island' && cursor.namespaceURI === 'http://www.w3.org/1999/xhtml') {
        island = cursor;
        break;
      }
      cursor = cursor.parentElement;
      levels += 1;
    }
    if (!island) return null;

    // Four naming attributes, each optional and length-bounded. props/opts
    // are deliberately never read: unbounded page-controlled JSON payloads.
    const get = (name: string): string | null => {
      const raw = island!.getAttribute(name);
      if (raw === null) return null;
      return usableText(raw, 512);
    };
    const componentExport = get('component-export');
    const componentUrl = get('component-url');
    const rendererUrl = get('renderer-url');
    const client = get('client');
    if (componentExport === null && componentUrl === null && rendererUrl === null && client === null) {
      // Bare island with stripped metadata: distinct from "no island".
      return JSON.stringify({ version: 1, island: true, metadata: 'absent' });
    }
    // Framework is inferred only from the renderer's filename stem, never
    // from the content hash. Unknown stems stay unknown, never guessed.
    let framework: string | null = null;
    if (rendererUrl) {
      const stem = rendererUrl.split('/').at(-1)?.split('.')[0]?.toLowerCase() ?? '';
      for (const known of ['react', 'preact', 'vue', 'svelte', 'solid', 'lit']) {
        if (stem.includes(known)) { framework = known; break; }
      }
    }
    if (resolveExactTarget() !== selected) return null;
    checkClock();
    // Hydration flag: a template fallback still present means the island has
    // not hydrated yet, so probe `none` on its interior is expected, not a
    // failure. Never inspect the fallback's contents.
    const hydrated = island.querySelector('[data-astro-template]') === null;
    return JSON.stringify({
      version: 1,
      island: true,
      metadata: 'present',
      framework,
      componentExport,
      componentUrl,
      rendererUrl,
      client,
      hydrated,
    });
  } catch {
    // Chrome reports a thrown injected function as a null result, which
    // reads as "no component". Return the token so failure stays explicit.
    return failureToken;
  }
}
