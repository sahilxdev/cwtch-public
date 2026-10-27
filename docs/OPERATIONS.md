# Relay operations

Build from the repository root with `docker build -f relay/Dockerfile -t cwtch-relay .`. The container runs as a non-root user. `docker compose up --build -d` exposes only loopback by default; use an HTTPS reverse proxy for a remote relay.

| Variable               | Default               | Meaning                                                          |
| ---------------------- | --------------------- | ---------------------------------------------------------------- |
| HOST                   | 0.0.0.0               | Listener interface                                               |
| PORT                   | 8787                  | HTTP and WebSocket port                                          |
| ALLOWED_ORIGINS        | chrome-extension://\* | Comma-separated exact origins, or valid Chrome extension origins |
| ROOM_IDLE_TTL_MS       | 21600000              | Inactive room lifetime; live pings refresh activity              |
| MAX_CONNECTIONS        | 5000                  | Open sockets across rooms and probes                             |
| MAX_CONNECTIONS_PER_IP | 100                   | Sockets per TCP source; tune for your proxy/network              |
| JOIN_TIMEOUT_MS        | 10000                 | Time allowed before a join or health request                     |
| LOG_LEVEL              | info                  | debug, info, warn, or error                                      |

The wildcard extension origin accepts the standard 32-character Chrome extension-ID shape. Narrow it to a known extension ID for a distributed build. Do not use `*` in production. No database credentials or service API key are required by the relay itself.

- `/health`: JSON process health and aggregate room/connection counts.
- `/ready`: returns 503 while draining; useful for load-balancer readiness.
- `/version`: release and protocol metadata.
- `/ws`: WebSocket transport and health probes.

Allow WebSocket upgrades and idle connections longer than 30 seconds at the proxy. TLS terminates at the host/proxy. Keep access logs free of invite data and avoid unnecessary IP retention. Aggregate application counters emit once per minute: successful joins, rejects, forwarded messages, rate limits, rooms, and connections. Route those logs into your host's monitoring and alerting system; no external monitoring account is configured here.

SIGINT/SIGTERM stops readiness, closes sockets with restart status, and terminates remaining sockets after a bounded grace period. Clients retry with exponential backoff and jitter. Restarting loses all rooms. Valid unexpired clients can recreate membership while reconnecting; stale playback events are not replayed. Invite expiry requires creating a fresh room.

One process owns a room. Horizontal scale needs consistent room routing or a shared membership/router design, neither of which is implemented. The default connection cap is a protective ceiling, not a measured capacity claim. Test your host with realistic traffic before increasing it.

## Deployment acceptance

Verify the container's healthcheck, HTTPS readiness, correct protocol, allowed extension origin, a real two-device encrypted session, reconnection during a rolling restart, proxy timeouts, and log retention. Set host-specific uptime and resource alerts. Record the deployed image digest and extension version. Keep the previous release available for rollback, remembering that protocol 1 and 2 cannot share invites.

## Render Free deployment

Use one Node web service in Singapore, on the `free` compute plan, with repository root as the working directory. Build with `npm ci --prefix relay --omit=dev` and start with `node relay/src/server.js`. Set `NODE_VERSION=24.19.0`, `NODE_ENV=production`, `HOST=0.0.0.0`, `ALLOWED_ORIGINS=chrome-extension://*`, `MAX_CONNECTIONS=100`, and `MAX_CONNECTIONS_PER_IP=100`. Let Render supply `PORT`. Configure `/ready` as the HTTP health check when the creation interface supports it; otherwise Render uses its default TCP health check and verify `/ready` separately.

A free service can take about a minute to wake after inactivity. Extension health checks retry Render-hosted relays for up to approximately 90 seconds. Other relays keep the five-second probe. Room traffic includes keepalive messages. Free compute hours are shared by the workspace, including any other free services. Do not enable paid compute or purchase extra resources without an approved budget.

After the deployment is live, run `node scripts/relay-smoke.mjs wss://YOUR-SERVICE.onrender.com/ws`. This checks HTTPS readiness, WebSocket health, authenticated membership, two-person capacity, bidirectional messages encrypted with the extension's actual crypto implementation, leader transfer, reconnection, replay rejection, and origin rejection. It uses two clients on one computer; a successful run is not evidence of a real two-device streaming-player test.

Set the resulting `wss://` URL in both extensions' Settings. Keep the service on one instance: separate instances do not share in-memory rooms.
