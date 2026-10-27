import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
export function browser(files = [], extra = {}) {
  const window = new EventTarget();
  const context = vm.createContext({
    console,
    crypto: webcrypto,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    ArrayBuffer,
    btoa,
    atob,
    EventTarget,
    Event,
    CustomEvent,
    AbortController,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    window,
    navigator: { onLine: true, userAgent: 'test' },
    document: { title: 'Example', visibilityState: 'visible' },
    location: new URL('https://www.youtube.com/watch?v=abcdef12345'),
    ...extra,
  });
  for (const file of [
    'shared/protocol',
    'content/namespace',
    'content/constants',
    'content/utils',
    ...files,
  ])
    vm.runInContext(
      readFileSync(new URL(`../extension/${file}.js`, import.meta.url), 'utf8'),
      context,
      { filename: file },
    );
  return context;
}
export function diagnostics() {
  return {
    entries: [],
    metrics: {},
    record(...args) {
      this.entries.push(args);
    },
    metric(k, v) {
      this.metrics[k] = v;
    },
  };
}
export const bundle = {
  v: 2,
  roomId: 'room000000000001',
  creatorId: 'client000000001',
  secret: Buffer.alloc(32, 5).toString('base64url'),
  platform: 'youtube',
  contentKey: 'youtube:abcdef12345',
  contentUrl: 'https://www.youtube.com/watch?v=abcdef12345',
  title: 'Example',
  roomName: 'Tonight',
  relayUrl: 'ws://localhost:8787/ws',
  expiresAt: Date.now() + 3600000,
};
export const envelope = {
  roomId: bundle.roomId,
  senderId: 'client000000001',
  sessionId: 'session00000001',
  seq: 1,
};
