import test from 'node:test';
import assert from 'node:assert/strict';
import { browser, bundle, envelope, diagnostics } from './helpers.mjs';
function client() {
  const ctx = browser(['content/crypto', 'content/room-client']);
  const c = new ctx.Cwtch.RoomClient({
    bundle,
    identity: { id: 'client000000001' },
    diagnostics: diagnostics(),
  });
  c.joined = true;
  c.connected = true;
  c.members = ['client000000001', 'client000000002'];
  c.port = { postMessage() {} };
  return { ctx, c };
}
test('outbound encryption is serialized and seq assigned in invocation order', async () => {
  const { c } = client(),
    sent = [];
  c.sendRaw = (e) => {
    sent.push(e);
    return true;
  };
  const original = c.crypto.encrypt.bind(c.crypto);
  let first = true;
  c.crypto.encrypt = async (...args) => {
    if (first) {
      first = false;
      await new Promise((r) => setTimeout(r, 30));
    }
    return original(...args);
  };
  await Promise.all([
    c.send('reaction', { reaction: '♡' }),
    c.send('reaction', { reaction: '😂' }),
  ]);
  assert.deepEqual(
    sent.map((e) => e.seq),
    [0, 1],
  );
  assert.equal((await c.crypto.decrypt(sent[0].payload, sent[0])).data.reaction, '♡');
  c.close();
});
test('offline playback and reactions are never replayed', async () => {
  const { c } = client();
  c.joined = false;
  assert.equal(await c.send('reaction', { reaction: '♡' }), false);
  assert.equal(c.seq, 0);
  c.close();
});
test('duplicate chat is acknowledged but rendered once', async () => {
  const { c } = client();
  const received = [];
  c.addEventListener('payload', (e) => received.push(e.detail));
  for (let seq = 0; seq < 2; seq++) {
    const metadata = { v: 2, type: 'relay', ...envelope, senderId: 'client000000002', seq };
    metadata.payload = await c.crypto.encrypt(
      {
        type: 'chat',
        senderId: metadata.senderId,
        sentServerTime: Date.now(),
        data: { id: 'message000001', text: 'hi', time: Date.now() },
      },
      metadata,
    );
    await c.handleMessage(JSON.stringify(metadata));
  }
  assert.equal(received.length, 1);
  c.close();
});
test('stale ephemeral messages are discarded', async () => {
  const { c } = client();
  let count = 0;
  c.addEventListener('payload', () => count++);
  const m = { v: 2, type: 'relay', ...envelope, senderId: 'client000000002' };
  m.payload = await c.crypto.encrypt(
    {
      type: 'reaction',
      senderId: m.senderId,
      sentServerTime: Date.now() - 60000,
      data: { reaction: '♡' },
    },
    m,
  );
  await c.handleMessage(JSON.stringify(m));
  assert.equal(count, 0);
  c.close();
});
test('disconnect marks pending delivery unconfirmed and clears presence', async () => {
  const { c } = client(),
    statuses = [];
  c.addEventListener('delivery', (e) => statuses.push(e.detail.status));
  await c.send('chat', { id: 'message000001', text: 'hi', time: Date.now() });
  c.disconnected();
  assert.deepEqual(statuses, ['sending', 'unconfirmed']);
  assert.equal(c.members.length, 0);
  c.close();
});
test('tampered routing metadata cannot decrypt', async () => {
  const { c } = client();
  const m = { v: 2, type: 'relay', ...envelope, senderId: 'client000000002' };
  m.payload = await c.crypto.encrypt(
    { type: 'nudge', senderId: m.senderId, sentServerTime: Date.now(), data: {} },
    m,
  );
  m.seq++;
  await assert.rejects(c.handleMessage(JSON.stringify(m)));
  c.close();
});

test('a disconnect invalidates decryption already in progress', async () => {
  const { c } = client();
  let finish;
  const metadata = { v: 2, type: 'relay', ...envelope, senderId: 'client000000002' };
  c.crypto.decrypt = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  let received = 0;
  c.addEventListener('payload', () => received++);
  const handling = c.handleMessage(JSON.stringify(metadata));
  c.disconnected();
  finish({ type: 'nudge', senderId: metadata.senderId, sentServerTime: Date.now(), data: {} });
  await handling;
  assert.equal(received, 0);
  c.close();
});
