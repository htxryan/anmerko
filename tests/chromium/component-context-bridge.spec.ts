import { test, expect } from '@playwright/test';
import {
  COMPONENT_CONTEXT_DEADLINE_MS,
  COMPONENT_CONTEXT_MESSAGE_TYPE,
  COMPONENT_CONTEXT_PROBE_FAILURE,
  classifyComponentContextProbeResult,
  createComponentContextBroker,
  createExtensionComponentContextProbeRunner,
  requestComponentContext,
  type ComponentContextBridgeRequest,
  type ComponentContextProbe,
  type ComponentContextProbeRunner,
} from '../../src/component-context-bridge';

const target = {
  selectorPath: ['#app', 'button.save'],
  expectedTag: 'button',
  markerName: `data-anmerko-context-${'a'.repeat(32)}`,
};
const request: ComponentContextBridgeRequest = {
  type: COMPONENT_CONTEXT_MESSAGE_TYPE,
  version: 1,
  ...target,
};
const sender = {
  id: 'extension-id', frameId: 0, url: 'https://example.com/path', origin: 'https://example.com', documentId: 'document-1',
  tab: { id: 42, url: 'https://example.com/path' },
} as chrome.runtime.MessageSender;
const react = JSON.stringify({ version: 1, framework: 'react', provenance: 'react-dom-fiber-dev', path: ['App', 'Button'], truncated: false });
const vue = JSON.stringify({ version: 1, framework: 'vue', provenance: 'vue3-instance-debug', path: ['App'], truncated: false });
const probes = [(() => null), (() => null), (() => null)] as const satisfies readonly [ComponentContextProbe, ComponentContextProbe, ComponentContextProbe];

function broker(runProbe: ComponentContextProbeRunner, readPreference: () => Promise<unknown> = async () => true, deadlineMs = 750) {
  return createComponentContextBroker({ extensionId: 'extension-id', probes, runProbe, readPreference, deadlineMs });
}

test('publishes one fixed protocol, deadline, and sanitized failure token', () => {
  expect(COMPONENT_CONTEXT_MESSAGE_TYPE).toBe('ANMERKO_COMPONENT_CONTEXT');
  expect(COMPONENT_CONTEXT_DEADLINE_MS).toBe(750);
  expect(COMPONENT_CONTEXT_PROBE_FAILURE).toBe('ANMERKO_COMPONENT_CONTEXT_PROBE_FAILED');
});

test('accepts only an own-extension top-frame HTTP(S) sender and an exact bounded request', async () => {
  let calls = 0;
  const bridge = broker(async () => { calls++; return null; });
  const denied = [
    [{ ...request, tabId: 42 }, sender],
    [{ ...request, selectorPath: [] }, sender],
    [{ ...request, selectorPath: ['x'.repeat(1_025)] }, sender],
    [{ ...request, selectorPath: Array(5).fill('x'.repeat(1_000)) }, sender],
    [request, { ...sender, id: 'other-extension' }],
    [request, { ...sender, frameId: 1 }],
    [request, { ...sender, tab: undefined, url: 'chrome-extension://extension-id/sidebar.html' }],
    [request, { ...sender, url: 'file:///tmp/page.html', tab: { id: 42, url: 'file:///tmp/page.html' } }],
  ] as const;
  for (const [message, source] of denied) expect(bridge.handle(message, source as chrome.runtime.MessageSender)).toBeUndefined();
  expect(calls).toBe(0);
});

test('derives execution identity from the sender and accepts exactly one valid plus two clean nulls', async () => {
  const values = [react, null, null];
  const executions: unknown[] = [];
  let preferenceReads = 0;
  const bridge = broker(async (_probe, probeTarget, execution) => {
    executions.push({ probeTarget, execution });
    return values.shift();
  }, async () => { preferenceReads++; return true; });

  await expect(bridge.handle(request, sender)).resolves.toEqual({
    version: 1, framework: 'react', provenance: 'react-dom-fiber-dev', path: ['App', 'Button'], truncated: false,
  });
  expect(executions).toEqual(Array(3).fill({ probeTarget: target, execution: { tabId: 42, documentId: 'document-1' } }));
  expect(preferenceReads).toBe(4);
});

