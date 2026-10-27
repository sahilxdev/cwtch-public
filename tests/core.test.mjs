import test from 'node:test';
import assert from 'node:assert/strict';
import { browser, bundle, envelope } from './helpers.mjs';
import { RoomRegistry } from '../relay/src/room-registry.js';
import { SlidingWindowLimiter } from '../relay/src/rate-limiter.js';
import {
  validateJoin,
  validateRelay,
  originAllowed,
  parseJsonMessage,
} from '../relay/src/validation.js';

test('invites round-trip and strip the fragment from destination', () => {
  const { Cwtch: C } = browser();
  const url = C.utils.buildInviteUrl(bundle);
  assert.equal(C.utils.normalizeInviteInput(url).roomId, bundle.roomId);
  assert.equal(C.utils.validateContentUrl(url), bundle.contentUrl);
});
for (const [name, patch] of [
  ['expired', { expiresAt: 1 }],
  ['old protocol', { v: 1 }],
  ['wrong key size', { secret: 'a'.repeat(40) }],
  ['unsafe destination', { contentUrl: 'https://youtube.com.evil.test/watch' }],
  ['wrong platform', { platform: 'netflix' }],
  ['public insecure relay', { relayUrl: 'ws://example.com/ws' }],
  ['credential relay', { relayUrl: 'wss://user:password@example.com/ws' }],
]) {
  test(`reject ${name}`, () => {
    const { Cwtch: C } = browser();
    assert.throws(() => C.utils.decodeBundle(C.utils.encodeBundle({ ...bundle, ...patch })));
  });
}
test('oversized input and local content URLs are rejected', () => {
  const { Cwtch: C } = browser();
  assert.throws(() => C.utils.decodeBundle('a'.repeat(20000)));
  assert.throws(() => C.utils.validateContentUrl('http://localhost/private'));
});
test('AES-GCM roundtrip and metadata tamper resistance', async () => {
  const { Cwtch: C } = browser(['content/crypto']);
  const crypto = new C.RoomCrypto(bundle.secret, bundle.roomId);
  const encrypted = await crypto.encrypt({ hello: 'world' }, envelope);
  assert.equal((await crypto.decrypt(encrypted, envelope)).hello, 'world');
  for (const key of ['roomId', 'senderId', 'sessionId', 'seq'])
    await assert.rejects(
      crypto.decrypt(encrypted, { ...envelope, [key]: key === 'seq' ? 2 : 'tampered' }),
    );
  assert.equal((await crypto.auth()).length, 43);
  assert.notEqual(
    await crypto.auth(),
    await new C.RoomCrypto(Buffer.alloc(32, 6).toString('base64url'), bundle.roomId).auth(),
  );
});
test('room authentication, capacity, replacement and leader transfer', () => {
  const r = new RoomRegistry(),
    closed = [];
  const a = { close: (code) => closed.push(code) },
    b = {},
    replacement = {};
  assert.equal(r.join('room', 'alice', a, 0, 'auth').leaderId, 'alice');
  assert.equal(r.join('room', 'bob', b, 1, 'wrong').code, 'AUTH_FAILED');
  assert.equal(r.join('room', 'bob', b, 1, 'auth').occupants, 2);
  assert.equal(r.join('room', 'carol', {}, 2, 'auth').code, 'ROOM_FULL');
  r.join('room', 'alice', replacement, 3, 'auth');
  assert.deepEqual(closed, [4009]);
  assert.equal(r.leave('room', 'alice', a), false);
  assert.equal(r.occupants('room'), 2);
  assert.equal(r.leave('room', 'alice', replacement), true);
  assert.equal(r.membership('room').leaderId, 'bob');
});
test('room expiry and slow client backpressure', () => {
  const r = new RoomRegistry({ idleTtlMs: 100 }),
    closed = [];
  r.join(
    'room',
    'alice',
    { readyState: 1, bufferedAmount: 300000, close: (code) => closed.push(code) },
    0,
    'auth',
  );
  assert.equal(r.relay('room', 'bob', 'x', 1), 0);
  assert.deepEqual(closed, [4010]);
  r.touch('room', 90);
  assert.equal(r.sweep(110).length, 0);
  assert.equal(r.sweep(191).length, 1);
});
test('strict relay envelopes and allowed origins', () => {
  assert.equal(validateJoin({ v: 1, type: 'join' }).code, 'PROTOCOL_MISMATCH');
  assert.equal(
    validateRelay({
      v: 2,
      type: 'relay',
      seq: 0,
      sessionId: 'session00000001',
      payload: { iv: 'a'.repeat(16), ciphertext: 'b'.repeat(22) },
    }).ok,
    true,
  );
  assert.equal(validateRelay({ v: 2, type: 'relay', seq: NaN }).ok, false);
  assert.equal(
    originAllowed('chrome-extension://' + 'a'.repeat(32), ['chrome-extension://*']),
    true,
  );
  assert.equal(originAllowed('chrome-extension://evil/path', ['chrome-extension://*']), false);
  assert.equal(originAllowed('', ['chrome-extension://*']), false);
  assert.equal(parseJsonMessage('[]', 100).ok, false);
  assert.equal(parseJsonMessage('x'.repeat(101), 100).code, 'PAYLOAD_TOO_LARGE');
});
test('rate limit releases capacity after the window', () => {
  const l = new SlidingWindowLimiter(2, 100);
  assert.equal(l.accept(0), true);
  assert.equal(l.accept(1), true);
  assert.equal(l.accept(2), false);
  assert.equal(l.accept(101), true);
});
test('diagnostic report redacts URLs, keys and strings', () => {
  const { Cwtch: C } = browser(['content/diagnostics']);
  const d = new C.Diagnostics();
  d.record('INTERNAL_ERROR', 'error', {
    invite: 'secret',
    message: `failure ${C.utils.buildInviteUrl(bundle)}`,
    token: 'abc',
  });
  const json = JSON.stringify(d.snapshot());
  assert.ok(!json.includes(bundle.secret));
  assert.ok(!json.includes('watch?v='));
  assert.ok(!json.includes('"token":"abc"'));
  d.destroy();
});
test('decrypted application messages reject invalid numeric state and unknown types', () => {
  const { CwtchProtocol: P } = browser();
  const base = { senderId: envelope.senderId, sentServerTime: Date.now(), data: {} };
  assert.equal(P.application({ ...base, type: 'unknown' }), false);
  assert.equal(
    P.application({
      ...base,
      type: 'chat',
      data: { id: 'message000001', text: 'hello', time: Date.now() },
    }),
    true,
  );
  assert.equal(
    P.application({
      ...base,
      type: 'moment',
      data: { id: 'message000001', at: Infinity, note: 'x' },
    }),
    false,
  );
});
test('supported-domain redirect and browsing pages cannot be used as destinations', () => {
  const { Cwtch: C } = browser();
  for (const url of [
    'https://www.youtube.com/redirect?q=https://evil.test',
    'https://www.netflix.com/browse',
    'https://www.primevideo.com/',
  ])
    assert.throws(() => C.utils.validateContentUrl(url));
});
