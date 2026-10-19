(() => {
  "use strict";
  const C = globalThis.Cwtch;

  class SyncEngine extends EventTarget {
    constructor({ media, platform, roomClient, diagnostics, identity, roomBundle, settings }) {
      super();
      this.media = media;
      this.platform = platform;
      this.roomClient = roomClient;
      this.diagnostics = diagnostics;
      this.identity = identity;
      this.roomBundle = roomBundle;
      this.settings = settings;
      this.running = false;
      this.remoteEventGuards = new Map();
      this.heartbeatTimer = null;
      this.softCorrectionTimer = null;
      this.lastRemoteState = null;
      this.lastSentFingerprint = "";
      this.excessiveDriftCount = 0;
      this.bufferingTimer = null;
      this.boundMediaEvent = (event) => this.onLocalMediaEvent(event);
      this.boundMediaHealthEvent = (event) => this.onMediaHealthEvent(event);
      this.boundPayload = (event) => this.onPayload(event.detail);
    }

    isLeader() {
      return this.identity.id === this.roomBundle.creatorId;
    }

    runAsync(task, stage) {
      Promise.resolve(task).catch((error) => {
        this.diagnostics.record("INTERNAL_ERROR", "error", {
          stage,
          message: error?.message || String(error)
        });
      });
    }

    replaceMedia(media) {
      if (this.media === media) return;
      this.detachMedia();
      this.media = media;
      this.attachMedia();
      this.diagnostics.record("VIDEO_REPLACED", "info", { contentKey: this.platform.getContentKey() });
      this.runAsync(this.sendState("media-replaced", true), "sync-media-replaced");
    }

    start() {
      if (this.running) return;
      this.running = true;
      this.attachMedia();
      this.roomClient.addEventListener("payload", this.boundPayload);
      this.heartbeatTimer = setInterval(() => {
        if (this.isLeader()) this.runAsync(this.sendState("heartbeat", false), "sync-heartbeat");
      }, C.SYNC.heartbeatMs);
      this.runAsync(this.sendState("startup", true), "sync-startup");
    }

    stop() {
      this.running = false;
      this.detachMedia();
      this.roomClient.removeEventListener("payload", this.boundPayload);
      clearInterval(this.heartbeatTimer);
      clearTimeout(this.softCorrectionTimer);
      clearTimeout(this.bufferingTimer);
      this.remoteEventGuards.clear();
      if (this.media && Number.isFinite(this.lastRemoteState?.playbackRate)) {
        try { this.media.playbackRate = this.lastRemoteState.playbackRate; }
        catch (error) { this.diagnostics.record("MEDIA_RATE_REJECTED", "warning", { stage: "sync-stop", message: error.message }); }
      }
    }

    attachMedia() {
      if (!(this.media instanceof HTMLMediaElement)) return;
      for (const name of ["play", "pause", "seeked", "ratechange", "ended", "loadedmetadata"]) {
        this.media.addEventListener(name, this.boundMediaEvent, true);
      }
      for (const name of ["error", "stalled", "waiting", "playing", "canplay"]) {
        this.media.addEventListener(name, this.boundMediaHealthEvent, true);
      }
      this.diagnostics.metric("playerReady", this.media.readyState >= 1);
    }

    detachMedia() {
      if (!(this.media instanceof HTMLMediaElement)) return;
      for (const name of ["play", "pause", "seeked", "ratechange", "ended", "loadedmetadata"]) {
        this.media.removeEventListener(name, this.boundMediaEvent, true);
      }
      for (const name of ["error", "stalled", "waiting", "playing", "canplay"]) {
        this.media.removeEventListener(name, this.boundMediaHealthEvent, true);
      }
      clearTimeout(this.bufferingTimer);
    }

    currentState(reason = "state") {
      const adActive = Boolean(this.platform.isAdActive());
      this.diagnostics.metric("adActive", adActive);
      return {
        reason,
        contentKey: this.platform.getContentKey(),
        contentUrl: this.platform.getContentUrl(),
        title: this.platform.getTitle(),
        mediaTime: Number.isFinite(this.media?.currentTime) ? this.media.currentTime : 0,
        duration: Number.isFinite(this.media?.duration) ? this.media.duration : null,
        paused: this.media?.paused ?? true,
        ended: this.media?.ended ?? false,
        playbackRate: Number.isFinite(this.media?.playbackRate) ? this.media.playbackRate : 1,
        readyState: this.media?.readyState ?? 0,
        adActive,
        sentServerTime: this.roomClient.serverNow()
      };
    }

    fingerprint(state) {
      return [state.contentKey, state.paused, Math.round(state.mediaTime * 4), state.playbackRate, state.adActive].join("|");
    }

    async sendState(reason, force = false) {
      if (!this.running || !this.roomClient.joined || !(this.media instanceof HTMLMediaElement)) return;
      const state = this.currentState(reason);
      const fingerprint = this.fingerprint(state);
      if (!force && fingerprint === this.lastSentFingerprint) return;
      await this.roomClient.send("sync-state", state);
      this.lastSentFingerprint = fingerprint;
      this.diagnostics.metric("lastSyncAt", Date.now());
      C.utils.emit(this, "state_sent", { state });
    }

    armRemoteEvent(type, expected = {}) {
      const queue = this.remoteEventGuards.get(type) || [];
      const guard = { token: C.utils.randomId(6), expected, expiresAt: Date.now() + C.SYNC.applyGuardMs };
      queue.push(guard);
      while (queue.length > 4) queue.shift();
      this.remoteEventGuards.set(type, queue);
      return guard;
    }

    cancelRemoteEvent(type, guard) {
      const queue = this.remoteEventGuards.get(type);
      if (!queue?.length || !guard) return;
      const next = queue.filter((item) => item.token !== guard.token);
      if (next.length) this.remoteEventGuards.set(type, next);
      else this.remoteEventGuards.delete(type);
    }

    consumeRemoteEvent(event) {
      const queue = this.remoteEventGuards.get(event.type);
      if (!queue?.length) return false;
      const now = Date.now();
      const active = queue.filter((guard) => guard.expiresAt >= now);
      let matchedIndex = -1;
      for (let index = 0; index < active.length; index += 1) {
        const expected = active[index].expected || {};
        if (event.type === "seeked") {
          if (Number.isFinite(expected.currentTime) && Math.abs(this.media.currentTime - expected.currentTime) <= 0.75) matchedIndex = index;
        } else if (event.type === "ratechange") {
          if (Number.isFinite(expected.playbackRate) && Math.abs(this.media.playbackRate - expected.playbackRate) <= 0.06) matchedIndex = index;
        } else if (event.type === "play") {
          if (this.media.paused === false) matchedIndex = index;
        } else if (event.type === "pause") {
          if (this.media.paused === true) matchedIndex = index;
        } else {
          matchedIndex = index;
        }
        if (matchedIndex >= 0) break;
      }
      if (matchedIndex >= 0) active.splice(matchedIndex, 1);
      if (active.length) this.remoteEventGuards.set(event.type, active);
      else this.remoteEventGuards.delete(event.type);
      return matchedIndex >= 0;
    }

    onLocalMediaEvent(event) {
      if (!this.running) return;
      if (this.consumeRemoteEvent(event)) return;
      if (event.type === "loadedmetadata") this.diagnostics.metric("playerReady", true);
      this.runAsync(this.sendState(`local-${event.type}`, true), `sync-local-${event.type}`);
    }

    onMediaHealthEvent(event) {
      if (!this.running || !(this.media instanceof HTMLMediaElement)) return;
      const evidence = {
        event: event.type,
        readyState: this.media.readyState,
        networkState: this.media.networkState,
        mediaErrorCode: this.media.error?.code ?? null,
        mediaErrorMessage: this.media.error?.message || null
      };

      if (event.type === "error") {
        clearTimeout(this.bufferingTimer);
        this.bufferingTimer = null;
        this.diagnostics.metric("buffering", false);
        this.diagnostics.metric("playerReady", false);
        this.diagnostics.record("MEDIA_ERROR", "error", evidence);
        C.utils.emit(this, "media_health", { state: "error", evidence });
        return;
      }

      if (event.type === "waiting" || event.type === "stalled") {
        this.diagnostics.metric("buffering", true);
        clearTimeout(this.bufferingTimer);
        this.bufferingTimer = setTimeout(() => {
          if (!this.running || !(this.media instanceof HTMLMediaElement) || this.media.paused || this.media.readyState >= 3) return;
          const stalledEvidence = {
            event: event.type,
            readyState: this.media.readyState,
            networkState: this.media.networkState,
            currentTime: Number.isFinite(this.media.currentTime) ? Number(this.media.currentTime.toFixed(3)) : null
          };
          this.diagnostics.record("BUFFERING_STALLED", "warning", stalledEvidence);
          C.utils.emit(this, "media_health", { state: "stalled", evidence: stalledEvidence });
        }, 15_000);
        C.utils.emit(this, "media_health", { state: "buffering", evidence });
        return;
      }

      if (event.type === "playing" || event.type === "canplay") {
        clearTimeout(this.bufferingTimer);
        this.bufferingTimer = null;
        this.diagnostics.metric("buffering", false);
        this.diagnostics.metric("playerReady", this.media.readyState >= 1);
        C.utils.emit(this, "media_health", { state: "ready", evidence });
      }
    }

    onPayload({ senderId, payload } = {}) {
      if (senderId === this.identity.id || !payload) return;
      if (payload.type === "sync-request") {
        if (this.isLeader()) this.runAsync(this.sendState("sync-request", true), "sync-request-response");
        return;
      }
      if (payload.type === "sync-state") {
        this.runAsync(this.applyRemoteState(payload.data, payload.sentServerTime), "sync-apply-remote");
      }
    }

    async applyRemoteState(state, outerSentServerTime) {
      if (!state || !(this.media instanceof HTMLMediaElement)) return;
      this.lastRemoteState = state;

      const localKey = this.platform.getContentKey();
      if (state.contentKey && localKey && state.contentKey !== localKey) {
        this.diagnostics.record("CONTENT_MISMATCH", "warning", { localKey, remoteKey: state.contentKey, remoteTitle: state.title });
        C.utils.emit(this, "content_mismatch", { state });
        return;
      }

      const localAd = Boolean(this.platform.isAdActive());
      if (state.adActive || localAd) {
        this.diagnostics.record("AD_BREAK_DETECTED", "info", { localAd, remoteAd: state.adActive });
        return;
      }

      if (this.media.readyState < 1) {
        this.diagnostics.record("PLAYER_NOT_READY", "warning", { readyState: this.media.readyState });
        return;
      }

      const sentServerTime = Number.isFinite(state.sentServerTime) ? state.sentServerTime : outerSentServerTime;
      const elapsedSeconds = state.paused ? 0 : Math.max(0, (this.roomClient.serverNow() - sentServerTime) / 1000);
      const target = C.utils.clamp(state.mediaTime + elapsedSeconds * (state.playbackRate || 1), 0, Number.isFinite(this.media.duration) ? this.media.duration : Number.MAX_SAFE_INTEGER);
      const drift = target - this.media.currentTime;
      this.diagnostics.metric("driftSeconds", Number(drift.toFixed(3)));
      C.utils.emit(this, "drift", { drift, target, state });

      try {
        if (Math.abs(drift) > C.SYNC.hardSeekThresholdSeconds) {
          const seekGuard = this.armRemoteEvent("seeked", { currentTime: target });
          try {
            if (typeof this.platform.seek === "function") await this.platform.seek(this.media, target);
            else this.media.currentTime = target;
          }
          catch (error) {
            this.cancelRemoteEvent("seeked", seekGuard);
            throw error;
          }
          this.excessiveDriftCount += 1;
        } else if (this.settings.softSync && this.platform.supportsRateSync !== false && !state.paused && Math.abs(drift) > C.SYNC.softSeekThresholdSeconds) {
          this.applySoftCorrection(drift, state.playbackRate || 1);
        } else {
          this.excessiveDriftCount = Math.max(0, this.excessiveDriftCount - 1);
        }
      } catch (error) {
        const code = this.platform.id === "netflix" && /Netflix player|player API/i.test(error.message)
          ? "NETFLIX_PLAYER_API_UNAVAILABLE"
          : "MEDIA_SEEK_FAILED";
        this.diagnostics.record(code, "error", { message: error.message, target, drift });
      }

      if (this.excessiveDriftCount >= 4) {
        this.diagnostics.record("DRIFT_EXCESSIVE", "warning", { drift, count: this.excessiveDriftCount, latencyMs: this.roomClient.latencyMs });
        this.excessiveDriftCount = 0;
      }

      if (this.platform.supportsRateSync !== false && Math.abs((this.media.playbackRate || 1) - (state.playbackRate || 1)) > 0.06) {
        const remoteRate = state.playbackRate || 1;
        const rateGuard = this.armRemoteEvent("ratechange", { playbackRate: remoteRate });
        try {
          if (typeof this.platform.setPlaybackRate === "function") await this.platform.setPlaybackRate(this.media, remoteRate);
          else this.media.playbackRate = remoteRate;
        }
        catch { this.cancelRemoteEvent("ratechange", rateGuard); }
      }

      if (state.paused && !this.media.paused) {
        const pauseGuard = this.armRemoteEvent("pause", { paused: true });
        try {
          if (typeof this.platform.pause === "function") await this.platform.pause(this.media);
          else this.media.pause();
        }
        catch (error) {
          this.cancelRemoteEvent("pause", pauseGuard);
          this.diagnostics.record("MEDIA_PAUSE_FAILED", "warning", { name: error.name, message: error.message });
        }
      } else if (!state.paused && this.media.paused) {
        const playGuard = this.armRemoteEvent("play", { paused: false });
        try {
          if (typeof this.platform.play === "function") await this.platform.play(this.media);
          else await this.media.play();
        } catch (error) {
          this.cancelRemoteEvent("play", playGuard);
          this.diagnostics.record("MEDIA_PLAY_BLOCKED", "warning", { name: error.name, message: error.message });
          C.utils.emit(this, "play_blocked", { state });
        }
      }
    }

    applySoftCorrection(drift, baseRate) {
      clearTimeout(this.softCorrectionTimer);
      const delta = C.utils.clamp(drift * 0.035, -C.SYNC.maxSoftRateDelta, C.SYNC.maxSoftRateDelta);
      const corrected = C.utils.clamp(baseRate + delta, 0.5, 2);
      const correctionGuard = this.armRemoteEvent("ratechange", { playbackRate: corrected });
      try {
        this.media.playbackRate = corrected;
      } catch (error) {
        this.cancelRemoteEvent("ratechange", correctionGuard);
        this.diagnostics.record("MEDIA_RATE_REJECTED", "warning", { message: error.message, corrected });
        return;
      }
      this.softCorrectionTimer = setTimeout(() => {
        if (!(this.media instanceof HTMLMediaElement)) return;
        const restoreGuard = this.armRemoteEvent("ratechange", { playbackRate: baseRate });
        try { this.media.playbackRate = baseRate; }
        catch { this.cancelRemoteEvent("ratechange", restoreGuard); }
      }, C.SYNC.softCorrectionMs);
    }

    async requestSync() {
      if (this.isLeader()) {
        await this.sendState("manual-resync", true);
        return;
      }
      await this.roomClient.send("sync-request", { contentKey: this.platform.getContentKey(), leaderOnly: true });
    }

    async resumeTogether() {
      if (!(this.media instanceof HTMLMediaElement)) return false;
      try {
        await this.media.play();
        await this.sendState("manual-resume", true);
        return true;
      } catch (error) {
        this.diagnostics.record("MEDIA_PLAY_BLOCKED", "error", { name: error.name, message: error.message });
        return false;
      }
    }
  }

  C.SyncEngine = SyncEngine;
})();
