# Architecture and contracts

## Process boundaries

The popup sends typed runtime commands to the content application. That application owns the room key and player adapter, encrypts payloads, and sends them through a Chrome runtime port. The background worker owns WebSockets, health probes, backoff, and per-tab browser-session storage. The relay validates envelopes and membership but never receives the AES key.

The extension's ordered content script list loads `shared/protocol.js` first. The same file is imported by the relay, avoiding protocol/default drift. `Cwtch` exposes modules in the isolated content world; the Netflix bridge alone runs in the page's main world. The bridge transports player commands, never room messages or keys.

## Protocol 2

Join: version, room ID, client ID, session ID, and a domain-separated SHA-256 room authentication value derived from the invite key and room ID. The relay stores this value only in memory and compares it in constant time. It prevents someone who knows identifiers but not the key from joining an already established room. It is not proof of a real-world identity.

Membership responses include the current member IDs and leader. A replaced socket cannot relay or announce departure for the replacement. The first connected member is the periodic sync leader; removing it transfers leadership to the next member.

Encrypted envelope: version, room ID, sender ID, session ID, monotonically increasing sequence, a fresh 96-bit IV, and ciphertext. AES-GCM associated data is the JSON array `[2, roomId, senderId, sessionId, seq]`. Encryption and decryption use separate serial chains. Both relay and receiver reject repeated sequence numbers. The receiver validates the decrypted payload and inner sender identity before dispatch.

Message types are presence, sync-state, sync-request, chat, ack, reaction, nudge, moment, prompt, and navigation. Unknown or malformed messages are rejected. Sync states require finite media positions and playback rates; navigation is validated again at the point of use.

Chat and moments receive encrypted acknowledgements. Acknowledgements are not receipts for reading or durable storage. Retrying a chat retains its ID, and the receiver's bounded in-memory set suppresses repeat rendering. Deduplication does not survive a full client restart.

## Playback ordering

Each local playback action increments a logical counter and stamps the sender's ID. A receiver accepts the greater counter, then a lexicographic ID tie-break. Remote operations consume expected media events to avoid an echo. A new local action takes priority over the remaining work of a slow remote seek. Periodic updates come only from the elected leader, but either person can issue a control.

Large drift seeks; small drift can temporarily adjust speed. Netflix uses its player API for seek, play, and pause and disables rate correction. Ads, unloaded players, and mismatched content suspend correction. Seeking is bounded to actual seekable ranges. Infinite-duration media does not receive an absolute seek because live offsets are not portable.

## State and lifetime

`chrome.storage.local`: settings and display name; encrypted room history only when explicitly enabled. `chrome.storage.session`, mediated by the worker: tab client IDs and tab room bundles. Tab closure removes both. A browser-session reset removes keys. Legacy global active-room keys are removed on extension update.

The content app tracks timers/listeners and destroys them when replaced. The player watchdog reattaches to a replacement video, clears detached players, and remounts a removed overlay. Navigation updates the tab's room bundle before following another title.

## Deliberate choices

- Equal control instead of moderator roles.
- No forced mutual pause on buffering; show readiness and offer resync.
- No automatic live-timeline matching.
- No persistent server-side chat, accounts, or video transport.
- No automatic sending of diagnostic reports or external telemetry.
- One relay process unless deployment provides deterministic room routing.
