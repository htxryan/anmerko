import { stripUrlCredentials, type JourneyEventBatchV1 } from './journey-events';
import { isJourneyBackgroundSender, JOURNEY_EVENTS_PORT_NAME } from './journey-messaging';
import { attachJourneyRecorder } from './journey-recorder';
import { attachJourneyFields, type JourneyFieldCommit } from './journey-fields';
import { extensionApi } from './platform';
import { createUuid } from './uuid';

type PageIdentity = {
  documentToken: string;
  url: string;
  viewport: { width: number; height: number };
  scroll: { x: number; y: number };
  generation: number;
  visible: boolean;
  recording?: { sessionId: string; epoch: number };
};

type Recording = {
  sessionId: string;
  epoch: number;
  disposeRecorder: () => void;
  flushRecorder: () => void;
  disposeFields: () => void;
  strip: JourneyStrip;
  eventPort?: chrome.runtime.Port;
  portDisconnected?: () => void;
};

type HiddenHost = {
  element: HTMLElement;
  captureHidden: string | null;
  display: string;
  displayPriority: string;
  visibility: string;
  visibilityPriority: string;
};

type PreparedCapture = {
  captureId: string;
  hiddenHosts: HiddenHost[];
  timeout: number;
};

type JourneyStrip = {
  host: HTMLElement;
  setCount(count: number): void;
  remove(): void;
};

type RecordingSignal = { recording: boolean; listeners: Set<(recording: boolean) => void> };

type Message = Record<string, unknown> & { type?: unknown };

const GENERIC_ERROR = 'Journey command unavailable.';
const CAPTURE_HIDDEN_ATTRIBUTE = 'data-anmerko-capture-hidden';
const UI_HOST_SELECTOR = 'anmerko-overlay, anmerko-image, anmerko-journey-strip';
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/;
// Gap between the recording strip and the visible edge it sits on.
const STRIP_GAP = 12;
// Height assumed for the strip before it has laid out.
const STRIP_HEIGHT = 58;
// A visual viewport this much shorter than the layout viewport has an
// on-screen keyboard over it; browser toolbars take less.
const KEYBOARD_SHRINK = 120;
const NON_TEXT_INPUT = /^(?:button|checkbox|color|file|hidden|image|radio|range|reset|submit)$/;

// The observer and content scripts can each bundle this module, so the signal
// lives on the content-script global. Page scripts cannot reach that world.
function recordingSignal(): RecordingSignal {
  const global = globalThis as typeof globalThis & { __anmerkoJourneyRecording?: RecordingSignal };
  global.__anmerkoJourneyRecording ??= { recording: false, listeners: new Set() };
  return global.__anmerkoJourneyRecording;
}

function setPageRecording(recording: boolean): void {
  const signal = recordingSignal();
  if (signal.recording === recording) return;
  signal.recording = recording;
  for (const listener of signal.listeners) {
    try { listener(recording); } catch { /* One panel's failure must not block the recorder. */ }
  }
}

// Lets the floating panel make room for the recording strip on this page.
export function watchJourneyPageRecording(listener: (recording: boolean) => void): () => void {
  const signal = recordingSignal();
  signal.listeners.add(listener);
  if (signal.recording) listener(true);
  return () => { signal.listeners.delete(listener); };
}

function success<T>(value: T) {
  return { ok: true as const, value };
}

function failure() {
  return { ok: false as const, error: GENERIC_ERROR };
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID.test(value);
}

