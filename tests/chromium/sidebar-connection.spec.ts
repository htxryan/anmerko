import { test, expect } from '@playwright/test';
import { bindSidebarConnection } from '../../src/sidebar-connection';

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture(owners = new Map<number, object>(), modes = new Map<number, string>()) {
  let receive!: (message: unknown) => void;
  let disconnect!: () => void;
  const replies: unknown[] = [];
  const pending: { tabId: number; finish(): void }[] = [];
  const layouts: { tabId: number; windowId: number; mode: string; state?: unknown }[] = [];
  const pendingLayouts: { finish(): void; fail(error: Error): void }[] = [];
  const port = {
    onMessage: { addListener: (listener: typeof receive) => { receive = listener; } },
    onDisconnect: { addListener: (listener: typeof disconnect) => { disconnect = listener; } },
    postMessage: (message: unknown) => replies.push(message),
  } as unknown as chrome.runtime.Port;
  bindSidebarConnection(port, {
    activate: tabId => new Promise<void>(resolve => pending.push({ tabId, finish() { modes.set(tabId, 'remote'); resolve(); } })),
    view: async tabId => ({ url: `https://example.com/${tabId}` }),
    closed: async tabId => { modes.set(tabId, 'minimized'); },
    layout: (tabId, windowId, mode, state) => new Promise<void>((resolve, reject) => {
      layouts.push({ tabId, windowId, mode, state });
      pendingLayouts.push({ finish() { modes.set(tabId, mode); resolve(); }, fail: reject });
    }),
  }, owners);
  return { receive, disconnect, replies, modes, pending, layouts, pendingLayouts, owners };
}

test('closing during startup restores the page after a delayed remote activation', async () => {
  const f = fixture();
  f.receive({ tabId: 1, windowId: 10, version: 1 });
  f.disconnect();
  f.pending[0].finish();
  await flush();
  expect(f.modes.get(1)).toBe('minimized');
  expect(f.replies).toEqual([]);
  expect(f.owners.size).toBe(0);
});

test('switching tabs cannot let a late old connection hide that page again', async () => {
  const f = fixture();
  f.receive({ tabId: 1, windowId: 10, version: 1 });
  f.receive({ tabId: 2, windowId: 10, version: 2 });
  f.pending[1].finish();
  await flush();
  f.pending[0].finish();
  await flush();
  expect(f.modes.get(1)).toBe('minimized');
  expect(f.modes.get(2)).toBe('remote');
  expect(f.replies).toEqual([{ version: 2, ok: true, value: { url: 'https://example.com/2' } }]);
});

test('an old sidebar disconnect cannot dismiss its replacement', async () => {
  const owners = new Map<number, object>();
  const old = fixture(owners), replacement = fixture(owners);
  old.receive({ tabId: 1, windowId: 10, version: 1 });
  replacement.receive({ tabId: 1, windowId: 10, version: 1 });
  replacement.pending[0].finish();
  await flush();
  old.disconnect();
  old.pending[0].finish();
  await flush();
  expect(old.modes.get(1)).toBe('remote');
  expect(replacement.modes.get(1)).toBe('remote');
  expect(old.replies).toEqual([]);
  expect(owners.size).toBe(1);
});

test('invalid and disconnected requests cannot start page activation', () => {
  const f = fixture();
  f.receive({ tabId: '1', windowId: 10, version: 1 });
  f.receive({ tabId: 1, windowId: '10', version: 1 });
  f.receive({ tabId: 1, windowId: 10 });
  f.disconnect();
  f.receive({ tabId: 1, windowId: 10, version: 1 });
  expect(f.pending).toEqual([]);
});

test('only the ready current owner can transfer a closing layout through the port', async () => {
  const f = fixture();
  f.receive({ tabId: 1, windowId: 10, version: 1 });
  f.receive({ type: 'ANMERKO_SIDEBAR_LAYOUT', version: 1, mode: 'overlay', state: { url: 'https://example.com/1' } });
  expect(f.layouts).toEqual([]);
  f.pending[0].finish();
  await flush();
  f.receive({ type: 'ANMERKO_SIDEBAR_LAYOUT', version: 2, mode: 'overlay' });
  f.receive({ type: 'ANMERKO_SIDEBAR_LAYOUT', version: 1, mode: 'dock' });
  expect(f.layouts).toEqual([]);
  f.receive({ type: 'ANMERKO_SIDEBAR_LAYOUT', version: 1, mode: 'overlay', state: { url: 'https://example.com/1' }, tabId: 99 });
  expect(f.layouts).toEqual([{
    tabId: 1, windowId: 10, mode: 'overlay', state: { url: 'https://example.com/1' },
  }]);
  f.disconnect();
  f.pendingLayouts[0].finish();
  await flush();
  expect(f.modes.get(1)).toBe('overlay');
});

