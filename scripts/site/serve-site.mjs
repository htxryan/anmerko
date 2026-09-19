import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, join } from 'node:path';
const root = resolve('site/dist');
const port = Number(process.env.SITE_PORT || 4174);
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.vtt': 'text/vtt; charset=utf-8', '.zip': 'application/zip', '.xpi': 'application/x-xpinstall', '.json': 'application/json', '.wasm': 'application/wasm' };
// Match the global security headers used by Workers static assets.
const headers = Object.fromEntries((await readFile(join(root, '_headers'), 'utf8')).split('\n')
  .filter(line => /^\s+[^:]+:/.test(line)).map(line => {
    const colon = line.indexOf(':');
    return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()];
  }));
createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); }
  catch { res.writeHead(400); res.end('Invalid path'); return; }
  const file = resolve(root, '.' + pathname);
  if (file !== root && !file.startsWith(root + '/')) { res.writeHead(403); res.end(); return; }
  try {
    const target = pathname.endsWith('/') || !extname(pathname) ? join(file, 'index.html') : file;
    const body = await readFile(target);
    res.writeHead(200, { ...headers, 'Content-Type': types[extname(target)] || 'application/octet-stream' });
    res.end(body);
  }
  catch {
    res.writeHead(404, { ...headers, 'Content-Type': types['.html'] });
    res.end(await readFile(join(root, '404.html')));
  }
}).listen(port, '127.0.0.1', () => console.log(`Local site preview → http://127.0.0.1:${port}`));
