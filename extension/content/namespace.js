(() => {
  "use strict";
  const existing = globalThis.Cwtch;
  if (existing?.APP_VERSION && existing.APP_VERSION !== "0.1.4") {
    const staleApp = existing.app;
    try { staleApp.destroyed = true; } catch {}
    try { clearInterval(staleApp?.playerTimer); } catch {}
    try { clearInterval(staleApp?.navigationTimer); } catch {}
    try { staleApp?.syncEngine?.stop?.(); } catch {}
    try { staleApp?.roomClient?.close?.(); } catch {}
    try { document.getElementById("cwtch-extension-root")?.remove(); } catch {}
    globalThis.__CWTCH_APP_BOOTSTRAPPED__ = false;
    globalThis.Cwtch = {};
    return;
  }
  globalThis.Cwtch = existing || {};
})();