function validEpoch(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function validStartedAt(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

// The focused element that takes typing, looking into open shadow roots.
function focusedEditable(): Element | undefined {
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  if (!active) return;
  if (active instanceof HTMLTextAreaElement || (active instanceof HTMLElement && active.isContentEditable)) return active;
  if (active instanceof HTMLInputElement && !NON_TEXT_INPUT.test(active.type)) return active;
}

function nextPaint(): Promise<void> {
  return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

function mountJourneyStrip(
  sessionId: string,
  epoch: number,
  initialCount: number,
  stop: (sessionId: string, epoch: number) => Promise<boolean>,
): JourneyStrip {
  const host = document.createElement('anmerko-journey-strip');
  host.style.cssText = [
    'position:fixed!important',
    'left:12px!important',
    'z-index:2147483647!important',
    'display:block!important',
    'width:max-content!important',
    'max-width:calc(100% - 24px)!important',
    'height:auto!important',
  ].join(';');
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `
    .strip { background:#171717; border:1px solid #525252; border-radius:10px; box-shadow:0 4px 18px rgba(0,0,0,.28);
      color:#fff; font:600 13px/1.3 system-ui,sans-serif; padding:6px 6px 6px 12px; }
    .row { align-items:center; display:flex; flex-wrap:wrap; gap:6px 10px; }
    .recording::before { background:#ef4444; border-radius:50%; content:""; display:inline-block; height:8px;
      margin-right:7px; width:8px; }
    button { appearance:none; background:#fff; border:0; border-radius:7px; color:#171717; cursor:pointer;
      font:700 13px system-ui,sans-serif; min-height:44px; min-width:44px; padding:0 14px; }
    button:focus-visible { outline:3px solid #60a5fa; outline-offset:2px; }
    button:disabled { cursor:wait; opacity:.7; }
    .error { color:#fecaca; font-weight:500; margin:0; padding-right:6px; }
    .error:not(:empty) { margin:4px 0 2px; }
  `;
  const container = document.createElement('div');
  container.className = 'strip';
  container.setAttribute('role', 'group');
  container.setAttribute('aria-label', 'anmerko journey recording');
  const row = document.createElement('div');
  row.className = 'row';
  const recording = document.createElement('span');
  recording.className = 'recording';
  recording.textContent = 'Recording';
  const count = document.createElement('span');
  const setCount = (value: number) => { count.textContent = `${value} ${value === 1 ? 'step' : 'steps'}`; };
  setCount(initialCount);
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Stop';
  button.setAttribute('aria-label', 'Stop recording journey');
  // Present while empty, so a failure is announced when its text arrives.
  const error = document.createElement('p');
  error.className = 'error';
  error.setAttribute('role', 'alert');
  root.append(style, container);
  row.append(recording, count, button);
  container.append(row, error);
  const listeners = new AbortController();
  // An on-screen keyboard shrinks only the visual viewport, and the browser
  // scrolls the field being typed into toward its bottom edge. The strip
  // follows the visible bottom edge, and moves to the visible top while
  // typing or while a keyboard is open, unless the field is up there.
  const place = () => {
    const visual = window.visualViewport;
    const top = visual?.offsetTop ?? 0;
    const height = visual?.height ?? innerHeight;
    const covered = Math.max(0, Math.round(innerHeight - (top + height)));
    const size = host.getBoundingClientRect().height || STRIP_HEIGHT;
    const field = focusedEditable();
    let atTop = !!field || innerHeight - height * (visual?.scale ?? 1) > KEYBOARD_SHRINK;
    if (field) {
      const rect = field.getBoundingClientRect();
      const covers = (from: number) => rect.bottom > from && rect.top < from + size;
      if (covers(top + STRIP_GAP) && !covers(top + height - STRIP_GAP - size)) atTop = false;
    }
    host.style.setProperty('top', atTop ? `calc(${Math.round(top) + STRIP_GAP}px + env(safe-area-inset-top, 0px))` : 'auto', 'important');
    host.style.setProperty('bottom', atTop ? 'auto' : `calc(${STRIP_GAP + covered}px + env(safe-area-inset-bottom, 0px))`, 'important');
  };
  // Focus has not moved on yet while focusout dispatches.
  const placeAfterFocus = () => { setTimeout(place, 0); };
  window.visualViewport?.addEventListener('resize', place, { passive: true, signal: listeners.signal });
  window.visualViewport?.addEventListener('scroll', place, { passive: true, signal: listeners.signal });
  window.addEventListener('resize', place, { passive: true, signal: listeners.signal });
  window.addEventListener('scroll', place, { passive: true, signal: listeners.signal });
  document.addEventListener('focusin', place, { capture: true, signal: listeners.signal });
  document.addEventListener('focusout', placeAfterFocus, { capture: true, signal: listeners.signal });
  button.addEventListener('click', async () => {
    if (button.disabled) return;
    button.disabled = true;
    error.textContent = '';
    place();
    const stopped = await stop(sessionId, epoch).catch(() => false);
    if (!stopped && host.isConnected) {
      error.textContent = 'Could not stop the journey. Try again.';
      button.disabled = false;
      place();
    }
  }, { signal: listeners.signal });
  place();
  (document.documentElement ?? document.body).append(host);
  place();
  return {
    host,
    setCount,
    remove() {
      listeners.abort();
      host.remove();
    },
  };
}

export function bindJourneyPage(onDispose?: () => void): () => void {
  if (window.top !== window) return () => {};
  const api = extensionApi();
  const documentToken = createUuid();
  let generation = 0;
  let layoutWidth = innerWidth;
  let layoutHeight = innerHeight;
  let visibleWidth = Math.round(window.visualViewport?.width ?? innerWidth);
  let visibleHeight = Math.round(window.visualViewport?.height ?? innerHeight);
  let visibleOffsetX = window.visualViewport?.offsetLeft ?? 0;
  let visibleOffsetY = window.visualViewport?.offsetTop ?? 0;
  let visibleScale = window.visualViewport?.scale ?? 1;
  let recording: Recording | undefined;
  let preparedCapture: PreparedCapture | undefined;
  let disposed = false;

  // The visible viewport follows the static capture path: visualViewport size
  // with window scroll plus visual offsets, so pinch zoom and panning change
  // the recorded identity even when the layout viewport is untouched.
  const recordViewportChange = () => {
    const visual = window.visualViewport;
    const width = Math.round(visual?.width ?? innerWidth);
    const height = Math.round(visual?.height ?? innerHeight);
    const offsetX = visual?.offsetLeft ?? 0;
    const offsetY = visual?.offsetTop ?? 0;
    const scale = visual?.scale ?? 1;
    if (innerWidth === layoutWidth && innerHeight === layoutHeight
      && width === visibleWidth && height === visibleHeight
      && offsetX === visibleOffsetX && offsetY === visibleOffsetY && scale === visibleScale) return;
    layoutWidth = innerWidth;
    layoutHeight = innerHeight;
    visibleWidth = width;
    visibleHeight = height;
    visibleOffsetX = offsetX;
    visibleOffsetY = offsetY;
    visibleScale = scale;
    generation += 1;
  };

  const identity = (): PageIdentity => {
    recordViewportChange();
    return {
      documentToken,
      url: stripUrlCredentials(location.href),
      viewport: { width: visibleWidth, height: visibleHeight },
      scroll: { x: scrollX + visibleOffsetX, y: scrollY + visibleOffsetY },
      generation,
      visible: !document.hidden,
      ...(recording ? { recording: { sessionId: recording.sessionId, epoch: recording.epoch } } : {}),
    };
  };

  const restoreUi = () => {
    const capture = preparedCapture;
    if (!capture) return;
    preparedCapture = undefined;
    clearTimeout(capture.timeout);
    for (const hidden of capture.hiddenHosts) {
      if (!hidden.element.isConnected) continue;
      if (hidden.display) hidden.element.style.setProperty('display', hidden.display, hidden.displayPriority);
      else hidden.element.style.removeProperty('display');
      if (hidden.visibility) hidden.element.style.setProperty('visibility', hidden.visibility, hidden.visibilityPriority);
      else hidden.element.style.removeProperty('visibility');
      if (hidden.captureHidden === null) hidden.element.removeAttribute(CAPTURE_HIDDEN_ATTRIBUTE);
      else hidden.element.setAttribute(CAPTURE_HIDDEN_ATTRIBUTE, hidden.captureHidden);
    }
  };

  const disconnectEventPort = (active: Recording) => {
    const port = active.eventPort;
    const disconnected = active.portDisconnected;
    active.eventPort = undefined;
    active.portDisconnected = undefined;
    if (!port) return;
    if (disconnected) port.onDisconnect.removeListener(disconnected);
    try { port.disconnect(); } catch { /* The document or extension context may already be gone. */ }
  };

  const connectEventPort = (active: Recording): chrome.runtime.Port | undefined => {
    try {
      const port = api.runtime.connect({ name: JOURNEY_EVENTS_PORT_NAME });
      const disconnected = () => {
        void api.runtime.lastError;
        if (active.eventPort !== port) return;
        active.eventPort = undefined;
        active.portDisconnected = undefined;
      };
      port.onDisconnect.addListener(disconnected);
      active.eventPort = port;
      active.portDisconnected = disconnected;
      return port;
    } catch {
      return;
    }
  };

  const postEventBatch = (active: Recording, batch: JourneyEventBatchV1) => {
    const port = active.eventPort ?? connectEventPort(active);
    if (!port) return;
    try {
      port.postMessage({ type: 'ANMERKO_JOURNEY_EVENTS', batch });
      return;
    } catch {
      disconnectEventPort(active);
    }
    const replacement = connectEventPort(active);
    if (!replacement) return;
    try {
      replacement.postMessage({ type: 'ANMERKO_JOURNEY_EVENTS', batch });
    } catch {
      disconnectEventPort(active);
    }
  };

  const stopRecording = () => {
    const active = recording;
    active?.flushRecorder();
    recording = undefined;
    active?.disposeRecorder();
    active?.disposeFields();
    if (active) disconnectEventPort(active);
    active?.strip.remove();
    restoreUi();
    if (active) setPageRecording(false);
  };

  const viewportChanged = () => { recordViewportChange(); };
  window.addEventListener('resize', viewportChanged, { passive: true });
  window.visualViewport?.addEventListener('resize', viewportChanged, { passive: true });
  window.visualViewport?.addEventListener('scroll', viewportChanged, { passive: true });

  const sendStop = async (sessionId: string, epoch: number): Promise<boolean> => {
    try {
      const response = await api.runtime.sendMessage({ type: 'ANMERKO_JOURNEY_STOP', sessionId, epoch });
      return !(response && typeof response === 'object' && 'ok' in response && response.ok === false);
    } catch {
      return false;
    }
  };

  const start = (message: Message) => {
    if (!validId(message.sessionId) || !validEpoch(message.epoch)
      || message.documentToken !== documentToken || !validStartedAt(message.startedAt)
      || (message.count !== undefined && (!Number.isSafeInteger(message.count) || (message.count as number) < 0))) return failure();
    if (message.expectedUrl !== undefined) {
      if (typeof message.expectedUrl !== 'string') return failure();
      try {
        if (stripUrlCredentials(message.expectedUrl) !== message.expectedUrl
          || message.expectedUrl !== stripUrlCredentials(location.href)) return failure();
      } catch { return failure(); }
    }
    if (message.includeEnteredValues !== undefined && typeof message.includeEnteredValues !== 'boolean') {
      return failure();
    }
    if (recording) {
      return recording.sessionId === message.sessionId && recording.epoch === message.epoch
        ? success(identity()) : failure();
    }
    let strip: JourneyStrip | undefined;
    let active: Recording | undefined;
    try {
      strip = mountJourneyStrip(message.sessionId, message.epoch, (message.count as number | undefined) ?? 0, sendStop);
      const collectValues = message.includeEnteredValues === true;
      let fieldCommits: JourneyFieldCommit[] = [];
      const nextActive: Recording = {
        sessionId: message.sessionId,
        epoch: message.epoch,
        strip,
        disposeRecorder: () => {},
        flushRecorder: () => {},
        disposeFields: () => {},
      };
      active = nextActive;
      if (!connectEventPort(nextActive)) throw new Error(GENERIC_ERROR);
      if (collectValues) {
        const disposeFields = attachJourneyFields({
          sessionId: message.sessionId,
          epoch: message.epoch,
          documentToken,
          startedAt: message.startedAt,
          onFieldCommit(commit) {
            if (recording === nextActive) fieldCommits.push(commit);
          },
        });
        nextActive.disposeFields = disposeFields;
      }
      const recorder = attachJourneyRecorder({
        sessionId: message.sessionId,
        epoch: message.epoch,
        documentToken,
        startedAt: message.startedAt,
        drainFieldCommits: collectValues ? () => {
          const pending = fieldCommits;
          fieldCommits = [];
          return pending;
        } : undefined,
        onBatch(batch: JourneyEventBatchV1) {
          if (recording === nextActive) postEventBatch(nextActive, batch);
        },
      });
      nextActive.disposeRecorder = () => recorder.dispose();
      nextActive.flushRecorder = () => recorder.flushFieldCommits();
      recording = nextActive;
      setPageRecording(true);
      return success(identity());
    } catch {
      if (active) disconnectEventPort(active);
      strip?.remove();
      return failure();
    }
  };

  const stop = (message: Message) => {
    if (!validId(message.sessionId) || !validEpoch(message.epoch) || !recording
      || message.sessionId !== recording.sessionId || message.epoch < recording.epoch
      || (message.documentToken !== undefined && message.documentToken !== documentToken)) return failure();
    stopRecording();
    return success(identity());
  };

  const status = (message: Message) => {
    if (!validId(message.sessionId) || !validEpoch(message.epoch) || !recording
      || message.sessionId !== recording.sessionId || message.epoch !== recording.epoch
      || !Number.isSafeInteger(message.count) || (message.count as number) < 0) return failure();
    recording.strip.setCount(message.count as number);
    return success(identity());
  };

  const prepare = async (message: Message) => {
    if (!validId(message.captureId) || message.documentToken !== documentToken || preparedCapture) return failure();
    const hiddenHosts = Array.from(document.querySelectorAll<HTMLElement>(UI_HOST_SELECTOR)).map(element => ({
      element,
      captureHidden: element.getAttribute(CAPTURE_HIDDEN_ATTRIBUTE),
      display: element.style.getPropertyValue('display'),
      displayPriority: element.style.getPropertyPriority('display'),
      visibility: element.style.getPropertyValue('visibility'),
      visibilityPriority: element.style.getPropertyPriority('visibility'),
    }));
    for (const hidden of hiddenHosts) {
      hidden.element.setAttribute(CAPTURE_HIDDEN_ATTRIBUTE, '');
      hidden.element.style.setProperty('display', 'none', 'important');
      hidden.element.style.setProperty('visibility', 'hidden', 'important');
    }
    const capture: PreparedCapture = {
      captureId: message.captureId,
      hiddenHosts,
      timeout: window.setTimeout(() => {
        if (preparedCapture === capture) restoreUi();
      }, 5_000),
    };
    preparedCapture = capture;
    await nextPaint();
    return !disposed && preparedCapture === capture ? success(identity()) : failure();
  };

  const finish = (message: Message) => {
    if (!validId(message.captureId) || message.captureId !== preparedCapture?.captureId) return failure();
    const value = identity();
    restoreUi();
    return success(value);
  };

  const listener = (
    rawMessage: unknown,
    sender: chrome.runtime.MessageSender,
    respond: (response: unknown) => void,
  ): boolean | void => {
    if (!rawMessage || typeof rawMessage !== 'object') return;
    const message = rawMessage as Message;
    if (typeof message.type !== 'string' || !message.type.startsWith('ANMERKO_JOURNEY_PAGE_')) return;
    if (!isJourneyBackgroundSender(api.runtime, sender)) {
      respond(failure());
      return;
    }
    try {
      if (message.type === 'ANMERKO_JOURNEY_PAGE_IDENTIFY') respond(success(identity()));
      else if (message.type === 'ANMERKO_JOURNEY_PAGE_START') respond(start(message));
      else if (message.type === 'ANMERKO_JOURNEY_PAGE_STOP') respond(stop(message));
      else if (message.type === 'ANMERKO_JOURNEY_PAGE_STATUS') respond(status(message));
      else if (message.type === 'ANMERKO_JOURNEY_PAGE_FINISH') respond(finish(message));
      else if (message.type === 'ANMERKO_JOURNEY_PAGE_PREPARE') {
        void prepare(message).then(respond, () => respond(failure()));
        return true;
      } else respond(failure());
    } catch {
      respond(failure());
    }
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    try {
      stopRecording();
      api.runtime.onMessage.removeListener(listener);
      window.removeEventListener('resize', viewportChanged);
      window.visualViewport?.removeEventListener('resize', viewportChanged);
      window.visualViewport?.removeEventListener('scroll', viewportChanged);
      window.removeEventListener('pagehide', dispose);
    } finally { onDispose?.(); }
  };
  api.runtime.onMessage.addListener(listener);
  window.addEventListener('pagehide', dispose, { once: true });
  return dispose;
}
