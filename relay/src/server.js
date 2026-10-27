import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { config } from './config.js';
import { createLogger } from './logger.js';
import { SlidingWindowLimiter } from './rate-limiter.js';
import { RoomRegistry } from './room-registry.js';
import {
  originAllowed,
  parseJsonMessage,
  validateJoin,
  validateRelay,
  PROTOCOL_VERSION,
} from './validation.js';

export function createRelay(options = {}) {
  const cfg = { ...config, ...options },
    logger = createLogger(cfg.logLevel);
  const registry = new RoomRegistry({ idleTtlMs: cfg.roomIdleTtlMs });
  const startedAt = Date.now(),
    ipCounts = new Map();
  const metrics = { joins: 0, rejected: 0, relayed: 0, rateLimited: 0 };
  let draining = false;
  const server = http.createServer((req, res) => {
    const path = (req.url || '/').split('?')[0];
    const status =
      req.method === 'GET' && ['/health', '/ready', '/version'].includes(path)
        ? draining
          ? 503
          : 200
        : 404;
    const body =
      status === 404
        ? { ok: false, code: 'NOT_FOUND' }
        : {
            ok: !draining,
            service: 'cwtch-relay',
            version: '0.2.0',
            protocol: PROTOCOL_VERSION,
            uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
            ...registry.stats(),
          };
    res.writeHead(status, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
    });
    res.end(JSON.stringify(body));
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: cfg.maxPayloadBytes,
    perMessageDeflate: false,
  });
  server.on('upgrade', (req, socket, head) => {
    const ip = req.socket.remoteAddress || 'unknown';
    const status =
      draining ||
      wss.clients.size >= cfg.maxConnections ||
      (ipCounts.get(ip) || 0) >= cfg.maxConnectionsPerIp
        ? 503
        : (req.url || '').split('?')[0] !== '/ws'
          ? 404
          : !originAllowed(req.headers.origin || '', cfg.allowedOrigins)
            ? 403
            : 0;
    if (status) {
      metrics.rejected++;
      socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\n\r\n`);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress || 'unknown';
    ipCounts.set(ip, (ipCounts.get(ip) || 0) + 1);
    const limiter = new SlidingWindowLimiter(cfg.maxMessagesPerWindow, cfg.rateWindowMs);
    const state = { joined: false, roomId: null, clientId: null, sessionId: null, seq: -1 };
    let alive = true;
    const send = (data) => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ v: PROTOCOL_VERSION, ...data }));
    };
    const fail = (code, message, closeCode) => {
      metrics.rejected++;
      send({ type: 'error', code, message });
      if (closeCode) ws.close(closeCode, code);
    };
    const joinTimeout = setTimeout(() => {
      if (!state.joined) ws.close(4002, 'JOIN_TIMEOUT');
    }, cfg.joinTimeoutMs);
    joinTimeout.unref();
    ws.on('pong', () => {
      alive = true;
    });
    ws.on('message', (data) => {
      if (!limiter.accept()) {
        metrics.rateLimited++;
        fail('RATE_LIMITED', 'Too many messages. Try again shortly.', 4011);
        return;
      }
      const parsed = parseJsonMessage(data, cfg.maxPayloadBytes);
      if (!parsed.ok) return fail(parsed.code, parsed.reason, 4002);
      const m = parsed.value;
      if (!state.joined && m.v === PROTOCOL_VERSION && m.type === 'health') {
        send({
          type: 'health',
          ok: true,
          service: 'cwtch-relay',
          protocol: PROTOCOL_VERSION,
          uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
          ...registry.stats(),
        });
        ws.close(1000, 'HEALTH_CHECK_COMPLETE');
        return;
      }
      if (!state.joined) {
        const valid = validateJoin(m);
        if (!valid.ok) return fail(valid.code, valid.reason, 4002);
        const joined = registry.join(m.roomId, m.clientId, ws, Date.now(), m.auth);
        if (!joined.ok)
          return fail(
            joined.code,
            joined.code === 'ROOM_FULL'
              ? 'This room already has two people.'
              : 'This invite cannot join this room.',
            joined.code === 'ROOM_FULL' ? 4003 : 4004,
          );
        clearTimeout(joinTimeout);
        Object.assign(state, {
          joined: true,
          roomId: m.roomId,
          clientId: m.clientId,
          sessionId: m.sessionId,
        });
        metrics.joins++;
        send({ type: 'joined', roomId: state.roomId, ...joined, serverTime: Date.now() });
        registry.relay(
          state.roomId,
          state.clientId,
          JSON.stringify({
            v: PROTOCOL_VERSION,
            type: 'peer_joined',
            ...registry.membership(state.roomId),
            serverTime: Date.now(),
          }),
        );
        return;
      }
      if (!registry.isCurrent(state.roomId, state.clientId, ws))
        return ws.close(4009, 'DUPLICATE_SESSION');
      if (m.v !== PROTOCOL_VERSION) return fail('PROTOCOL_MISMATCH', 'Update Cwtch.', 4002);
      if (m.type === 'ping') {
        registry.touch(state.roomId);
        send({
          type: 'pong',
          nonce: typeof m.nonce === 'string' ? m.nonce.slice(0, 80) : '',
          clientTime: m.clientTime,
          serverTime: Date.now(),
        });
        return;
      }
      if (m.type !== 'relay') return fail('UNKNOWN_MESSAGE', 'Unknown message type.', 4002);
      if (
        m.roomId !== state.roomId ||
        m.senderId !== state.clientId ||
        m.sessionId !== state.sessionId
      )
        return fail('IDENTITY_MISMATCH', 'Session identity mismatch.', 4002);
      const valid = validateRelay(m);
      if (!valid.ok) return fail(valid.code, valid.reason, 4002);
      if (m.seq <= state.seq)
        return fail('INVALID_SEQUENCE', 'Message sequence was replayed.', 4002);
      state.seq = m.seq;
      metrics.relayed += registry.relay(
        state.roomId,
        state.clientId,
        JSON.stringify({
          v: PROTOCOL_VERSION,
          type: 'relay',
          roomId: state.roomId,
          senderId: state.clientId,
          sessionId: state.sessionId,
          seq: m.seq,
          payload: m.payload,
          serverTime: Date.now(),
        }),
      );
    });
    ws.on('close', () => {
      clearTimeout(joinTimeout);
      const remaining = (ipCounts.get(ip) || 1) - 1;
      if (remaining) ipCounts.set(ip, remaining);
      else ipCounts.delete(ip);
      if (state.joined && registry.leave(state.roomId, state.clientId, ws)) {
        registry.relay(
          state.roomId,
          state.clientId,
          JSON.stringify({
            v: PROTOCOL_VERSION,
            type: 'peer_left',
            ...registry.membership(state.roomId),
            serverTime: Date.now(),
          }),
        );
      }
    });
    ws.on('error', () => {
      metrics.rejected++;
    });
    ws.heartbeat = () => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    };
  });
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) if (ws.readyState === 1) ws.heartbeat();
  }, 30000);
  const sweep = setInterval(() => registry.sweep(), 60000);
  const reporting = setInterval(
    () =>
      logger.info('relay_metrics', { ...metrics, ...registry.stats(), sockets: wss.clients.size }),
    60000,
  );
  heartbeat.unref();
  sweep.unref();
  reporting.unref();
  async function close() {
    draining = true;
    clearInterval(heartbeat);
    clearInterval(sweep);
    clearInterval(reporting);
    for (const ws of wss.clients) ws.close(1012, 'SERVER_RESTARTING');
    const force = setTimeout(() => {
      for (const ws of wss.clients) ws.terminate();
    }, 1000);
    force.unref();
    await Promise.all([
      new Promise((resolve) => server.close(resolve)),
      new Promise((resolve) => wss.close(resolve)),
    ]);
    clearTimeout(force);
  }
  return { server, wss, registry, metrics, close };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const relay = createRelay();
  relay.server.listen(config.port, config.host, () =>
    console.log(
      JSON.stringify({ event: 'server_started', port: config.port, protocol: PROTOCOL_VERSION }),
    ),
  );
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, () => relay.close().then(() => process.exit(0)));
}
