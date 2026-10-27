/* Shared by the extension and relay. No browser or Node dependencies. */
(() => {
  'use strict';
  const ID = /^[A-Za-z0-9_-]{12,80}$/;
  const B64 = /^[A-Za-z0-9_-]+$/;
  const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const text = (value, max) => typeof value === 'string' && value.length <= max;
  const finite = (value, min, max) => Number.isFinite(value) && value >= min && value <= max;
  const defaults = Object.freeze({
    relayUrl: 'wss://cwtch-relay.onrender.com/ws',
    displayName: '',
    autoOpenPanel: true,
    debugMode: false,
    softSync: true,
    nudgeSound: true,
    autoFollow: false,
    rememberHistory: false,
    showPrompts: true,
  });
  function relayUrl(value) {
    const url = new URL(value);
    if (!['ws:', 'wss:'].includes(url.protocol))
      throw new Error('Use a ws:// or wss:// relay address.');
    if (url.protocol === 'ws:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      throw new Error('Public relays must use wss://.');
    if (url.username || url.password || url.hash || url.search)
      throw new Error('Relay addresses cannot contain credentials, fragments, or query strings.');
    return url.toString();
  }
  function application(message) {
    if (
      !object(message) ||
      !ID.test(message.senderId || '') ||
      !finite(message.sentServerTime, 0, 1e15) ||
      !object(message.data)
    )
      return false;
    const d = message.data;
    switch (message.type) {
      case 'presence':
        return text(d.name, 40) && text(d.contentKey, 240) && text(d.contentUrl, 2048);
      case 'sync-request':
        return true;
      case 'sync-state':
        return (
          text(d.contentKey, 240) &&
          text(d.contentUrl, 2048) &&
          text(d.title, 180) &&
          finite(d.mediaTime, 0, 1e9) &&
          finite(d.playbackRate, 0.25, 4) &&
          typeof d.paused === 'boolean' &&
          typeof d.adActive === 'boolean' &&
          finite(d.readyState, 0, 4) &&
          finite(d.sentServerTime, 0, 1e15) &&
          object(d.action) &&
          Number.isSafeInteger(d.action.clock) &&
          d.action.clock >= 0 &&
          ID.test(d.action.actor || '')
        );
      case 'chat':
        return (
          ID.test(d.id || '') &&
          text(d.text, 500) &&
          d.text.trim().length > 0 &&
          finite(d.time, 0, 1e15)
        );
      case 'ack':
        return ID.test(d.id || '');
      case 'reaction':
        return ['♡', '😂', '😮', '🥺', '🔥', '👀'].includes(d.reaction);
      case 'nudge':
        return true;
      case 'prompt':
        return Number.isInteger(d.index) && d.index >= 0 && d.index < 12;
      case 'moment':
        return (
          ID.test(d.id || '') &&
          finite(d.at, 0, 1e9) &&
          text(d.note, 180) &&
          text(d.contentKey, 240) &&
          text(d.contentUrl, 2048) &&
          text(d.title, 180)
        );
      case 'navigation':
        return text(d.contentKey, 240) && text(d.contentUrl, 2048) && text(d.title, 180);
      default:
        return false;
    }
  }
  globalThis.CwtchProtocol = Object.freeze({
    version: 2,
    appVersion: '0.2.0',
    defaults,
    ID,
    B64,
    object,
    application,
    relayUrl,
    maxPayloadBytes: 65536,
    aad: (e) => JSON.stringify([2, e.roomId, e.senderId, e.sessionId, e.seq]),
  });
})();
