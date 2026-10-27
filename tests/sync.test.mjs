import test from 'node:test';
import assert from 'node:assert/strict';
import { browser, bundle, diagnostics } from './helpers.mjs';
class Media extends EventTarget {
  constructor() {
    super();
    this.currentTime = 10;
    this.duration = 300;
    this.paused = false;
    this.playbackRate = 1;
    this.readyState = 4;
    this.seekable = { length: 1, start: () => 0, end: () => 300 };
  }
  async play() {
    this.paused = false;
    this.dispatchEvent(new Event('play'));
  }
  pause() {
    this.paused = true;
    this.dispatchEvent(new Event('pause'));
  }
}
function setup() {
  const ctx = browser(['content/sync-engine'], { HTMLMediaElement: Media });
  const media = new Media();
  const room = Object.assign(new EventTarget(), {
    leaderId: 'client000000001',
    joined: true,
    serverNow: () => 100000,
    send: async () => true,
  });
  const platform = {
    id: 'youtube',
    supportsRateSync: true,
    isAdActive: () => false,
    getContentKey: () => bundle.contentKey,
    getContentUrl: () => bundle.contentUrl,
    getTitle: () => bundle.title,
    seek: async (m, t) => {
      m.currentTime = t;
    },
    play: (m) => m.play(),
    pause: (m) => m.pause(),
  };
  const engine = new ctx.Cwtch.SyncEngine({
    media,
    platform,
    roomClient: room,
    diagnostics: diagnostics(),
    identity: { id: 'client000000002' },
    roomBundle: bundle,
    settings: { softSync: true },
  });
  engine.running = true;
  const state = {
    contentKey: bundle.contentKey,
    mediaTime: 20,
    playbackRate: 1,
    paused: false,
    readyState: 4,
    adActive: false,
    sentServerTime: 100000,
    action: { clock: 1, actor: 'client000000001' },
  };
  return { engine, media, platform, room, state };
}
test('hard drift seeks to the projected timestamp', async () => {
  const { engine, media, state } = setup();
  await engine.applyRemoteState(state);
  assert.equal(media.currentTime, 20);
  engine.stop();
});
test('small drift gently adjusts rate', async () => {
  const { engine, media, state } = setup();
  await engine.applyRemoteState({ ...state, mediaTime: 10.5 });
  assert.ok(media.playbackRate > 1 && media.playbackRate <= 1.04);
  engine.stop();
});
test('ads, content mismatch and loading suspend corrections', async () => {
  for (const patch of [{ adActive: true }, { contentKey: 'youtube:other' }, { readyState: 1 }]) {
    const { engine, media, state } = setup();
    await engine.applyRemoteState({ ...state, ...patch });
    assert.equal(media.currentTime, 10);
    engine.stop();
  }
});
test('concurrent actions converge using logical clock and actor ordering', async () => {
  const { engine, media, state } = setup();
  engine.action = { clock: 2, actor: 'client000000002' };
  await engine.applyRemoteState({ ...state, action: { clock: 2, actor: 'client000000001' } });
  assert.equal(media.currentTime, 10);
  await engine.applyRemoteState({ ...state, action: { clock: 3, actor: 'client000000001' } });
  assert.equal(media.currentTime, 20);
  engine.stop();
});
test('seek clamps to an available range', async () => {
  const { engine, media, state } = setup();
  media.seekable = { length: 1, start: () => 30, end: () => 50 };
  await engine.applyRemoteState(state);
  assert.equal(media.currentTime, 30);
  engine.stop();
});
test('live media never receives a guessed absolute seek', async () => {
  const { engine, media, state } = setup();
  media.duration = Infinity;
  await engine.applyRemoteState(state);
  assert.equal(media.currentTime, 10);
  engine.stop();
});
test('relay membership elects the remaining participant', () => {
  const { engine, room } = setup();
  assert.equal(engine.isLeader(), false);
  room.leaderId = 'client000000002';
  assert.equal(engine.isLeader(), true);
  engine.stop();
});
test('resume uses the platform adapter', async () => {
  const { engine, platform } = setup();
  let calls = 0;
  platform.play = async () => calls++;
  assert.equal(await engine.resumeTogether(), true);
  assert.equal(calls, 1);
  engine.stop();
});
test('a newer user action wins while a protected player seek is pending', async () => {
  const { engine, media, platform, state } = setup();
  let resolve;
  platform.seek = () => new Promise((r) => (resolve = r));
  const pending = engine.applyRemoteState({ ...state, paused: true });
  engine.onLocalMediaEvent(new Event('play'));
  resolve();
  await pending;
  assert.equal(media.paused, false);
  assert.equal(engine.action.clock, 2);
  engine.stop();
});
