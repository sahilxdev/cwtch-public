(() => {
  'use strict';
  const C = globalThis.Cwtch;

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  function bytesToBase64Url(bytes) {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function base64UrlToBytes(value) {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function platformForUrl(value) {
    let url;
    try {
      url = new URL(value);
    } catch {
      return null;
    }
    const host = url.hostname.replace(/^www\./, '').toLowerCase();

    if (url.protocol !== 'https:') return null;
    if (host === 'netflix.com' || host.endsWith('.netflix.com')) return 'netflix';
    if (host === 'primevideo.com' || host.endsWith('.primevideo.com')) return 'prime';
    if (host === 'youtube.com' || host.endsWith('.youtube.com')) return 'youtube';
    return null;
  }

  function validateContentUrl(value, expectedPlatform = null) {
    const platform = platformForUrl(value);
    if (!platform) throw new Error('The invite points outside supported streaming sites.');
    if (expectedPlatform && platform !== 'local' && platform !== expectedPlatform) {
      throw new Error('The shared link does not match this streaming platform.');
    }
    const url = new URL(value);
    const watchPage =
      platform === 'youtube'
        ? (url.pathname === '/watch' &&
            /^[A-Za-z0-9_-]{6,}$/.test(url.searchParams.get('v') || '')) ||
          /^\/(shorts|live)\/[A-Za-z0-9_-]{6,}\/?$/.test(url.pathname)
        : platform === 'netflix'
          ? /^\/watch\/\d+\/?$/.test(url.pathname)
          : /\/(detail|gp\/video\/detail|region\/[^/]+\/detail)\/[^/?]+/.test(url.pathname);
    if (!watchPage)
      throw new Error('Use a direct link to a supported video, not a redirect or browsing page.');
    url.username = '';
    url.password = '';
    url.hash = '';
    return url.toString();
  }

  const validateRelayUrl = CwtchProtocol.relayUrl;

  function randomId(bytes = 16) {
    const buffer = new Uint8Array(bytes);
    crypto.getRandomValues(buffer);
    return bytesToBase64Url(buffer);
  }

  function encodeBundle(bundle) {
    return bytesToBase64Url(encoder.encode(JSON.stringify(bundle)));
  }

  function decodeBundle(value) {
    if (typeof value !== 'string' || value.length > 12000) throw new Error('Invite is too large.');
    const parsed = JSON.parse(decoder.decode(base64UrlToBytes(value)));
    if (!parsed || parsed.v !== C.PROTOCOL_VERSION)
      throw new Error(
        'This invite uses another Cwtch version. Update both extensions and create a new invite.',
      );
    if (!/^[A-Za-z0-9_-]{12,48}$/.test(parsed.roomId || ''))
      throw new Error('Invite room ID is invalid.');
    if (!/^[A-Za-z0-9_-]{12,80}$/.test(parsed.creatorId || ''))
      throw new Error('Invite creator ID is invalid.');
    if (
      typeof parsed.secret !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(parsed.secret) ||
      base64UrlToBytes(parsed.secret).length !== 32
    )
      throw new Error('Invite secret is invalid.');
    if (!['netflix', 'prime', 'youtube'].includes(parsed.platform))
      throw new Error('Invite platform is invalid.');
    parsed.relayUrl = validateRelayUrl(parsed.relayUrl || '');
    parsed.contentUrl = validateContentUrl(parsed.contentUrl || '', parsed.platform);
    if (!Number.isFinite(parsed.expiresAt)) throw new Error('Invite expiry is missing.');
    if (parsed.expiresAt < Date.now()) throw new Error('This Cwtch invite has expired.');
    if (parsed.expiresAt > Date.now() + 24 * 60 * 60 * 1000)
      throw new Error('Invite expiry is outside the allowed window.');
    parsed.roomName = sanitizeText(parsed.roomName || 'Tonight', 50) || 'Tonight';
    parsed.title = sanitizeText(parsed.title || 'Shared watch', 180) || 'Shared watch';
    parsed.contentKey = sanitizeText(parsed.contentKey || '', 240) || null;
    return parsed;
  }

  function currentCleanUrl() {
    const url = new URL(location.href);
    url.hash = '';
    return url.toString();
  }

  function buildInviteUrl(bundle) {
    const url = new URL(validateContentUrl(bundle.contentUrl, bundle.platform || null));
    url.hash = `cwtch=${encodeURIComponent(encodeBundle(bundle))}`;
    return url.toString();
  }

  function isCwtchInviteUrl(value) {
    try {
      const url = new URL(String(value || ''));
      const params = new URLSearchParams(url.hash.replace(/^#/, ''));
      const encoded = params.get('cwtch');
      if (!encoded) return false;
      decodeBundle(encoded);
      return true;
    } catch {
      return false;
    }
  }

  function extractInviteFromLocation() {
    const raw = location.hash.replace(/^#/, '');
    if (!raw) return null;
    const params = new URLSearchParams(raw);
    const encoded = params.get('cwtch');
    if (!encoded) return null;
    const url = new URL(location.href);
    url.hash = '';
    history.replaceState(history.state, document.title, url.toString());
    return decodeBundle(encoded);
  }

  function normalizeInviteInput(input) {
    const trimmed = String(input || '').trim();
    if (trimmed.length > 16000) throw new Error('Invite is too large.');
    if (!trimmed) throw new Error('Paste the complete Cwtch invite link.');
    try {
      const url = new URL(trimmed);
      const params = new URLSearchParams(url.hash.replace(/^#/, ''));
      const encoded = params.get('cwtch');
      if (!encoded) throw new Error('The link has no Cwtch room secret.');
      return decodeBundle(encoded);
    } catch (error) {
      if (/^[A-Za-z0-9_-]{80,}$/.test(trimmed)) return decodeBundle(trimmed);
      throw error;
    }
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
    const total = Math.floor(seconds);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    return hours > 0
      ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
      : `${minutes}:${String(secs).padStart(2, '0')}`;
  }

  function sanitizeText(value, maxLength = 500) {
    // Strip control characters from user-facing text.
    return (
      String(value || '')
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001F\u007F]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maxLength)
    );
  }

  function safeJson(value) {
    try {
      return JSON.stringify(value);
    } catch {
      return '[unserializable]';
    }
  }

  async function copyText(text) {
    const value = String(text || '');
    if (!value) return false;
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {}

    const previousActive = document.activeElement;
    const selection = globalThis.getSelection?.();
    const previousRanges = [];
    if (selection) {
      for (let index = 0; index < selection.rangeCount; index += 1) {
        previousRanges.push(selection.getRangeAt(index).cloneRange());
      }
    }

    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.setAttribute('readonly', '');
    textarea.setAttribute('aria-hidden', 'true');
    textarea.style.cssText =
      'position:fixed;left:-10000px;top:0;width:1px;height:1px;opacity:0;pointer-events:none';
    document.documentElement.appendChild(textarea);

    const forceClipboardValue = (event) => {
      try {
        event.clipboardData?.setData('text/plain', value);
        event.preventDefault();
      } catch {}
    };
    document.addEventListener('copy', forceClipboardValue, true);

    let ok;
    try {
      textarea.focus({ preventScroll: true });
      textarea.select();
      textarea.setSelectionRange(0, value.length);
      ok = Boolean(document.execCommand('copy'));
    } catch {
      ok = false;
    } finally {
      document.removeEventListener('copy', forceClipboardValue, true);
      textarea.remove();
      try {
        previousActive?.focus?.({ preventScroll: true });
      } catch {}
      if (selection) {
        try {
          selection.removeAllRanges();
          for (const range of previousRanges) selection.addRange(range);
        } catch {}
      }
    }
    return ok;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function storageGet(area, key) {
    try {
      return await chrome.storage[area].get(key);
    } catch (error) {
      throw new Error(`Storage read failed: ${error.message}`, { cause: error });
    }
  }

  async function storageSet(area, value) {
    try {
      return await chrome.storage[area].set(value);
    } catch (error) {
      throw new Error(`Storage write failed: ${error.message}`, { cause: error });
    }
  }

  function emit(target, type, detail = {}) {
    target.dispatchEvent(new CustomEvent(type, { detail }));
  }

  C.utils = Object.freeze({
    encoder,
    decoder,
    bytesToBase64Url,
    base64UrlToBytes,
    randomId,
    platformForUrl,
    validateContentUrl,
    validateRelayUrl,
    encodeBundle,
    decodeBundle,
    currentCleanUrl,
    buildInviteUrl,
    isCwtchInviteUrl,
    extractInviteFromLocation,
    normalizeInviteInput,
    clamp,
    formatTime,
    sanitizeText,
    safeJson,
    copyText,
    sleep,
    storageGet,
    storageSet,
    emit,
  });
})();
