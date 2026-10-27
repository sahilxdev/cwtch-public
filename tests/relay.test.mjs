import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from '../relay/node_modules/ws/index.js';
import { createRelay } from '../relay/src/server.js';
const origin = 'chrome-extension://' + 'a'.repeat(32);
async function setup(t, options = {}) {
  const relay = createRelay({ port: 0, host: '127.0.0.1', logLevel: 'error', ...options });
  relay.server.listen(0, '127.0.0.1');
  await once(relay.server, 'listening');
  t.after(() => relay.close());
  return { relay, url: `ws://127.0.0.1:${relay.server.address().port}/ws` };
}
async function connect(url) {
  const ws = new WebSocket(url, { origin });
  await once(ws, 'open');
  return ws;
}
function next(ws) {
  return once(ws, 'message').then(([data]) => JSON.parse(data));
}
async function join(ws, id, auth = 'a'.repeat(43)) {
  const result = next(ws);
  ws.send(
    JSON.stringify({
      v: 2,
      type: 'join',
      roomId: 'room000000001',
      clientId: id,
      sessionId: 'session00000001',
      auth,
    }),
  );
  return result;
}
test('health endpoint, WebSocket probe and malformed origin', async (t) => {
  const { url } = await setup(t);
  const response = await fetch(url.replace('ws:', 'http:').replace('/ws', '/health'));
  assert.equal((await response.json()).protocol, 2);
  const ws = await connect(url),
    result = next(ws);
  ws.send(JSON.stringify({ v: 2, type: 'health' }));
  assert.equal((await result).ok, true);
  const bad = new WebSocket(url, { origin: 'https://example.com' });
  const [error] = await once(bad, 'error');
  assert.match(error.message, /403/);
});
test('two clients, third rejection, encrypted relay and duplicate replacement', async (t) => {
  const { url, relay } = await setup(t);
  const a = await connect(url),
    b = await connect(url);
  assert.equal((await join(a, 'client000000001')).occupants, 1);
  const peer = next(a);
  assert.equal((await join(b, 'client000000002')).occupants, 2);
  assert.equal((await peer).type, 'peer_joined');
  const c = await connect(url);
  assert.equal((await join(c, 'client000000003')).code, 'ROOM_FULL');
  const receive = next(b);
  a.send(
    JSON.stringify({
      v: 2,
      type: 'relay',
      roomId: 'room000000001',
      senderId: 'client000000001',
      sessionId: 'session00000001',
      seq: 0,
      payload: { iv: 'a'.repeat(16), ciphertext: 'b'.repeat(22) },
    }),
  );
  assert.equal((await receive).seq, 0);
  const replacement = await connect(url);
  await join(replacement, 'client000000001');
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(relay.registry.occupants('room000000001'), 2);
  const departed = next(b);
  replacement.close();
  assert.equal((await departed).leaderId, 'client000000002');
});
test('wrong room authentication is rejected', async (t) => {
  const { url } = await setup(t);
  const a = await connect(url),
    b = await connect(url);
  await join(a, 'client000000001');
  assert.equal((await join(b, 'client000000002', 'b'.repeat(43))).code, 'AUTH_FAILED');
});
test('unjoined sockets expire', async (t) => {
  const { url } = await setup(t, { joinTimeoutMs: 100 });
  const ws = await connect(url);
  const [code] = await once(ws, 'close');
  assert.equal(code, 4002);
});
test('rate limits close abusive clients', async (t) => {
  const { url } = await setup(t, { maxMessagesPerWindow: 2 });
  const ws = await connect(url);
  await join(ws, 'client000000001');
  const closed = once(ws, 'close');
  for (let i = 0; i < 3; i++) ws.send(JSON.stringify({ v: 2, type: 'ping', nonce: 'x' }));
  assert.equal((await closed)[0], 4011);
});
