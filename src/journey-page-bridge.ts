import { stripUrlCredentials, type JourneyEventBatchV1 } from './journey-events';
import { isJourneyBackgroundSender, JOURNEY_EVENTS_PORT_NAME } from './journey-messaging';
import { attachJourneyRecorder } from './journey-recorder';
import { extensionApi } from './platform';
import { createUuid } from './uuid';

type PageIdentity = {
  documentToken: string;
  url: string;
  viewport: { width: number; height: number };
  scroll: { x: number; y: number };
  generation: number;
  visible: boolean;
};

type Recording = {
  sessionId: string;
  epoch: number;
  disposeRecorder: () => void;
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
};

type Message = Record<string, unknown> & { type?: unknown };

const GENERIC_ERROR = 'Journey command unavailable.';
const CAPTURE_HIDDEN_ATTRIBUTE = 'data-anmerko-capture-hidden';
const UI_HOST_SELECTOR = 'anmerko-overlay, anmerko-image, anmerko-journey-strip';
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/;

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
    'bottom:12px!important',
    'left:12px!important',
    'z-index:2147483647!important',
    'display:block!important',
    'width:max-content!important',
    'height:auto!important',
  ].join(';');
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `
    .strip { align-items:center; background:#171717; border:1px solid #525252; border-radius:10px;
      box-shadow:0 4px 18px rgba(0,0,0,.28); color:#fff; display:flex; font:600 13px/1.3 system-ui,sans-serif;
      gap:10px; padding:6px 6px 6px 12px; }
    .recording::before { background:#ef4444; border-radius:50%; content:""; display:inline-block; height:8px;
      margin-right:7px; width:8px; }
    button { appearance:none; background:#fff; border:0; border-radius:7px; color:#171717; cursor:pointer;
      font:700 13px system-ui,sans-serif; min-height:44px; min-width:44px; padding:0 14px; }
    button:focus-visible { outline:3px solid #60a5fa; outline-offset:2px; }
    button:disabled { cursor:wait; opacity:.7; }
    .error { color:#fecaca; font-weight:500; max-width:190px; }
  `;
  const container = document.createElement('div');
  container.className = 'strip';
  const recording = document.createElement('span');
  recording.className = 'recording';
  recording.textContent = 'Recording';
  const count = document.createElement('span');
  const setCount = (value: number) => { count.textContent = `${value} ${value === 1 ? 'step' : 'steps'}`; };
  setCount(initialCount);
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Stop';
  const error = document.createElement('span');
  error.className = 'error';
  error.hidden = true;
  root.append(style, container);
  container.append(recording, count, button, error);
  button.addEventListener('click', async () => {
    if (button.disabled) return;
    button.disabled = true;
    error.hidden = true;
    const stopped = await stop(sessionId, epoch).catch(() => false);
    if (!stopped && host.isConnected) {
      error.textContent = 'Could not stop the journey. Try again.';
      error.hidden = false;
      button.disabled = false;
    }
  });
  (document.documentElement ?? document.body).append(host);
  return {
    host,
    setCount,
  };
}

export function bindJourneyPage(onDispose?: () => void): () => void {
  if (window.top !== window) return () => {};
  const api = extensionApi();
  const documentToken = createUuid();
  let generation = 0;
  let viewportWidth = innerWidth;
  let viewportHeight = innerHeight;
  let recording: Recording | undefined;
  let preparedCapture: PreparedCapture | undefined;
  let disposed = false;

  const recordViewportChange = () => {
    if (innerWidth === viewportWidth && innerHeight === viewportHeight) return;
    viewportWidth = innerWidth;
    viewportHeight = innerHeight;
    generation += 1;
  };

  const identity = (): PageIdentity => {
    recordViewportChange();
    return {
      documentToken,
      url: stripUrlCredentials(location.href),
      viewport: { width: innerWidth, height: innerHeight },
      scroll: { x: scrollX, y: scrollY },
      generation,
      visible: !document.hidden,
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
    recording = undefined;
    active?.disposeRecorder();
    if (active) disconnectEventPort(active);
    active?.strip.host.remove();
    restoreUi();
  };

  const resize = () => { recordViewportChange(); };
  window.addEventListener('resize', resize, { passive: true });
  window.visualViewport?.addEventListener('resize', resize, { passive: true });

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
    if (recording) {
      return recording.sessionId === message.sessionId && recording.epoch === message.epoch
        ? success(identity()) : failure();
    }
    let strip: JourneyStrip | undefined;
    let active: Recording | undefined;
    try {
      strip = mountJourneyStrip(message.sessionId, message.epoch, (message.count as number | undefined) ?? 0, sendStop);
      const nextActive: Recording = {
        sessionId: message.sessionId,
        epoch: message.epoch,
        strip,
        disposeRecorder: () => {},
      };
      active = nextActive;
      if (!connectEventPort(nextActive)) throw new Error(GENERIC_ERROR);
      const disposeRecorder = attachJourneyRecorder({
        sessionId: message.sessionId,
        epoch: message.epoch,
        documentToken,
        startedAt: message.startedAt,
        onBatch(batch: JourneyEventBatchV1) {
          if (recording === nextActive) postEventBatch(nextActive, batch);
        },
      });
      nextActive.disposeRecorder = disposeRecorder;
      recording = nextActive;
      return success(identity());
    } catch {
      if (active) disconnectEventPort(active);
      strip?.host.remove();
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
      window.removeEventListener('resize', resize);
      window.visualViewport?.removeEventListener('resize', resize);
      window.removeEventListener('pagehide', dispose);
    } finally { onDispose?.(); }
  };
  api.runtime.onMessage.addListener(listener);
  window.addEventListener('pagehide', dispose, { once: true });
  return dispose;
}