test('keeps no hint for ambiguous, all-none, malformed, oversized, or rejected probe outcomes', async () => {
  const cases: unknown[][] = [
    [react, vue, null],
    [null, react, null],
    [null, null, null],
    ['not json', null, null],
    ['x'.repeat(2_049), null, null],
    [JSON.stringify({ version: 1, framework: 'vue', provenance: 'react-dom-fiber-dev', path: ['App'], truncated: false }), null, null],
  ];
  for (const values of cases) {
    const bridge = broker(async () => values.shift());
    await expect(bridge.handle(request, sender)).resolves.toBeNull();
  }
  const rejected = broker(async () => { throw new Error('hostile page secret'); });
  await expect(rejected.handle(request, sender)).resolves.toBeNull();
});

test('classifies only literal null as clean none and validates bounded result strings', () => {
  expect(classifyComponentContextProbeResult(null)).toEqual({ kind: 'none' });
  expect(classifyComponentContextProbeResult(undefined)).toEqual({ kind: 'indeterminate' });
  expect(classifyComponentContextProbeResult({})).toEqual({ kind: 'indeterminate' });
  expect(classifyComponentContextProbeResult(react)).toEqual({ kind: 'valid', value: JSON.parse(react) });
  expect(classifyComponentContextProbeResult(`${react} `)).toEqual({ kind: 'valid', value: JSON.parse(react) });
});

test('extension runner targets the authenticated document when supplied and never retries with broader frame scope', async () => {
  const calls: unknown[] = [];
  const api = { scripting: { async executeScript(details: unknown) {
    calls.push(details);
    return [{ frameId: 0, documentId: 'document-1', result: react }];
  } } } as unknown as typeof chrome;
  const runner = createExtensionComponentContextProbeRunner(api);
  await expect(runner(probes[0], target, { tabId: 42, documentId: 'document-1' })).resolves.toBe(react);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ target: { tabId: 42, documentIds: ['document-1'] }, world: 'MAIN', args: [target] });

  const unavailable = { scripting: { async executeScript() { calls.push('rejected'); throw new Error('engine failure detail'); } } } as unknown as typeof chrome;
  await expect(createExtensionComponentContextProbeRunner(unavailable)(probes[0], target, { tabId: 42, documentId: 'document-1' }))
    .rejects.toThrow(COMPONENT_CONTEXT_PROBE_FAILURE);
  expect(calls.filter(call => call === 'rejected')).toHaveLength(1);

  const firefoxError = { scripting: { async executeScript() {
    return [{ frameId: 0, documentId: 'document-1', error: new Error('page-owned secret') }];
  } } } as unknown as typeof chrome;
  await expect(createExtensionComponentContextProbeRunner(firefoxError)(probes[0], target, { tabId: 42, documentId: 'document-1' }))
    .rejects.toThrow(COMPONENT_CONTEXT_PROBE_FAILURE);
});

test('extension runner falls back to the already-authenticated top frame only when no sender document ID exists', async () => {
  let details: any;
  const api = { scripting: { async executeScript(value: unknown) { details = value; return [{ frameId: 0, result: null }]; } } } as unknown as typeof chrome;
  await expect(createExtensionComponentContextProbeRunner(api)(probes[0], target, { tabId: 42 })).resolves.toBeNull();
  expect(details.target).toEqual({ tabId: 42, frameIds: [0] });
  expect(details.target).not.toHaveProperty('documentIds');
});

test('checks the committed setting before every probe and again before returning', async () => {
  let enabled = true;
  let calls = 0;
  const disabled = broker(async () => { calls++; return null; }, async () => false);
  await expect(disabled.handle(request, sender)).resolves.toBeNull();
  expect(calls).toBe(0);

  const bridge = broker(async () => { calls++; if (calls === 1) enabled = false; return calls === 1 ? react : null; }, async () => enabled);
  await expect(bridge.handle(request, sender)).resolves.toBeNull();
  expect(calls).toBe(1);
});

