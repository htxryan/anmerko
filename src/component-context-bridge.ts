import {
  COMPONENT_CONTEXT_KEY,
  COMPONENT_CONTEXT_MAX_WIRE_BYTES,
  normalizeComponentContext,
  type ComponentContextV1,
} from './component-context';
import { selectComponentContext } from './component-context-dispatch';

export const COMPONENT_CONTEXT_MESSAGE_TYPE = 'ANMERKO_COMPONENT_CONTEXT';
export const COMPONENT_CONTEXT_DEADLINE_MS = 750;
export const COMPONENT_CONTEXT_PROBE_FAILURE = 'ANMERKO_COMPONENT_CONTEXT_PROBE_FAILED';
export const COMPONENT_CONTEXT_MAX_SELECTOR_SEGMENTS = 8;
export const COMPONENT_CONTEXT_MAX_SELECTOR_SEGMENT_LENGTH = 1_024;
export const COMPONENT_CONTEXT_MAX_SELECTOR_LENGTH = 4_096;

export interface ComponentContextProbeTarget {
  selectorPath: string[];
  expectedTag: string;
  markerName: string;
}

export interface ComponentContextBridgeRequest extends ComponentContextProbeTarget {
  type: typeof COMPONENT_CONTEXT_MESSAGE_TYPE;
  version: 1;
}

export type ComponentContextProbe = (target: ComponentContextProbeTarget) => string | null;
export type ComponentContextProbeTuple = readonly [
  react: ComponentContextProbe,
  vue: ComponentContextProbe,
  angular: ComponentContextProbe,
  preact: ComponentContextProbe,
];

export interface ComponentContextProbeExecution {
  tabId: number;
  documentId?: string;
}

export type ComponentContextProbeRunner = (
  probe: ComponentContextProbe,
  target: ComponentContextProbeTarget,
  execution: ComponentContextProbeExecution,
) => Promise<unknown>;

export type ComponentContextProbeOutcome =
  | { kind: 'none' }
  | { kind: 'valid'; value: ComponentContextV1 }
  | { kind: 'indeterminate' };

const REQUEST_KEYS = ['type', 'version', 'selectorPath', 'expectedTag', 'markerName'] as const;
const MARKER_PATTERN = /^data-anmerko-context-[a-f0-9]{32}$/;
const TAG_PATTERN = /^[a-z][a-z0-9._:-]{0,127}$/;
const TIMED_OUT = Symbol('timed-out');
const EXPECTED_FRAMEWORKS = ['react', 'vue', 'angular', 'preact'] as const;

function dataProperties(value: object, expectedKeys: readonly string[]): Record<string, unknown> | undefined {
  try {
    const keys = Reflect.ownKeys(value);
    if (keys.length !== expectedKeys.length || keys.some(key => typeof key !== 'string' || !expectedKeys.includes(key))) return undefined;
    const properties: Record<string, unknown> = {};
    for (const key of expectedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) return undefined;
      properties[key] = descriptor.value;
    }
    return properties;
  } catch { return undefined; }
}

function stringArray(value: unknown): string[] | undefined {
  try {
    if (!Array.isArray(value)) return undefined;
    const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
    if (!Number.isInteger(length) || length < 1 || length > COMPONENT_CONTEXT_MAX_SELECTOR_SEGMENTS) return undefined;
    const keys = [...Array.from({ length }, (_, index) => String(index)), 'length'];
    const properties = dataProperties(value, keys);
    if (!properties) return undefined;
    const result: string[] = [];
    let total = 0;
    for (let index = 0; index < length; index++) {
      const segment = properties[String(index)];
      if (typeof segment !== 'string' || segment.length < 1 || segment.length > COMPONENT_CONTEXT_MAX_SELECTOR_SEGMENT_LENGTH
        || /\p{Cc}/u.test(segment)) return undefined;
      total += segment.length;
      if (total > COMPONENT_CONTEXT_MAX_SELECTOR_LENGTH) return undefined;
      result.push(segment);
    }
    return result;
  } catch { return undefined; }
}

function normalizeRequest(value: unknown): ComponentContextBridgeRequest | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const properties = dataProperties(value, REQUEST_KEYS);
  if (!properties || properties.type !== COMPONENT_CONTEXT_MESSAGE_TYPE || properties.version !== 1
    || typeof properties.expectedTag !== 'string' || !TAG_PATTERN.test(properties.expectedTag)
    || typeof properties.markerName !== 'string' || !MARKER_PATTERN.test(properties.markerName)) return undefined;
  const selectorPath = stringArray(properties.selectorPath);
  if (!selectorPath) return undefined;
  try { structuredClone(value); } catch { return undefined; }
  return {
    type: COMPONENT_CONTEXT_MESSAGE_TYPE,
    version: 1,
    selectorPath,
    expectedTag: properties.expectedTag,
    markerName: properties.markerName,
  };
}

