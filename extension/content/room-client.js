(() => {
  'use strict';
  const C = globalThis.Cwtch;
  class RoomClient extends EventTarget {
    constructor({ bundle, identity, diagnostics }) {
      super();
      Object.assign(this, { bundle, identity, diagnostics });
      this.crypto = new C.RoomCrypto(bundle.secret, bundle.roomId);
      this.port = null;
      this.status = 'idle';
      this.connected = false;
      this.joined = false;
      this.manualClose = false;
      this.seq = 0;
      this.sessionId = C.utils.randomId(18);
      this.members = [];
      this.leaderId = null;
      this.latencyMs = null;
      this.serverOffsetMs = 0;
      this.offsetSamples = [];
      this.pendingPings = new Map();
      this.lastMessageAt = null;
      this.lastSeqBySession = new Map();
      this.pending = new Map();
      this.seen = new Set();
      this.sendChain = Promise.resolve();
      this.receiveChain = Promise.resolve();
      this.generation = 0;
      this.portAttempts = 0;
    }
    setStatus(status, detail = {}) {
      this.status = status;
      C.utils.emit(this, 'status', { ...detail, status });
    }
    validateRelayUrl() {
      return CwtchProtocol.relayUrl(this.bundle.relayUrl);
    }
    async connect() {
      if (this.port || this.manualClose) return;
      const generation = ++this.generation;
      this.setStatus('connecting');
      try {
        const relayUrl = this.validateRelayUrl(),
          auth = await this.crypto.auth();
        if (generation !== this.generation || this.manualClose) return;
        const port = chrome.runtime.connect({ name: 'cwtch-room' });
        this.port = port;
        port.onMessage.addListener((m) => {
          if (this.port === port) this.handlePortMessage(m);
        });
        port.onDisconnect.addListener(() => {
          const error = chrome.runtime.lastError;
          if (this.port !== port) return;
          this.port = null;
          this.disconnected();
          if (!this.manualClose && this.portAttempts++ < 12) {
            this.setStatus('reconnecting');
            this.portReconnectTimer = setTimeout(
              () => this.connect(),
              Math.min(30000, 1000 * 2 ** this.portAttempts),
            );
          } else if (!this.manualClose)
            this.setStatus('error', { message: error?.message || 'Reload this tab to reconnect.' });
        });
        port.postMessage({
          type: 'socket-connect',
          relayUrl,
          joinPayload: {
            v: C.PROTOCOL_VERSION,
            type: 'join',
            roomId: this.bundle.roomId,
            clientId: this.identity.id,
            sessionId: this.sessionId,
            auth,
          },
        });
      } catch (error) {
        this.diagnostics.record('WS_CONFIG_INVALID', 'error', { message: error.message });
        this.setStatus('error');
      }
    }
    disconnected() {
      this.generation++;
      this.connected = false;
      this.joined = false;
      this.members = [];
      this.leaderId = null;
      this.diagnostics.metric('connected', false);
      this.stopPings();
      for (const id of this.pending.keys()) this.finishDelivery(id, 'unconfirmed');
      C.utils.emit(this, 'membership', { members: [], leaderId: null });
    }
    handlePortMessage(m) {
      if (!m || typeof m !== 'object') return;
      if (m.type === 'socket-open') {
        this.connected = true;
        this.diagnostics.metric('connected', true);
      }
      if (m.type === 'socket-status') this.setStatus(m.status);
      if (m.type === 'socket-error') {
        const local = ['localhost', '127.0.0.1', '[::1]'].includes(
          new URL(this.bundle.relayUrl).hostname,
        );
        this.diagnostics.record(local ? 'LOCAL_RELAY_NOT_RUNNING' : 'WS_CONNECT_FAILED', 'error', {
          message: m.message,
        });
        this.setStatus('error', { message: m.message });
      }
      if (m.type === 'socket-close') {
        this.disconnected();
        C.utils.emit(this, 'closed', m);
        const terminal = {
          4002: 'WS_PROTOCOL_MISMATCH',
          4003: 'ROOM_FULL',
          4004: 'ROOM_SECRET_INVALID',
          4008: 'INVITE_EXPIRED',
          4009: 'DUPLICATE_SESSION',
        }[m.code];
        if (terminal) {
          this.manualClose = true;
          this.diagnostics.record(terminal, 'error', { reason: m.reason });
          this.setStatus('error');
        }
      }
      if (m.type === 'socket-message') {
        const generation = this.generation;
        this.receiveChain = this.receiveChain
          .then(() => generation === this.generation && this.handleMessage(m.data))
          .catch((error) =>
            this.diagnostics.record('DECRYPT_FAILED', 'error', { message: error.message }),
          );
      }
    }
    membership(m) {
      if (
        !Array.isArray(m.members) ||
        m.members.length > 2 ||
        !m.members.every((id) => CwtchProtocol.ID.test(id))
      )
        throw new Error('Invalid membership.');
      this.members = m.members;
      this.leaderId = m.leaderId;
      C.utils.emit(this, 'membership', { members: this.members, leaderId: this.leaderId });
    }
    async handleMessage(raw) {
      const m = JSON.parse(raw);
      this.lastMessageAt = Date.now();
      if (m.v !== C.PROTOCOL_VERSION)
        throw new Error('Protocol mismatch. Update both extensions and relay.');
      if (m.type === 'joined') {
        this.joined = true;
        this.portAttempts = 0;
        this.membership(m);
        this.setStatus('joined');
        this.startPings();
        C.utils.emit(this, 'joined', m);
        return;
      }
      if (m.type === 'peer_joined' || m.type === 'peer_left') {
        this.membership(m);
        C.utils.emit(this, m.type, m);
        return;
      }
      if (m.type === 'pong') {
        const started = this.pendingPings.get(m.nonce);
        if (started != null) {
          this.pendingPings.delete(m.nonce);
          this.sampleOffset(started, Date.now(), m.serverTime);
        }
        return;
      }
      if (m.type === 'error') {
        this.diagnostics.record(
          m.code === 'AUTH_FAILED'
            ? 'ROOM_SECRET_INVALID'
            : m.code === 'ROOM_FULL'
              ? 'ROOM_FULL'
              : m.code === 'RATE_LIMITED'
                ? 'RATE_LIMITED'
                : 'WS_PROTOCOL_MISMATCH',
          'error',
          { serverCode: m.code },
        );
        this.setStatus('error', { code: m.code, message: m.message });
        C.utils.emit(this, 'server_error', m);
        return;
      }
      if (m.type !== 'relay') return;
      if (
        m.roomId !== this.bundle.roomId ||
        !this.members.includes(m.senderId) ||
        m.senderId === this.identity.id ||
        !CwtchProtocol.ID.test(m.sessionId || '') ||
        !Number.isSafeInteger(m.seq) ||
        m.seq < 0
      )
        throw new Error('Invalid message identity.');
      const key = `${m.senderId}:${m.sessionId}`,
        previous = this.lastSeqBySession.get(key) ?? -1;
      if (m.seq <= previous) return;
      const generation = this.generation;
      const payload = await this.crypto.decrypt(m.payload, m);
      if (generation !== this.generation || !this.joined) return;
      if (!CwtchProtocol.application(payload) || payload.senderId !== m.senderId)
        throw new Error('Invalid room message.');
      this.lastSeqBySession.set(key, m.seq);
      if (this.lastSeqBySession.size > 16)
        this.lastSeqBySession.delete(this.lastSeqBySession.keys().next().value);
      if (payload.type === 'ack') {
        this.finishDelivery(payload.data.id, 'delivered');
        return;
      }
      const age = this.serverNow() - payload.sentServerTime;
      if (age > 15000 && ['sync-state', 'reaction', 'nudge', 'navigation'].includes(payload.type))
        return;
      if (['chat', 'moment'].includes(payload.type)) {
        await this.send('ack', { id: payload.data.id });
        if (this.seen.has(payload.data.id)) return;
        this.seen.add(payload.data.id);
        if (this.seen.size > 300) this.seen.delete(this.seen.values().next().value);
      }
      C.utils.emit(this, 'payload', { senderId: m.senderId, payload, seq: m.seq });
    }
    sampleOffset(start, finish, server) {
      if (!Number.isFinite(server)) return;
      this.offsetSamples.push({ offset: server - (start + finish) / 2, latency: finish - start });
      this.offsetSamples = this.offsetSamples.slice(-8);
      const best = [...this.offsetSamples].sort((a, b) => a.latency - b.latency).slice(0, 4);
      this.serverOffsetMs = best.reduce((s, x) => s + x.offset, 0) / best.length;
      this.latencyMs = best.reduce((s, x) => s + x.latency, 0) / best.length;
      this.diagnostics.metric('latencyMs', Math.round(this.latencyMs));
      C.utils.emit(this, 'quality', { latencyMs: this.latencyMs });
    }
    serverNow() {
      return Date.now() + this.serverOffsetMs;
    }
    startPings() {
      this.stopPings();
      const ping = () => {
        if (!this.joined) return;
        if (this.lastMessageAt && Date.now() - this.lastMessageAt > 45000) {
          this.retryNow();
          return;
        }
        const nonce = C.utils.randomId(8),
          now = Date.now();
        this.pendingPings.set(nonce, now);
        this.sendRaw({ v: C.PROTOCOL_VERSION, type: 'ping', nonce, clientTime: now });
        for (const [id, time] of this.pendingPings)
          if (now - time > 30000) this.pendingPings.delete(id);
      };
      ping();
      this.pingTimer = setInterval(ping, 15000);
    }
    stopPings() {
      clearInterval(this.pingTimer);
      this.pendingPings.clear();
    }
    sendRaw(value) {
      if (!this.port || !this.connected) return false;
      try {
        this.port.postMessage({ type: 'socket-send', data: JSON.stringify(value) });
        return true;
      } catch {
        return false;
      }
    }
    send(type, data = {}) {
      const generation = this.generation;
      const operation = this.sendChain.then(async () => {
        if (!this.joined || generation !== this.generation) return false;
        const message = {
          type,
          data,
          senderId: this.identity.id,
          sentServerTime: this.serverNow(),
          clientVersion: C.APP_VERSION,
        };
        if (!CwtchProtocol.application(message)) throw new Error(`Invalid ${type} message.`);
        const envelope = {
          v: C.PROTOCOL_VERSION,
          type: 'relay',
          roomId: this.bundle.roomId,
          senderId: this.identity.id,
          sessionId: this.sessionId,
          seq: this.seq++,
        };
        envelope.payload = await this.crypto.encrypt(message, envelope);
        if (!this.joined || generation !== this.generation) return false;
        if (['chat', 'moment'].includes(type)) {
          if (this.pending.size >= 30) return false;
          this.pending.set(
            data.id,
            setTimeout(() => this.finishDelivery(data.id, 'unconfirmed'), 10000),
          );
          C.utils.emit(this, 'delivery', { id: data.id, status: 'sending' });
        }
        const sent = this.sendRaw(envelope);
        if (!sent) this.finishDelivery(data.id, 'unconfirmed');
        return sent;
      });
      this.sendChain = operation.catch(() => {});
      return operation;
    }
    finishDelivery(id, status) {
      if (!this.pending.has(id)) return;
      clearTimeout(this.pending.get(id));
      this.pending.delete(id);
      C.utils.emit(this, 'delivery', { id, status });
    }
    retryNow() {
      if (this.bundle.expiresAt < Date.now()) {
        this.diagnostics.record('INVITE_EXPIRED', 'error');
        return false;
      }
      this.manualClose = false;
      this.closePort();
      this.portAttempts = 0;
      this.connect();
      return true;
    }
    closePort() {
      this.generation++;
      clearTimeout(this.portReconnectTimer);
      const port = this.port;
      this.port = null;
      try {
        port?.postMessage({ type: 'socket-close' });
        port?.disconnect();
      } catch {}
      this.disconnected();
    }
    close() {
      this.manualClose = true;
      this.closePort();
      this.lastSeqBySession.clear();
      this.setStatus('closed');
    }
  }
  C.RoomClient = RoomClient;
})();
