import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { config } from "./config.js";
import { createLogger } from "./logger.js";
import { SlidingWindowLimiter } from "./rate-limiter.js";
import { RoomRegistry } from "./room-registry.js";
import { originAllowed, parseJsonMessage, validateJoin, validateRelay, PROTOCOL_VERSION } from "./validation.js";

const logger = createLogger(config.logLevel);
const registry = new RoomRegistry({ idleTtlMs: config.roomIdleTtlMs });
const startedAt = Date.now();

function writeJson(response, status, body) {
  const json = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(json),
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'"
  });
  response.end(json);
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  if (request.method === "GET" && url.pathname === "/health") {
    writeJson(response, 200, {
      ok: true,
      service: "cwtch-relay",
      protocol: PROTOCOL_VERSION,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      ...registry.stats()
    });
    return;
  }
  if (request.method === "GET" && url.pathname === "/version") {
    writeJson(response, 200, { service: "cwtch-relay", version: "0.1.4", protocol: PROTOCOL_VERSION });
    return;
  }
  writeJson(response, 404, { ok: false, code: "NOT_FOUND" });
});

const wss = new WebSocketServer({ noServer: true, maxPayload: config.maxPayloadBytes });
let totalConnections = 0;

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  if (url.pathname !== "/ws") {
    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  const origin = request.headers.origin || "";
  if (!originAllowed(origin, config.allowedOrigins)) {
    socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    socket.destroy();
    logger.warn("upgrade_rejected_origin", { origin });
    return;
  }
  if (totalConnections >= config.maxConnections) {
    socket.write("HTTP/1.1 503 Service Unavailable\r\nRetry-After: 5\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
});

wss.on("connection", (ws, request) => {
  totalConnections += 1;
  const limiter = new SlidingWindowLimiter(config.maxMessagesPerWindow, config.rateWindowMs);
  const state = { joined: false, roomId: null, clientId: null, sessionId: null };
  ws._cwtchAlive = true;
  const remoteAddress = request.socket.remoteAddress || "unknown";

  ws.on("pong", () => { ws._cwtchAlive = true; });

  ws.on("message", (data) => {
    if (!limiter.accept()) {
      ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "error", code: "RATE_LIMITED", message: "Too many messages. Slow down and reconnect if needed." }));
      return;
    }

    const parsed = parseJsonMessage(data, config.maxPayloadBytes);
    if (!parsed.ok) {
      ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "error", code: parsed.code, message: parsed.reason }));
      return;
    }
    const message = parsed.value;

    if (!state.joined && message.v === PROTOCOL_VERSION && message.type === "health") {
      ws.send(JSON.stringify({
        v: PROTOCOL_VERSION,
        type: "health",
        ok: true,
        service: "cwtch-relay",
        protocol: PROTOCOL_VERSION,
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        ...registry.stats()
      }));
      ws.close(1000, "HEALTH_CHECK_COMPLETE");
      return;
    }

    if (!state.joined) {
      const result = validateJoin(message);
      if (!result.ok) {
        ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "error", code: result.code, message: result.reason }));
        ws.close(4002, result.code);
        return;
      }
      const joined = registry.join(message.roomId, message.clientId, ws);
      if (!joined.ok) {
        ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "error", code: joined.code, message: "This Cwtch room already has two people." }));
        ws.close(4003, joined.code);
        return;
      }
      Object.assign(state, {
        joined: true,
        roomId: message.roomId,
        clientId: message.clientId,
        sessionId: message.sessionId
      });
      ws.send(JSON.stringify({
        v: PROTOCOL_VERSION,
        type: "joined",
        roomId: state.roomId,
        occupants: joined.occupants,
        replaced: joined.replaced,
        serverTime: Date.now()
      }));
      registry.relay(state.roomId, state.clientId, JSON.stringify({
        v: PROTOCOL_VERSION,
        type: "peer_joined",
        occupants: joined.occupants,
        serverTime: Date.now()
      }));
      logger.info("client_joined", { roomId: state.roomId, clientId: state.clientId, occupants: joined.occupants, remoteAddress });
      return;
    }

    if (message.type === "ping") {
      ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "pong", nonce: message.nonce, clientTime: message.clientTime, serverTime: Date.now() }));
      return;
    }

    if (message.type === "relay") {
      if (message.roomId !== state.roomId || message.senderId !== state.clientId || message.sessionId !== state.sessionId) {
        ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "error", code: "IDENTITY_MISMATCH", message: "Relay identity does not match the joined connection." }));
        return;
      }
      const valid = validateRelay(message);
      if (!valid.ok) {
        ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "error", code: valid.code, message: valid.reason }));
        return;
      }
      const outgoing = JSON.stringify({ ...message, serverTime: Date.now() });
      registry.relay(state.roomId, state.clientId, outgoing);
      return;
    }

    ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "error", code: "UNKNOWN_MESSAGE", message: "Unknown message type." }));
  });

  ws.on("close", (code, reason) => {
    totalConnections = Math.max(0, totalConnections - 1);
    if (state.joined) {
      const occupants = registry.leave(state.roomId, state.clientId, ws);
      registry.relay(state.roomId, state.clientId, JSON.stringify({
        v: PROTOCOL_VERSION,
        type: "peer_left",
        occupants,
        serverTime: Date.now()
      }));
      logger.info("client_left", { roomId: state.roomId, clientId: state.clientId, occupants, code, reason: reason.toString() });
    }
  });

  ws.on("error", (error) => {
    logger.warn("websocket_error", { roomId: state.roomId, clientId: state.clientId, message: error.message });
  });
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    if (ws._cwtchAlive === false) {
      ws.terminate();
      continue;
    }
    ws._cwtchAlive = false;
    ws.ping();
  }
}, 30_000);
heartbeat.unref();

const sweep = setInterval(() => {
  const removed = registry.sweep();
  if (removed.length) logger.info("rooms_swept", { count: removed.length });
}, 60_000);
sweep.unref();

const shutdown = (signal) => {
  logger.info("shutdown_started", { signal });
  clearInterval(heartbeat);
  clearInterval(sweep);
  for (const client of wss.clients) {
    try { client.close(1012, "SERVER_RESTARTING"); } catch {}
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("uncaughtException", (error) => {
  logger.error("uncaught_exception", { message: error.message, stack: error.stack });
  shutdown("uncaughtException");
});
process.on("unhandledRejection", (reason) => {
  logger.error("unhandled_rejection", { message: String(reason) });
});

server.listen(config.port, config.host, () => {
  logger.info("server_started", { host: config.host, port: config.port, protocol: PROTOCOL_VERSION });
});
