# Security boundaries

Cwtch is not independently audited. The following describes implementation and known boundaries, not a security certification.

## Protected data

A 256-bit random room key encrypts room payloads using AES-GCM with a fresh random 96-bit nonce. Protocol metadata is authenticated as associated data. The key is shared in an invite fragment, removed from the current URL when the content app extracts it, and stored in extension browser-session storage. Optional history is encrypted using the same room key with separate associated-data labels. Public relay connections require TLS.

Fragments are not sent as part of normal HTTP requests, but can be observed by page scripts or other extensions before removal, clipboard tools, browser history/session facilities, and anyone receiving the invite. Sharing an invite grants access. Cwtch cannot protect a compromised browser, computer, or streaming page environment.

## Relay trust

The relay can observe IP addresses at the transport layer, room IDs, participant IDs, timing, sizes, membership, and a derived room authentication value. Application logs contain aggregate counters rather than raw IPs or room IDs. Hosting providers and reverse proxies may maintain their own logs; configure those separately.

The authentication value is not the AES key. However, a malicious relay can deny service, manipulate membership/timing, or replay/reorder traffic. Metadata binding and sequence checks limit envelope tampering and same-session replay, not all possible attacks by a malicious relay. There is no independently verifiable participant identity or cryptographic forward secrecy. A participant with the shared key can impersonate another participant; two-person access is not a substitute for trusted invite sharing.

Empty rooms are deleted. There is no persistent room reservation. A relay restart clears authentication values and membership. Invites are client-expiring bearer credentials, not server-enforced revocation or proof of identity.

## Input and resource limits

The relay restricts origins, payload sizes, per-connection rates, total and per-source-IP connections, join timeouts, and slow-client buffers. Origin checks are defense in depth, not authentication. Source-IP limits use the TCP peer, never blindly trust forwarded headers. Behind a proxy the cap may apply to the proxy itself.

The client validates invite size, protocol, key size, expiry, relay URL, content destination, decrypted message schema, sender, and sequence. Dynamic message text is rendered using textContent. Direct supported watch pages are allowed; local addresses and supported-site redirect endpoints are rejected as content destinations.

The Netflix bridge exists in a streaming page's main world. Page scripts can observe or imitate its player-command protocol. It carries no secrets; it is not an authenticated security boundary. A bridge reply cannot establish that a real protected player executed the requested action.

## Local data and diagnostics

History is off by default, capped, encrypted, and pruned after expiry during worker activity. Disabling history removes saved ciphertext. Clearing saved conversations removes that device's stored copy, not another participant's copy or the currently displayed conversation. A later message can save the active conversation again if retention remains enabled.

Diagnostic export redacts URL strings and likely secret values, omits query/path information from the environment, and excludes detailed evidence unless debug mode is enabled. Review reports before sharing; generic redaction cannot guarantee removal of every sensitive string. Exported moments are plaintext by design.

## Before a public release

Commission a cryptographic and browser-extension review; test CSP and extension-world assumptions; review key retention and message ordering under hostile inputs; confirm dependency audit results; validate the actual packaged extension and deployed TLS service. Do not claim audit, anonymity, end-to-end identity verification, or forward secrecy.
