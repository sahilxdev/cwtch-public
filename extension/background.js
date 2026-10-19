const DEFAULT_SETTINGS = Object.freeze({
  relayUrl: "ws://localhost:8787/ws",
  displayName: "",
  autoOpenPanel: true,
  debugMode: false,
  softSync: true,
  nudgeSound: true,
  autoFollow: false
});

const socketSessions = new Map();

const CONTENT_SCRIPT_FILES = Object.freeze([
  "content/namespace.js",
  "content/constants.js",
  "content/utils.js",
  "content/diagnostics.js",
  "content/crypto.js",
  "content/platforms.js",
  "content/room-client.js",
  "content/sync-engine.js",
  "content/ui.js",
  "content/main.js"
]);

function randomClientId(bytes = 18) {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  let binary = "";
  for (const value of buffer) binary += String.fromCharCode(value);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function tabClientId(tabId) {
  if (!Number.isInteger(tabId)) throw new Error("Cwtch could not identify this browser tab.");
  const key = `tab-client:${tabId}`;
  const stored = await chrome.storage.session.get(key);
  let clientId = stored[key];
  if (!/^[A-Za-z0-9_-]{12,80}$/.test(clientId || "")) {
    clientId = randomClientId();
    await chrome.storage.session.set({ [key]: clientId });
  }
  return clientId;
}

function validateRelayUrl(relayUrl) {
  const url = new URL(relayUrl);
  if (!["ws:", "wss:"].includes(url.protocol)) throw new Error("Relay URL must use ws:// or wss://.");
  const isLoopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol === "ws:" && !isLoopback) throw new Error("Public Cwtch relays must use wss://.");
  if (url.username || url.password) throw new Error("Relay URLs cannot contain usernames or passwords.");
  return url.toString();
}

