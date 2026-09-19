import type * as Demo from './demo-runtime';

const launch = document.querySelector<HTMLButtonElement>('#try-demo')!;
const status = document.querySelector<HTMLElement>('#demo-status')!;
let demo: typeof Demo | undefined;
let opening = false;
let importFailed = false;
let generation = 0;

launch.hidden = false;
launch.addEventListener('click', async () => {
  if (opening) return;
  // Browsers can cache a failed module fetch. A fresh document reliably retries it.
  if (importFailed) { location.reload(); return; }
  const activation = generation;
  opening = true;
  launch.disabled = true;
  launch.setAttribute('aria-busy', 'true');
  status.textContent = 'Opening anmerko…';
  try {
    try { demo ??= await import('./demo-runtime'); }
    catch (error) { if (activation === generation) importFailed = true; throw error; }
    if (activation !== generation) return;
    await demo.openDemo(() => { launch.setAttribute('aria-expanded', 'false'); launch.focus(); });
    if (activation !== generation) return;
    launch.setAttribute('aria-expanded', 'true');
    status.textContent = '';
  } catch {
    if (activation !== generation) return;
    status.textContent = 'The demo could not load. Your page is still available. Try again.';
    launch.textContent = importFailed ? 'Reload to try demo' : 'Try the Demo';
  } finally {
    if (activation === generation) {
      opening = false;
      launch.disabled = false;
      launch.removeAttribute('aria-busy');
    }
  }
});
window.addEventListener('pagehide', () => {
  // A cached document may finish an import after navigation. Invalidate that
  // activation and leave a fresh launcher if the browser restores the page.
  ++generation;
  demo?.disposeDemo();
  opening = false;
  launch.disabled = false;
  launch.removeAttribute('aria-busy');
  status.textContent = '';
});
