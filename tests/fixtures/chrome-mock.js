// Browser fixture only: each page has a separate Chrome storage/session.
(() => {
  const listeners = new Set(),
    changes = new Set(),
    store = { local: {}, session: {} };
  const area = (name) => ({
    async get(keys) {
      const source = store[name];
      if (keys == null) return { ...source };
      return Object.fromEntries(
        (Array.isArray(keys) ? keys : [keys]).map((key) => [key, source[key]]),
      );
    },
    async set(values) {
      Object.assign(store[name], values);
      for (const fn of changes)
        fn(
          Object.fromEntries(Object.entries(values).map(([key, newValue]) => [key, { newValue }])),
          name,
        );
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete store[name][key];
    },
  });
  const sessionId = btoa(crypto.randomUUID()).replace(/[^A-Za-z0-9_-]/g, '');
  globalThis.chrome = {
    storage: {
      local: area('local'),
      session: area('session'),
      onChanged: { addListener: (f) => changes.add(f), removeListener: (f) => changes.delete(f) },
    },
    runtime: {
      id: 'a'.repeat(32),
      getURL: (path) => `/extension/${path}`,
      openOptionsPage: async () => {},
      onMessage: {
        addListener: (f) => listeners.add(f),
        removeListener: (f) => listeners.delete(f),
      },
      async sendMessage(m) {
        if (m.type === 'CWTCH_GET_TAB_CLIENT_ID') return { ok: true, clientId: sessionId };
        if (m.type === 'CWTCH_CHECK_RELAY') return { ok: true, health: { protocol: 2 } };
        if (m.type === 'CWTCH_ROOM_GET') return { ok: true, bundle: store.session.bundle };
        if (m.type === 'CWTCH_ROOM_SET') {
          store.session.bundle = m.bundle;
          return { ok: true };
        }
        if (m.type === 'CWTCH_ROOM_CLEAR') {
          delete store.session.bundle;
          return { ok: true };
        }
        return { ok: true };
      },
      connect() {
        const messages = new Set(),
          disconnects = new Set();
        let socket;
        const emit = (m) => {
          for (const fn of messages) fn(m);
        };
        return {
          onMessage: { addListener: (f) => messages.add(f) },
          onDisconnect: { addListener: (f) => disconnects.add(f) },
          postMessage(m) {
            if (m.type === 'socket-connect') {
              socket = new WebSocket(m.relayUrl);
              socket.onopen = () => {
                emit({ type: 'socket-open' });
                socket.send(JSON.stringify(m.joinPayload));
              };
              socket.onmessage = (e) => emit({ type: 'socket-message', data: e.data });
              socket.onclose = (e) =>
                emit({ type: 'socket-close', code: e.code, reason: e.reason });
              socket.onerror = () => emit({ type: 'socket-error', message: 'Connection failed' });
            }
            if (m.type === 'socket-send' && socket?.readyState === 1) socket.send(m.data);
            if (m.type === 'socket-close') socket?.close();
          },
          disconnect() {
            socket?.close();
            for (const fn of disconnects) fn();
          },
        };
      },
    },
  };
})();
