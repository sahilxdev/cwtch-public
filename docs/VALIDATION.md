# Release validation

## Automated checks

`npm run check` validates JavaScript syntax and manifest references. `npm run lint` and `npm run format:check` enforce source consistency. `npm test` exercises crypto, invites, validation, replay handling, room replacement and election, limits, source-IP/origin behavior, tab storage, transport, ordering, delivery, diagnostics, and simulated player correction. Browser checks use real modules and relay sockets with explicit Chrome/media test doubles.

`npm run test:browser` launches Playwright Chromium. The interactive equivalent (`node scripts/preview.mjs`) exposes two pages: `/tests/fixtures/review.html` for the room flow and `/tests/fixtures/interfaces.html` for popup/settings regressions. Neither is a real streaming-player certification.

## Manual matrix before distribution

Run on current Chrome on macOS, Windows, and Linux. Record extension version, relay version, date, title, ad/subscription tier, observed result, and diagnostic evidence. Do not mark an item passed without running it.

| Area           | Cases                                                                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Install/update | Fresh unpacked install; update with tabs open; repair injection; unsupported site; no running relay                                               |
| Invites        | Extension absent; signed out; title unavailable; damaged/expired/old-version link; wrong relay; third participant; duplicate tab                  |
| Playback       | Play/pause from either side; simultaneous actions; long seek; repeated seeks; speeds 0.5/1/1.5/2; seek rejected; autoplay rejected; ending/replay |
| Players        | Real Netflix API available/unavailable; Prime title/episode IDs; YouTube videos/shorts/live; hidden trailers; video replaced; quality change      |
| Interruptions  | One-sided and unequal ads; buffering; offline/online; slow connection; packet delay; computer sleep; background tab; service-worker restart       |
| Navigation     | Next episode; SPA route; full reload; follow/auto-follow; mismatched title; unsafe redirect; room restored on same tab; browser restart           |
| UI             | Light/dark; 200% zoom; narrow viewport; fullscreen; native video fullscreen; picture-in-picture; subtitle overlap; reduced motion; high contrast  |
| Accessibility  | Keyboard entry/exit; arrow-key tabs; Escape; screen-reader announcement of messages/status; labels; visible focus; contrast measurement           |
| Social         | Failed acknowledgement; retry duplicates; disconnect while sending; unread count; sound muted/blocked; shared prompts; moments from other title   |
| Data           | History opt-in/out; reload restoration; clear history; expired data; encrypted storage inspection; plaintext moment export; diagnostic redaction  |
| Operations     | Two actual devices; TLS proxy; restart under load; readiness; rate-limit recovery; slow client; connection ceiling; logs/alerts                   |

## Evidence and remaining boundaries

Local Node tests and the interactive browser scenarios were exercised during implementation. The separate headless launcher could not start Chrome in the execution sandbox, so the browser scenarios were run in the in-app browser. CI and container builds are configured but must be observed in their actual environments. Real streaming accounts, live platform compatibility, cross-device behavior, production load, independent security review, and a complete assistive-technology audit remain release gates.

The current design deliberately uses equal participant control, manual handling for live timelines, and no forced pause of both viewers during buffering. These are product decisions, not unimplemented accidental behaviors.