async function checkRelayHealth(relayUrl, timeoutMs = 5000) {
  const url = validateRelayUrl(relayUrl);
  return new Promise((resolve, reject) => {
    let settled = false;
    let socket;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket?.close(1000, "HEALTH_CHECK_COMPLETE"); } catch {}
      callback(value);
    };
    const timer = setTimeout(() => finish(reject, new Error("Relay health check timed out after 5 seconds.")), timeoutMs);
    try { socket = new WebSocket(url); }
    catch (error) { finish(reject, error); return; }
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ v: 1, type: "health" }));
    });
    socket.addEventListener("message", (event) => {
      try {
        const body = JSON.parse(event.data);
        if (body?.type !== "health" || body?.ok !== true || body?.service !== "cwtch-relay") {
          throw new Error(body?.code || "Unexpected relay health response.");
        }
        finish(resolve, body);
      } catch (error) { finish(reject, error); }
    });
    socket.addEventListener("error", () => finish(reject, new Error("The relay connection failed.")));
    socket.addEventListener("close", (event) => {
      if (!settled && event.code !== 1000) finish(reject, new Error(event.reason || `Relay closed with code ${event.code}.`));
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
    try { this.port.postMessage(message); } catch {}
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
    if (this.socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(this.socket.readyState)) return;

    let url;
    try { url = this.validateUrl(); }
    catch (error) {
      this.post({ type: "socket-error", code: "WS_CONFIG_INVALID", message: error.message });
      return;
    }

    this.post({ type: "socket-status", status: this.reconnectAttempt ? "reconnecting" : "connecting", attempt: this.reconnectAttempt });
    let socket;
    try { socket = new WebSocket(url); }
    catch (error) {
      this.post({ type: "socket-error", code: "WS_CONNECT_FAILED", message: error.message });
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    const timeout = setTimeout(() => {
      if (socket.readyState === WebSocket.CONNECTING) socket.close(4000, "CONNECT_TIMEOUT");
    }, 10_000);

    socket.addEventListener("open", () => {
      clearTimeout(timeout);
      this.reconnectAttempt = 0;
      this.post({ type: "socket-open" });
      this.send(JSON.stringify(this.joinPayload));
      this.flush();
      this.startKeepAlive();
    });

    socket.addEventListener("message", (event) => {
      this.post({ type: "socket-message", data: event.data });
    });

    socket.addEventListener("error", () => {
      this.post({ type: "socket-error", code: "WS_CONNECT_FAILED", message: "The relay connection failed." });
    });

    socket.addEventListener("close", (event) => {
      clearTimeout(timeout);
      this.stopKeepAlive();
      this.socket = null;
      this.post({ type: "socket-close", code: event.code, reason: event.reason });
      if (!this.manualClose && ![4002, 4003, 4009].includes(event.code)) this.scheduleReconnect();
    });
  }

  send(serialized) {
    if (typeof serialized !== "string" || serialized.length > 100_000) return false;
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.enqueue(serialized);
      return false;
    }
    try {
      this.socket.send(serialized);
      return true;
    } catch (error) {
      this.enqueue(serialized);
      this.post({ type: "socket-error", code: "WS_CONNECT_FAILED", message: error.message });
      try { this.socket.close(4000, "SEND_FAILED"); } catch {}
      return false;
    }
  }

  enqueue(serialized) {
    this.outbox.push(serialized);
    if (this.outbox.length > 40) this.outbox.shift();
  }

  flush() {
    const pending = this.outbox.splice(0);
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.outbox.unshift(...pending);
      return;
    }
    for (let index = 0; index < pending.length; index += 1) {
      try {
        this.socket.send(pending[index]);
      } catch (error) {
        this.outbox.unshift(...pending.slice(index));
        if (this.outbox.length > 40) this.outbox.splice(0, this.outbox.length - 40);
        this.post({ type: "socket-error", code: "WS_CONNECT_FAILED", message: error.message });
        break;
      }
    }
  }

  startKeepAlive() {
    this.stopKeepAlive();
    this.keepAliveTimer = setInterval(() => {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
      this.send(JSON.stringify({
        v: 1,
        type: "ping",
        nonce: `sw_${Date.now()}`,
        clientTime: Date.now()
      }));
    }, 20_000);
  }

  stopKeepAlive() {
    clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = null;
  }

  scheduleReconnect() {
    if (this.closed || this.manualClose || this.reconnectAttempt >= 12) {
      if (this.reconnectAttempt >= 12) this.post({ type: "socket-error", code: "WS_CONNECT_FAILED", message: "Reconnect limit reached." });
      return;
    }
    const delay = Math.min(30_000, 750 * 2 ** this.reconnectAttempt) + Math.floor(Math.random() * 350);
    this.reconnectAttempt += 1;
    this.post({ type: "socket-status", status: "reconnecting", attempt: this.reconnectAttempt, delay });
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  close(reason = "USER_LEFT") {
    this.manualClose = true;
    this.closed = true;
    clearTimeout(this.reconnectTimer);
    this.stopKeepAlive();
    this.outbox.length = 0;
    try { this.socket?.close(1000, reason); } catch {}
    this.socket = null;
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get("settings");
  await chrome.storage.local.set({ settings: { ...DEFAULT_SETTINGS, ...(current.settings || {}) } });
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "cwtch-room") return;
  const key = `${port.sender?.tab?.id ?? "no-tab"}:${port.sender?.frameId ?? 0}`;
  const previous = socketSessions.get(key);
  previous?.close("PORT_REPLACED");

  const session = new SocketSession(port);
  socketSessions.set(key, session);

  port.onMessage.addListener((message) => {
    if (!message || typeof message !== "object") return;
    if (message.type === "socket-connect") session.configure(message);
    else if (message.type === "socket-send") session.send(message.data);
    else if (message.type === "socket-close") session.close("CONTENT_CLOSED");
  });

  port.onDisconnect.addListener(() => {
    session.close("PORT_DISCONNECTED");
    if (socketSessions.get(key) === session) socketSessions.delete(key);
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") return false;

  if (message.type === "CWTCH_GET_TAB_CLIENT_ID") {
    const tabId = sender.tab?.id;
    tabClientId(tabId)
      .then((clientId) => sendResponse({ ok: true, clientId }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "CWTCH_GET_CONTENT_SCRIPT_FILES") {
    sendResponse({ ok: true, files: CONTENT_SCRIPT_FILES });
    return false;
  }

  if (message.type === "CWTCH_SET_BADGE") {
    const tabId = sender.tab?.id;
    if (tabId == null) return false;
    const text = typeof message.text === "string" ? message.text.slice(0, 4) : "";
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#C56A6F" });
    chrome.action.setBadgeText({ tabId, text });
    return false;
  }

  if (message.type === "CWTCH_OPEN_OPTIONS") {
    chrome.runtime.openOptionsPage();
    return false;
  }

  if (message.type === "CWTCH_GET_DEFAULTS") {
    sendResponse({ ok: true, settings: DEFAULT_SETTINGS });
    return false;
  }

  if (message.type === "CWTCH_CHECK_RELAY") {
    checkRelayHealth(message.relayUrl)
      .then((health) => sendResponse({ ok: true, health }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});


chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(`tab-client:${tabId}`).catch(() => {});
});
