// A single instance belongs to the background coordinator. Static screenshots
// and journey images must use the same API-start budget, without a work queue.
// The API-start timestamp can be retained in session storage so a worker wake
// keeps the spacing. The store holds only the timestamp, never image bytes,
// and is never used to order journey steps.
export interface CaptureSpacingStore {
  loadLastStart(): Promise<number | undefined>;
  saveLastStart(lastStart: number): Promise<void>;
}

const API_START_SPACING_MS = 600;

export function createCaptureService(
  capture: (windowId: number) => Promise<string>,
  now = () => Date.now(),
  store?: CaptureSpacingStore,
) {
  let pending = false;
  let lastStart = -Infinity;
  let restored: Promise<void> | undefined;
  if (store) {
    const spacing = store;
    restored = spacing.loadLastStart().then(value => {
      if (typeof value === 'number' && Number.isFinite(value) && value <= now()) {
        lastStart = Math.max(lastStart, value);
      }
    }).catch(() => {});
  }
  const waitMs = () => Math.min(
    API_START_SPACING_MS,
    Math.max(0, API_START_SPACING_MS - (now() - lastStart)),
  );
  return {
    waitMs,
    async capture(windowId: number): Promise<string> {
      if (restored) await restored;
      if (pending || waitMs() > 0) throw new Error('Wait a moment before taking another screenshot.');
      pending = true;
      lastStart = now();
      if (store) {
        try {
          await store.saveLastStart(lastStart);
        } catch {
          // Spacing persistence is best-effort; the in-memory budget still applies.
        }
      }
      try { return await capture(windowId); }
      finally { pending = false; }
    },
  };
}
