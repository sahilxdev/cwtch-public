const parseInteger = (name, fallback, min, max) => {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
};

export const config = Object.freeze({
  port: parseInteger('PORT', 8787, 1, 65535),
  host: process.env.HOST || '0.0.0.0',
  roomIdleTtlMs: parseInteger('ROOM_IDLE_TTL_MS', 6 * 60 * 60 * 1000, 60_000, 24 * 60 * 60 * 1000),
  maxConnections: parseInteger('MAX_CONNECTIONS', 5000, 2, 100_000),
  maxConnectionsPerIp: parseInteger('MAX_CONNECTIONS_PER_IP', 100, 2, 10000),
  joinTimeoutMs: parseInteger('JOIN_TIMEOUT_MS', 10000, 100, 60000),
  maxPayloadBytes: 65_536,
  maxMessagesPerWindow: 80,
  rateWindowMs: 10_000,
  logLevel: process.env.LOG_LEVEL || 'info',
  allowedOrigins: (process.env.ALLOWED_ORIGINS || 'chrome-extension://*')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
});
