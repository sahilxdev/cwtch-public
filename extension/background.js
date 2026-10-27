importScripts('shared/protocol.js');
const DEFAULT_SETTINGS = CwtchProtocol.defaults;
const socketSessions = new Map();

const CONTENT_SCRIPT_FILES = Object.freeze([
  'shared/protocol.js',
  'content/namespace.js',
  'content/constants.js',
  'content/utils.js',
  'content/diagnostics.js',
  'content/crypto.js',
  'content/platforms.js',
  'content/room-client.js',
  'content/sync-engine.js',
  'content/ui.js',
  'content/main.js',
]);

function randomClientId(bytes = 18) {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  let binary = '';
  for (const value of buffer) binary += String.fromCharCode(value);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function tabClientId(tabId) {
  if (!Number.isInteger(tabId)) throw new Error('Cwtch could not identify this browser tab.');
  const key = `tab-client:${tabId}`;
  const stored = await chrome.storage.session.get(key);
  let clientId = stored[key];
  if (!/^[A-Za-z0-9_-]{12,80}$/.test(clientId || '')) {
    clientId = randomClientId();
    await chrome.storage.session.set({ [key]: clientId });
  }
  return clientId;
}

const validateRelayUrl = CwtchProtocol.relayUrl;

async function checkRelayHealth(relayUrl) {
  const url = validateRelayUrl(relayUrl);
  // Render Free can take about a minute to wake. Each bounded probe also
  // gives the extension worker network events while the service starts.
  const attempts = new URL(url).hostname.endsWith('.onrender.com') ? 15 : 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await probeRelayHealth(url);
    } catch (error) {
      if (error.name === 'RelayProtocolError' || attempt === attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

async function probeRelayHealth(relayUrl, timeoutMs = 5000) {
  const url = validateRelayUrl(relayUrl);
  return new Promise((resolve, reject) => {
    let settled = false;
    let socket;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket?.close(1000, 'HEALTH_CHECK_COMPLETE');
      } catch {}
      callback(value);
    };
    const timer = setTimeout(
      () => finish(reject, new Error('Relay health check timed out after 5 seconds.')),
      timeoutMs,
    );
    try {
      socket = new WebSocket(url);
    } catch (error) {
      finish(reject, error);
      return;
    }
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ v: CwtchProtocol.version, type: 'health' }));
    });
    socket.addEventListener('message', (event) => {
      try {
        const body = JSON.parse(event.data);
        if (
          body?.type !== 'health' ||
          body?.ok !== true ||
          body?.service !== 'cwtch-relay' ||
          body?.protocol !== CwtchProtocol.version
        ) {
          const error = new Error(body?.code || 'Unexpected relay health response.');
          error.name = 'RelayProtocolError';
          throw error;
        }
        finish(resolve, body);
      } catch (error) {
        finish(reject, error);
      }
    });
    socket.addEventListener('error', () =>
      finish(reject, new Error('The relay connection failed.')),
    );
    socket.addEventListener('close', (event) => {
      if (!settled)
        finish(reject, new Error(event.reason || `Relay closed with code ${event.code}.`));
    });
  });
}

class SocketSession {
  constructor(port) {
    this.port = port;
    this.socket = null;
    this.relayUrl = null;
    this.joinPayload = null;
    this.manualClose = false;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.keepAliveTimer = null;
    this.outbox = [];
    this.closed = false;
  }

  post(message) {
    try {
      this.port.postMessage(message);
    } catch {}
  }

  configure({ relayUrl, joinPayload }) {
    this.relayUrl = relayUrl;
    this.joinPayload = joinPayload;
    this.manualClose = false;
    this.connect();
  }

  validateUrl() {
    return validateRelayUrl(this.relayUrl);
  }

