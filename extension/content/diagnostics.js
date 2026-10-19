(() => {
  "use strict";
  const C = globalThis.Cwtch;

  const CATALOG = Object.freeze({
    UNSUPPORTED_PAGE: ["This page is not a supported watch page.", "Open a Netflix, Prime Video, or YouTube video, then reopen Cwtch."],
    VIDEO_NOT_FOUND: ["Cwtch cannot find the active video element.", "Start the video, dismiss profiles or trailers, then press Run checks."],
    VIDEO_REPLACED: ["The site replaced its video player during navigation.", "Cwtch reattached automatically. If sync feels wrong, press Resync."],
    MEDIA_ERROR: ["The streaming player reported a media failure.", "Reload the title, disable VPN or content blockers temporarily, and try a lower playback quality."],
    BUFFERING_STALLED: ["Playback has been buffering for longer than expected.", "Pause both players, check both connections, then press Resume together."],
    MEDIA_RATE_REJECTED: ["The player rejected a temporary speed correction.", "Turn off Soft sync in settings or press Resync for a direct timestamp correction."],
    PLAYER_NOT_READY: ["The video player is still loading.", "Wait until the timeline appears and try Resume together."],
    WS_CONFIG_INVALID: ["The relay address is invalid.", "Open Cwtch settings and use a ws:// address locally or wss:// address in production."],
    LOCAL_RELAY_NOT_RUNNING: ["The local Cwtch relay is not running.", "Open the Cwtch source folder and run `npm ci`, then `npm run server`. Localhost only works on this computer; remote couples need a deployed wss:// relay."],
    WS_CONNECT_FAILED: ["Cwtch cannot reach the room relay.", "Check that the relay is running, the URL is correct, and HTTPS deployments use wss://."],
    WS_PROTOCOL_MISMATCH: ["The extension and relay speak different protocol versions.", "Deploy the relay bundled with this exact Cwtch release."],
    ROOM_FULL: ["This room already has two people.", "Ask your partner to close an old Cwtch tab, then join again."],
    ROOM_SECRET_INVALID: ["The invite secret is missing or damaged.", "Ask for a newly copied invite link."],
    INVITE_COPY_FAILED: ["Cwtch could not place the secure invite on the clipboard.", "Use the toolbar popup and press Copy invite again. Reload the streaming tab if another extension is intercepting clipboard actions."],
    INVITE_EXPIRED: ["This Cwtch invite is no longer active.", "Ask your person to create and copy a fresh room invite."],
    CONTENT_URL_UNSAFE: ["A shared destination was blocked for safety.", "Navigate to the title manually or ask for a fresh invite from the supported site."],
    DECRYPT_FAILED: ["A room message could not be decrypted.", "Both people must join from the same invite link. Leave and create a new room if it repeats."],
    ROOM_ID_INVALID: ["The room identifier is invalid.", "Create a fresh room instead of editing the invite link."],
    MEDIA_PLAY_BLOCKED: ["Chrome blocked remote playback until you interact with the page.", "Click Resume together once on this tab."],
    MEDIA_PAUSE_FAILED: ["The streaming player rejected a remote pause.", "Pause manually once, then press Resync."],
    MEDIA_SEEK_FAILED: ["The streaming player rejected a seek correction.", "Wait for buffering to finish, then press Resync."],
    NETFLIX_PLAYER_API_UNAVAILABLE: ["Netflix's protected player controls are not ready yet.", "Reload the Netflix title, wait until playback starts, then reopen or resync Cwtch."],
    DRIFT_EXCESSIVE: ["Playback drift stayed above the safe threshold.", "Check both connections, exit any ad break, and press Resync."],
    CONTENT_MISMATCH: ["You and your partner are on different videos.", "Open the shared title shown in Cwtch before resuming."],
    AD_BREAK_DETECTED: ["A platform ad break is active.", "Cwtch pauses hard corrections during ads and resumes automatically afterward."],
    PAGE_NAVIGATION: ["The streaming site navigated to another title or episode.", "Cwtch is reacquiring the player. Use Follow if your partner moved first."],
    EXTENSION_CONTEXT_INVALIDATED: ["Chrome reloaded or updated the extension context.", "Reload this streaming tab once."],
    STORAGE_FAILED: ["Cwtch could not save local room state.", "Check Chrome storage access, then reload the extension."],
    SERVER_UNHEALTHY: ["The relay health check failed.", "Open settings, confirm the relay URL, and restart the relay service."],
    NETWORK_OFFLINE: ["This computer is offline.", "Reconnect to the internet; Cwtch will retry the room automatically."],
    RELAY_SILENT: ["The relay stopped answering health pings.", "Check the network and relay status, then leave and rejoin if it does not recover."],
    PERMISSION_MISSING: ["A required Chrome extension capability is unavailable.", "Reload Cwtch from chrome://extensions and reload this streaming tab."],
    RATE_LIMITED: ["The relay temporarily slowed this client.", "Avoid rapid repeated controls. Cwtch will reconnect automatically."],
    DUPLICATE_SESSION: ["The same Cwtch identity opened another active session.", "Keep only one watch tab open for this room."],
    CLOCK_SKEW: ["The two computers' clocks differ significantly.", "Enable automatic date and time on both computers."],
    CSP_OR_DOM_INTERFERENCE: ["The site UI is interfering with Cwtch's overlay or player access.", "Reload the page and temporarily disable other watch-party extensions."],
    INTERNAL_ERROR: ["Cwtch hit an unexpected error.", "Copy the diagnostic report before reloading; it includes the failing step without room secrets."]
  });

  class Diagnostics extends EventTarget {
    constructor(context = {}) {
      super();
      this.context = { appVersion: C.APP_VERSION, protocol: C.PROTOCOL_VERSION, ...context };
      this.entries = [];
      this.metrics = {
        connected: false,
        latencyMs: null,
        serverOffsetMs: null,
        playerReady: false,
        driftSeconds: null,
        adActive: false,
        lastSyncAt: null
      };
      this.maxEntries = 120;
      this.dedupeWindowMs = 12_000;
      window.addEventListener("online", () => this.dispatchEvent(new Event("change")));
      window.addEventListener("offline", () => this.record("NETWORK_OFFLINE", "warning", { online: false }));
      window.addEventListener("error", (event) => {
        this.record("INTERNAL_ERROR", "error", { message: event.message, source: event.filename, line: event.lineno });
      });
      window.addEventListener("unhandledrejection", (event) => {
        this.record("INTERNAL_ERROR", "error", { message: String(event.reason?.message || event.reason) });
      });
    }

    updateContext(patch) {
      Object.assign(this.context, patch);
      this.dispatchEvent(new Event("change"));
    }

    metric(name, value) {
      this.metrics[name] = value;
      this.dispatchEvent(new Event("change"));
    }

    record(code, severity = "warning", evidence = {}) {
      const [message, fix] = CATALOG[code] || CATALOG.INTERNAL_ERROR;
      const redactedEvidence = this.redact(evidence);
      const now = Date.now();
      const latest = this.entries[0];
      if (latest && latest.code === code && now - Date.parse(latest.time) < this.dedupeWindowMs && C.utils.safeJson(latest.evidence) === C.utils.safeJson(redactedEvidence)) {
        latest.time = new Date(now).toISOString();
        latest.occurrences = (latest.occurrences || 1) + 1;
        this.dispatchEvent(new Event("change"));
        return latest;
      }
      const entry = {
        id: C.utils.randomId(8),
        time: new Date(now).toISOString(),
        code,
        severity,
        message,
        fix,
        evidence: redactedEvidence,
        occurrences: 1
      };
      this.entries.unshift(entry);
      if (this.entries.length > this.maxEntries) this.entries.length = this.maxEntries;
      this.dispatchEvent(new Event("change"));
      return entry;
    }

    clearResolved() {
      this.entries = this.entries.filter((entry) => entry.severity === "error");
      this.dispatchEvent(new Event("change"));
    }

    redact(value) {
      const secretKeys = /secret|cipher|token|invite/i;
      if (Array.isArray(value)) return value.map((item) => this.redact(item));
      if (!value || typeof value !== "object") return value;
      const output = {};
      for (const [key, item] of Object.entries(value)) {
        output[key] = secretKeys.test(key) ? "[redacted]" : this.redact(item);
      }
      return output;
    }

    snapshot() {
      return {
        generatedAt: new Date().toISOString(),
        context: this.redact(this.context),
        metrics: { ...this.metrics },
        latestIssues: this.entries.slice(0, 50),
        environment: {
          userAgent: navigator.userAgent,
          online: navigator.onLine,
          visibility: document.visibilityState,
          url: `${location.origin}${location.pathname}${location.search}`
        }
      };
    }

    async runSelfTest({ platform, media, roomClient, settings, roomBundle }) {
      const results = [];
      const push = (name, ok, detail) => results.push({ name, ok, detail });
      push("Network", navigator.onLine, navigator.onLine ? "Online" : "Offline");
      push("Supported platform", Boolean(platform?.supported), platform?.name || "Unknown");
      push("Watch page", Boolean(platform?.isWatchPage?.()), platform?.getContentKey?.() || "No content key");
      push("Video element", media instanceof HTMLMediaElement, media ? `readyState ${media.readyState}` : "Not found");
      push("Player ready", Boolean(media && media.readyState >= 1), media ? `duration ${Number.isFinite(media.duration) ? Math.round(media.duration) : "live"}` : "Not found");
      push("Media pipeline", !media?.error, media?.error ? `media error ${media.error.code}` : "No player error");
      push("Ad break", !platform?.isAdActive?.(), platform?.isAdActive?.() ? "Active — sync safely suspended" : "Not active");
      push("Web Crypto", Boolean(globalThis.crypto?.subtle), globalThis.crypto?.subtle ? "Available" : "Unavailable");
      push("Extension runtime", Boolean(chrome?.runtime?.id), chrome?.runtime?.id ? "Available" : "Unavailable");
      push("Extension storage", Boolean(chrome?.storage?.local), chrome?.storage?.local ? "Available" : "Unavailable");
      if (roomBundle?.secret) {
        let secretOk = false;
        try { secretOk = C.utils.base64UrlToBytes(roomBundle.secret).byteLength === 32; } catch {}
        push("Room encryption key", secretOk, secretOk ? "32-byte AES key" : "Invalid key");
      }
      if (roomClient) {
        push("Relay connection", Boolean(roomClient.connected), roomClient.status || "Disconnected");
        const fresh = !roomClient.lastMessageAt || Date.now() - roomClient.lastMessageAt < 45_000;
        push("Relay heartbeat", fresh, roomClient.lastMessageAt ? `${Math.round((Date.now() - roomClient.lastMessageAt) / 1000)}s ago` : "Waiting for first response");
      } else if (settings?.relayUrl) {
        try {
          const response = await chrome.runtime.sendMessage({ type: "CWTCH_CHECK_RELAY", relayUrl: settings.relayUrl });
          push("Relay health", Boolean(response?.ok), response?.ok ? `protocol ${response.health.protocol}` : response?.error || "Unavailable");
        } catch (error) { push("Relay health", false, error.message); }
      }
      return results;
    }
  }

  C.Diagnostics = Diagnostics;
  C.DIAGNOSTIC_CATALOG = CATALOG;
})();
