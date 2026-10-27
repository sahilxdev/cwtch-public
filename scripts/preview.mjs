import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { createRelay } from '../relay/src/server.js';
const root = resolve('.');
const relay = createRelay({ allowedOrigins: ['http://127.0.0.1:8790'], logLevel: 'error' });
relay.server.listen(8791, '127.0.0.1');
const server = http.createServer(async (req, res) => {
  const path = resolve(root, '.' + new URL(req.url, 'http://localhost').pathname);
  if (!path.startsWith(root + sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    let data = await readFile(path);
    if (
      req.url.includes('fixture=1') &&
      ['popup.html', 'options.html'].some((name) => path.endsWith(name))
    ) {
      const mock = `<script src="/tests/fixtures/chrome-mock.js"></script><script>chrome.tabs={query:async()=>[{id:1,url:'https://www.youtube.com/watch?v=abcdef12345'}],sendMessage:(_id,m,cb)=>{if(m.type==='CWTCH_CREATE_ROOM')cb({ok:false,error:'The relay is offline. Start it in Settings.'});else cb({ok:true,supported:true,platform:'YouTube',title:'The quiet between',room:null});}};</script>`;
      data = Buffer.from(data.toString().replace('<head>', '<head>' + mock));
    }
    res.setHeader(
      'content-type',
      {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.svg': 'image/svg+xml',
      }[extname(path)] || 'application/octet-stream',
    );
    res.end(data);
  } catch {
    res.writeHead(404).end();
  }
});
server.listen(8790, '127.0.0.1', () =>
  console.log('Preview: http://127.0.0.1:8790/tests/fixtures/review.html'),
);
process.on('SIGTERM', async () => {
  await relay.close();
  server.close(() => process.exit(0));
});
