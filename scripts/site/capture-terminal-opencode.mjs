// Records a real OpenCode TUI session in a real terminal (headless-friendly).
//
// A local xterm.js page is attached over WebSocket to `opencode` running
// under node-pty. The copied brief is typed into a fresh prompt as raw
// keystrokes — bracketed paste would collapse into a "[Pasted ~N lines]"
// chip and hide the content — and the prompt is NEVER submitted: no tokens
// burn, no agent side effects.
//
// One-time setup (kept outside the repo: node-pty is native and finicky):
//   npm install --prefix /tmp/anmerko-term node-pty ws xterm @xterm/addon-fit
//   chmod +x /tmp/anmerko-term/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper
// Override with XTERM_DIR when the modules live elsewhere.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OVERLAY, caption } from './clip-helpers.mjs';

const MODULES = process.env.XTERM_DIR || '/tmp/anmerko-term/node_modules';

async function loadModules() {
  let pty, WebSocketServer;
  try {
    const { pathToFileURL } = await import('node:url');
    const { join: joinPath } = await import('node:path');
    pty = await import(pathToFileURL(joinPath(MODULES, 'node-pty/lib/index.js')).href);
    // ws is CJS without analyzable named exports: take Server off the default.
    ({ Server: WebSocketServer } = await import(pathToFileURL(joinPath(MODULES, 'ws/index.js')).href).then(m => m.default));
  } catch {
    throw new Error('Terminal recording needs node-pty and ws: npm install --prefix /tmp/anmerko-term node-pty ws xterm @xterm/addon-fit (see module header).');
  }
  return { pty, WebSocketServer };
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/xterm.css"><style>
html,body{margin:0;height:100%;background:#0b0e14;overflow:hidden}
#term{position:fixed;inset:12px}
</style></head><body><div id="term"></div>
<script src="/xterm.js"></script>
<script src="/addon-fit.js"></script>
<script>
const term = new Terminal({ fontSize: 13, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', theme: { background: '#0b0e14' } });
term.open(document.getElementById('term'));
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
fit.fit();
const ws = new WebSocket('ws://' + location.host + '/ws');
ws.onopen = () => ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
ws.onmessage = event => {
  const message = JSON.parse(event.data);
  if (message.type === 'output') term.write(message.data);
  if (message.type === 'ready') document.title = 'opencode-ready';
};
term.onData(data => ws.send(JSON.stringify({ type: 'input', data })));
term.onResize(({ cols, rows }) => ws.send(JSON.stringify({ type: 'resize', cols, rows })));
addEventListener('resize', () => fit.fit());
</script></body></html>`;

// Paste real brief text into a fresh opencode prompt. Never submits.
// Returns the page's recording path; the caller closes the context.
export async function recordTerminalPaste({ context, viewport, briefText, captionText = 'Paste the brief into your agent' }) {
  const { pty, WebSocketServer } = await loadModules();
  const xtermJs = await readFile(join(MODULES, 'xterm/lib/xterm.js'));
  const fitJs = await readFile(join(MODULES, '@xterm/addon-fit/lib/addon-fit.js'));
  const xtermCss = await readFile(join(MODULES, 'xterm/css/xterm.css'));

  let socket;
  let pasted = false;
  let pasteAt = 0;
  let cleanBuf = '';
  // Match against de-styled text: TUIs often split words with escape runs.
  // eslint-disable-next-line no-control-regex
  const stripAnsi = text => text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b[()][AB0]/g, '');
  const proc = pty.spawn('opencode', [], {
    name: 'xterm-256color', cols: 132, rows: 34,
    cwd: '/tmp/anmerko-term', env: process.env,
  });
  console.log('Terminal: opencode spawned, waiting for the prompt');
  const readyMessage = JSON.stringify({ type: 'ready' });
  proc.onData(data => {
    cleanBuf = stripAnsi(cleanBuf + data).slice(-4000);
    if (!pasted && /Ask anything/.test(cleanBuf)) {
      pasted = true;
      pasteAt = Date.now();
      // Typed, not bracketed-pasted: opencode collapses every multiline paste
      // into a "[Pasted ~N lines]" chip, which would hide the content this
      // clip exists to show. The bytes are exactly the copied brief, written
      // as keystrokes over ~2s so the arrival reads on screen. Never submitted.
      console.log(`Terminal: prompt ready, typing ${briefText.length} chars (never submitting)`);
      (async () => {
        const lines = briefText.split('\n');
        for (let i = 0; i < lines.length; i += 5) {
          proc.write(lines.slice(i, i + 5).join('\n') + (i + 5 < lines.length ? '\n' : ''));
          await new Promise(r => setTimeout(r, 350));
        }
        socket?.send(readyMessage);
      })();
    }
    socket?.send(JSON.stringify({ type: 'output', data }));
  });

  const server = createServer((req, res) => {
    const routes = {
      '/': [PAGE, 'text/html; charset=utf-8'],
      '/xterm.js': [xtermJs, 'text/javascript'],
      '/addon-fit.js': [fitJs, 'text/javascript'],
      '/xterm.css': [xtermCss, 'text/css'],
    };
    const route = routes[req.url];
    if (!route) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': route[1] });
    res.end(route[0]);
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', ws => {
    socket = ws;
    if (pasted) ws.send(readyMessage);
    ws.on('message', raw => {
      const message = JSON.parse(String(raw));
      if (message.type === 'input') proc.write(message.data);
      if (message.type === 'resize') proc.resize(message.cols, message.rows);
    });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const page = await context.newPage();
  const pageBorn = Date.now();
  await page.setViewportSize(viewport);
  try {
    await page.goto(origin);
    await page.evaluate(OVERLAY);
    // No pointer moves on this page: keep the overlay dot parked out of sight.
    await page.evaluate(() => { document.getElementById('anmerko-clip-cursor').hidden = true; });
    await page.waitForFunction(() => document.title === 'opencode-ready', null, { timeout: 30000 });
    await caption(page, captionText);
    // Let the typed brief sit readable in the prompt. Never press Enter.
    await page.waitForTimeout(3000);
    const video = await page.video().path();
    // Start ~1.4s before the first typed byte: the window gets a readable
    // beat with its empty prompt and caption before content streams in.
    const preRoll = Math.max(0, (pasteAt - pageBorn) / 1000 - 1.4);
    page._clipBorn = pageBorn;
    page._clipSs = preRoll;
    return { page, video, preRoll };
  } finally {
    // Terminate sockets first: server.close() waits for open connections.
    try { wss.clients.forEach(client => client.terminate()); } catch {}
    wss.close();
    proc.kill();
    await new Promise(done => { server.close(done); setTimeout(done, 3000); });
  }
}
