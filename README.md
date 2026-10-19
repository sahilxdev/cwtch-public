# Cwtch

Cwtch is a Chrome extension for private two-person watch parties on Netflix, Prime Video, and YouTube. It synchronizes playback and adds room chat, reactions, nudges, date-night prompts, and shared timestamped moments.

The video stays on the streaming service. The extension sends playback state and room messages through a small WebSocket relay. Room payloads are encrypted in the extension with AES-GCM before relaying. The relay still handles connection and routing metadata, so this should not be described as an independently audited security product.

## Repository layout

- `extension/` — unpacked Chrome Manifest V3 extension, version 0.1.5.
- `relay/` — Node.js WebSocket relay, protocol version 1, with Docker deployment support.

## Run locally

Requirements: Google Chrome 116 or newer, Node.js 20.17 or newer, and npm 10 or newer.

1. Start the relay:

   ```sh
   cd relay
   npm ci
   npm start
   ```

   The local WebSocket endpoint is `ws://localhost:8787/ws`; the health endpoint is `http://localhost:8787/health`.

2. In Chrome, open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select this repository's `extension/` folder.
3. Open the extension settings and leave the relay URL as `ws://localhost:8787/ws` for two browsers on the same computer. For two different computers, deploy the relay and use its secure `wss://` URL on both.
4. Open a supported watch page, create a room, and send the invite link privately to the other person. The invite includes the room key; anyone with it can join while the room exists.

## Deploy the relay

The relay includes a Dockerfile and can be deployed to a container host that supports WebSockets and provides HTTPS/TLS. Use the repository root as the source and `relay/` as the Docker build context (or configure the host's Dockerfile path as `relay/Dockerfile`). The process listens on `0.0.0.0:$PORT`; if the host does not set `PORT`, it uses 8787.

Set these environment variables in the hosting service:

| Variable | Value | Purpose |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | Listen on the container network interface. |
| `PORT` | Host-provided port, or `8787` | HTTP and WebSocket listener. |
| `ALLOWED_ORIGINS` | `chrome-extension://*` | Permit Chrome extension origins. Narrow this to your known extension origin when you have a stable extension ID. |
| `ROOM_IDLE_TTL_MS` | `21600000` | Expire rooms after six hours without activity. |
| `MAX_CONNECTIONS` | `5000` | Maximum simultaneous relay connections. |
| `LOG_LEVEL` | `info` | Relay log verbosity. |

After deployment, confirm `https://YOUR-HOST/health` returns a healthy response. In the extension settings, set the relay URL to `wss://YOUR-HOST/ws` on both computers. Do not use public `ws://` URLs; the extension rejects insecure non-local relays.

The relay keeps room membership in memory. A restart disconnects participants and removes active rooms; create a fresh invite after restarting. It does not need API keys or credentials for this setup.

## Privacy and security notes

- Room data is encrypted by the extension using AES-GCM and a randomly generated 32-byte room key. That key is carried in the invite URL fragment, so share invites only with the intended person.
- The relay forwards ciphertext and manages room membership. It can still observe connection metadata such as IP address, room identifier, timing, and message size.
- Use a TLS-enabled `wss://` endpoint for any public relay deployment.
- Do not commit invite links, diagnostic reports, `.env` files, certificates, or private keys. This repository does not require a secret to run.
- This is a personal project, not an audited security product. Streaming services can change their player implementations and break compatibility.

## Current scope

This is an unpacked extension source release. It is not a Chrome Web Store listing, and the project files do not establish that every supported-site flow has been validated against current production players. The relay has no user accounts, persistent storage, or video streaming functionality.

## License

MIT. See [`LICENSE`](LICENSE).
