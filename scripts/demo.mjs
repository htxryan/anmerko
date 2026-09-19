import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
const html = await readFile(new URL('../tests/fixtures/demo/index.html', import.meta.url));
const server = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
});
server.listen(4173, '127.0.0.1', () => console.log('anmerko demo → http://127.0.0.1:4173'));
