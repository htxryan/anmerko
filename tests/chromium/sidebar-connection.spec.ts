import { test, expect } from '@playwright/test';
import { bindSidebarConnection } from '../../src/sidebar-connection';

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture(owners = new Map<number, object>()) {
  let receive!: (message: unknown) => void;
  let disconnect!: () => void;
  const replies: unknown[] = [];
  const modes = new Map<number, string>();
  const pending: { tabId: number; finish(): void }[] = [];
  const port = {
    onMessage: { addListener: (listener: typeof receive) => { receive = listener; } },
    onDisconnect: { addListener: (listener: typeof disconnect) => { disconnect = listener; } },
    postMessage: (message: unknown) => replies.push(message),
  } as unknown as chrome.runtime.Port;
  bindSidebarConnection(port, {
    activate: tabId => new Promise<void>(resolve => pending.push({ tabId, finish() { modes.set(tabId, 'remote'); resolve(); } })),
    view: async tabId => ({ url: `https://example.com/${tabId}` }),
    closed: async tabId => { modes.set(tabId, 'minimized'); },
  }, owners);
  return { receive, disconnect, replies, modes, pending, owners };
}

test('closing during startup restores the page after a delayed remote activation', async () => {
  const f = fixture();
  f.receive({ tabId: 1, version: 1 });
  f.disconnect();
  f.pending[0].finish();
  await flush();
  expect(f.modes.get(1)).toBe('minimized');
  expect(f.replies).toEqual([]);
  expect(f.owners.size).toBe(0);
});

test('switching tabs cannot let a late old connection hide that page again', async () => {
  const f = fixture();
  f.receive({ tabId: 1, version: 1 });
  f.receive({ tabId: 2, version: 2 });
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
  old.receive({ tabId: 1, version: 1 });
  replacement.receive({ tabId: 1, version: 1 });
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
  f.receive({ tabId: '1', version: 1 });
  f.receive({ tabId: 1 });
  f.disconnect();
  f.receive({ tabId: 1, version: 1 });
  expect(f.pending).toEqual([]);
});
