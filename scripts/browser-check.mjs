import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { createRelay } from '../relay/src/server.js';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = resolve('.'),
  output = process.env.CWTCH_SCREENSHOTS;
const server = http.createServer(async (req, res) => {
  const path = resolve(root, '.' + new URL(req.url, 'http://localhost').pathname);
  if (!path.startsWith(root + sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const data = await readFile(path);
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
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const url = `http://127.0.0.1:${server.address().port}`;
const relay = createRelay({ allowedOrigins: ['*'], logLevel: 'error' });
relay.server.listen(0, '127.0.0.1');
await once(relay.server, 'listening');
const relayUrl = `ws://127.0.0.1:${relay.server.address().port}/ws`;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
});
const failures = [];
try {
  const a = await browser.newPage({ viewport: { width: 1100, height: 850 }, colorScheme: 'dark' }),
    b = await browser.newPage({ viewport: { width: 1100, height: 850 }, colorScheme: 'dark' });
  for (const p of [a, b]) {
    p.on('pageerror', (e) => failures.push(e.message));
    await p.goto(`${url}/tests/fixtures/player.html`);
    await p.waitForFunction(() => Cwtch.app.ui && Cwtch.app.identity);
    await p.evaluate((relayUrl) => {
      Cwtch.app.settings.relayUrl = relayUrl;
    }, relayUrl);
  }
  await a.evaluate(() =>
    Cwtch.app.createRoom({ displayName: 'Sahil', roomName: 'Our kind of evening' }),
  );
  await a.waitForFunction(() => Cwtch.app.roomClient?.joined);
  const bundle = await a.evaluate(() => Cwtch.app.roomBundle);
  await b.evaluate(async (bundle) => {
    await Cwtch.app.setDisplayName('Alex');
    await Cwtch.app.joinRoom(bundle);
  }, bundle);
  await Promise.all(
    [a, b].map((p) =>
      p.waitForFunction(
        () =>
          Cwtch.app.participants.size === 2 &&
          [...Cwtch.app.participants.values()].every((p) => p.name !== 'Connecting…'),
      ),
    ),
  );
  await a.evaluate(() => Cwtch.app.sendChat('Ready when you are. ♡'));
  await b.waitForFunction(() => Cwtch.app.ui.messages.length === 1);
  await a.waitForFunction(() => Cwtch.app.ui.messages[0]?.status === 'delivered');
  await a.evaluate(() => {
    Cwtch.app.media.currentTime = 42;
  });
  await b.waitForFunction(() => Math.abs(Cwtch.app.media.currentTime - 42) < 0.1);
  await b.evaluate(() => Cwtch.app.syncEngine.resumeTogether());
  await a.waitForFunction(() => !Cwtch.app.media.paused);
  await a.evaluate(() => Cwtch.app.saveMoment('This is the scene.'));
  await b.waitForFunction(() => Cwtch.app.ui.moments.length === 1);
  await a.evaluate(() => Cwtch.app.ui.nextPrompt());
  await b.waitForFunction(() => Cwtch.app.ui.promptIndex > 0);
  await a.evaluate(() => Cwtch.app.ui.open('room'));
  if (output) {
    await mkdir(output, { recursive: true });
    await a.screenshot({
      path: resolve(output, 'cwtch-room-dark.png'),
      clip: { x: 675, y: 100, width: 415, height: 740 },
    });
    await a.emulateMedia({ colorScheme: 'light' });
    await a.screenshot({
      path: resolve(output, 'cwtch-room-light.png'),
      clip: { x: 675, y: 100, width: 415, height: 740 },
    });
  }
  // Keyboard navigation uses the actual closed shadow root exposed to this test fixture through the app.
  await a.evaluate(() => Cwtch.app.ui.q('[data-tab="room"]').focus());
  await a.keyboard.press('ArrowRight');
  assert.equal(await a.evaluate(() => Cwtch.app.ui.activeTab), 'chat');
  await a.keyboard.press('Escape');
  assert.equal(await a.evaluate(() => Cwtch.app.ui.panelOpen), false);
  // Remaining client becomes the periodic synchronization leader.
  await a.evaluate(() => Cwtch.app.leaveRoom());
  await b.waitForFunction(
    () => Cwtch.app.participants.size === 1 && Cwtch.app.syncEngine.isLeader(),
  );
  assert.equal(await a.evaluate(() => Cwtch.app.ui.messages.length), 0);
  // Reconnect handshake and room history isolation.
  await b.evaluate(() => Cwtch.app.roomClient.retryNow());
  await b.waitForFunction(() => Cwtch.app.roomClient.joined);
  // Simulated popup runtime; exercises the real popup DOM and scripts.
  const popup = await browser.newPage({
    viewport: { width: 380, height: 800 },
    colorScheme: 'light',
  });
  popup.on('pageerror', (e) => failures.push(e.message));
  await popup.addInitScript(() => {
    const stored = { settings: { displayName: 'Sahil' }, identity: { name: 'Sahil' } };
    globalThis.chrome = {
      storage: {
        local: { get: async () => stored, set: async (data) => Object.assign(stored, data) },
      },
      runtime: { lastError: null, openOptionsPage: async () => {} },
      tabs: {
        query: async () => [{ id: 1, url: 'https://www.youtube.com/watch?v=abcdef12345' }],
        sendMessage: (_id, m, cb) => {
          if (m.type === 'CWTCH_CREATE_ROOM')
            cb({ ok: false, error: 'The relay is offline. Start it in Settings.' });
          else
            cb({
              ok: true,
              supported: true,
              platform: 'YouTube',
              title: 'The quiet between',
              room: null,
            });
        },
      },
    };
  });
  await popup.goto(`${url}/extension/popup/popup.html`);
  await popup.locator('#create').click();
  await popup.waitForFunction(() =>
    document.querySelector('#toast').textContent.includes('relay is offline'),
  );
  assert.equal(await popup.locator('#active').isVisible(), false);
  if (output) await popup.screenshot({ path: resolve(output, 'cwtch-popup.png') });
  for (const width of [320, 380, 736]) {
    await popup.setViewportSize({ width, height: 850 });
    assert.ok(
      await popup.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      `Popup overflow at ${width}`,
    );
  }
  const options = await browser.newPage({
    viewport: { width: 800, height: 1000 },
    colorScheme: 'light',
  });
  await options.addInitScript({ path: resolve('tests/fixtures/chrome-mock.js') });
  options.on('pageerror', (e) => failures.push(e.message));
  await options.goto(`${url}/extension/options/options.html`);
  await options.locator('#display-name').fill('Sahil');
  await options.locator('#save').click();
  await options.waitForFunction(() => document.querySelector('#saved').textContent === 'Saved.');
  for (const width of [320, 800]) {
    await options.setViewportSize({ width, height: 1000 });
    assert.ok(
      await options.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      `Settings overflow at ${width}`,
    );
  }
  if (output)
    await options.screenshot({ path: resolve(output, 'cwtch-settings.png'), fullPage: true });
  assert.deepEqual(failures, []);
  console.log(
    'Browser checks passed: two-party encrypted chat + acknowledgement, seek/play, moments, shared prompts, host transfer, reconnect, room reset, keyboard navigation, popup error propagation, settings and responsive layouts.',
  );
} finally {
  await browser.close();
  await relay.close();
  await new Promise((r) => server.close(r));
}
