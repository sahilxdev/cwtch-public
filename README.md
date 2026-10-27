# Cwtch

A quiet place to watch together. Cwtch is a Chrome extension for private, two-person watch parties on Netflix, Prime Video, and YouTube. Video plays separately through each person's streaming account. Cwtch exchanges encrypted playback state, chat, reactions, prompts, and timestamped moments.

**Version 0.2.0 · protocol 2.** Both participants and the relay must update together. Old invites are incompatible; create a new one after updating. This is an unpacked source release, not a Chrome Web Store listing or an independently audited security product.

## Start locally

Requirements: Chrome 124+, Node.js 22.13+ (24 recommended), npm 10+.

```sh
npm ci --prefix relay
npm start
```

The relay listens at `ws://localhost:8787/ws`. Its health endpoint is `http://localhost:8787/health`.

1. Open `chrome://extensions`, turn on Developer mode, and choose **Load unpacked** → this repository's `extension/` directory.
2. Open Cwtch settings and check the relay connection.
3. Open a supported title and start the video once. Open Cwtch, enter your name, and choose **Create room**.
4. Share the private invite. Your person needs Cwtch installed and access to the same title.
5. Both people can use normal player controls. If Chrome blocks remote playback, choose **Resume together** once.

Localhost works on one computer. Two computers need a shared, TLS-enabled `wss://` relay. No public relay is provisioned or hardcoded in this repository.

## What changed in 0.2

- Readable light/dark interfaces, clear connection versus playback states, accessible keyboard tabs, reduced motion, and actionable errors.
- Authenticated room joins, AES-GCM binding of message metadata, strict application schemas, ordered crypto processing, and replay rejection.
- Deterministic conflict resolution for simultaneous controls; periodic synchronization leadership transfers when someone leaves.
- Playback correction respects ads, loading, title mismatches, and seekable ranges. Live streams deliberately avoid guessed absolute seeks.
- No replay of stale playback commands or reactions after reconnecting.
- Chat delivery acknowledgement, duplicate suppression, and explicit retry for unconfirmed messages.
- Moments include the original title, can seek both players on that title, and export as JSON. Date-night cards can be shared or hidden.
- Per-tab room restoration through browser-session storage. Optional encrypted local history, disabled by default, with expiry and clear controls.
- Relay join deadlines, connection caps, rate limits, slow-client protection, aggregate metrics, and graceful shutdown.
- Automated tests, browser fixtures, linting, formatting, CI, and deployment documentation.

## Behavior to know

Either person can control playback. Competing actions are ordered by a logical counter and participant ID, giving both clients the same tie-break rule. The first connected member supplies periodic correction; the remaining member takes over on departure. This is synchronization authority, not an account or moderator role.

A room has at most two connections. Refreshing the same tab retains its identity during the browser session; another tab has a separate identity. Leaving affects only that tab. All keys disappear when the browser session ends. An invite admits participants for eight hours; an already connected session can continue past that time, but cannot be restored with an expired invite.

Ads and loading suspend correction. Cwtch does not forcibly pause the other person when one player buffers. It never skips ads. Title following is opt-in and restricted to direct supported watch pages on the same service. Live video has manual controls because equal timestamps do not reliably mean equal live content.

An acknowledgement means the receiving extension validated the message, not that a person read it. An unconfirmed message may already have arrived; retry uses the same ID to suppress duplicates during the current client session. Offline messages are not silently queued. Chat is limited to 100 messages and moments to 80 per room view. Optional saved history is encrypted on the device and requires the original invite key to reopen it. Expired ciphertext is pruned when the worker starts or an active connection checks in. Exported moments are intentionally plaintext and contain notes and title links.

## Deploy

Use the **repository root as Docker build context**:

```sh
docker build -f relay/Dockerfile -t cwtch-relay .
docker run --rm -p 127.0.0.1:8787:8787 cwtch-relay
# Or: docker compose up --build -d
```

Place a WebSocket-capable TLS proxy in front for remote use. See [operations](docs/OPERATIONS.md) for settings, capacity boundaries, and restart behavior. The relay has no database. Use one instance, or route both members of a room to the same instance; random load balancing across independent instances will split rooms.

## Develop and verify

```sh
npm ci --ignore-scripts
npm ci --prefix relay --ignore-scripts
npm run check
npm run lint
npm run format:check
npm test
npx playwright install chromium
npm run test:browser
```

`npm run test:browser` uses real extension modules and real relay sockets, with simulated Chrome APIs and media players. Set `CHROME_PATH` to a compatible installed Chrome executable if needed. These tests do not establish current Netflix, Prime Video, or YouTube player compatibility.

For a local interactive review, run `node scripts/preview.mjs`, then open `http://127.0.0.1:8790/tests/fixtures/review.html`. The preview binds to loopback and runs an isolated test relay on port 8791. It never touches your streaming accounts. Stop it with Ctrl+C.

See [architecture](docs/ARCHITECTURE.md), [security boundaries](docs/SECURITY.md), and the [release validation matrix](docs/VALIDATION.md). GitHub CI runs when these local changes are pushed; its presence is not evidence that a remote run has passed.

## Layout

- `extension/shared/`: protocol rules and settings shared by clients and relay; UI theme.
- `extension/content/`: lifecycle, player adapters, crypto, connection client, synchronization, diagnostics, and panel.
- `extension/background.js`: WebSocket transport, browser-session room state, and per-tab identities.
- `extension/popup/`, `extension/options/`: entry flow and preferences.
- `relay/src/`: HTTP/WebSocket server, registry, configuration, and validation.
- `tests/`, `scripts/`: regressions, simulated browser scenarios, and developer checks.

MIT. See [LICENSE](LICENSE).
