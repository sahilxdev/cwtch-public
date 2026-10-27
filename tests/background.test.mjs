import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
function setup() {
  const listeners = {},
    data = { local: {}, session: {} };
  const event = (name) => ({
    addListener: (fn) => {
      listeners[name] = fn;
    },
  });
  const area = (name) => ({
    get: async (keys) =>
      keys === null
        ? data[name]
        : Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((k) => [k, data[name][k]])),
    set: async (values) => Object.assign(data[name], values),
    remove: async (keys) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete data[name][k];
    },
  });
  const chrome = {
    runtime: {
      onInstalled: event('installed'),
      onStartup: event('startup'),
      onConnect: event('connect'),
      onMessage: event('message'),
    },
    storage: { local: area('local'), session: area('session') },
    tabs: { onRemoved: event('removed') },
  };
  class Socket extends EventTarget {
    static OPEN = 1;
    static CONNECTING = 0;
    constructor() {
      super();
      this.readyState = 0;
      this.bufferedAmount = 0;
      this.sent = [];
    }
    send(s) {
      this.sent.push(s);
    }
    close() {
      this.readyState = 3;
      this.dispatchEvent(new Event('close'));
    }
  }
  const ctx = vm.createContext({
    chrome,
    crypto: webcrypto,
    URL,
    btoa,
    Uint8Array,
    WebSocket: Socket,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    console,
  });
  ctx.importScripts = () =>
    vm.runInContext(
      readFileSync(new URL('../extension/shared/protocol.js', import.meta.url), 'utf8'),
      ctx,
    );
  vm.runInContext(
    readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8'),
    ctx,
  );
  const message = (m, id) =>
    new Promise((resolve) => listeners.message(m, { tab: { id } }, resolve));
  return { ctx, listeners, data, message };
}
test('room storage is isolated by tab and expires', async () => {
  const { message, data } = setup();
  const bundle = { expiresAt: Date.now() + 10000, roomId: 'room' };
  await message({ type: 'CWTCH_ROOM_SET', bundle }, 1);
  assert.equal((await message({ type: 'CWTCH_ROOM_GET' }, 2)).bundle, null);
  assert.equal((await message({ type: 'CWTCH_ROOM_GET' }, 1)).bundle.roomId, 'room');
  await message({ type: 'CWTCH_ROOM_CLEAR' }, 2);
  assert.ok(data.session['tab-room:1']);
  await message({ type: 'CWTCH_ROOM_SET', bundle: { ...bundle, expiresAt: 1 } }, 1);
  assert.equal((await message({ type: 'CWTCH_ROOM_GET' }, 1)).bundle, null);
});
test('tab identity survives refresh and is removed with its tab', async () => {
  const { message, listeners, data } = setup();
  const a = await message({ type: 'CWTCH_GET_TAB_CLIENT_ID' }, 1);
  const b = await message({ type: 'CWTCH_GET_TAB_CLIENT_ID' }, 1);
  assert.equal(a.clientId, b.clientId);
  listeners.removed(1);
  assert.equal(data.session['tab-client:1'], undefined);
});
test('socket transport does not queue stale messages offline', () => {
  const { ctx } = setup();
  const session = vm.runInContext('new SocketSession({postMessage(){}})', ctx);
  assert.equal(session.send('stale'), false);
  assert.equal(session.outbox.length, 0);
  session.close();
});
test('updating clears obsolete globally stored room keys', async () => {
  const { listeners, data } = setup();
  data.local.activeRoom = { secret: 'old' };
  data.local.activeRoomExpiresAt = 1;
  await listeners.installed();
  assert.equal(data.local.activeRoom, undefined);
  assert.equal(data.local.settings.showPrompts, true);
});
test('transport joins before sending and does not replay offline traffic', () => {
  const { ctx } = setup();
  const messages = [];
  ctx.testPort = { postMessage: (m) => messages.push(m) };
  const s = vm.runInContext('new SocketSession(testPort)', ctx);
  s.configure({ relayUrl: 'ws://localhost:8787/ws', joinPayload: { v: 2, type: 'join' } });
  assert.equal(s.send('old seek'), false);
  s.socket.readyState = 1;
  s.socket.dispatchEvent(new Event('open'));
  assert.equal(JSON.parse(s.socket.sent[0]).type, 'join');
  assert.equal(s.socket.sent.length, 1);
  assert.ok(messages.some((m) => m.type === 'socket-open'));
  s.close();
});

test('Render health checks retry a sleeping service and stop after success', async () => {
  const { ctx } = setup();
  ctx.setTimeout = (callback) => {
    callback();
    return 0;
  };
  vm.runInContext(
    `
    globalThis.probes = 0;
    probeRelayHealth = async () => {
      probes++;
      if (probes < 3) throw new Error('Service is waking');
      return { ok: true };
    };
  `,
    ctx,
  );
  assert.equal(
    (await vm.runInContext("checkRelayHealth('wss://test.onrender.com/ws')", ctx)).ok,
    true,
  );
  assert.equal(ctx.probes, 3);
});
test('Render health retries are bounded and local failures remain immediate', async () => {
  const { ctx } = setup();
  ctx.setTimeout = (callback) => {
    callback();
    return 0;
  };
  vm.runInContext(
    `
    globalThis.probes = 0;
    probeRelayHealth = async () => { probes++; throw new Error('Unavailable'); };
  `,
    ctx,
  );
  await assert.rejects(
    vm.runInContext("checkRelayHealth('wss://test.onrender.com/ws')", ctx),
    /Unavailable/,
  );
  assert.equal(ctx.probes, 15);
  ctx.probes = 0;
  await assert.rejects(
    vm.runInContext("checkRelayHealth('ws://localhost:8787/ws')", ctx),
    /Unavailable/,
  );
  assert.equal(ctx.probes, 1);
});
test('a wrong protocol fails immediately even on Render', async () => {
  const { ctx } = setup();
  vm.runInContext(
    `
    globalThis.probes = 0;
    probeRelayHealth = async () => {
      probes++;
      const error = new Error('Wrong protocol');
      error.name = 'RelayProtocolError';
      throw error;
    };
  `,
    ctx,
  );
  await assert.rejects(
    vm.runInContext("checkRelayHealth('wss://test.onrender.com/ws')", ctx),
    /Wrong protocol/,
  );
  assert.equal(ctx.probes, 1);
});
