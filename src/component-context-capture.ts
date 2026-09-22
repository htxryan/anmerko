import { normalizeComponentContext, type ComponentContextV1 } from './component-context';
import type { Runtime } from './runtime';

/** One disposable lookup owned by an unsaved editor target. */
export function componentContextCapture() {
  let stop: (() => void) | undefined;
  return {
    cancel() { stop?.(); },
    start(runtime: Runtime, element: Element, selectorPath: string[], current: () => boolean,
      apply: (value: ComponentContextV1) => void) {
      stop?.();
      if (!runtime.captureComponentContext || !element.isConnected) return;
      const controller = new AbortController();
      const observer = new MutationObserver(() => { if (!element.isConnected || !current()) cancel(); });
      const cancel = () => {
        controller.abort();
        observer.disconnect();
        clearTimeout(timer);
        if (stop === cancel) stop = undefined;
      };
      const timer = setTimeout(cancel, 750);
      stop = cancel;
      let root: Node = element.getRootNode();
      while (root instanceof ShadowRoot) {
        observer.observe(root, { childList: true, subtree: true });
        root = root.host.getRootNode();
      }
      observer.observe(element.ownerDocument, { childList: true, subtree: true });
      // Runtime failures and timeouts are ordinary absence, never editor errors.
      void Promise.resolve().then(() => controller.signal.aborted ? null
        : runtime.captureComponentContext!(element, selectorPath, controller.signal)).then(value => {
        if (controller.signal.aborted || !element.isConnected || !current()) return;
        const normalized = normalizeComponentContext(value);
        if (normalized) apply(normalized);
      }).catch(() => {}).finally(cancel);
    },
  };
}
