(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  let tabId = null;
  let activeTabInfo = null;
  let state = null;
  let nameWrite = Promise.resolve();
  const CONTENT_SCRIPT_FILES = Object.freeze([
    'shared/protocol.js',
    'content/namespace.js',
    'content/constants.js',
    'content/utils.js',
    'content/diagnostics.js',
    'content/crypto.js',
    'content/platforms.js',
    'content/room-client.js',
    'content/sync-engine.js',
    'content/ui.js',
    'content/main.js',
  ]);

  function show(section) {
    $('identity-fields').classList.toggle('hidden', !['idle', 'unavailable'].includes(section));
    $('join-card').classList.toggle('hidden', !['idle', 'unavailable'].includes(section));
    for (const id of ['loading', 'unavailable', 'idle', 'active'])
      $(id).classList.toggle('hidden', id !== section);
  }

  function toast(message) {
    const node = $('toast');
    node.textContent = message;
    node.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => node.classList.remove('show'), 2400);
  }

  function validInviteUrl(value) {
    return Cwtch.utils.isCwtchInviteUrl(value);
  }

  async function copyExactText(text) {
    const value = String(text || '');
    if (!value) throw new Error('No Cwtch invite is available yet.');
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {}

    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.readOnly = true;
    textarea.style.cssText = 'position:fixed;left:-10000px;top:0;opacity:0';
    document.body.appendChild(textarea);
    const forceClipboardValue = (event) => {
      try {
        event.clipboardData?.setData('text/plain', value);
        event.preventDefault();
      } catch {}
    };
    document.addEventListener('copy', forceClipboardValue, true);
    let ok;
    try {
      textarea.focus();
      textarea.select();
      textarea.setSelectionRange(0, value.length);
      ok = Boolean(document.execCommand('copy'));
    } finally {
      document.removeEventListener('copy', forceClipboardValue, true);
      textarea.remove();
    }
    if (!ok) throw new Error('Chrome blocked the clipboard write.');
    return true;
  }

  function readDisplayName() {
    const displayName = $('display-name').value.trim().slice(0, 40);
    if (!displayName) throw new Error('Enter the name your person should see.');
    return displayName;
  }

  function storeDisplayName(displayName) {
    const clean = String(displayName || '')
      .trim()
      .slice(0, 40);
    if (!clean) return nameWrite;
    nameWrite = nameWrite
      .catch(() => {})
      .then(async () => {
        const stored = await chrome.storage.local.get(['settings', 'identity']);
        const settings = { ...(stored.settings || {}), displayName: clean };
        const identity = { ...(stored.identity || {}), name: clean };
        await chrome.storage.local.set({ settings, identity });
      });
    return nameWrite;
  }

  async function applyDisplayName(displayName) {
    await storeDisplayName(displayName);
    if (!tabId) return null;
    return send('CWTCH_SET_DISPLAY_NAME', { displayName });
  }

  async function activeTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('No active Chrome tab was found.');
    tabId = tab.id;
    activeTabInfo = tab;
    return tab;
  }

  function sendOnce(type, payload) {
    return new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, { type, payload }, (response) => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else if (!response || response.ok === false)
          reject(new Error(response?.error || 'Cwtch did not respond. Reload this tab.'));
        else resolve(response);
      });
    });
  }

  function supportedStreamingUrl(value) {
    try {
      const url = new URL(value || '');
      const host = url.hostname.replace(/^www\./, '').toLowerCase();
      return (
        url.protocol === 'https:' &&
        (host === 'youtube.com' ||
          host.endsWith('.youtube.com') ||
          host === 'netflix.com' ||
          host.endsWith('.netflix.com') ||
          host === 'primevideo.com' ||
          host.endsWith('.primevideo.com'))
      );
    } catch {
      return false;
    }
  }

  async function repairContentScript() {
    if (!tabId || !supportedStreamingUrl(activeTabInfo?.url)) return false;
    const host = new URL(activeTabInfo.url).hostname.replace(/^www\./, '').toLowerCase();
    if (host === 'netflix.com' || host.endsWith('.netflix.com')) {
      await chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        files: ['content/netflix-main-bridge.js'],
        world: 'MAIN',
      });
    }
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      files: CONTENT_SCRIPT_FILES,
      world: 'ISOLATED',
    });
    await new Promise((resolve) => setTimeout(resolve, 180));
    return true;
  }

  async function send(type, payload, allowRepair = true) {
    try {
      return await sendOnce(type, payload);
    } catch (error) {
      const missingReceiver = /Receiving end does not exist|Could not establish connection/i.test(
        error.message,
      );
      if (!allowRepair || !missingReceiver) throw error;
      const repaired = await repairContentScript();
      if (!repaired) throw error;
      return send(type, payload, false);
    }
  }

  async function load() {
    show('loading');
    const stored = await chrome.storage.local.get(['settings', 'identity']);
    $('display-name').value = stored.settings?.displayName || stored.identity?.name || '';
    try {
      await activeTab();
      state = await send('CWTCH_GET_STATE');
      render(state);
    } catch (error) {
      show('unavailable');
      $('unavailable-copy').textContent =
        'Open a Netflix, Prime Video, or YouTube title to create a room. You can also paste an invite below.';
      if (supportedStreamingUrl(activeTabInfo?.url))
        renderIssue({
          code: 'CONTENT_SCRIPT_UNAVAILABLE',
          message: error.message,
          fix: 'Cwtch tried to repair this tab automatically. Reload the streaming tab once if Chrome still blocks it.',
        });
    }
  }

  function render(next) {
    state = next;
    if (!next?.supported) {
      show('unavailable');
      $('unavailable-copy').textContent = next?.mediaReady
        ? 'This is not a recognized watch page yet. Start the title and check again.'
        : 'Open and start a Netflix, Prime Video, or YouTube video.';
    } else if (next.room) {
      show('active');
      $('active-platform').textContent = next.platform;
      $('sync-status').textContent = next.syncStatus || 'Waiting for playback';
      $('active-room').textContent = next.room.name;
      $('active-title').textContent = next.title || '';
      const roomStatusLabels = {
        idle: 'Not connected',
        connecting: 'Connecting…',
        reconnecting: 'Retrying relay…',
        error: 'Relay offline',
        closed: 'Room closed',
      };
      $('status-text').textContent =
        next.roomStatus === 'joined'
          ? next.occupants >= 2
            ? 'Connected'
            : 'Waiting for your person'
          : roomStatusLabels[next.roomStatus] || next.roomStatus;
      $('status-dot').className = next.roomStatus;
      $('occupants').textContent = `${Math.max(1, next.occupants || 1)}/2`;
      $('self-label').textContent =
        next.displayName ||
        next.participants?.find((participant) => participant.self)?.name ||
        'You';
      $('partner-label').textContent =
        next.occupants >= 2
          ? next.partnerName ||
            next.participants?.find((participant) => !participant.self)?.name ||
            'Your person'
          : 'Waiting…';
      $('resync').textContent = next.roomStatus === 'joined' ? 'Resync' : 'Reconnect';
    } else {
      show('idle');
      $('platform-label').textContent = `${next.platform} · ready`;
      $('video-title').textContent = next.title || 'Tonight’s watch';
    }
    renderIssue(next?.latestIssue);
  }

  function renderIssue(issue) {
    const box = $('issue');
    box.classList.toggle('hidden', !issue);
    if (!issue) return;
    $('issue-code').textContent = issue.code || 'CWTCH_NOTICE';
    $('issue-message').textContent = issue.message || 'Cwtch needs attention.';
    $('issue-fix').textContent = issue.fix || 'Open Fixes for the exact recovery steps.';
  }

  $('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('retry').addEventListener('click', load);
  $('create').addEventListener('click', async () => {
    const roomName = $('room-name').value.trim();
    $('create').disabled = true;
    $('create').textContent = 'Connecting…';
    toast('Free hosting may take up to 90 seconds to wake.');
    try {
      const displayName = readDisplayName();
      await storeDisplayName(displayName);
      const next = await send('CWTCH_CREATE_ROOM', { displayName, roomName });
      render(next);
      toast('Room created. Copy the invite to bring your person in.');
    } catch (error) {
      toast(error.message);
    } finally {
      $('create').disabled = false;
      $('create').textContent = 'Create room';
    }
  });
  $('join').addEventListener('click', async () => {
    $('join').disabled = true;
    try {
      const displayName = readDisplayName();
      await storeDisplayName(displayName);
      const bundle = Cwtch.utils.normalizeInviteInput($('invite').value);
      if (!supportedStreamingUrl(activeTabInfo?.url) || !state?.supported) {
        await chrome.tabs.update(tabId, { url: Cwtch.utils.buildInviteUrl(bundle) });
        window.close();
        return;
      }
      const next = await send('CWTCH_JOIN_ROOM', { invite: $('invite').value, displayName });
      if (next?.navigating) window.close();
      else render(next);
    } catch (error) {
      toast(error.message);
    } finally {
      $('join').disabled = false;
    }
  });
  $('open-panel').addEventListener('click', async () => {
    await send('CWTCH_TOGGLE_PANEL');
    window.close();
  });
  $('copy').addEventListener('click', async () => {
    try {
      const fresh = await send('CWTCH_GET_STATE');
      state = fresh || state;
      const inviteUrl = state?.inviteUrl;
      if (!validInviteUrl(inviteUrl))
        throw new Error(
          'This invite is missing or expired. Create a fresh room to invite someone.',
        );
      await copyExactText(inviteUrl);
      toast('Invite copied — paste it into Chrome’s address bar.');
    } catch (error) {
      toast(error.message || 'Could not copy the invite.');
    }
  });
  $('resync').addEventListener('click', async () => {
    const result = await send('CWTCH_RESYNC');
    toast(result?.roomStatus === 'joined' ? 'Resync requested.' : 'Reconnecting…');
  });
  $('leave').addEventListener('click', async () => {
    const next = await send('CWTCH_LEAVE_ROOM');
    render(next);
  });
  $('diagnose').addEventListener('click', async () => {
    await send('CWTCH_TOGGLE_PANEL');
    await send('CWTCH_RUN_CHECKS');
    window.close();
  });
  $('display-name').addEventListener('input', () => {
    const displayName = $('display-name').value.trim().slice(0, 40);
    if (displayName) storeDisplayName(displayName).catch(() => {});
  });
  $('display-name').addEventListener('change', () => {
    const displayName = $('display-name').value.trim().slice(0, 40);
    if (displayName) applyDisplayName(displayName).catch((error) => toast(error.message));
  });

  window.addEventListener('unhandledrejection', (event) => {
    event.preventDefault();
    toast(event.reason?.message || 'Something went wrong. Please try again.');
  });
  const poll = setInterval(async () => {
    if (tabId && state?.room) {
      try {
        render(await send('CWTCH_GET_STATE', undefined, false));
      } catch {}
    }
  }, 1500);
  window.addEventListener('pagehide', () => clearInterval(poll), { once: true });
  load().catch((error) => {
    show('unavailable');
    renderIssue({
      code: 'POPUP_INIT_FAILED',
      message: error.message,
      fix: 'Reload the extension and this streaming tab.',
    });
  });
})();