test('a committed off epoch invalidates an in-flight result even after the setting is re-enabled', async () => {
  let release!: (value: unknown) => void;
  let started!: () => void;
  const pending = new Promise<unknown>(resolve => { release = resolve; });
  const running = new Promise<void>(resolve => { started = resolve; });
  let calls = 0;
  const bridge = broker(async () => { calls++; started(); return pending; });
  const result = bridge.handle(request, sender)!;
  await running;
  bridge.preferenceChanged(false);
  bridge.preferenceChanged(true);
  release(react);
  await expect(result).resolves.toBeNull();
  expect(calls).toBe(1);
});

test('shares one deadline across sequential probes and retains the per-tab lock until timed-out work settles', async () => {
  let release!: (value: unknown) => void;
  const pending = new Promise<unknown>(resolve => { release = resolve; });
  let calls = 0;
  const bridge = broker(async () => { calls++; return calls === 1 ? pending : null; }, async () => true, 10);
  await expect(bridge.handle(request, sender)).resolves.toBeNull();
  expect(calls).toBe(1);
  await expect(bridge.handle(request, sender)).resolves.toBeNull();
  expect(calls).toBe(1);
  release(null);
  await new Promise(resolve => setTimeout(resolve, 0));
  await expect(bridge.handle(request, sender)).resolves.toBeNull();
  expect(calls).toBe(4);
});

class FakeElement {
  localName = 'button';
  isConnected = true;
  attributes = new Map<string, string>();
  hasAttribute(name: string) { return this.attributes.has(name); }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string) { this.attributes.delete(name); }
}

const cryptoStub = { getRandomValues(bytes: Uint8Array) { bytes.fill(0xab); return bytes; } } as unknown as Crypto;

test('client sends only the bounded target request, revalidates the DTO, and always removes its owned marker', async () => {
  const element = new FakeElement();
  let sent: unknown;
  const api = { async sendMessage(message: unknown) {
    sent = message;
    const markerName = (message as ComponentContextBridgeRequest).markerName;
    expect(element.attributes.get(markerName)).toBe('');
    return { ok: true, value: JSON.parse(react) };
  } };
  const result = await requestComponentContext(api, element as unknown as Element, target.selectorPath, new AbortController().signal, { crypto: cryptoStub });
  expect(result).toEqual(JSON.parse(react));
  expect(sent).toEqual({ ...request, markerName: `data-anmerko-context-${'ab'.repeat(16)}` });
  expect(element.attributes.size).toBe(0);
  expect(Object.keys(sent as object).sort()).toEqual(['expectedTag', 'markerName', 'selectorPath', 'type', 'version']);
});

test('client cancellation, timeout, malformed response, and changed marker all fail closed', async () => {
  const aborted = new AbortController(); aborted.abort();
  let calls = 0;
  await expect(requestComponentContext({ async sendMessage() { calls++; } }, new FakeElement() as unknown as Element,
    ['button'], aborted.signal, { crypto: cryptoStub })).resolves.toBeNull();
  expect(calls).toBe(0);

  const timed = new FakeElement();
  await expect(requestComponentContext({ sendMessage: async () => new Promise(() => {}) }, timed as unknown as Element,
    ['button'], new AbortController().signal, { crypto: cryptoStub, deadlineMs: 5 })).resolves.toBeNull();
  expect(timed.attributes.size).toBe(0);

  const malformed = new FakeElement();
  await expect(requestComponentContext({ async sendMessage() { return { ok: true, value: { ...JSON.parse(react), source: 'secret' } }; } },
    malformed as unknown as Element, ['button'], new AbortController().signal, { crypto: cryptoStub })).resolves.toBeNull();
  expect(malformed.attributes.size).toBe(0);

  const changed = new FakeElement();
  await expect(requestComponentContext({ async sendMessage(message) {
    changed.attributes.set((message as ComponentContextBridgeRequest).markerName, 'page-owned');
    return { ok: true, value: JSON.parse(react) };
  } }, changed as unknown as Element, ['button'], new AbortController().signal, { crypto: cryptoStub })).resolves.toBeNull();
  expect([...changed.attributes.values()]).toEqual(['page-owned']);
});