function senderExecution(sender: chrome.runtime.MessageSender, extensionId: string): ComponentContextProbeExecution | undefined {
  try {
    if (sender.id !== extensionId || sender.frameId !== 0 || !Number.isInteger(sender.tab?.id) || sender.tab!.id! < 0
      || typeof sender.url !== 'string' || typeof sender.tab?.url !== 'string' || sender.tab.url !== sender.url) return undefined;
    const url = new URL(sender.url);
    if (!['http:', 'https:'].includes(url.protocol)) return undefined;
    if (sender.origin !== undefined && sender.origin !== url.origin) return undefined;
    if (sender.documentId !== undefined && (typeof sender.documentId !== 'string' || sender.documentId.length < 1 || sender.documentId.length > 256)) return undefined;
    return { tabId: sender.tab.id!, ...(sender.documentId ? { documentId: sender.documentId } : {}) };
  } catch { return undefined; }
}

export function classifyComponentContextProbeResult(value: unknown): ComponentContextProbeOutcome {
  if (value === null) return { kind: 'none' };
  if (typeof value !== 'string' || value.length > COMPONENT_CONTEXT_MAX_WIRE_BYTES
    || new TextEncoder().encode(value).byteLength > COMPONENT_CONTEXT_MAX_WIRE_BYTES) {
    return { kind: 'indeterminate' };
  }
  try {
    const context = normalizeComponentContext(JSON.parse(value));
    return context ? { kind: 'valid', value: context } : { kind: 'indeterminate' };
  } catch { return { kind: 'indeterminate' }; }
}

interface ComponentContextBrokerOptions {
  extensionId: string;
  probes: ComponentContextProbeTuple;
  runProbe: ComponentContextProbeRunner;
  readPreference: () => Promise<unknown>;
  deadlineMs?: number;
}

export interface ComponentContextBroker {
  handle(message: unknown, sender: chrome.runtime.MessageSender): Promise<ComponentContextV1 | null> | undefined;
  preferenceChanged(value: unknown): void;
}

export function createComponentContextBroker(options: ComponentContextBrokerOptions): ComponentContextBroker {
  if (options.probes.length !== 4) throw new TypeError('Exactly four component context probes are required.');
  const deadlineMs = options.deadlineMs ?? COMPONENT_CONTEXT_DEADLINE_MS;
  const activeTabs = new Map<number, Promise<void>>();
  let disabledEpoch = 0;

  return {
    preferenceChanged(value) {
      if (value !== true) disabledEpoch++;
    },
    handle(message, sender) {
      const normalized = normalizeRequest(message);
      const execution = senderExecution(sender, options.extensionId);
      if (!normalized || !execution) return undefined;
      if (activeTabs.has(execution.tabId)) return Promise.resolve(null);

      const epoch = disabledEpoch;
      const deadline = Date.now() + deadlineMs;
      let pendingBoundary: Promise<unknown> | undefined;
      const wait = async (factory: () => Promise<unknown>): Promise<unknown | typeof TIMED_OUT> => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return TIMED_OUT;
        const current = Promise.resolve().then(factory);
        pendingBoundary = current;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const result = await Promise.race([
          current.then(value => ({ value }), () => ({ value: TIMED_OUT })),
          new Promise<{ value: typeof TIMED_OUT }>(resolve => { timer = setTimeout(() => resolve({ value: TIMED_OUT }), remaining); }),
        ]);
        if (timer) clearTimeout(timer);
        if (result.value !== TIMED_OUT && pendingBoundary === current) pendingBoundary = undefined;
        return result.value;
      };
      const enabled = async () => {
        if (disabledEpoch !== epoch) return false;
        const value = await wait(() => options.readPreference());
        return value !== TIMED_OUT && value === true && disabledEpoch === epoch;
      };

      const operation = (async (): Promise<ComponentContextV1 | null> => {
        const outcomes: ComponentContextProbeOutcome[] = [];
        const { type: _type, version: _version, ...probeTarget } = normalized;
        for (let index = 0; index < options.probes.length; index++) {
          if (!await enabled()) return null;
          const returned = await wait(() => options.runProbe(options.probes[index], probeTarget, execution));
          if (returned === TIMED_OUT) return null;
          const outcome = classifyComponentContextProbeResult(returned);
          if (outcome.kind === 'indeterminate' || (outcome.kind === 'valid' && outcome.value.framework !== EXPECTED_FRAMEWORKS[index])) return null;
          outcomes.push(outcome);
        }
        if (!await enabled()) return null;
        return selectComponentContext(outcomes);
      })().catch(() => null);

      const lifetime = operation.finally(async () => {
        if (pendingBoundary) await pendingBoundary.catch(() => {});
      }).then(() => {}, () => {}).finally(() => {
        if (activeTabs.get(execution.tabId) === lifetime) activeTabs.delete(execution.tabId);
      });
      activeTabs.set(execution.tabId, lifetime);
      return operation;
    },
  };
}

