declare const __TARGET_JOURNEYS__: boolean;

// Whether this build target includes journeys: scripts/extension/build.mjs
// defines it per target (Chrome, Edge, and Firefox yes; Orion no). It is not a
// switch; nothing at build or run time turns it on. Bundles built without the
// define, such as test harnesses, leave journeys out.
export const targetJourneys = typeof __TARGET_JOURNEYS__ !== 'undefined' && __TARGET_JOURNEYS__;

export interface JourneyPlatform {
  userAgent?: string;
  // navigator.userAgentData.platform, where the engine reports it.
  userAgentPlatform?: string;
  // Service workers cannot see the touch screen.
  maxTouchPoints?: number;
  // runtime.getPlatformInfo().os, for contexts that can wait for it.
  os?: string;
}

export function currentPlatform(): JourneyPlatform {
  const agent = globalThis.navigator as (Navigator & { userAgentData?: { platform?: string } }) | undefined;
  return {
    userAgent: agent?.userAgent,
    userAgentPlatform: agent?.userAgentData?.platform,
    maxTouchPoints: agent?.maxTouchPoints,
  };
}

// Journeys are not offered on iPhone or iPad in any browser. Edge there
// installs the Chrome and Edge package, but recording is unverified on iOS.
export function iPhoneOrIPad(platform: JourneyPlatform): boolean {
  const agent = platform.userAgent ?? '';
  if (platform.os === 'ios' || platform.userAgentPlatform === 'iOS'
    || /\b(?:iPhone|iPad|iPod)\b|\b(?:EdgiOS|CriOS|FxiOS)\//.test(agent)) return true;
  // Desktop-class iPadOS browsing reports a Mac. Gecko never runs there, so a
  // Firefox token is a Mac or Firefox for Android asking for a desktop site.
  if (!/\bMacintosh\b/.test(agent) || /\bFirefox\//.test(agent)) return false;
  // A page sees the touch screen; a worker cannot, but a Mac user agent without
  // a Chromium token is WebKit: an iPad browser such as Edge, or a Mac browser
  // this package does not support.
  return (platform.maxTouchPoints ?? 0) > 1 || !/(?:Chrome|Chromium)\//.test(agent);
}

type Listenable = { addListener?: unknown } | undefined;
type JourneyApi = {
  alarms?: { onAlarm?: Listenable; create?: unknown; clear?: unknown };
  webNavigation?: { onCommitted?: Listenable; onHistoryStateUpdated?: Listenable; onReferenceFragmentUpdated?: Listenable };
  tabs?: { onActivated?: Listenable; onUpdated?: Listenable; onRemoved?: Listenable };
  scripting?: { executeScript?: unknown };
  storage?: { session?: { get?: unknown; set?: unknown; remove?: unknown } };
};

const listenable = (event: Listenable) => typeof event?.addListener === 'function';

// The background registers these at startup and a recording depends on each.
export function journeyApisPresent(api: unknown): boolean {
  const { alarms, webNavigation, tabs, scripting, storage } = (api ?? {}) as JourneyApi;
  return listenable(alarms?.onAlarm) && typeof alarms?.create === 'function' && typeof alarms.clear === 'function'
    && listenable(webNavigation?.onCommitted) && listenable(webNavigation?.onHistoryStateUpdated)
    && listenable(webNavigation?.onReferenceFragmentUpdated)
    && listenable(tabs?.onActivated) && listenable(tabs?.onUpdated) && listenable(tabs?.onRemoved)
    && typeof scripting?.executeScript === 'function'
    && typeof storage?.session?.get === 'function' && typeof storage.session.set === 'function'
    && typeof storage.session.remove === 'function';
}

// Set in a page's content-script world by a background that declined journeys,
// before the overlay mounts. Web pages cannot reach that world.
export const JOURNEYS_DECLINED_GLOBAL = '__anmerkoJourneysDeclined';

// The one journey capability check. The background and extension pages pass
// their own platform and extension API. Page content scripts pass nothing:
// they cannot see those APIs, and DevTools device mode or a desktop-site
// request rewrites a page's user agent without changing the browser. They
// trust the background, which marks a page it declined before the overlay
// mounts and injects the journey observer only after its own check passed.
export function journeysAvailable(browser?: { platform: JourneyPlatform; api: unknown }): boolean {
  if (!targetJourneys) return false;
  if (!browser) return (globalThis as Record<string, unknown>)[JOURNEYS_DECLINED_GLOBAL] !== true;
  return !iPhoneOrIPad(browser.platform) && journeyApisPresent(browser.api);
}
