(() => {
  'use strict';
  const DEFAULTS = CwtchProtocol.defaults;
  const $ = (id) => document.getElementById(id);

  function fill(settings) {
    $('relay-url').value = settings.relayUrl;
    $('display-name').value = settings.displayName;
    $('auto-open').checked = settings.autoOpenPanel;
    $('soft-sync').checked = settings.softSync;
    $('nudge-sound').checked = settings.nudgeSound;
    $('auto-follow').checked = settings.autoFollow;
    $('debug-mode').checked = settings.debugMode;
    $('remember-history').checked = settings.rememberHistory;
    $('show-prompts').checked = settings.showPrompts;
  }

  function collect() {
    const relayUrl = $('relay-url').value.trim();
    const parsed = CwtchProtocol.relayUrl(relayUrl);
    return {
      relayUrl: parsed,
      displayName: $('display-name').value.trim().slice(0, 40),
      autoOpenPanel: $('auto-open').checked,
      softSync: $('soft-sync').checked,
      nudgeSound: $('nudge-sound').checked,
      autoFollow: $('auto-follow').checked,
      rememberHistory: $('remember-history').checked,
      showPrompts: $('show-prompts').checked,
      debugMode: $('debug-mode').checked,
    };
  }

  async function load() {
    const result = await chrome.storage.local.get(['settings', 'identity']);
    fill({ ...DEFAULTS, ...(result.settings || {}) });
  }

  async function save() {
    try {
      const settings = collect();
      const result = await chrome.storage.local.get('identity');
      const identity = result.identity || {};
      if (settings.displayName) identity.name = settings.displayName;
      await chrome.storage.local.set({ settings, identity });
      if (!settings.rememberHistory) {
        const all = await chrome.storage.local.get(null);
        await chrome.storage.local.remove(
          Object.keys(all).filter((key) => key.startsWith('history:')),
        );
      }
      $('saved').textContent = 'Saved.';
      setTimeout(() => {
        $('saved').textContent = '';
      }, 2000);
    } catch (error) {
      $('saved').textContent = error.message;
    }
  }

  async function checkHealth() {
    const dot = $('health-dot');
    dot.className = '';
    $('health-title').textContent = 'Checking…';
    $('health-detail').textContent =
      'Connecting to the relay. Free hosting may take up to 90 seconds to wake.';
    try {
      const relayUrl = $('relay-url').value.trim();
      const result = await chrome.runtime.sendMessage({ type: 'CWTCH_CHECK_RELAY', relayUrl });
      if (!result?.ok) throw new Error(result?.error || 'Relay health check failed.');
      const body = result.health;
      dot.className = 'good';
      $('health-title').textContent = 'Relay healthy';
      $('health-detail').textContent =
        `${body.rooms} active rooms · protocol ${body.protocol} · ${body.uptimeSeconds}s uptime`;
    } catch (error) {
      dot.className = 'bad';
      $('health-title').textContent = 'Relay unavailable';
      $('health-detail').textContent = error.message;
    }
  }

  $('clear-history').addEventListener('click', async () => {
    const all = await chrome.storage.local.get(null);
    await chrome.storage.local.remove(Object.keys(all).filter((key) => key.startsWith('history:')));
    $('clear-status').textContent = 'Saved conversations cleared from this device.';
  });
  window.addEventListener('unhandledrejection', (event) => {
    event.preventDefault();
    $('saved').textContent = event.reason?.message || 'Could not complete that action.';
  });
  $('save').addEventListener('click', save);
  $('reset').addEventListener('click', () => {
    fill(DEFAULTS);
    $('saved').textContent = 'Defaults restored. Save to apply.';
  });
  $('health-check').addEventListener('click', checkHealth);
  load();
})();