export function createExtensionComponentContextProbeRunner(api: typeof chrome): ComponentContextProbeRunner {
  return async (probe, target, execution) => {
    const injectionTarget: chrome.scripting.InjectionTarget = execution.documentId
      ? { tabId: execution.tabId, documentIds: [execution.documentId] }
      : { tabId: execution.tabId, frameIds: [0] };
    try {
      const results = await api.scripting.executeScript({ target: injectionTarget, world: 'MAIN', func: probe, args: [target] });
      if (results.length !== 1 || results[0].frameId !== 0) throw new Error(COMPONENT_CONTEXT_PROBE_FAILURE);
      // Firefox reports a thrown injected value on the result object. Never
      // inspect or forward that page-controlled value.
      if ('error' in results[0]) throw new Error(COMPONENT_CONTEXT_PROBE_FAILURE);
      if (execution.documentId && results[0].documentId && results[0].documentId !== execution.documentId) {
        throw new Error(COMPONENT_CONTEXT_PROBE_FAILURE);
      }
      return results[0].result;
    } catch {
      throw new Error(COMPONENT_CONTEXT_PROBE_FAILURE);
    }
  };
}

interface ComponentContextClientApi {
  sendMessage(message: unknown): Promise<unknown>;
}

interface ComponentContextClientOptions {
  crypto?: Crypto;
  deadlineMs?: number;
}

function randomMarker(cryptoApi: Crypto): string {
  const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
  return `data-anmerko-context-${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

export async function requestComponentContext(
  api: ComponentContextClientApi,
  element: Element,
  selectorPath: string[],
  signal: AbortSignal,
  options: ComponentContextClientOptions = {},
): Promise<ComponentContextV1 | null> {
  if (signal.aborted) return null;
  let markerName = '';
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      const candidate = randomMarker(options.crypto ?? crypto);
      if (!element.hasAttribute(candidate)) { markerName = candidate; break; }
    }
    if (!markerName || !element.isConnected) return null;
    const request = normalizeRequest({
      type: COMPONENT_CONTEXT_MESSAGE_TYPE,
      version: 1,
      selectorPath,
      expectedTag: element.localName,
      markerName,
    });
    if (!request) return null;
    element.setAttribute(markerName, '');
    if (element.getAttribute(markerName) !== '') return null;

    const deadlineMs = options.deadlineMs ?? COMPONENT_CONTEXT_DEADLINE_MS;
    const response = await new Promise<unknown | typeof TIMED_OUT>(resolve => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      const finish = (value: unknown | typeof TIMED_OUT) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', aborted);
        resolve(value);
      };
      const aborted = () => finish(TIMED_OUT);
      timer = setTimeout(() => finish(TIMED_OUT), deadlineMs);
      signal.addEventListener('abort', aborted, { once: true });
      if (signal.aborted) aborted();
      else Promise.resolve(api.sendMessage(request)).then(finish, () => finish(TIMED_OUT));
    });
    if (response === TIMED_OUT || signal.aborted || !element.isConnected || element.getAttribute(markerName) !== ''
      || !response || typeof response !== 'object') return null;
    const properties = dataProperties(response, ['ok', 'value']);
    if (!properties || properties.ok !== true) return null;
    return normalizeComponentContext(properties.value) ?? null;
  } catch { return null; }
  finally {
    try {
      if (markerName && element.getAttribute(markerName) === '') element.removeAttribute(markerName);
    } catch { /* The page can detach or replace the target during lookup. */ }
  }
}

export { COMPONENT_CONTEXT_KEY };
