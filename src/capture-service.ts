// A single instance belongs to the background coordinator. Static screenshots
// and journey images must use the same API-start budget, without a work queue.
export function createCaptureService(
  capture: (windowId: number) => Promise<string>,
  now = () => Date.now(),
) {
  let pending = false;
  let lastStart = -Infinity;
  const waitMs = () => Math.max(0, 600 - (now() - lastStart));
  return {
    waitMs,
    async capture(windowId: number): Promise<string> {
      if (pending || waitMs() > 0) throw new Error('Wait a moment before taking another screenshot.');
      pending = true;
      lastStart = now();
      try { return await capture(windowId); }
      finally { pending = false; }
    },
  };
}
