// Extension pages offer journeys only when the browser has every API the
// background needs to record one. Harnesses that fake chrome add these inert
// stubs, keeping any fakes they already define. Self-contained so tests can
// also pass it to page.evaluate.
export function addJourneyApis(): void {
  const event = () => ({ addListener() {}, removeListener() {} });
  const api = (globalThis as unknown as { chrome: Record<string, any> }).chrome;
  api.alarms = { onAlarm: event(), create: async () => {}, clear: async () => true, ...api.alarms };
  api.webNavigation = { onCommitted: event(), onHistoryStateUpdated: event(), onReferenceFragmentUpdated: event(), ...api.webNavigation };
  api.tabs = { onActivated: event(), onUpdated: event(), onRemoved: event(), ...api.tabs };
  api.scripting = { executeScript: async () => [], ...api.scripting };
  api.storage = { ...api.storage, session: { get: async () => ({}), set: async () => {}, remove: async () => {}, ...api.storage?.session } };
}
