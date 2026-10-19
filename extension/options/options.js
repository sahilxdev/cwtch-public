(() => {
  "use strict";
  const DEFAULTS = {
    relayUrl: "ws://localhost:8787/ws",
    displayName: "",
    autoOpenPanel: true,
    debugMode: false,
    softSync: true,
    nudgeSound: true,
    autoFollow: false
  };
  const $ = (id) => document.getElementById(id);

  function fill(settings) {
    $("relay-url").value = settings.relayUrl;
    $("display-name").value = settings.displayName;
    $("auto-open").checked = settings.autoOpenPanel;
    $("soft-sync").checked = settings.softSync;
    $("nudge-sound").checked = settings.nudgeSound;
    $("auto-follow").checked = settings.autoFollow;
    $("debug-mode").checked = settings.debugMode;
  }

  function collect() {
    const relayUrl = $("relay-url").value.trim();
    const parsed = new URL(relayUrl);
    if (!['ws:', 'wss:'].includes(parsed.protocol)) throw new Error("The relay must use ws:// or wss://.");
    const isLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
    if (parsed.protocol === "ws:" && !isLoopback) throw new Error("Public relays must use wss://.");
    if (parsed.username || parsed.password) throw new Error("Relay URLs cannot contain usernames or passwords.");
    return {
      relayUrl: parsed.toString(),
      displayName: $("display-name").value.trim().slice(0, 40),
      autoOpenPanel: $("auto-open").checked,
      softSync: $("soft-sync").checked,
      nudgeSound: $("nudge-sound").checked,
      autoFollow: $("auto-follow").checked,
      debugMode: $("debug-mode").checked
    };
  }

  async function load() {
    const result = await chrome.storage.local.get(["settings", "identity"]);
    fill({ ...DEFAULTS, ...(result.settings || {}) });
  }

  async function save() {
    try {
      const settings = collect();
      const result = await chrome.storage.local.get("identity");
      const identity = result.identity || {};
      if (settings.displayName) identity.name = settings.displayName;
      await chrome.storage.local.set({ settings, identity });
      $("saved").textContent = "Saved.";
      setTimeout(() => { $("saved").textContent = ""; }, 2000);
    } catch (error) {
      $("saved").textContent = error.message;
    }
  }

  async function checkHealth() {
    const dot = $("health-dot");
    dot.className = "";
    $("health-title").textContent = "Checking…";
    $("health-detail").textContent = "Opening a WebSocket health probe.";
    try {
      const relayUrl = $("relay-url").value.trim();
      const result = await chrome.runtime.sendMessage({ type: "CWTCH_CHECK_RELAY", relayUrl });
      if (!result?.ok) throw new Error(result?.error || "Relay health check failed.");
      const body = result.health;
      dot.className = "good";
      $("health-title").textContent = "Relay healthy";
      $("health-detail").textContent = `${body.rooms} active rooms · protocol ${body.protocol} · ${body.uptimeSeconds}s uptime`;
    } catch (error) {
      dot.className = "bad";
      $("health-title").textContent = "Relay unavailable";
      $("health-detail").textContent = error.message;
    }
  }

  $("save").addEventListener("click", save);
  $("reset").addEventListener("click", () => { fill(DEFAULTS); $("saved").textContent = "Defaults restored. Save to apply."; });
  $("health-check").addEventListener("click", checkHealth);
  load();
})();
