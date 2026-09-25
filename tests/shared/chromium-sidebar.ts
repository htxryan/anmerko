import { expect, type BrowserContext, type Page } from '@playwright/test';

// Native side panels are separate CDP targets, not ordinary Playwright tabs.
// Attach to the real panel so viewport changes and browser close behavior are tested.
export async function sidebar(context: BrowserContext, page: Page) {
  const cdp = await context.newCDPSession(page);
  let targetId = '';
  let acquisition: { selectedTargetId: string; targets: { targetId: string; type: string; attached: boolean }[] } | undefined;
  await expect.poll(async () => {
    const targets = (await cdp.send('Target.getTargets')).targetInfos.filter(target => target.url.endsWith('/sidebar.html'));
    targetId = targets[0]?.targetId || '';
    acquisition = {
      selectedTargetId: targetId,
      targets: targets.map(target => ({ targetId: target.targetId, type: target.type, attached: target.attached })),
    };
    return targetId;
  }).not.toBe('');
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: false });
  let id = 0;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  cdp.on('Target.receivedMessageFromTarget', event => {
    if (event.sessionId !== sessionId) return;
    const response = JSON.parse(event.message);
    const request = pending.get(response.id);
    if (!request) return;
    pending.delete(response.id);
    if (response.error) request.reject(new Error(response.error.message));
    else request.resolve(response.result);
  });
  async function command(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const requestId = ++id;
    let timeout: ReturnType<typeof setTimeout>;
    try {
      return await new Promise((resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`Sidebar ${method} timed out: ${JSON.stringify(params)}`)), 10000);
        pending.set(requestId, { resolve, reject });
        void cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id: requestId, method, params }) }).catch(reject);
      });
    } finally { clearTimeout(timeout!); pending.delete(requestId); }
  }
  async function evaluate(expression: string) {
    const result = await command('Runtime.evaluate', { expression: `(() => { const root = document.querySelector('anmerko-overlay')?.shadowRoot; ${expression} })()`, returnByValue: true, awaitPromise: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text + JSON.stringify(result.exceptionDetails.exception));
    return result.result.value;
  }
  function click(selector: string) {
    // Floating/minimizing destroys this target. Let the evaluation reply leave
    // before closing it; Chrome 152 otherwise loses the response on macOS/Windows.
    // Keep other clicks synchronous so gesture-sensitive actions retain their gesture.
    const closesTarget = selector === '.dock' || selector === '.minimize';
    return evaluate(`const button = root.querySelector(${JSON.stringify(selector)}); if (!button) throw new Error('Sidebar button missing'); ${closesTarget ? 'setTimeout(() => button.click(), 0)' : 'button.click()'};`);
  }
  // A real mouse click. It focuses the side panel and reaches controls that
  // ignore untrusted events, such as Record journey.
  async function press(selector: string) {
    const point = await evaluate(`const element = root.querySelector(${JSON.stringify(selector)}); if (!element) throw new Error('Sidebar control missing: ' + ${JSON.stringify(selector)});
      element.scrollIntoView({ block: 'center', behavior: 'instant' }); const box = element.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };`);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await command('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', clickCount: 1 });
    }
  }
  async function targets() {
    const snapshot = await cdp.send('Target.getTargets');
    return snapshot.targetInfos.filter(target => target.url.endsWith('/sidebar.html')).map(target => ({
      targetId: target.targetId, type: target.type, attached: target.attached,
    }));
  }
  const surface = () => evaluate(`return {
    hidden: document.hidden, visibilityState: document.visibilityState,
    panelHidden: root?.querySelector('.panel')?.hidden ?? null,
    promptHidden: root?.querySelector('.connection-prompt')?.hidden ?? null,
    statusText: root?.querySelector('.status')?.textContent?.trim() || ''
  }`);
  await expect.poll(() => evaluate("return !!root?.querySelector('.panel') && root.querySelector('.connection-prompt').hidden")).toBe(true);
  return {
    targetId, acquisition: acquisition!, evaluate, command, click, press, targets, surface,
    value: (selector: string) => evaluate(`return root.querySelector(${JSON.stringify(selector)})?.value`),
    close: () => cdp.send('Target.closeTarget', { targetId }),
  };
}
