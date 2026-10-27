(() => {
  'use strict';
  const existing = globalThis.Cwtch;
  if (
    existing?.APP_VERSION === globalThis.CwtchProtocol.appVersion &&
    existing.app &&
    !existing.app.destroyed
  )
    return;
  existing?.app?.destroy?.();
  globalThis.__CWTCH_APP_BOOTSTRAPPED__ = false;
  globalThis.Cwtch = {};
})();
