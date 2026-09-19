import { mount } from '../../../src/content';
import type { Controller } from '../../../src/runtime';
import panelStyles from '../../../src/panel.css?url&no-inline';
import { createMemoryStore } from './memory-store';

const store = createMemoryStore();
let controller: Controller | undefined;

function loadStyles(shadow: ShadowRoot, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet'; link.href = panelStyles;
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', aborted);
      link.onload = link.onerror = null;
      if (error) { link.remove(); reject(error); } else resolve();
    };
    const aborted = () => finish(new Error('Demo closed while loading.'));
    const timeout = window.setTimeout(() => finish(new Error('Demo styles took too long to load.')), 10000);
    link.onload = () => finish();
    link.onerror = () => finish(new Error('Could not load demo styles.'));
    signal.addEventListener('abort', aborted, { once: true });
    shadow.prepend(link);
  });
}

export async function openDemo(onClose: () => void) {
  if (!controller) {
    controller = mount({
      store, attachStyles: loadStyles,
      captureUnavailable: 'Screenshots require the extension',
      settingsLabel: 'Feedback settings',
      storageError: 'Could not save or load demo comments. Keep your draft and try again.',
      onDispose() { controller = undefined; onClose(); },
    });
  }
  const opening = controller;
  await opening.ready;
  if (controller === opening) opening.reveal();
}

export function disposeDemo() {
  controller?.dispose();
  store.clear();
}
