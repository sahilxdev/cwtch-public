import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import WebSocket from '../relay/node_modules/ws/index.js';
import { browser } from '../tests/helpers.mjs';

const target = process.argv[2];
if (!target) throw new Error('Usage: node scripts/relay-smoke.mjs wss://HOST/ws');
const { Cwtch: C } = browser(['content/crypto']);
const url = C.utils.validateRelayUrl(target);
const origin = 'chrome-extension://' + 'a'.repeat(32);
const sockets = [];
const id = () => randomBytes(18).toString('base64url');
const roomId = id();
const crypto = new C.RoomCrypto(randomBytes(32).toString('base64url'), roomId);
const auth = await crypto.auth();
const timeout = () => AbortSignal.timeout(15000);
function next(socket, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => finish(reject, new Error(`Timed out waiting for ${type}`)),
      15000,
    );
    function finish(callback, value) {
      clearTimeout(timer);
      socket.off('message', onMessage);
      socket.off('error', onError);
      callback(value);
    }
    function onError(error) {
      finish(reject, error);
    }
    function onMessage(raw) {
      try {
        const data = JSON.parse(raw);
        if (data.type === type) finish(resolve, data);
      } catch (error) {
        finish(reject, error);
      }
    }
    socket.on('message', onMessage);
    socket.on('error', onError);
  });
}
async function connect() {
  const socket = new WebSocket(url, { origin, handshakeTimeout: 15000 });
  sockets.push(socket);
  await once(socket, 'open', { signal: timeout() });
  return socket;
}
async function join(socket, clientId, roomAuth = auth, expected = 'joined') {
  const sessionId = id();
  const response = next(socket, expected);
  socket.send(JSON.stringify({ v: 2, type: 'join', roomId, clientId, sessionId, auth: roomAuth }));
  return { socket, clientId, sessionId, response: await response };
}
async function exchange(from, to, seq, text) {
  const envelope = {
    v: 2,
    type: 'relay',
    roomId,
    senderId: from.clientId,
    sessionId: from.sessionId,
    seq,
  };
  const message = {
    type: 'chat',
    senderId: from.clientId,
    sentServerTime: Date.now(),
    data: { text, id: id() },
  };
  envelope.payload = await crypto.encrypt(message, envelope);
  const received = next(to.socket, 'relay');
  from.socket.send(JSON.stringify(envelope));
  const forwarded = await received;
  assert.equal((await crypto.decrypt(forwarded.payload, forwarded)).data.text, text);
  return envelope;
}
try {
  const healthUrl = new URL('/ready', url.replace(/^ws/, 'http'));
  const health = await fetch(healthUrl, { signal: AbortSignal.timeout(90000) });
  assert.equal(health.status, 200);
  assert.equal((await health.json()).protocol, 2);
  const probe = await connect();
  const probeReply = next(probe, 'health');
  probe.send(JSON.stringify({ v: 2, type: 'health' }));
  assert.equal((await probeReply).ok, true);
  console.log('PASS HTTP readiness and extension-origin WebSocket health');

  const a = await join(await connect(), id());
  assert.equal(a.response.occupants, 1);
  const unauthorized = await join(await connect(), id(), id() + 'a'.repeat(19), 'error');
  assert.equal(unauthorized.response.code, 'AUTH_FAILED');
  const joined = next(a.socket, 'peer_joined');
  const b = await join(await connect(), id());
  assert.equal(b.response.occupants, 2);
  await joined;
  const full = await join(await connect(), id(), auth, 'error');
  assert.equal(full.response.code, 'ROOM_FULL');
  console.log('PASS membership, room authentication and two-person capacity');

  await exchange(a, b, 0, 'Public relay encrypted message A to B');
  await exchange(b, a, 0, 'Public relay encrypted message B to A');
  const left = next(b.socket, 'peer_left');
  a.socket.close();
  assert.equal((await left).leaderId, b.clientId);
  const rejoined = next(b.socket, 'peer_joined');
  const replacement = await join(await connect(), a.clientId);
  await rejoined;
  const envelope = await exchange(replacement, b, 0, 'Encrypted message after reconnect');
  const replay = next(replacement.socket, 'error');
  replacement.socket.send(JSON.stringify(envelope));
  assert.equal((await replay).code, 'INVALID_SEQUENCE');
  console.log('PASS bidirectional AES-GCM, leader transfer, reconnection and replay rejection');

  const bad = new WebSocket(url, { origin: 'https://example.com', handshakeTimeout: 15000 });
  sockets.push(bad);
  const [error] = await once(bad, 'error', { signal: timeout() });
  assert.match(error.message, /403/);
  console.log('PASS unauthorized browser origin rejected');
  console.log(
    'PASS relay smoke test (two network clients on this computer; not a two-device player test)',
  );
} finally {
  for (const socket of sockets) socket.terminate();
}
