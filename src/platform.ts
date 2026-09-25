// Firefox's browser namespace returns Promises. Chrome 120+ does too, through
// chrome. Resolve this lazily so the prompt formatter also runs outside a browser.
export function extensionApi(): typeof chrome {
  const api = (globalThis as typeof globalThis & { browser?: typeof chrome }).browser ?? globalThis.chrome;
  if (!api) throw new Error('anmerko must run inside a browser extension.');
  return api;
}

// Firefox manifests declare sidebar_action; Chromium manifests use side_panel.
export function firefoxExtension(): boolean {
  try { return 'sidebar_action' in extensionApi().runtime.getManifest(); }
  catch { return false; }
}
