// Firefox's browser namespace returns Promises. Chrome 120+ does too, through
// chrome. Resolve this lazily so the prompt formatter also runs outside a browser.
export function extensionApi(): typeof chrome {
  const api = (globalThis as typeof globalThis & { browser?: typeof chrome }).browser ?? globalThis.chrome;
  if (!api) throw new Error('anmerko must run inside a browser extension.');
  return api;
}

// Only Firefox, on desktop and Android alike, implements runtime.getBrowserInfo
// and serves extension pages from moz-extension: URLs. Manifest keys are no
// signal: Firefox for Android does not support sidebar_action and may drop it.
export function firefoxExtension(api?: typeof chrome): boolean {
  try {
    const runtime = (api ?? extensionApi()).runtime as typeof chrome.runtime & { getBrowserInfo?: unknown };
    return typeof runtime.getBrowserInfo === 'function' || runtime.getURL('').startsWith('moz-extension:');
  } catch { return false; }
}
