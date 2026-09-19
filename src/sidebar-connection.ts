type Request = { tabId: number; version: number };
type Operations = {
  activate(tabId: number): Promise<void>;
  view(tabId: number): Promise<unknown>;
  closed(tabId: number): Promise<unknown>;
};

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
    if (owns(request)) owners.delete(request.tabId);
    void restore(request);
  };
  const respond = (request: Request, result: object) => {
    if (!active(request)) return;
    // Context destruction can precede delivery of the disconnect event.
    try { port.postMessage({ version: request.version, ...result }); } catch { /* The sidebar has closed. */ }
  };
  port.onMessage.addListener(message => {
    if (disconnected || !Number.isInteger(message.tabId) || !Number.isInteger(message.version)) return;
    if (current && current.tabId !== message.tabId) release(current);
    const request: Request = { tabId: message.tabId, version: message.version };
    current = request;
    owners.set(request.tabId, request);
    void (async () => {
      try {
        await operations.activate(request.tabId);
        if (!active(request)) { await restore(request); return; }
        const value = await operations.view(request.tabId);
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
