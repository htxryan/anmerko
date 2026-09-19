import { renderIcons } from './icons';
import type { ScreenshotContext } from './core';

type Rect = ScreenshotContext['region'];
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

// Page scripts cannot read image pixels or data URLs from this closed root.
// All controls remain outside it; the full capture is discarded after cropping.
export function privateImage(dataUrl: string, alt: string): HTMLElement {
  const host = document.createElement('anmerko-image');
  const root = host.attachShadow({ mode: 'closed' });
  const image = document.createElement('img');
  image.src = dataUrl; image.alt = alt;
  image.style.cssText = 'display:block;width:100%;height:100%;object-fit:contain;pointer-events:none;';
  root.append(image);
  return host;
}

export async function selectScreenshot(app: HTMLElement, mobile: boolean, capture: () => Promise<string>, signal: AbortSignal): Promise<ScreenshotContext | null> {
  const viewport = window.visualViewport;
  const width = viewport?.width ?? innerWidth;
  const height = viewport?.height ?? innerHeight;
  const left = viewport?.offsetLeft ?? 0;
  const top = viewport?.offsetTop ?? 0;
  // The capture includes classic scrollbars; visualViewport excludes them.
  // Keep the selection inside the visible content, but size the photo and crop
  // against the full captured surface (including the scrollbar gutters).
  const zoom = viewport?.scale ?? 1;
  const root = document.compatMode === 'BackCompat' ? document.body : document.documentElement;
  const captureWidth = width + Math.max(0, innerWidth - root.clientWidth) / zoom;
  const captureHeight = height + Math.max(0, innerHeight - root.clientHeight) / zoom;
  const scroll = { x: window.scrollX + left, y: window.scrollY + top };
  const startUrl = location.href;
  const valid = () => !signal.aborted && !document.hidden && location.href === startUrl
    && Math.abs((viewport?.width ?? innerWidth) - width) < 1 && Math.abs((viewport?.height ?? innerHeight) - height) < 1
    && Math.abs(window.scrollX + (viewport?.offsetLeft ?? 0) - scroll.x) < 1
    && Math.abs(window.scrollY + (viewport?.offsetTop ?? 0) - scroll.y) < 1;
  let dataUrl: string;
  app.classList.add('capture-hidden');
  try {
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    if (!valid()) throw new Error('The page moved. Try capturing again.');
    dataUrl = await capture();
  } finally { app.classList.remove('capture-hidden'); }
  if (!valid()) throw new Error('The page moved during capture. Try again.');
  const image = new Image(); image.src = dataUrl;
  await image.decode();
  if (!valid()) throw new Error('The page moved during capture. Try again.');
  const layer = document.createElement('div');
  layer.className = 'capture-layer'; layer.setAttribute('role', 'dialog'); layer.setAttribute('aria-label', 'Select screenshot region');
  Object.assign(layer.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
  const photo = privateImage(dataUrl, 'Captured page'); photo.className = 'capture-photo';
  Object.assign(photo.style, { width: `${captureWidth}px`, height: `${captureHeight}px` });
  dataUrl = ''; // The decoder and closed preview are the only remaining full-image references.
  layer.append(photo);
  layer.insertAdjacentHTML('beforeend', `<div class="capture-shade"></div><div class="capture-region" tabindex="0" aria-label="Move screenshot region"><button class="capture-handle nw" data-corner="nw" aria-label="Resize top left"></button><button class="capture-handle ne" data-corner="ne" aria-label="Resize top right"></button><button class="capture-handle sw" data-corner="sw" aria-label="Resize bottom left"></button><button class="capture-handle se" data-corner="se" aria-label="Resize bottom right"></button></div><div class="capture-toolbar"><p></p><div><button class="secondary capture-cancel"><span data-icon="close"></span>Cancel</button><button class="primary capture-use" disabled><span data-icon="check"></span>Use Screenshot</button></div></div>`);
  renderIcons(layer);
  const region = layer.querySelector<HTMLElement>('.capture-region')!;
  const use = layer.querySelector<HTMLButtonElement>('.capture-use')!;
  const toolbar = layer.querySelector<HTMLElement>('.capture-toolbar')!;
  toolbar.querySelector('p')!.textContent = mobile ? 'Drag the box or its corners.' : 'Drag to select an area.';
  app.classList.add('capturing'); app.append(layer);
  const min = 12;
  let rect: Rect | null = mobile ? { x: Math.round(width * .15), y: Math.round(height * .2), width: Math.round(width * .7), height: Math.round(height * .45) } : null;
  function render() {
    region.hidden = !rect;
    layer.querySelector<HTMLElement>('.capture-shade')!.hidden = !!rect;
    use.disabled = !rect || rect.width < min || rect.height < min;
    if (rect) Object.assign(region.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` });
  }
  render();
  return new Promise((resolve, reject) => {
    const listeners = new AbortController();
    let finished = false;
    function finish(result: ScreenshotContext | null, error?: Error) {
      if (finished) return;
      finished = true; listeners.abort(); signal.removeEventListener('abort', aborted);
      layer.remove(); app.classList.remove('capturing'); image.src = '';
      if (error) reject(error); else resolve(result);
    }
    const aborted = () => finish(null);
    signal.addEventListener('abort', aborted, { once: true });
    const changed = () => { if (!valid()) finish(null, new Error('The page changed. Capture the region again.')); };
    for (const target of [window, viewport].filter(Boolean) as EventTarget[]) {
      for (const name of ['resize', 'scroll']) target.addEventListener(name, changed, { signal: listeners.signal });
    }
    document.addEventListener('visibilitychange', changed, { signal: listeners.signal });
    layer.addEventListener('wheel', event => event.preventDefault(), { passive: false, signal: listeners.signal });
    let drag: { id: number; x: number; y: number; corner: string; original: Rect; before: Rect | null } | null = null;
    const pointers = new Set<number>();
    layer.addEventListener('pointerdown', event => {
      if (!event.isTrusted || toolbar.contains(event.target as Node)) return;
      event.preventDefault(); event.stopPropagation(); pointers.add(event.pointerId);
      if (pointers.size > 1) { if (drag) rect = drag.before; drag = null; render(); return; }
      const x = clamp(event.clientX - left, 0, width), y = clamp(event.clientY - top, 0, height);
      const target = event.target as HTMLElement;
      const corner = target.dataset.corner || (target === region ? 'move' : 'new');
      const before = rect && { ...rect };
      if (!rect || corner === 'new') rect = { x, y, width: 0, height: 0 };
      drag = { id: event.pointerId, x, y, corner, original: { ...rect }, before };
      layer.setPointerCapture(event.pointerId); render();
    }, { signal: listeners.signal });
    layer.addEventListener('pointermove', event => {
      if (!event.isTrusted || !drag || drag.id !== event.pointerId) return;
      event.preventDefault();
      const x = clamp(event.clientX - left, 0, width), y = clamp(event.clientY - top, 0, height);
      const original = drag.original;
      if (drag.corner === 'move') rect = { ...original, x: clamp(original.x + x - drag.x, 0, width - original.width), y: clamp(original.y + y - drag.y, 0, height - original.height) };
      else {
        const anchorX = drag.corner === 'new' ? drag.x : original.x + (drag.corner.includes('w') ? original.width : 0);
        const anchorY = drag.corner === 'new' ? drag.y : original.y + (drag.corner.includes('n') ? original.height : 0);
        rect = { x: Math.min(x, anchorX), y: Math.min(y, anchorY), width: Math.abs(x - anchorX), height: Math.abs(y - anchorY) };
      }
      render();
    }, { signal: listeners.signal });
    for (const name of ['pointerup', 'pointercancel'] as const) layer.addEventListener(name, event => {
      pointers.delete(event.pointerId);
      if (drag?.id === event.pointerId) { if (name === 'pointercancel') rect = drag.before; drag = null; render(); }
    }, { signal: listeners.signal });
    document.addEventListener('keydown', event => {
      if (!event.isTrusted) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); finish(null); }
      else if (rect && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
        event.preventDefault();
        const step = event.shiftKey ? 10 : 1;
        const active = (layer.getRootNode() as ShadowRoot).activeElement as HTMLElement | null;
        const corner = active?.dataset.corner;
        const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
        const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
        if (corner) {
          const x1 = corner.includes('w') ? clamp(rect.x + dx, 0, rect.x + rect.width - min) : rect.x;
          const y1 = corner.includes('n') ? clamp(rect.y + dy, 0, rect.y + rect.height - min) : rect.y;
          const x2 = corner.includes('e') ? clamp(rect.x + rect.width + dx, rect.x + min, width) : rect.x + rect.width;
          const y2 = corner.includes('s') ? clamp(rect.y + rect.height + dy, rect.y + min, height) : rect.y + rect.height;
          rect = { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
        } else rect = { ...rect, x: clamp(rect.x + dx, 0, width - rect.width), y: clamp(rect.y + dy, 0, height - rect.height) };
        render();
      } else if (event.key === 'Tab') {
        const controls = [...layer.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]')].filter(el => el.getClientRects().length);
        const current = (layer.getRootNode() as ShadowRoot).activeElement as HTMLElement;
        const index = controls.indexOf(current);
        event.preventDefault(); controls[(index + (event.shiftKey ? controls.length - 1 : 1)) % controls.length]?.focus();
      }
    }, { capture: true, signal: listeners.signal });
    function activate(button: HTMLButtonElement, action: () => void) {
      let tap: { id: number; x: number; y: number; time: number } | null = null;
      button.addEventListener('pointerdown', event => {
        if (!event.isTrusted || event.pointerType !== 'touch') return;
        tap = event.isPrimary ? { id: event.pointerId, x: event.clientX, y: event.clientY, time: performance.now() } : null;
      }, { signal: listeners.signal });
      button.addEventListener('pointercancel', () => { tap = null; }, { signal: listeners.signal });
      button.addEventListener('pointermove', event => {
        if (tap && Math.hypot(event.clientX - tap.x, event.clientY - tap.y) > 12) tap = null;
      }, { signal: listeners.signal });
      button.addEventListener('pointerup', event => {
        const candidate = tap; tap = null;
        const bounds = button.getBoundingClientRect();
        if (!event.isTrusted || button.disabled || candidate?.id !== event.pointerId || performance.now() - candidate.time > 700
          || event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) return;
        event.preventDefault(); event.stopPropagation();
        // Some browsers omit the compatibility click after a region drag. Use
        // the completed tap, then swallow any delayed click after the UI closes.
        // A new pointer-down is a new intentional action and clears this guard.
        const cleanup = () => { document.removeEventListener('click', suppress, true); document.removeEventListener('pointerdown', cleanup, true); clearTimeout(timer); };
        const suppress = (click: MouseEvent) => {
          if (!click.isTrusted || click.detail === 0) return;
          click.preventDefault(); click.stopImmediatePropagation(); cleanup();
        };
        const timer = setTimeout(cleanup, 800);
        document.addEventListener('click', suppress, true);
        document.addEventListener('pointerdown', cleanup, true);
        action();
      }, { signal: listeners.signal });
      button.addEventListener('click', event => { if (event.isTrusted && !button.disabled) action(); }, { signal: listeners.signal });
    }
    activate(layer.querySelector<HTMLButtonElement>('.capture-cancel')!, () => finish(null));
    activate(use, () => {
      if (!rect || use.disabled || drag) return;
      if (!valid()) { changed(); return; }
      try {
        const x = Math.round(rect.x * image.naturalWidth / captureWidth), y = Math.round(rect.y * image.naturalHeight / captureHeight);
        const right = Math.round((rect.x + rect.width) * image.naturalWidth / captureWidth);
        const bottom = Math.round((rect.y + rect.height) * image.naturalHeight / captureHeight);
        const scale = Math.min(1, 2400 / Math.max(right - x, bottom - y));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round((right - x) * scale)); canvas.height = Math.max(1, Math.round((bottom - y) * scale));
        canvas.getContext('2d')!.drawImage(image, x, y, right - x, bottom - y, 0, 0, canvas.width, canvas.height);
        const cropped = canvas.toDataURL('image/png');
        if (cropped.length > 2_800_000) { toolbar.querySelector('p')!.textContent = 'Image is too large. Select a smaller area.'; return; }
        finish({ dataUrl: cropped, width: canvas.width, height: canvas.height,
          region: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
          viewport: { width: Math.round(width), height: Math.round(height) }, scroll });
      } catch { finish(null, new Error('Could not crop this screenshot. Try again.')); }
    });
    (rect ? region : layer.querySelector<HTMLElement>('.capture-cancel'))!.focus();
  });
}
