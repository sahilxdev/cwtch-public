(() => {
  "use strict";
  if (globalThis.__CWTCH_APP_BOOTSTRAPPED__) return;
  globalThis.__CWTCH_APP_BOOTSTRAPPED__ = true;
  const C = globalThis.Cwtch;

  class CwtchApp {
    constructor() {
      this.platform = C.platform;
      this.settings = { ...C.DEFAULT_SETTINGS };
      this.identity = null;
      this.media = null;
      this.roomBundle = null;
      this.roomClient = null;
      this.syncEngine = null;
      this.ui = null;
      this.diagnostics = new C.Diagnostics({ platform: this.platform.id, platformName: this.platform.name });
      this.participants = new Map();
      this.lastContentKey = null;
      this.playerTimer = null;
      this.navigationTimer = null;
      this.storageChangeHandler = null;
      this.destroyed = false;
    }

    runAsync(task, stage) {
      Promise.resolve(task).catch((error) => {
        this.diagnostics.record("INTERNAL_ERROR", "error", {
          stage,
          message: error?.message || String(error)
        });
      });
    }

    sendRuntime(message, stage = "runtime-send") {
      try {
        const request = chrome.runtime.sendMessage(message);
        if (request?.catch) {
          request.catch((error) => {
            this.diagnostics.record("EXTENSION_CONTEXT_INVALIDATED", "warning", { stage, message: error.message });
          });
        }
      } catch (error) {
        this.diagnostics.record("EXTENSION_CONTEXT_INVALIDATED", "warning", { stage, message: error.message });
      }
    }

    async waitForDocument() {
      if (document.documentElement) return;
      await new Promise((resolve) => {
        const finish = () => {
          if (!document.documentElement) return;
          document.removeEventListener("readystatechange", finish);
          resolve();
        };
        document.addEventListener("readystatechange", finish);
        queueMicrotask(finish);
      });
    }

    async init() {
      let invite = null;
      try { invite = C.utils.extractInviteFromLocation(); }
      catch (error) {
        const code = /expired/i.test(error.message) ? "INVITE_EXPIRED" : /outside supported|does not match/i.test(error.message) ? "CONTENT_URL_UNSAFE" : "ROOM_SECRET_INVALID";
        this.diagnostics.record(code, "error", { message: error.message });
      }
      try {
        await this.waitForDocument();
        await this.loadLocalState();
        this.bindStorageChanges();
        this.ui = new C.CwtchUI({ diagnostics: this.diagnostics, platform: this.platform });
        this.ui.mount();
        this.bindUi();
        this.bindRuntimeMessages();
        this.media = this.platform.findVideo();
        this.lastContentKey = this.platform.getContentKey();
        this.updateMediaState();
        this.startWatchdogs();

        if (!this.platform.supported || !this.platform.isWatchPage()) {
          this.diagnostics.record("UNSUPPORTED_PAGE", "info", { pathname: location.pathname, platform: this.platform.id });
        }

        if (invite) await this.joinRoom(invite, { fromInvite: true });
        else await this.restoreRoom();
      } catch (error) {
        this.diagnostics.record("INTERNAL_ERROR", "error", { stage: "init", message: error.message, stack: error.stack });
      }
    }

    async loadLocalState() {
      try {
        const result = await C.utils.storageGet("local", ["settings", "identity"]);
        this.settings = { ...C.DEFAULT_SETTINGS, ...(result.settings || {}) };
        const storedIdentity = result.identity || {};
        const identityValid = Boolean(
          Number.isFinite(storedIdentity.expiresAt)
          && storedIdentity.expiresAt > Date.now()
        );
        let clientId = null;
        try {
          const response = await chrome.runtime.sendMessage({ type: "CWTCH_GET_TAB_CLIENT_ID" });
          if (response?.ok && /^[A-Za-z0-9_-]{12,80}$/.test(response.clientId || "")) clientId = response.clientId;
        } catch (error) {
          this.diagnostics.record("EXTENSION_CONTEXT_INVALIDATED", "warning", { stage: "tab-identity", message: error.message });
        }
        this.identity = {
          id: clientId || C.utils.randomId(18),
          name: this.settings.displayName || (identityValid ? storedIdentity.name : "") || "You",
          createdAt: identityValid ? storedIdentity.createdAt : Date.now(),
          expiresAt: Date.now() + 8 * 60 * 60 * 1000
        };
        await C.utils.storageSet("local", {
          identity: { name: this.identity.name, createdAt: this.identity.createdAt, expiresAt: this.identity.expiresAt },
          settings: this.settings
        });
      } catch (error) {
        this.diagnostics.record("STORAGE_FAILED", "error", { message: error.message });
        this.identity = { id: C.utils.randomId(18), name: "You", createdAt: Date.now() };
      }
    }

    bindStorageChanges() {
      if (!chrome.storage?.onChanged?.addListener || this.storageChangeHandler) return;
      this.storageChangeHandler = (changes, areaName) => {
        if (areaName !== "local" || !changes.settings?.newValue) return;
        const nextSettings = { ...C.DEFAULT_SETTINGS, ...changes.settings.newValue };
        const nextName = C.utils.sanitizeText(nextSettings.displayName || "", 40);
        Object.assign(this.settings, nextSettings);
        if (nextName && nextName !== this.identity?.name) {
          this.runAsync(this.setDisplayName(nextName, { persist: false, broadcast: true }), "storage-display-name");
        }
      };
      chrome.storage.onChanged.addListener(this.storageChangeHandler);
    }

    async setDisplayName(rawName, { persist = true, broadcast = true } = {}) {
      const displayName = C.utils.sanitizeText(rawName || "", 40);
      if (!displayName) throw new Error("Enter the name your person should see.");
      const changed = this.identity?.name !== displayName || this.settings.displayName !== displayName;
      this.identity.name = displayName;
      this.settings.displayName = displayName;
      const self = this.participants.get(this.identity.id);
      if (self) {
        self.name = displayName;
        this.participants.set(this.identity.id, self);
      }
      if (persist && changed) {
        await C.utils.storageSet("local", {
          identity: { name: displayName, createdAt: this.identity.createdAt, expiresAt: this.identity.expiresAt },
          settings: this.settings
        });
      }
      this.updateUiRoom();
      if (broadcast && this.roomClient?.joined) {
        await this.roomClient.send("presence", {
          name: displayName,
          contentKey: this.platform.getContentKey(),
          contentUrl: this.platform.getContentUrl(),
          title: this.platform.getTitle()
        });
      }
      return displayName;
    }

    bindUi() {
      this.ui.addEventListener("settings", () => this.sendRuntime({ type: "CWTCH_OPEN_OPTIONS" }, "open-options"));
      this.ui.addEventListener("copy-invite", () => this.runAsync(this.copyInvite(), "copy-invite"));
      this.ui.addEventListener("leave", () => this.runAsync(this.leaveRoom(), "leave-room"));
      this.ui.addEventListener("resync", () => this.runAsync(this.retryOrResync(), "manual-resync"));
      this.ui.addEventListener("resume", () => this.runAsync((async () => {
        const ok = await this.syncEngine?.resumeTogether();
        this.ui.showToast(ok ? "Playing together." : "Click the video once, then try again.");
      })(), "resume-together"));
      this.ui.addEventListener("chat", (event) => this.runAsync(this.sendChat(event.detail.text), "send-chat"));
      this.ui.addEventListener("reaction", (event) => this.runAsync(this.sendReaction(event.detail.reaction), "send-reaction"));
      this.ui.addEventListener("nudge", () => this.runAsync(this.sendNudge(), "send-nudge"));
      this.ui.addEventListener("moment", (event) => this.runAsync(this.saveMoment(event.detail.note), "save-moment"));
      this.ui.addEventListener("checks", () => this.runAsync(this.runChecks(), "run-checks"));
      this.ui.addEventListener("report", () => this.downloadReport());
      this.ui.addEventListener("follow", (event) => this.followContent(event.detail.content));
    }

    bindRuntimeMessages() {
      chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (!message || typeof message !== "object") return false;
        const handle = async () => {
          if (message.type === "CWTCH_GET_STATE") return this.publicState();
          if (message.type === "CWTCH_TOGGLE_PANEL") { this.ui.toggle(); return this.publicState(); }
          if (message.type === "CWTCH_SET_DISPLAY_NAME") {
            const displayName = await this.setDisplayName(message.payload?.displayName || "", { persist: true, broadcast: true });
            return { ...this.publicState(), displayName };
          }
          if (message.type === "CWTCH_CREATE_ROOM") return this.createRoom(message.payload || {});
          if (message.type === "CWTCH_JOIN_ROOM") {
            if (message.payload?.displayName) await this.setDisplayName(message.payload.displayName, { persist: true, broadcast: false });
            const bundle = C.utils.normalizeInviteInput(message.payload?.invite || "");
            const currentKey = this.platform.getContentKey();
            if (bundle.contentKey && currentKey && bundle.contentKey !== currentKey) {
              location.assign(C.utils.buildInviteUrl(bundle));
              return { ok: true, navigating: true };
            }
            await this.joinRoom(bundle, { fromInvite: true });
            return this.publicState();
          }
          if (message.type === "CWTCH_LEAVE_ROOM") { await this.leaveRoom(); return this.publicState(); }
          if (message.type === "CWTCH_COPY_INVITE") return { ok: await this.copyInvite() };
          if (message.type === "CWTCH_RUN_CHECKS") return { ok: true, results: await this.runChecks() };
          if (message.type === "CWTCH_RESYNC") { await this.retryOrResync(); return { ok: true, roomStatus: this.roomClient?.status || "idle" }; }
          return { ok: false, error: "Unknown Cwtch message." };
        };
        handle().then(sendResponse).catch((error) => {
          this.diagnostics.record("INTERNAL_ERROR", "error", { stage: "runtime-message", message: error.message });
          sendResponse({ ok: false, error: error.message });
        });
        return true;
      });
    }

    publicState() {
      return {
        ok: true,
        platform: this.platform.name,
        platformId: this.platform.id,
        supported: this.platform.supported && this.platform.isWatchPage(),
        mediaReady: Boolean(this.media && this.media.readyState >= 1),
        title: this.platform.getTitle(),
        contentKey: this.platform.getContentKey(),
        room: this.roomBundle ? { id: this.roomBundle.roomId, name: this.roomBundle.roomName } : null,
        roomStatus: this.roomClient?.status || "idle",
        occupants: this.participants.size,
        participants: [...this.participants.values()].map(({ id, name, self }) => ({ id, name, self })),
        displayName: this.identity?.name || "You",
        partnerName: [...this.participants.values()].find((participant) => !participant.self)?.name || "",
        inviteUrl: this.roomBundle ? C.utils.buildInviteUrl(this.roomBundle) : "",
        latestIssue: this.diagnostics.entries[0] || null
      };
    }

    async createRoom(payload) {
      if (!this.platform.supported || !this.platform.isWatchPage()) throw new Error("Open a supported video first.");
      this.media = this.platform.findVideo();
      if (!(this.media instanceof HTMLMediaElement)) {
        this.diagnostics.record("VIDEO_NOT_FOUND", "error", { platform: this.platform.id });
        throw new Error("Start the video before creating a room.");
      }
      await this.assertRelayReady();
      const displayName = await this.setDisplayName(payload.displayName || this.settings.displayName || this.identity.name, { persist: true, broadcast: false });
      const secret = new Uint8Array(32); crypto.getRandomValues(secret);
      const bundle = {
        v: C.PROTOCOL_VERSION,
        roomId: C.utils.randomId(12),
        secret: C.utils.bytesToBase64Url(secret),
        creatorId: this.identity.id,
        roomName: C.utils.sanitizeText(payload.roomName || "Tonight", 50) || "Tonight",
        contentUrl: this.platform.getContentUrl(),
        contentKey: this.platform.getContentKey(),
        title: this.platform.getTitle(),
        platform: this.platform.id,
        relayUrl: this.settings.relayUrl,
        createdAt: Date.now(),
        expiresAt: Date.now() + 8 * 60 * 60 * 1000
      };
      await this.joinRoom(bundle, { created: true });
      this.ui.open("room");
      return this.publicState();
    }

    async joinRoom(bundle, { created = false } = {}) {
      if (this.roomBundle?.roomId === bundle.roomId && this.roomClient) return;
      await this.leaveRoom({ quiet: true });
      this.roomBundle = bundle;
      this.participants.clear();
      this.participants.set(this.identity.id, { id: this.identity.id, name: this.identity.name || "You", self: true, joinedAt: Date.now() });
      this.roomClient = new C.RoomClient({ bundle, identity: this.identity, diagnostics: this.diagnostics });
      this.bindRoomClient();
      this.attachSyncEngine();
      await this.persistRoom();
      this.updateUiRoom();
      this.roomClient.connect();
      if (created || this.settings.autoOpenPanel) this.ui.open("room");
      this.sendRuntime({ type: "CWTCH_SET_BADGE", text: "1" }, "badge-room-created");
    }

    bindRoomClient() {
      this.roomClient.addEventListener("status", (event) => {
        this.updateUiRoom({ status: event.detail.status });
        if (event.detail.status === "error") this.sendRuntime({ type: "CWTCH_SET_BADGE", text: "!" }, "badge-error");
      });
      this.roomClient.addEventListener("joined", (event) => this.runAsync((async () => {
        await this.roomClient.send("presence", { name: this.identity.name, contentKey: this.platform.getContentKey(), contentUrl: this.platform.getContentUrl(), title: this.platform.getTitle() });
        if ((event.detail.occupants || 1) >= 2) await this.syncEngine?.requestSync();
        this.updateUiRoom({ status: "joined" });
        this.sendRuntime({ type: "CWTCH_SET_BADGE", text: String(event.detail.occupants || 1) }, "badge-joined");
      })(), "room-joined"));
      this.roomClient.addEventListener("peer_joined", (event) => this.runAsync((async () => {
        await this.roomClient.send("presence", { name: this.identity.name, contentKey: this.platform.getContentKey(), contentUrl: this.platform.getContentUrl(), title: this.platform.getTitle() });
        await this.syncEngine?.requestSync();
        this.sendRuntime({ type: "CWTCH_SET_BADGE", text: String(event.detail.occupants || 2) }, "badge-peer-joined");
      })(), "peer-joined"));
      this.roomClient.addEventListener("peer_left", (event) => {
        for (const [id, participant] of this.participants) if (!participant.self) this.participants.delete(id);
        this.updateUiRoom();
        this.sendRuntime({ type: "CWTCH_SET_BADGE", text: String(event.detail.occupants || 1) }, "badge-peer-left");
        this.ui.showToast("Your person left the room.");
      });
      this.roomClient.addEventListener("quality", (event) => this.updateUiRoom({ latencyMs: event.detail.latencyMs }));
      this.roomClient.addEventListener("payload", (event) => this.runAsync(this.handleRoomPayload(event.detail), "room-payload"));
      this.roomClient.addEventListener("server_error", (event) => {
        if (event.detail.code === "ROOM_FULL") this.ui.open("fixes");
      });
    }

    attachSyncEngine() {
      this.media = this.platform.findVideo();
      if (!(this.media instanceof HTMLMediaElement)) return;
      this.syncEngine?.stop();
      this.syncEngine = new C.SyncEngine({
        media: this.media,
        platform: this.platform,
        roomClient: this.roomClient,
        diagnostics: this.diagnostics,
        identity: this.identity,
        roomBundle: this.roomBundle,
        settings: this.settings
      });
      this.syncEngine.addEventListener("play_blocked", () => this.ui.showToast("Click Resume together once to unlock playback."));
      this.syncEngine.addEventListener("content_mismatch", (event) => {
        this.ui.update({ pendingContent: { ...event.detail.state, person: "Your person" } });
      });
      this.syncEngine.addEventListener("drift", (event) => this.ui.update({ driftSeconds: event.detail.drift }));
      this.syncEngine.start();
    }

    async handleRoomPayload({ senderId, payload }) {
      if (!payload || senderId === this.identity.id) return;
      const data = payload.data || {};
      const participant = this.participants.get(senderId) || { id: senderId, name: "Your person", self: false };
      if (payload.type === "presence") {
        participant.name = C.utils.sanitizeText(data.name || "Your person", 40) || "Your person";
        participant.joinedAt = Date.now();
        this.participants.set(senderId, participant);
        this.updateUiRoom();
        if (data.contentKey && data.contentKey !== this.platform.getContentKey()) {
          this.ui.update({ pendingContent: { contentKey: data.contentKey, title: data.title, person: participant.name, contentUrl: data.contentUrl } });
        }
        return;
      }
      if (payload.type === "chat") {
        this.ui.addMessage({ id: data.id, text: C.utils.sanitizeText(data.text, 500), name: participant.name, time: data.time || Date.now(), self: false });
        return;
      }
      if (payload.type === "reaction") {
        if (C.REACTIONS.includes(data.reaction)) this.ui.showReaction(data.reaction);
        return;
      }
      if (payload.type === "nudge") {
        this.ui.showNudge(participant.name);
        this.beep();
        return;
      }
      if (payload.type === "moment") {
        this.ui.addMoment({ id: data.id, at: Number(data.at) || 0, note: C.utils.sanitizeText(data.note, 180), name: participant.name, time: data.time || Date.now() });
        return;
      }
      if (payload.type === "navigation") {
        if (data.contentKey && data.contentKey !== this.platform.getContentKey()) {
          if (this.settings.autoFollow && data.contentUrl) this.followContent({ ...data, person: participant.name });
          else this.ui.update({ pendingContent: { ...data, person: participant.name } });
        }
      }
    }

    async sendChat(text) {
      if (!this.roomClient) return;
      const message = { id: C.utils.randomId(9), text, time: Date.now() };
      this.ui.addMessage({ ...message, name: this.identity.name, self: true });
      await this.roomClient.send("chat", message);
    }

    async sendReaction(reaction) {
      if (!this.roomClient || !C.REACTIONS.includes(reaction)) return;
      this.ui.showReaction(reaction);
      await this.roomClient.send("reaction", { reaction, time: Date.now() });
    }

    async sendNudge() {
      if (!this.roomClient) return;
      this.ui.showToast("Nudge sent.");
      await this.roomClient.send("nudge", { time: Date.now() });
    }

    async saveMoment(note = "") {
      if (!this.roomClient || !(this.media instanceof HTMLMediaElement)) return;
      note = C.utils.sanitizeText(note, 180) || "Keep this moment.";
      const moment = { id: C.utils.randomId(9), at: this.media.currentTime, note, time: Date.now() };
      this.ui.addMoment({ ...moment, name: this.identity.name });
      await this.roomClient.send("moment", moment);
      this.ui.showToast(`Saved ${C.utils.formatTime(moment.at)}.`);
    }

    async copyInvite() {
      if (!this.roomBundle) return false;
      const inviteUrl = C.utils.buildInviteUrl(this.roomBundle);
      if (!C.utils.isCwtchInviteUrl(inviteUrl)) {
        this.diagnostics.record("INVITE_COPY_FAILED", "error", { stage: "build-invite" });
        this.ui.showToast("Cwtch could not build a valid invite.");
        return false;
      }
      const ok = await C.utils.copyText(inviteUrl);
      if (!ok) this.diagnostics.record("INVITE_COPY_FAILED", "error", { stage: "clipboard-write" });
      this.ui.showToast(ok ? "Invite copied. Send it only to your person." : "Could not copy the invite.");
      return ok;
    }

    async assertRelayReady() {
      let result;
      try {
        result = await chrome.runtime.sendMessage({ type: "CWTCH_CHECK_RELAY", relayUrl: this.settings.relayUrl });
      } catch (error) {
        this.diagnostics.record("WS_CONNECT_FAILED", "error", { stage: "relay-preflight", message: error.message });
        throw new Error("Cwtch could not check the room relay. Reload the extension and try again.");
      }
      if (result?.ok) return result.health;

      let isLoopback = false;
      try {
        const url = new URL(this.settings.relayUrl);
        isLoopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      } catch {}
      const code = isLoopback ? "LOCAL_RELAY_NOT_RUNNING" : "WS_CONNECT_FAILED";
      this.diagnostics.record(code, "error", { stage: "relay-preflight", message: result?.error || "Relay unavailable" });
      this.ui.open("fixes");
      throw new Error(isLoopback
        ? "The local Cwtch relay is not running. Start it before creating a room."
        : "The configured Cwtch relay is unavailable. Check Settings and try again.");
    }

    async retryOrResync() {
      if (!this.roomClient) return false;
      if (this.roomClient.status === "joined") {
        await this.syncEngine?.requestSync();
        this.ui.showToast("Resync requested.");
        return true;
      }
      this.roomClient.retryNow();
      this.ui.showToast("Retrying the relay…");
      return true;
    }

    async leaveRoom({ quiet = false } = {}) {
      this.syncEngine?.stop();
      this.syncEngine = null;
      this.roomClient?.close();
      this.roomClient = null;
      this.roomBundle = null;
      this.participants.clear();
      try { await C.utils.storageSet("local", { activeRoom: null, activeRoomExpiresAt: 0 }); } catch {}
      this.sendRuntime({ type: "CWTCH_SET_BADGE", text: "" }, "badge-room-left");
      this.updateUiRoom({ status: "idle" });
      if (!quiet) this.ui?.showToast("Room closed on this tab.");
    }

    async persistRoom() {
      try {
        await C.utils.storageSet("local", {
          activeRoom: this.roomBundle,
          activeRoomExpiresAt: Date.now() + 8 * 60 * 60 * 1000
        });
      } catch (error) {
        this.diagnostics.record("STORAGE_FAILED", "warning", { message: error.message });
      }
    }

    async restoreRoom() {
      try {
        const result = await C.utils.storageGet("local", ["activeRoom", "activeRoomExpiresAt"]);
        const bundle = result.activeRoom;
        if (!bundle) return;
        if (result.activeRoomExpiresAt < Date.now() || (Number.isFinite(bundle.expiresAt) && bundle.expiresAt < Date.now())) {
          await C.utils.storageSet("local", { activeRoom: null, activeRoomExpiresAt: 0 });
          return;
        }
        if (bundle.contentKey && bundle.contentKey !== this.platform.getContentKey()) return;
        await this.joinRoom(bundle);
      } catch (error) {
        this.diagnostics.record("STORAGE_FAILED", "warning", { stage: "restore", message: error.message });
      }
    }

    updateUiRoom(patch = {}) {
      if (!this.ui) return;
      this.ui.update({
        room: this.roomBundle ? { id: this.roomBundle.roomId, name: this.roomBundle.roomName } : null,
        status: this.roomClient?.status || patch.status || "idle",
        occupants: this.participants.size,
        participants: [...this.participants.values()],
        inviteUrl: this.roomBundle ? C.utils.buildInviteUrl(this.roomBundle) : "",
        mediaReady: Boolean(this.media && this.media.readyState >= 1),
        title: this.platform.getTitle(),
        latencyMs: patch.latencyMs ?? this.roomClient?.latencyMs ?? null,
        ...patch
      });
    }

    updateMediaState() {
      this.diagnostics.metric("playerReady", Boolean(this.media && this.media.readyState >= 1));
      this.updateUiRoom({ mediaReady: Boolean(this.media && this.media.readyState >= 1), title: this.platform.getTitle() });
    }

    startWatchdogs() {
      this.playerTimer = setInterval(() => {
        if (this.destroyed) return;
        try {
          const next = this.platform.findVideo();
          if (next && next !== this.media) {
            this.media = next;
            this.updateMediaState();
            if (this.syncEngine) this.syncEngine.replaceMedia(next);
            else if (this.roomClient) this.attachSyncEngine();
          }
          if (!next && this.platform.isWatchPage()) {
            missingChecks += 1;
            this.diagnostics.metric("playerReady", false);
          } else if (next) missingChecks = 0;
          if (this.roomClient?.connected && this.roomClient.lastMessageAt && Date.now() - this.roomClient.lastMessageAt > 45_000) {
            this.diagnostics.record("RELAY_SILENT", "warning", { lastMessageAgeMs: Date.now() - this.roomClient.lastMessageAt });
          }
        } catch (error) {
          this.diagnostics.record("CSP_OR_DOM_INTERFERENCE", "warning", { message: error.message });
        }
      }, 1500);

      let missingChecks = 0;
      setTimeout(() => {
        if (!this.platform.findVideo() && this.platform.isWatchPage()) {
          this.diagnostics.record("VIDEO_NOT_FOUND", "warning", { platform: this.platform.id, checks: missingChecks });
        }
      }, 12_000);

      this.navigationTimer = setInterval(() => this.runAsync((async () => {
        const key = this.platform.getContentKey();
        if (key && this.lastContentKey && key !== this.lastContentKey) {
          this.diagnostics.record("PAGE_NAVIGATION", "info", { from: this.lastContentKey, to: key });
          this.lastContentKey = key;
          this.ui.update({ pendingContent: null, title: this.platform.getTitle() });
          if (this.roomClient) {
            await this.roomClient.send("navigation", {
              contentKey: key,
              contentUrl: this.platform.getContentUrl(),
              title: this.platform.getTitle()
            });
          }
        } else if (key) this.lastContentKey = key;
      })(), "navigation-watchdog"), 1200);
    }

    async runChecks() {
      const results = await this.diagnostics.runSelfTest({ platform: this.platform, media: this.media, roomClient: this.roomClient, settings: this.settings, roomBundle: this.roomBundle });
      if (!this.media) this.diagnostics.record("VIDEO_NOT_FOUND", "warning", { platform: this.platform.id });
      this.ui.setSelfTest(results);
      this.ui.open("fixes");
      return results;
    }

    downloadReport() {
      const report = this.diagnostics.snapshot();
      const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `cwtch-diagnostics-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      this.ui.showToast("Diagnostic report downloaded.");
    }

    followContent(content) {
      if (!content?.contentUrl) {
        this.ui.showToast("No safe destination was included. Ask for a fresh invite.");
        return;
      }
      try {
        const safeUrl = C.utils.validateContentUrl(content.contentUrl, this.platform.id);
        location.assign(safeUrl);
      } catch (error) {
        this.diagnostics.record("CONTENT_URL_UNSAFE", "error", { message: error.message, contentUrl: content.contentUrl });
        this.ui.showToast("Blocked an unsafe shared destination.");
      }
    }

    beep() {
      if (!this.settings.nudgeSound) return;
      try {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        const context = new AudioContextClass();
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = "sine";
        oscillator.frequency.setValueAtTime(523.25, context.currentTime);
        gain.gain.setValueAtTime(0.0001, context.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.055, context.currentTime + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.22);
        oscillator.connect(gain).connect(context.destination);
        oscillator.start();
        oscillator.stop(context.currentTime + 0.24);
        oscillator.addEventListener("ended", () => context.close());
      } catch {}
    }
  }

  const app = new CwtchApp();
  C.app = app;
  app.init();
})();
