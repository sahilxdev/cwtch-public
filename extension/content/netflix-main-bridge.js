(() => {
  "use strict";
  if (globalThis.__CWTCH_NETFLIX_MAIN_BRIDGE__) return;
  globalThis.__CWTCH_NETFLIX_MAIN_BRIDGE__ = true;

  const REQUEST_SOURCE = "cwtch-netflix-isolated";
  const RESPONSE_SOURCE = "cwtch-netflix-main";

  function getPlayer() {
    const videoPlayer = globalThis.netflix?.appContext?.state?.playerApp?.getAPI?.()?.videoPlayer;
    if (!videoPlayer) throw new Error("Netflix player API is not ready.");
    const sessionIds = videoPlayer.getAllPlayerSessionIds?.() || [];
    if (!sessionIds.length) throw new Error("Netflix has no active player session.");

    const candidates = sessionIds
      .map((sessionId) => {
        try {
          const player = videoPlayer.getVideoPlayerBySessionId(sessionId);
          if (!player) return null;
          let duration = 0;
          let currentTime = 0;
          let playing = false;
          try { duration = Number(player.getDuration?.()) || 0; } catch {}
          try { currentTime = Number(player.getCurrentTime?.()) || 0; } catch {}
          try { playing = Boolean(player.isPlaying?.()); } catch {}
          return { player, sessionId, duration, currentTime, playing };
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    if (!candidates.length) throw new Error("Netflix player session could not be opened.");
    candidates.sort((left, right) => {
      if (left.playing !== right.playing) return left.playing ? -1 : 1;
      if (left.duration !== right.duration) return right.duration - left.duration;
      return right.currentTime - left.currentTime;
    });
    return candidates[0].player;
  }

  async function execute(action, args = {}) {
    const player = getPlayer();
    if (action === "ping") {
      return {
        ready: true,
        currentTimeMs: Number(player.getCurrentTime?.()) || 0,
        durationMs: Number(player.getDuration?.()) || 0,
        playing: Boolean(player.isPlaying?.())
      };
    }
    if (action === "seek") {
      const timeMs = Number(args.timeMs);
      if (!Number.isFinite(timeMs) || timeMs < 0) throw new Error("Invalid Netflix seek target.");
      await Promise.resolve(player.seek(Math.round(timeMs)));
      return { ok: true };
    }
    if (action === "play") {
      await Promise.resolve(player.play());
      return { ok: true };
    }
    if (action === "pause") {
      await Promise.resolve(player.pause());
      return { ok: true };
    }
    throw new Error("Unknown Netflix player command.");
  }

  globalThis.addEventListener("message", (event) => {
    if (event.source !== globalThis) return;
    const message = event.data;
    if (!message || message.source !== REQUEST_SOURCE || typeof message.id !== "string") return;
    Promise.resolve(execute(message.action, message.args))
      .then((result) => {
        globalThis.postMessage({ source: RESPONSE_SOURCE, id: message.id, ok: true, result }, location.origin);
      })
      .catch((error) => {
        globalThis.postMessage({ source: RESPONSE_SOURCE, id: message.id, ok: false, error: error?.message || String(error) }, location.origin);
      });
  });
})();
