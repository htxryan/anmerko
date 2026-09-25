type JourneyRuntime = Pick<typeof chrome.runtime, 'id' | 'getManifest' | 'getURL'>;

export const JOURNEY_EVENTS_PORT_NAME = 'anmerko-journey-events-v1';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function backgroundPath(manifest: unknown): string | undefined {
  if (!isRecord(manifest) || !isRecord(manifest.background)) return;
  const background = manifest.background;
  if (typeof background.service_worker === 'string' && background.service_worker) return background.service_worker;
  if (typeof background.page === 'string' && background.page) return background.page;
  if (Array.isArray(background.scripts) && background.scripts.length > 0
    && background.scripts.every(script => typeof script === 'string' && script.length > 0)) {
    // Firefox hosts script-based backgrounds in this generated extension page.
    return '_generated_background_page.html';
  }
}

export function isJourneyBackgroundSender(
  runtime: JourneyRuntime,
  sender: chrome.runtime.MessageSender,
): boolean {
  if (sender.id !== runtime.id || sender.tab !== undefined) return false;
  if (sender.url === undefined) return true;
  try {
    const path = backgroundPath(runtime.getManifest());
    return path !== undefined && sender.url === runtime.getURL(path);
  } catch {
    return false;
  }
}
