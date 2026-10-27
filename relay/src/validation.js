import '../../extension/shared/protocol.js';
const P = globalThis.CwtchProtocol;
export const PROTOCOL_VERSION = P.version;
export function parseJsonMessage(data, maxPayloadBytes) {
  const text = typeof data === 'string' ? data : data.toString('utf8');
  if (Buffer.byteLength(text) > maxPayloadBytes)
    return { ok: false, code: 'PAYLOAD_TOO_LARGE', reason: 'Message exceeds the limit.' };
  try {
    const value = JSON.parse(text);
    return P.object(value)
      ? { ok: true, value }
      : { ok: false, code: 'INVALID_MESSAGE', reason: 'Expected a JSON object.' };
  } catch {
    return { ok: false, code: 'INVALID_JSON', reason: 'Invalid JSON.' };
  }
}
export function validateJoin(m) {
  if (m.v !== PROTOCOL_VERSION || m.type !== 'join')
    return {
      ok: false,
      code: 'PROTOCOL_MISMATCH',
      reason: 'Update both extensions and the relay to Cwtch 0.2.',
    };
  for (const [key, code] of [
    ['roomId', 'INVALID_ROOM_ID'],
    ['clientId', 'INVALID_CLIENT_ID'],
    ['sessionId', 'INVALID_SESSION_ID'],
  ]) {
    if (typeof m[key] !== 'string' || !P.ID.test(m[key]))
      return { ok: false, code, reason: 'Invalid room or session identifier.' };
  }
  if (typeof m.auth !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(m.auth))
    return { ok: false, code: 'AUTH_FAILED', reason: 'A valid invite is required.' };
  return { ok: true };
}
export function validateRelay(m) {
  if (
    m.v !== PROTOCOL_VERSION ||
    m.type !== 'relay' ||
    !Number.isSafeInteger(m.seq) ||
    m.seq < 0 ||
    !P.ID.test(m.sessionId || '')
  )
    return { ok: false, code: 'INVALID_RELAY', reason: 'Invalid envelope.' };
  const p = m.payload;
  if (
    !P.object(p) ||
    typeof p.iv !== 'string' ||
    !/^[A-Za-z0-9_-]{16}$/.test(p.iv) ||
    typeof p.ciphertext !== 'string' ||
    p.ciphertext.length < 22 ||
    p.ciphertext.length > 60000 ||
    !P.B64.test(p.ciphertext)
  )
    return { ok: false, code: 'INVALID_CIPHERTEXT', reason: 'Invalid encrypted payload.' };
  return { ok: true };
}
export function originAllowed(origin, patterns) {
  if (!origin) return patterns.includes('*');
  return patterns.some(
    (pattern) =>
      pattern === '*' ||
      (pattern === 'chrome-extension://*'
        ? /^chrome-extension:\/\/[a-p]{32}$/.test(origin)
        : origin === pattern),
  );
}
