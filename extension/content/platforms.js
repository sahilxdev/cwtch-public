(() => {
  'use strict';
  const C = globalThis.Cwtch;
  if (C.app && !C.app.destroyed) return;

  function visibleArea(element) {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0)
      return 0;
    if (rect.width < 160 || rect.height < 90) return 0;
    return Math.max(0, rect.width) * Math.max(0, rect.height);
  }

  function chooseBestVideo() {
    const videos = [...document.querySelectorAll('video')];
    let best = null;
    let bestScore = -1;
    for (const video of videos) {
      const area = visibleArea(video);
      if (!area) continue;
      const score =
        area + video.readyState * 100_000 + (Number.isFinite(video.duration) ? 50_000 : 0);
      if (score > bestScore) {
        best = video;
        bestScore = score;
      }
    }
    return best;
  }

  class NetflixBridge {
    constructor() {
      this.pending = new Map();
      this.sequence = 0;
      this.boundMessage = (event) => this.onMessage(event);
      globalThis.addEventListener('message', this.boundMessage);
    }

    onMessage(event) {
      if (event.source !== globalThis || event.origin !== location.origin) return;
      const message = event.data;
      if (
        !message ||
        message.source !== 'cwtch-netflix-main' ||
        typeof message.id !== 'string' ||
        message.id.length > 100
      )
        return;
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.ok) request.resolve(message.result);
      else request.reject(new Error(message.error || 'Netflix player command failed.'));
    }

    destroy() {
      globalThis.removeEventListener('message', this.boundMessage);
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error('Player disconnected.'));
      }
      this.pending.clear();
    }
    request(action, args = {}, timeoutMs = 2200) {
      const id = `cwtch_nf_${Date.now().toString(36)}_${(++this.sequence).toString(36)}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error('Netflix player API did not answer in time.'));
        }, timeoutMs);
        this.pending.set(id, { resolve, reject, timer });
        globalThis.postMessage(
          { source: 'cwtch-netflix-isolated', id, action, args },
          location.origin,
        );
      });
    }
  }

  const netflixBridge = new NetflixBridge();
  const hostname = location.hostname.replace(/^www\./, '');

  const common = {
    supported: true,
    supportsRateSync: true,
    findVideo: chooseBestVideo,
    getTitle() {
      return (
        document.title.replace(/\s+[-|]\s+(Netflix|Prime Video|YouTube).*$/i, '').trim() ||
        'Untitled'
      );
    },
    getContentUrl() {
      const url = new URL(location.href);
      url.hash = '';
      return url.toString();
    },
    async seek(media, timeSeconds) {
      media.currentTime = timeSeconds;
      return true;
    },
    async play(media) {
      await media.play();
      return true;
    },
    async pause(media) {
      media.pause();
      return true;
    },
    async setPlaybackRate(media, rate) {
      media.playbackRate = rate;
      return true;
    },
  };

  const adapters = {
    netflix: {
      ...common,
      id: 'netflix',
      name: 'Netflix',
      supportsRateSync: false,
      isWatchPage: () => /^\/watch\/\d+/.test(location.pathname),
      getContentKey() {
        const match = location.pathname.match(/^\/watch\/(\d+)/);
        return match ? `netflix:${match[1]}` : null;
      },
      isAdActive() {
        return Boolean(
          document.querySelector('[data-uia*="ad-"], .watch-video--ad, [class*="adBreak"]'),
        );
      },
      async seek(_media, timeSeconds) {
        await netflixBridge.request('seek', { timeMs: Math.max(0, timeSeconds) * 1000 });
        return true;
      },
      async play() {
        await netflixBridge.request('play');
        return true;
      },
      async pause() {
        await netflixBridge.request('pause');
        return true;
      },
      async setPlaybackRate() {
        return false;
      },
      async checkPlayerApi() {
        return netflixBridge.request('ping');
      },
    },
    prime: {
      ...common,
      id: 'prime',
      name: 'Prime Video',
      isWatchPage: () =>
        /\/(detail|gp\/video\/detail|region\/[^/]+\/detail)\//.test(location.pathname) ||
        Boolean(chooseBestVideo()),
      getContentKey() {
        const match = location.pathname.match(
          /\/(?:detail|gp\/video\/detail|region\/[^/]+\/detail)\/([^/?]+)/,
        );
        return match ? `prime:${match[1]}` : `prime:${location.pathname}`;
      },
      isAdActive() {
        return Boolean(
          document.querySelector(
            '[data-testid*="ad" i], [class*="adIndicator" i], [class*="adBreak" i]',
          ),
        );
      },
    },
    youtube: {
      ...common,
      id: 'youtube',
      name: 'YouTube',
      isWatchPage: () => {
        if (location.pathname === '/watch')
          return Boolean(new URLSearchParams(location.search).get('v'));
        return /^\/(shorts|live)\/[A-Za-z0-9_-]{6,}$/.test(location.pathname);
      },
      getContentKey() {
        const queryId = new URLSearchParams(location.search).get('v');
        const pathId = location.pathname.match(/^\/(?:shorts|live)\/([A-Za-z0-9_-]{6,})/)?.[1];
        const id = queryId || pathId;
        return id ? `youtube:${id}` : null;
      },
      getTitle() {
        return document.title.replace(/\s+-\s+YouTube$/i, '').trim() || 'YouTube video';
      },
      isAdActive() {
        return (
          document.querySelector('#movie_player')?.classList.contains('ad-showing') ||
          Boolean(document.querySelector('.video-ads.ytp-ad-module .ytp-ad-player-overlay'))
        );
      },
    },
  };

  let platform;
  if (hostname.endsWith('netflix.com')) platform = adapters.netflix;
  else if (hostname.endsWith('primevideo.com')) platform = adapters.prime;
  else if (hostname === 'youtube.com' || hostname.endsWith('.youtube.com'))
    platform = adapters.youtube;
  else
    platform = {
      supported: false,
      id: 'unknown',
      name: 'Unsupported',
      supportsRateSync: false,
      isWatchPage: () => false,
      findVideo: () => null,
      getContentKey: () => null,
      getTitle: () => document.title,
      getContentUrl: () => location.href,
      isAdActive: () => false,
      async seek() {
        return false;
      },
      async play() {
        return false;
      },
      async pause() {
        return false;
      },
      async setPlaybackRate() {
        return false;
      },
    };

  platform.destroy = () => netflixBridge.destroy();
  C.platform = platform;
})();
