export const PROTOCOL_VERSION = 1;

const ROOM_ID_RE = /^[A-Za-z0-9_-]{12,48}$/;
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{12,80}$/;
const SESSION_ID_RE = /^[A-Za-z0-9_-]{12,80}$/;

export function parseJsonMessage(data, maxPayloadBytes) {
  const text = typeof data === "string" ? data : data.toString("utf8");
  if (Buffer.byteLength(text, "utf8") > maxPayloadBytes) {
    return { ok: false, code: "PAYLOAD_TOO_LARGE", reason: "Message exceeds the 64 KB limit." };
  }
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, code: "INVALID_MESSAGE", reason: "Message must be a JSON object." };
    }
    return { ok: true, value };
  } catch {
    return { ok: false, code: "INVALID_JSON", reason: "Message is not valid JSON." };
  }
}

export function validateJoin(message) {
  if (message.v !== PROTOCOL_VERSION || message.type !== "join") {
    return { ok: false, code: "PROTOCOL_MISMATCH", reason: `Expected protocol v${PROTOCOL_VERSION} join message.` };
  }
  if (!ROOM_ID_RE.test(message.roomId || "")) {
    return { ok: false, code: "INVALID_ROOM_ID", reason: "Room ID format is invalid." };
  }
  if (!CLIENT_ID_RE.test(message.clientId || "")) {
    return { ok: false, code: "INVALID_CLIENT_ID", reason: "Client ID format is invalid." };
  }
  if (!SESSION_ID_RE.test(message.sessionId || "")) {
    return { ok: false, code: "INVALID_SESSION_ID", reason: "Session ID format is invalid." };
  }
  return { ok: true };
}

export function validateRelay(message) {
  if (message.v !== PROTOCOL_VERSION || message.type !== "relay") {
    return { ok: false, code: "INVALID_RELAY", reason: "Relay envelope is invalid." };
  }
  if (!Number.isSafeInteger(message.seq) || message.seq < 0) {
    return { ok: false, code: "INVALID_SEQUENCE", reason: "Relay sequence must be a non-negative integer." };
  }
  if (!SESSION_ID_RE.test(message.sessionId || "")) {
    return { ok: false, code: "INVALID_SESSION_ID", reason: "Relay session ID format is invalid." };
  }
  const payload = message.payload;
  if (!payload || typeof payload.iv !== "string" || typeof payload.ciphertext !== "string") {
    return { ok: false, code: "INVALID_CIPHERTEXT", reason: "Encrypted payload is missing." };
  }
  if (payload.iv.length > 64 || payload.ciphertext.length > 90_000) {
    return { ok: false, code: "INVALID_CIPHERTEXT", reason: "Encrypted payload shape is invalid." };
  }
  return { ok: true };
}

export function originAllowed(origin, patterns) {
  if (!origin) return patterns.includes("*");
  return patterns.some((pattern) => {
    if (pattern === "*") return true;
    if (!pattern.includes("*")) return origin === pattern;
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${escaped}$`).test(origin);
  });
}
