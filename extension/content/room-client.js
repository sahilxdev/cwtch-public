(() => {
  "use strict";
  const C = globalThis.Cwtch;

  class RoomClient extends EventTarget {
    constructor({ bundle, identity, diagnostics }) {
      super();
      this.bundle = bundle;
      this.identity = identity;
      this.diagnostics = diagnostics;
      this.crypto = new C.RoomCrypto(bundle.secret, bundle.roomId);
      this.port = null;
      this.status = "idle";
      this.connected = false;
      this.manualClose = false;
      this.joined = false;
      this.seq = 0;
      this.queue = [];
      this.portReconnectTimer = null;
      this.pingTimer = null;
      this.sessionId = C.utils.randomId(18);
      this.latencyMs = null;
      this.serverOffsetMs = 0;
      this.offsetSamples = [];
      this.pendingPings = new Map();
      this.lastMessageAt = null;
      this.lastSeqBySession = new Map();
      this.connectionFailureCode = null;
    }

    setStatus(status, detail = {}) {
      this.status = status;
      C.utils.emit(this, "status", { status, ...detail });
    }

    validateRelayUrl() {
      let url;
      try { url = new URL(this.bundle.relayUrl); }
      catch { throw new Error("Relay URL is not valid."); }
      if (!['ws:', 'wss:'].includes(url.protocol)) throw new Error("Relay URL must start with ws:// or wss://.");
      const isLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      if (url.protocol === "ws:" && !isLoopback) throw new Error("Public relays must use wss://.");
      if (url.username || url.password) throw new Error("Relay URLs cannot contain usernames or passwords.");
      return url.toString();
    }

    connect() {
      this.manualClose = false;
      let relayUrl;
      try { relayUrl = this.validateRelayUrl(); }
      catch (error) {
        this.diagnostics.record("WS_CONFIG_INVALID", "error", { message: error.message, relayUrl: this.bundle.relayUrl });
        this.setStatus("error", { code: "WS_CONFIG_INVALID", message: error.message });
        return;
      }

      if (this.port) return;
      this.setStatus("connecting");
      try {
        this.port = chrome.runtime.connect({ name: "cwtch-room" });
      } catch (error) {
        this.handlePortFailure(error);
        return;
      }

      this.port.onMessage.addListener((message) => this.handlePortMessage(message));
      this.port.onDisconnect.addListener(() => {
        const error = chrome.runtime.lastError;
        this.port = null;
        this.connected = false;
        this.joined = false;
        this.diagnostics.metric("connected", false);
        this.stopPings();
        if (!this.manualClose) {
          if (error) this.diagnostics.record("EXTENSION_CONTEXT_INVALIDATED", "warning", { message: error.message });
          this.schedulePortReconnect();
        }
      });

      this.port.postMessage({
        type: "socket-connect",
        relayUrl,
        joinPayload: {
          v: C.PROTOCOL_VERSION,
          type: "join",
          roomId: this.bundle.roomId,
          clientId: this.identity.id,
          sessionId: this.sessionId
        }
      });
    }

    handlePortFailure(error) {
      this.diagnostics.record("EXTENSION_CONTEXT_INVALIDATED", "error", { message: error.message });
      this.setStatus("error", { code: "EXTENSION_CONTEXT_INVALIDATED", message: error.message });
      this.schedulePortReconnect();
    }

    schedulePortReconnect() {
      if (this.manualClose) return;
      this.setStatus("reconnecting");
      clearTimeout(this.portReconnectTimer);
      this.portReconnectTimer = setTimeout(() => this.connect(), 1200);
    }

    handlePortMessage(message) {
      if (!message || typeof message !== "object") return;
      if (message.type === "socket-open") {
        this.connected = true;
        this.connectionFailureCode = null;
        this.diagnostics.metric("connected", true);
        return;
      }
      if (message.type === "socket-status") {
        if (message.status === "reconnecting" && this.connectionFailureCode) {
          this.setStatus("error", { ...message, code: this.connectionFailureCode, retrying: true });
        } else {
          this.setStatus(message.status, message);
        }
        return;
      }
      if (message.type === "socket-error") {
        let isLoopback = false;
        try {
          const url = new URL(this.bundle.relayUrl);
          isLoopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
        } catch {}
        const code = message.code === "WS_CONFIG_INVALID"
          ? "WS_CONFIG_INVALID"
          : isLoopback ? "LOCAL_RELAY_NOT_RUNNING" : "WS_CONNECT_FAILED";
        this.connectionFailureCode = code;
        this.diagnostics.record(code, "error", { message: message.message, relayHost: isLoopback ? "loopback" : "remote" });
        this.setStatus("error", { ...message, code, retrying: message.code !== "WS_CONFIG_INVALID" });
        return;
      }
      if (message.type === "socket-close") {
        this.connected = false;
        this.joined = false;
        this.diagnostics.metric("connected", false);
        this.stopPings();
        C.utils.emit(this, "closed", { code: message.code, reason: message.reason });
        if (message.code === 4009) {
          this.manualClose = true;
          this.diagnostics.record("DUPLICATE_SESSION", "error", { code: message.code });
          this.setStatus("error", { code: "DUPLICATE_SESSION" });
        } else if (message.code === 4003) {
          this.manualClose = true;
          this.diagnostics.record("ROOM_FULL", "error", { code: message.code });
          this.setStatus("error", { code: "ROOM_FULL" });
        }
        return;
      }
      if (message.type === "socket-message") {
        this.handleMessage(message.data).catch((error) => {
          this.diagnostics.record("INTERNAL_ERROR", "error", {
            stage: "room-message",
            message: error?.message || String(error)
          });
        });
      }
    }

    retryNow() {
      if (this.manualClose) return false;
      clearTimeout(this.portReconnectTimer);
      this.connectionFailureCode = null;
      try { this.port?.postMessage({ type: "socket-close" }); } catch {}
      try { this.port?.disconnect(); } catch {}
      this.port = null;
      this.connected = false;
      this.joined = false;
      this.setStatus("connecting", { manualRetry: true });
      this.connect();
      return true;
    }

    async handleMessage(raw) {
      this.lastMessageAt = Date.now();
      let message;
      try { message = JSON.parse(raw); }
      catch {
        this.diagnostics.record("WS_PROTOCOL_MISMATCH", "error", { rawType: typeof raw });
        return;
      }

      if (message.v !== C.PROTOCOL_VERSION) {
        this.diagnostics.record("WS_PROTOCOL_MISMATCH", "error", { received: message.v, expected: C.PROTOCOL_VERSION });
        return;
      }

      if (message.type === "joined") {
        this.joined = true;
        this.setStatus("joined", { occupants: message.occupants, replaced: message.replaced });
        this.sampleOffset(Date.now(), Date.now(), message.serverTime);
        this.startPings();
        this.flushQueue();
        C.utils.emit(this, "joined", message);
        return;
      }

      if (message.type === "peer_joined" || message.type === "peer_left") {
        C.utils.emit(this, message.type, message);
        return;
      }

      if (message.type === "pong") {
        const started = this.pendingPings.get(message.nonce);
        if (started != null) {
          this.pendingPings.delete(message.nonce);
          this.sampleOffset(started, Date.now(), message.serverTime);
        }
        return;
      }

      if (message.type === "error") {
        const map = {
          ROOM_FULL: "ROOM_FULL",
          RATE_LIMITED: "RATE_LIMITED",
          PROTOCOL_MISMATCH: "WS_PROTOCOL_MISMATCH",
          INVALID_ROOM_ID: "ROOM_ID_INVALID"
        };
        const diagnosticCode = map[message.code] || "INTERNAL_ERROR";
        this.diagnostics.record(diagnosticCode, "error", { serverCode: message.code, serverMessage: message.message });
        this.setStatus("error", { code: message.code, message: message.message });
        if (["ROOM_FULL", "PROTOCOL_MISMATCH", "INVALID_ROOM_ID"].includes(message.code)) this.manualClose = true;
        C.utils.emit(this, "server_error", message);
        return;
      }

      if (message.type === "relay") {
        try {
          const sequenceKey = `${message.senderId}:${message.sessionId || "legacy"}`;
          const previousSeq = this.lastSeqBySession.get(sequenceKey);
          if (Number.isSafeInteger(previousSeq) && message.seq <= previousSeq) return;
          const payload = await this.crypto.decrypt(message.payload);
          this.lastSeqBySession.set(sequenceKey, message.seq);
          if (this.lastSeqBySession.size > 8) this.lastSeqBySession.delete(this.lastSeqBySession.keys().next().value);
          C.utils.emit(this, "payload", {
            senderId: message.senderId,
            seq: message.seq,
            serverTime: message.serverTime,
            payload
          });
        } catch (error) {
          this.diagnostics.record("DECRYPT_FAILED", "error", { message: error.message, senderId: message.senderId });
        }
      }
    }

    sampleOffset(startedAt, finishedAt, serverTime) {
      if (!Number.isFinite(serverTime)) return;
      const midpoint = startedAt + (finishedAt - startedAt) / 2;
      const offset = serverTime - midpoint;
      const latency = Math.max(0, finishedAt - startedAt);
      this.offsetSamples.push({ offset, latency });
      if (this.offsetSamples.length > 8) this.offsetSamples.shift();
      const sorted = [...this.offsetSamples].sort((a, b) => a.latency - b.latency);
      const best = sorted.slice(0, Math.max(1, Math.ceil(sorted.length / 2)));
      this.serverOffsetMs = best.reduce((sum, sample) => sum + sample.offset, 0) / best.length;
      this.latencyMs = best.reduce((sum, sample) => sum + sample.latency, 0) / best.length;
      this.diagnostics.metric("latencyMs", Math.round(this.latencyMs));
      this.diagnostics.metric("serverOffsetMs", Math.round(this.serverOffsetMs));
      if (Math.abs(this.serverOffsetMs) > 120_000) {
        this.diagnostics.record("CLOCK_SKEW", "warning", { serverOffsetMs: Math.round(this.serverOffsetMs) });
      }
      C.utils.emit(this, "quality", { latencyMs: this.latencyMs, serverOffsetMs: this.serverOffsetMs });
    }

    serverNow() {
      return Date.now() + this.serverOffsetMs;
    }

    startPings() {
      this.stopPings();
      const ping = () => {
        if (!this.joined) return;
        const nonce = C.utils.randomId(8);
        const clientTime = Date.now();
        this.pendingPings.set(nonce, clientTime);
        this.sendRaw({ v: C.PROTOCOL_VERSION, type: "ping", nonce, clientTime });
        for (const [key, started] of this.pendingPings) {
          if (Date.now() - started > 30_000) this.pendingPings.delete(key);
        }
      };
      ping();
      this.pingTimer = setInterval(ping, 15_000);
    }

    stopPings() {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
      this.pendingPings.clear();
    }

    sendRaw(value) {
      if (!this.port) return false;
      try {
        this.port.postMessage({ type: "socket-send", data: JSON.stringify(value) });
        return true;
      } catch (error) {
        this.diagnostics.record("EXTENSION_CONTEXT_INVALIDATED", "warning", { message: error.message });
        return false;
      }
    }

    async send(type, data = {}) {
      const applicationMessage = {
        type,
        data,
        senderId: this.identity.id,
        sentServerTime: this.serverNow(),
        clientVersion: C.APP_VERSION
      };
      const payload = await this.crypto.encrypt(applicationMessage);
      const envelope = {
        v: C.PROTOCOL_VERSION,
        type: "relay",
        roomId: this.bundle.roomId,
        senderId: this.identity.id,
        sessionId: this.sessionId,
        seq: this.seq++,
        payload
      };
      if (!this.joined || !this.sendRaw(envelope)) {
        this.queue.push(envelope);
        if (this.queue.length > 30) this.queue.shift();
        return false;
      }
      return true;
    }

    flushQueue() {
      const queue = this.queue.splice(0);
      for (let index = 0; index < queue.length; index += 1) {
        if (!this.sendRaw(queue[index])) {
          this.queue.unshift(...queue.slice(index));
          break;
        }
      }
    }

    close() {
      this.manualClose = true;
      clearTimeout(this.portReconnectTimer);
      this.stopPings();
      this.queue.length = 0;
      this.lastSeqBySession.clear();
      this.connectionFailureCode = null;
      try { this.port?.postMessage({ type: "socket-close" }); } catch {}
      try { this.port?.disconnect(); } catch {}
      this.port = null;
      this.connected = false;
      this.joined = false;
      this.setStatus("closed");
    }
  }

  C.RoomClient = RoomClient;
})();
