type ClosingLayout = 'overlay' | 'minimized' | 'closed';
const ownerBarrier = Symbol('sidebar owner barrier');
type Owner = { [ownerBarrier]?: Promise<void> };
type Request = Owner & {
  tabId: number;
  windowId: number;
  version: number;
  ready: boolean;
  layoutAccepted: boolean;
  activation: Promise<boolean>;
};
type Operations = {
  activate(tabId: number, windowId: number): Promise<void>;
  view(tabId: number): Promise<unknown>;
  closed(tabId: number): Promise<unknown>;
  layout(tabId: number, windowId: number, mode: ClosingLayout, state?: unknown): Promise<void>;
};

const closingLayouts = new Set<ClosingLayout>(['overlay', 'minimized', 'closed']);
const barrierFor = (value: object | undefined) => value && ownerBarrier in value
  ? (value as Owner)[ownerBarrier]
  : undefined;

// Each request owns its page until a newer request takes over or its port closes.
// A delayed activation must not hide the resume button after sidebar dismissal.
export function bindSidebarConnection(port: chrome.runtime.Port, operations: Operations, owners: Map<number, object>) {
  let current: Request | undefined;
  let disconnected = false;
  const owns = (request: Request) => owners.get(request.tabId) === request;
  const active = (request: Request) => !disconnected && current === request && owns(request);
  const restore = async (request: Request) => {
    if (!owners.has(request.tabId)) await operations.closed(request.tabId).catch(() => {});
  };
  const release = (request: Request) => {
    if (!owns(request)) { void restore(request); return; }
    const barrier = request[ownerBarrier];
    if (!barrier) { owners.delete(request.tabId); void restore(request); return; }
    // Preserve an accepted layout handoff even when a waiting replacement closes.
    const marker: Owner = { [ownerBarrier]: barrier };
    owners.set(request.tabId, marker);
    void barrier.then(async () => {
      if (owners.get(request.tabId) === marker) owners.delete(request.tabId);
      await restore(request);
    });
  };
  const respond = (request: Request, result: object) => {
    if (!active(request)) return;
    // Context destruction can precede delivery of the disconnect event.
    try { port.postMessage({ version: request.version, ...result }); } catch { /* The sidebar has closed. */ }
  };
  port.onMessage.addListener(message => {
    if (disconnected) return;
    if (message?.type === 'ANMERKO_SIDEBAR_LAYOUT') {
      const request = current;
      if (!request || message.version !== request.version || !active(request) || !closingLayouts.has(message.mode)) return;
      request.layoutAccepted = true;
      current = undefined;
      let finishHandoff!: () => void;
      const handoff: Owner = {
        [ownerBarrier]: new Promise<void>(resolve => { finishHandoff = resolve; }),
      };
      owners.set(request.tabId, handoff);
      const layout = request.ready
        ? operations.layout(request.tabId, request.windowId, message.mode, message.state)
        : (async () => {
          if (!await request.activation) throw new Error('Sidebar activation failed.');
          await operations.layout(request.tabId, request.windowId, message.mode, message.state);
        })();
      void layout.catch(async () => {
        if (owners.get(request.tabId) === handoff) owners.delete(request.tabId);
        await restore(request);
        if (disconnected) return;
        try {
          port.postMessage({
            type: 'ANMERKO_SIDEBAR_LAYOUT_ERROR', version: request.version,
            code: 'layout-failed', error: 'Could not change layout.',
          });
        } catch { /* The sidebar closed while the layout was changing. */ }
      }).finally(() => {
        if (owners.get(request.tabId) === handoff) owners.delete(request.tabId);
        finishHandoff();
      });
      return;
    }
    if (!Number.isInteger(message.tabId) || !Number.isInteger(message.windowId) || !Number.isInteger(message.version)) return;
    if (current && current.tabId !== message.tabId) release(current);
    const previous = owners.get(message.tabId);
    const request: Request = {
      [ownerBarrier]: barrierFor(previous),
      tabId: message.tabId, windowId: message.windowId, version: message.version,
      ready: false, layoutAccepted: false, activation: Promise.resolve(false),
    };
    current = request;
    owners.set(request.tabId, request);
    request.activation = (async () => {
      try {
        if (request[ownerBarrier]) await request[ownerBarrier];
        if (!request.layoutAccepted && !active(request)) { await restore(request); return false; }
        await operations.activate(request.tabId, request.windowId);
        if (!request.layoutAccepted && !active(request)) { await restore(request); return false; }
        return true;
      } catch (error) {
        respond(request, { ok: false, error: String(error) });
        return false;
      }
    })();
    void (async () => {
      try {
        if (!await request.activation || request.layoutAccepted) return;
        if (!active(request)) { await restore(request); return; }
        const value = await operations.view(request.tabId);
        if (request.layoutAccepted) return;
        if (!active(request)) { await restore(request); return; }
        request.ready = true;
        respond(request, { ok: true, value });
      } catch (error) {
        respond(request, { ok: false, error: String(error) });
      }
    })();
  });
  port.onDisconnect.addListener(() => {
    disconnected = true;
    if (current) release(current);
  });
}