  connect() {
    if (this.closed || this.manualClose) return;
    if (!this.relayUrl || !this.joinPayload) return;
    if (this.socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(this.socket.readyState))
      return;

    let url;
    try {
      url = this.validateUrl();
    } catch (error) {
      this.post({ type: 'socket-error', code: 'WS_CONFIG_INVALID', message: error.message });
      return;
    }

    this.post({
      type: 'socket-status',
      status: this.reconnectAttempt ? 'reconnecting' : 'connecting',
      attempt: this.reconnectAttempt,
    });
    let socket;
    try {
      socket = new WebSocket(url);
    } catch (error) {
      this.post({ type: 'socket-error', code: 'WS_CONNECT_FAILED', message: error.message });
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    let joined = false;
    const timeout = setTimeout(() => {
      if (!joined && this.socket === socket) {
        try {
          socket.close(4000, 'JOIN_TIMEOUT');
        } catch {}
      }
    }, 10_000);

    socket.addEventListener('open', () => {
      if (this.socket !== socket || this.closed) return;
      this.post({ type: 'socket-open' });
      this.send(JSON.stringify(this.joinPayload));

      this.startKeepAlive();
    });

    socket.addEventListener('message', (event) => {
      if (this.socket !== socket || this.closed) return;
      try {
        if (JSON.parse(event.data).type === 'joined') {
          this.reconnectAttempt = 0;
          joined = true;
          clearTimeout(timeout);
        }
      } catch {}
      this.post({ type: 'socket-message', data: event.data });
    });

    socket.addEventListener('error', () => {
      if (this.socket !== socket || this.closed) return;
      this.post({
        type: 'socket-error',
        code: 'WS_CONNECT_FAILED',
        message: 'The relay connection failed.',
      });
    });

    socket.addEventListener('close', (event) => {
      clearTimeout(timeout);
      if (this.socket !== socket) return;
      this.stopKeepAlive();
      this.socket = null;
      this.post({ type: 'socket-close', code: event.code, reason: event.reason });
      if (!this.manualClose && ![4002, 4003, 4004, 4008, 4009].includes(event.code))
        this.scheduleReconnect();
    });
  }

  send(serialized) {
    if (typeof serialized !== 'string' || serialized.length > 100_000) return false;
    if (
      !this.socket ||
      this.socket.readyState !== WebSocket.OPEN ||
      this.socket.bufferedAmount > 262144
    ) {
      return false;
    }
    try {
      this.socket.send(serialized);
      return true;
    } catch (error) {
      this.post({ type: 'socket-error', code: 'WS_CONNECT_FAILED', message: error.message });
      try {
        this.socket.close(4000, 'SEND_FAILED');
      } catch {}
      return false;
    }
  }

  startKeepAlive() {
    this.stopKeepAlive();
    this.keepAliveTimer = setInterval(() => {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
      pruneHistory().catch(() => {});
      this.send(
        JSON.stringify({
          v: CwtchProtocol.version,
          type: 'ping',
          nonce: `sw_${Date.now()}`,
          clientTime: Date.now(),
        }),
      );
    }, 20_000);
  }

  stopKeepAlive() {
    clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = null;
  }

  scheduleReconnect() {
    if (this.closed || this.manualClose || this.reconnectAttempt >= 12) {
      if (this.reconnectAttempt >= 12)
        this.post({
          type: 'socket-error',
          code: 'WS_CONNECT_FAILED',
          message: 'Reconnect limit reached.',
        });
      return;
    }
    const delay =
      Math.min(30_000, 750 * 2 ** this.reconnectAttempt) + Math.floor(Math.random() * 350);
    this.reconnectAttempt += 1;
    this.post({
      type: 'socket-status',
      status: 'reconnecting',
      attempt: this.reconnectAttempt,
      delay,
    });
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  close(reason = 'USER_LEFT') {
    this.manualClose = true;
    this.closed = true;
    clearTimeout(this.reconnectTimer);
    this.stopKeepAlive();
    this.outbox.length = 0;
    try {
      this.socket?.close(1000, reason);
    } catch {}
    this.socket = null;
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get('settings');
  await chrome.storage.local.remove(['activeRoom', 'activeRoomExpiresAt']);
  await chrome.storage.local.set({
    settings: { ...DEFAULT_SETTINGS, ...(current.settings || {}) },
  });
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'cwtch-room') return;
  const key = `${port.sender?.tab?.id ?? 'no-tab'}:${port.sender?.frameId ?? 0}`;
  const previous = socketSessions.get(key);
  previous?.close('PORT_REPLACED');

  const session = new SocketSession(port);
  socketSessions.set(key, session);

  port.onMessage.addListener((message) => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'socket-connect') session.configure(message);
    else if (message.type === 'socket-send') session.send(message.data);
    else if (message.type === 'socket-close') session.close('CONTENT_CLOSED');
  });

  port.onDisconnect.addListener(() => {
    session.close('PORT_DISCONNECTED');
    if (socketSessions.get(key) === session) socketSessions.delete(key);
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false;

  if (['CWTCH_ROOM_GET', 'CWTCH_ROOM_SET', 'CWTCH_ROOM_CLEAR'].includes(message.type)) {
    if (!Number.isInteger(sender.tab?.id)) {
      sendResponse({ ok: false, error: 'A streaming tab is required.' });
      return false;
    }
    const key = `tab-room:${sender.tab.id}`;
    (async () => {
      if (message.type === 'CWTCH_ROOM_SET')
        await chrome.storage.session.set({ [key]: message.bundle });
      if (message.type === 'CWTCH_ROOM_CLEAR') await chrome.storage.session.remove(key);
      const value = await chrome.storage.session.get(key);
      if (value[key]?.expiresAt < Date.now()) {
        await chrome.storage.session.remove(key);
        return { ok: true, bundle: null };
      }
      return { ok: true, bundle: value[key] || null };
    })()
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === 'CWTCH_GET_TAB_CLIENT_ID') {
    const tabId = sender.tab?.id;
    tabClientId(tabId)
      .then((clientId) => sendResponse({ ok: true, clientId }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'CWTCH_GET_CONTENT_SCRIPT_FILES') {
    sendResponse({ ok: true, files: CONTENT_SCRIPT_FILES });
    return false;
  }

  if (message.type === 'CWTCH_SET_BADGE') {
    const tabId = sender.tab?.id;
    if (tabId == null) return false;
    const text = typeof message.text === 'string' ? message.text.slice(0, 4) : '';
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#C56A6F' });
    chrome.action.setBadgeText({ tabId, text });
    return false;
  }

  if (message.type === 'CWTCH_OPEN_OPTIONS') {
    chrome.runtime.openOptionsPage();
    return false;
  }

  if (message.type === 'CWTCH_GET_DEFAULTS') {
    sendResponse({ ok: true, settings: DEFAULT_SETTINGS });
    return false;
  }

  if (message.type === 'CWTCH_CHECK_RELAY') {
    checkRelayHealth(message.relayUrl)
      .then((health) => sendResponse({ ok: true, health }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove([`tab-client:${tabId}`, `tab-room:${tabId}`]).catch(() => {});
});

async function pruneHistory() {
  const all = await chrome.storage.local.get(null);
  const expired = Object.keys(all).filter(
    (key) =>
      key.startsWith('history:') &&
      (!all[key]?.expiresAt || all[key].expiresAt < Date.now() || !all.settings?.rememberHistory),
  );
  if (expired.length) await chrome.storage.local.remove(expired);
}
pruneHistory().catch(() => {});
chrome.runtime.onStartup?.addListener(() => pruneHistory().catch(() => {}));
