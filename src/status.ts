const TOAST_DURATION_MS = 4_000;

/** Replaces feedback in a live region; errors and unfinished work can stay visible. */
export function statusMessage(element: HTMLElement, signal: AbortSignal) {
  let timer: number | undefined;
  const cancel = () => { window.clearTimeout(timer); timer = undefined; };
  signal.addEventListener('abort', cancel, { once: true });
  return (text = '', { error = false, persistent = error }: { error?: boolean; persistent?: boolean } = {}) => {
    if (signal.aborted) return;
    cancel();
    element.textContent = text;
    element.classList.toggle('error', error);
    if (text && !persistent) {
      timer = window.setTimeout(() => {
        element.textContent = '';
        timer = undefined;
      }, TOAST_DURATION_MS);
    }
  };
}