test('a live port receives only a fixed layout failure and restores a safe page state', async () => {
  const f = fixture();
  f.receive({ tabId: 1, windowId: 10, version: 1 });
  f.pending[0].finish();
  await flush();
  f.receive({ type: 'ANMERKO_SIDEBAR_LAYOUT', version: 1, mode: 'overlay' });
  f.pendingLayouts[0].fail(new Error('private https://secret.example/value'));
  await flush();
  expect(f.modes.get(1)).toBe('minimized');
  expect(f.replies).toEqual([
    { version: 1, ok: true, value: { url: 'https://example.com/1' } },
    { type: 'ANMERKO_SIDEBAR_LAYOUT_ERROR', version: 1, code: 'layout-failed', error: 'Could not change layout.' },
  ]);
  expect(JSON.stringify(f.replies)).not.toContain('secret');
});

test('a failed transferred layout restores safely after the port disconnects without replying', async () => {
  const f = fixture();
  f.receive({ tabId: 1, windowId: 10, version: 1 });
  f.pending[0].finish();
  await flush();
  f.receive({ type: 'ANMERKO_SIDEBAR_LAYOUT', version: 1, mode: 'overlay' });
  f.disconnect();
  f.pendingLayouts[0].fail(new Error('private value'));
  await flush();
  expect(f.modes.get(1)).toBe('minimized');
  expect(f.replies).toEqual([{ version: 1, ok: true, value: { url: 'https://example.com/1' } }]);
});

test('a replacement owner waits for an accepted layout handoff and then wins', async () => {
  const owners = new Map<number, object>();
  const old = fixture(owners);
  old.receive({ tabId: 1, windowId: 10, version: 1 });
  old.pending[0].finish();
  await flush();
  old.receive({ type: 'ANMERKO_SIDEBAR_LAYOUT', version: 1, mode: 'overlay' });
  old.disconnect();

  const replacement = fixture(owners);
  replacement.receive({ tabId: 1, windowId: 10, version: 1 });
  await flush();
  expect(replacement.pending).toEqual([]);
  old.pendingLayouts[0].finish();
  await flush();
  expect(replacement.pending).toHaveLength(1);
  replacement.pending[0].finish();
  await flush();
  expect(old.modes.get(1)).toBe('overlay');
  expect(replacement.modes.get(1)).toBe('remote');
  expect(owners.size).toBe(1);
});

test('every replacement inherits an accepted layout handoff barrier', async () => {
  const owners = new Map<number, object>();
  const old = fixture(owners);
  old.receive({ tabId: 1, windowId: 10, version: 1 });
  old.pending[0].finish();
  await flush();
  old.receive({ type: 'ANMERKO_SIDEBAR_LAYOUT', version: 1, mode: 'overlay' });
  old.disconnect();

  const replacementA = fixture(owners), replacementB = fixture(owners);
  replacementA.receive({ tabId: 1, windowId: 10, version: 1 });
  replacementB.receive({ tabId: 1, windowId: 10, version: 1 });
  await flush();
  expect(replacementA.pending).toEqual([]);
  expect(replacementB.pending).toEqual([]);

  old.pendingLayouts[0].finish();
  await flush();
  expect(replacementA.pending).toEqual([]);
  expect(replacementB.pending).toHaveLength(1);
  replacementB.pending[0].finish();
  await flush();
  expect(replacementB.modes.get(1)).toBe('remote');
  expect(owners.size).toBe(1);
});

test('a replacement cancelled behind a layout handoff restores after the handoff finishes', async () => {
  const owners = new Map<number, object>(), modes = new Map<number, string>();
  const old = fixture(owners, modes);
  old.receive({ tabId: 1, windowId: 10, version: 1 });
  old.pending[0].finish();
  await flush();
  old.receive({ type: 'ANMERKO_SIDEBAR_LAYOUT', version: 1, mode: 'overlay' });
  old.disconnect();

  const replacement = fixture(owners, modes);
  replacement.receive({ tabId: 1, windowId: 10, version: 1 });
  replacement.disconnect();
  await flush();
  expect(modes.get(1)).toBe('remote');
  old.pendingLayouts[0].finish();
  await flush();
  expect(modes.get(1)).toBe('minimized');
  expect(owners.size).toBe(0);
});

test('a later replacement inherits the handoff after an earlier replacement disconnects', async () => {
  const owners = new Map<number, object>(), modes = new Map<number, string>();
  const old = fixture(owners, modes);
  old.receive({ tabId: 1, windowId: 10, version: 1 });
  old.pending[0].finish();
  await flush();
  old.receive({ type: 'ANMERKO_SIDEBAR_LAYOUT', version: 1, mode: 'overlay' });
  old.disconnect();

  const replacementA = fixture(owners, modes), replacementB = fixture(owners, modes);
  replacementA.receive({ tabId: 1, windowId: 10, version: 1 });
  replacementA.disconnect();
  replacementB.receive({ tabId: 1, windowId: 10, version: 1 });
  await flush();
  expect(replacementA.pending).toEqual([]);
  expect(replacementB.pending).toEqual([]);

  old.pendingLayouts[0].finish();
  await flush();
  expect(replacementA.pending).toEqual([]);
  expect(replacementB.pending).toHaveLength(1);
  replacementB.pending[0].finish();
  await flush();
  expect(modes.get(1)).toBe('remote');
  expect(owners.size).toBe(1);
});
