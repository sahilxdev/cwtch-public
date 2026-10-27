(() => {
  'use strict';
  const C = globalThis.Cwtch;

  class CwtchUI extends EventTarget {
    constructor({ diagnostics, platform }) {
      super();
      this.diagnostics = diagnostics;
      this.platform = platform;
      this.host = null;
      this.shadow = null;
      this.panelOpen = false;
      this.activeTab = 'room';
      this.unread = 0;
      this.messages = [];
      this.moments = [];
      this.selfTestResults = [];
      this.boundFullscreenChange = () => this.syncFullscreenParent();
      this.state = {
        room: null,
        status: 'idle',
        occupants: 0,
        participants: [],
        inviteUrl: '',
        mediaReady: false,
        title: platform.getTitle?.() || document.title,
        latencyMs: null,
        driftSeconds: null,
        pendingContent: null,
      };
    }

    mount() {
      if (this.host?.isConnected) return;
      this.host = document.createElement('div');
      this.host.id = 'cwtch-extension-root';
      this.host.style.cssText =
        'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647';
      this.shadow = this.host.attachShadow({ mode: 'closed' });
      this.shadow.innerHTML = `<style>${this.styles()}</style>${this.template()}`;
      document.documentElement.appendChild(this.host);
      document.addEventListener('fullscreenchange', this.boundFullscreenChange);
      this.bind();
      this.renderMessages();
      this.renderMoments();
      this.diagnosticHandler ||= () => this.renderDiagnostics();
      this.diagnostics.removeEventListener('change', this.diagnosticHandler);
      this.diagnostics.addEventListener('change', this.diagnosticHandler);
      this.render();
      if (this.panelOpen) this.open(this.activeTab);
    }

    styles() {
      return `:host{color-scheme:light dark;--bg:light-dark(#fafafa,#1c1c1f);--surface:light-dark(#f0f0f3,#29292e);--ink:light-dark(#242428,#f6f6f8);--muted:light-dark(#63636d,#b7b7c2);--line:light-dark(#dcdce2,#45454e);--accent:light-dark(#923e58,#efadc0);--on-accent:light-dark(#fff,#341722);--danger:light-dark(#a12838,#ffabb5);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--ink)}
*{box-sizing:border-box}button,input,textarea{font:inherit}button{cursor:pointer;min-height:40px}button:disabled{opacity:.45;cursor:default}button:focus-visible,input:focus-visible{outline:3px solid var(--accent);outline-offset:2px}[hidden]{display:none!important}h2,h3,p{margin:0}.cwtch-trigger{pointer-events:auto;position:fixed;right:24px;bottom:24px;width:52px;height:52px;border:1px solid var(--line);border-radius:18px;background:var(--bg);box-shadow:0 8px 24px #0003;display:grid;place-items:center}.cwtch-trigger img{width:32px;height:32px}.cwtch-dot{position:absolute;right:-2px;top:-2px;width:11px;height:11px;border-radius:50%;background:var(--muted);border:2px solid var(--bg)}.cwtch-dot[data-state=joined]{background:var(--accent)}.cwtch-panel{font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;pointer-events:auto;position:fixed;right:24px;bottom:88px;width:min(390px,calc(100vw - 24px));height:min(650px,calc(100dvh - 112px));background:var(--bg);border:1px solid var(--line);border-radius:24px;box-shadow:0 20px 70px #0005;display:none;flex-direction:column;overflow:hidden;color:var(--ink)}.cwtch-panel[data-open=true]{display:flex}.cwtch-head{display:flex;gap:8px;align-items:center;padding:16px 18px}.cwtch-brand{display:flex;gap:10px;align-items:center}.cwtch-brand img{width:32px;height:32px}.cwtch-brand strong{font-size:20px;letter-spacing:-.4px}.cwtch-brand small{display:block;font-size:11px;color:var(--muted)}.cwtch-spacer{flex:1}.icon-btn{border:0;background:transparent;color:var(--muted);border-radius:10px;width:40px;font-size:18px}.cwtch-tabs{display:grid;grid-template-columns:repeat(4,1fr);margin:0 16px 12px;background:var(--surface);border-radius:12px;padding:3px}.cwtch-tab{border:0;background:transparent;color:var(--muted);border-radius:9px;font-size:12px;min-width:0}.cwtch-tab[data-active=true]{color:var(--ink);background:var(--bg);box-shadow:0 1px 3px #0002}.cwtch-body{flex:1;min-height:0;overflow:auto;padding:6px 20px 24px;scrollbar-width:thin}.view{display:none}.view[data-active=true]{display:block}.eyebrow{font-size:12px;color:var(--accent);font-weight:600;margin-bottom:8px}.room-title{font-size:26px;line-height:1.2;letter-spacing:-.6px;overflow-wrap:anywhere}.subtitle{font-size:13px;color:var(--muted);margin-top:8px;overflow-wrap:anywhere}.status-card{padding:14px 0 20px}.status-line{display:flex;gap:8px;align-items:center;font-size:12px}.status-orb{width:7px;height:7px;border-radius:50%;background:var(--muted)}.status-orb[data-state=joined]{background:var(--accent)}.status-meta{margin-left:auto;color:var(--muted)}.pair{display:grid;grid-template-columns:1fr 32px 1fr;align-items:center;margin-top:20px}.person{text-align:center;min-width:0}.avatar{background:var(--surface);border-radius:50%;width:48px;height:48px;display:grid;place-items:center;margin:0 auto 8px;font-size:18px;color:var(--accent)}.person-name{font-size:12px;overflow-wrap:anywhere}.pair-heart{text-align:center;color:var(--accent);font-size:20px}.sync-status{margin-top:16px;padding:10px 12px;background:var(--surface);border-radius:10px;color:var(--ink);font-size:13px}.button-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:16px}.primary,.secondary,.danger{border-radius:12px;padding:10px 12px;font-size:13px;font-weight:500}.primary{background:var(--accent);color:var(--on-accent);border:0}.secondary{background:var(--surface);color:var(--ink);border:1px solid var(--line)}.danger{background:transparent;color:var(--danger);border:1px solid var(--line)}.section{margin-top:24px}.section-head{display:flex;align-items:center;gap:8px;margin-bottom:10px}.section-head h3{font-size:13px}.section-head small{margin-left:auto;font-size:11px;color:var(--muted)}.reactions{display:grid;grid-template-columns:repeat(6,1fr);gap:4px}.reaction-btn{border:0;border-radius:12px;background:var(--surface);font-size:20px;color:var(--ink)}.prompt{padding:16px;background:var(--surface);border-radius:16px}.prompt p{font-size:15px}.prompt button{margin-top:12px}.empty{padding:36px 8px;text-align:center;color:var(--muted)}.empty strong{display:block;color:var(--ink);margin-bottom:8px;font-size:14px}.empty p{font-size:13px}.view[data-view=chat][data-active=true]{display:flex;flex-direction:column;min-height:100%}.chat-list{flex:1}.chat-list,.moment-list,.fix-list{display:flex;flex-direction:column;gap:12px}.bubble{max-width:90%;padding:12px;border-radius:16px 16px 16px 4px;background:var(--surface);align-self:flex-start}.bubble[data-self=true]{align-self:flex-end;border-radius:16px 16px 4px 16px;border:1px solid var(--line)}.bubble-meta{display:flex;gap:10px;color:var(--muted);font-size:11px;margin-bottom:5px}.bubble-text{font-size:14px;overflow-wrap:anywhere;white-space:pre-wrap}.delivery{font-size:11px;color:var(--muted);margin-top:6px}.retry-message{border:0;background:transparent;color:var(--accent);font-size:12px;padding:4px 0;min-height:32px}.composer{position:sticky;bottom:-24px;display:flex;gap:8px;background:var(--bg);padding:20px 0 8px}.composer input{flex:1;min-width:0}.composer input,.moment-composer input{border:1px solid var(--line);border-radius:12px;padding:11px;background:var(--surface);color:var(--ink)}.composer button{border:0;border-radius:12px;background:var(--accent);color:var(--on-accent);width:44px}.moment-composer{display:grid;gap:8px;margin-bottom:16px}.moment-composer input{width:100%}.moment{padding:16px;background:var(--surface);border-radius:16px}.moment-top{display:flex;gap:10px;align-items:center}.timestamp{font-variant-numeric:tabular-nums;border:0;background:transparent;color:var(--accent);padding:0;min-height:32px}.moment-by{font-size:11px;color:var(--muted);margin-left:auto}.moment-note{margin-top:8px;overflow-wrap:anywhere}.moment-title{color:var(--muted);font-size:12px;margin-top:6px}.fix{padding:14px;border-bottom:1px solid var(--line)}.fix-code{display:flex;gap:8px;font-size:11px;overflow-wrap:anywhere;color:var(--muted)}.fix-time{margin-left:auto;flex-shrink:0}.fix-message{font-size:14px;margin-top:8px}.fix-action{font-size:12px;color:var(--muted);margin-top:6px}.metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:8px 0 16px}.metric strong{display:block;font-size:16px}.metric span{font-size:11px;color:var(--muted)}.test-row{display:flex;gap:8px;padding:10px 0;font-size:12px;border-bottom:1px solid var(--line)}.test-detail{margin-left:auto;text-align:right;max-width:50%;color:var(--muted)}.test-ok{color:var(--accent)}.test-bad{color:var(--danger)}.toast{position:absolute;bottom:16px;left:16px;right:16px;background:var(--ink);color:var(--bg);padding:12px 14px;border-radius:12px;font-size:13px;opacity:0;pointer-events:none;transition:opacity .15s;z-index:2}.toast[data-show=true]{opacity:1}.floating-reaction{position:fixed;right:90px;bottom:110px;font-size:34px;pointer-events:none;animation:cwtch-float 1.8s ease-out forwards}@keyframes cwtch-float{from{transform:translateY(0);opacity:1}to{transform:translateY(-100px);opacity:0}}.mismatch{display:none;background:var(--surface);padding:14px;border-radius:14px;margin:8px 0}.mismatch[data-show=true]{display:block}.mismatch strong{font-size:14px}.mismatch p{font-size:12px;color:var(--muted);margin:8px 0 12px}.unread{font-size:11px;color:var(--accent)}@media(max-width:520px){.cwtch-trigger{right:12px;bottom:12px}.cwtch-panel{right:12px;bottom:76px;height:min(650px,calc(100dvh - 88px))}}@media(prefers-reduced-motion:reduce){*,*:before,*:after{animation:none!important;transition:none!important}}@media(forced-colors:active){button,input,.cwtch-panel{border:1px solid ButtonText}}
`;
    }

    template() {
      const logo = chrome.runtime.getURL('assets/logo.svg');
      return `
        <button class="cwtch-trigger" aria-label="Open Cwtch" aria-expanded="false"><img src="${logo}" alt=""><span class="cwtch-dot" data-state="idle"></span></button>
        <section class="cwtch-panel" role="dialog" aria-label="Cwtch watch party" data-open="false">
          <header class="cwtch-head">
            <div class="cwtch-brand"><img src="${logo}" alt=""><div><strong>Cwtch</strong><small>watch parties for two</small></div></div>
            <div class="cwtch-spacer"></div>
            <button class="icon-btn" data-action="settings" aria-label="Open settings">⚙</button>
            <button class="icon-btn" data-action="close" aria-label="Close Cwtch">×</button>
          </header>
          <nav class="cwtch-tabs" aria-label="Cwtch sections" role="tablist">
            <button class="cwtch-tab" role="tab" id="cwtch-tab-room" aria-controls="cwtch-view-room" aria-selected="true" tabindex="0" data-tab="room" data-active="true">Room</button>
            <button class="cwtch-tab" role="tab" id="cwtch-tab-chat" aria-controls="cwtch-view-chat" aria-selected="false" tabindex="-1" data-tab="chat" data-active="false">Chat <span class="unread" aria-label="unread messages"></span></button>
            <button class="cwtch-tab" role="tab" id="cwtch-tab-moments" aria-controls="cwtch-view-moments" aria-selected="false" tabindex="-1" data-tab="moments" data-active="false">Moments</button>
            <button class="cwtch-tab" role="tab" id="cwtch-tab-fixes" aria-controls="cwtch-view-fixes" aria-selected="false" tabindex="-1" data-tab="fixes" data-active="false">Help</button>
          </nav>
          <main class="cwtch-body">
            <section class="view" role="tabpanel" id="cwtch-view-room" aria-labelledby="cwtch-tab-room" data-view="room" data-active="true">
              <div class="mismatch" data-role="mismatch"><strong>You are watching different titles.</strong><p data-role="mismatch-copy"></p><button class="primary" data-action="follow">Follow this title</button></div>
              <div class="status-card">
                <div class="status-line"><span class="status-orb" data-role="status-orb" data-state="idle"></span><span class="status-text" data-role="status-text">Not in a room</span><span class="status-meta" data-role="status-meta">${this.platform.name}</span></div>
                <div class="pair">
                  <div class="person"><div class="avatar" data-role="self-avatar">Y</div><div class="person-name" data-role="self-name">You</div></div>
                  <div class="pair-heart">♡</div>
                  <div class="person"><div class="avatar" data-role="peer-avatar">?</div><div class="person-name" data-role="peer-name">Waiting…</div></div>
                </div>
              </div>
              <div><div class="eyebrow" data-role="room-eyebrow">${this.platform.name}</div><h2 class="room-title" data-role="room-title">Open a room from the Cwtch icon.</h2><p class="subtitle" data-role="room-subtitle">The film stays on this site. Cwtch only synchronizes your controls and private room messages.</p></div>
              <p class="sync-status" data-role="sync-status" role="status">Waiting for a room</p><div class="button-grid">
                <button class="primary" data-action="copy">Copy invite</button>
                <button class="secondary" data-action="resync">Resync</button>
                <button class="secondary" data-action="resume">Resume together</button>
                <button class="danger" data-action="leave">Leave room</button>
              </div>
              <div class="section"><div class="section-head"><h3>Say it without interrupting</h3><small>quiet reactions</small></div><div class="reactions">${C.REACTIONS.map((r) => `<button class="reaction-btn" data-reaction="${r}" aria-label="Send ${r}">${r}</button>`).join('')}</div></div>
              <div class="section"><div class="section-head"><h3>A small nudge</h3><small>for the other tab</small></div><button class="secondary" style="width:100%" data-action="nudge">Send “I’m here”</button></div>
              <div class="section prompt" data-role="prompt"><div class="eyebrow">Date-night card</div><p data-role="prompt-copy">${C.DATE_PROMPTS[0]}</p><button class="secondary" data-action="new-prompt">Another card</button></div>
            </section>
            <section class="view" role="tabpanel" id="cwtch-view-chat" aria-labelledby="cwtch-tab-chat" data-view="chat"><div class="chat-list" data-role="chat-list" role="log" aria-live="polite" aria-label="Room messages"></div><form class="composer" data-role="chat-form"><input maxlength="500" autocomplete="off" placeholder="Say something…" aria-label="Chat message"><button aria-label="Send message">↗</button></form></section>
            <section class="view" role="tabpanel" id="cwtch-view-moments" aria-labelledby="cwtch-tab-moments" data-view="moments"><form class="moment-composer" data-role="moment-form"><input maxlength="180" autocomplete="off" placeholder="Why keep it? (optional)" aria-label="Moment note"><button class="primary" type="submit">Keep current moment</button></form><div class="moment-list" data-role="moment-list"></div><button class="secondary" data-action="export-moments" style="margin-top:16px">Export moments</button><p class="subtitle">Tap a timestamp to jump together. Exports contain your notes and title links.</p></section>
            <section class="view" role="tabpanel" id="cwtch-view-fixes" aria-labelledby="cwtch-tab-fixes" data-view="fixes"><div class="metrics" data-role="metrics"></div><div class="button-grid" style="margin:0 0 12px"><button class="primary" data-action="checks">Run checks</button><button class="secondary" data-action="report">Download report</button></div><div data-role="test-results"></div><div class="fix-list" data-role="fix-list"></div></section>
            <div class="toast" data-role="toast" role="status" aria-live="polite"></div>
          </main>
        </section>
      `;
    }

    bind() {
      const q = (selector) => this.shadow.querySelector(selector);
      q('.cwtch-trigger').addEventListener('click', () => this.toggle());
      this.shadow.addEventListener('click', (event) => {
        const button = event.target.closest('button');
        if (!button) return;
        const tab = button.dataset.tab;
        if (tab) return this.setTab(tab);
        const action = button.dataset.action;
        if (action === 'retry-message')
          return C.utils.emit(this, 'retry-message', { id: button.dataset.id });
        if (action === 'seek-moment')
          return C.utils.emit(this, 'seek-moment', {
            moment: this.moments.find((m) => m.id === button.dataset.id),
          });
        if (action === 'export-moments') return C.utils.emit(this, 'export-moments');
        if (action === 'close') return this.close();
        if (action === 'settings') return C.utils.emit(this, 'settings');
        if (action === 'copy') return C.utils.emit(this, 'copy-invite');
        if (action === 'resync') return C.utils.emit(this, 'resync');
        if (action === 'resume') return C.utils.emit(this, 'resume');
        if (action === 'leave') return C.utils.emit(this, 'leave');
        if (action === 'nudge') return C.utils.emit(this, 'nudge');
        if (action === 'moment') return C.utils.emit(this, 'moment');
        if (action === 'checks') return C.utils.emit(this, 'checks');
        if (action === 'report') return C.utils.emit(this, 'report');
        if (action === 'follow')
          return C.utils.emit(this, 'follow', { content: this.state.pendingContent });
        if (action === 'new-prompt') return this.nextPrompt();
        if (button.dataset.reaction)
          C.utils.emit(this, 'reaction', { reaction: button.dataset.reaction });
      });
      q('[data-role="chat-form"]').addEventListener('submit', (event) => {
        event.preventDefault();
        const input = event.currentTarget.querySelector('input');
        const text = C.utils.sanitizeText(input.value, 500);
        if (!text) return;
        C.utils.emit(this, 'chat', { text });
        input.value = '';
      });
      q('[data-role="moment-form"]').addEventListener('submit', (event) => {
        event.preventDefault();
        const input = event.currentTarget.querySelector('input');
        const note = C.utils.sanitizeText(input.value, 180);
        C.utils.emit(this, 'moment', { note });
        input.value = '';
      });
      this.shadow.addEventListener('keydown', (event) => {
        if (
          event.target.matches('[role=tab]') &&
          ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)
        ) {
          event.preventDefault();
          const tabs = [...this.shadow.querySelectorAll('[role=tab]')];
          let index = tabs.indexOf(event.target);
          index =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? tabs.length - 1
                : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
          this.setTab(tabs[index].dataset.tab);
          tabs[index].focus();
        }
        if (['INPUT', 'TEXTAREA'].includes(event.target.tagName) || this.panelOpen)
          event.stopPropagation();
      });
      this.shadow.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && this.panelOpen) this.close();
      });
    }

    syncFullscreenParent() {
      if (!this.host) return;
      const fullscreen = document.fullscreenElement;
      if (fullscreen && fullscreen.tagName !== 'VIDEO') {
        if (this.host.parentNode !== fullscreen) fullscreen.appendChild(this.host);
      } else if (this.host.parentNode !== document.documentElement) {
        document.documentElement.appendChild(this.host);
      }
    }

    q(selector) {
      return this.shadow.querySelector(selector);
    }

    open(tab) {
      this.panelOpen = true;
      this.q('.cwtch-panel').dataset.open = 'true';
      this.q('.cwtch-trigger').setAttribute('aria-expanded', 'true');
      if (tab) this.setTab(tab);
      this.q(`[data-tab="${this.activeTab}"]`).focus();
    }

    close() {
      this.panelOpen = false;
      this.q('.cwtch-panel').dataset.open = 'false';
      this.q('.cwtch-trigger').setAttribute('aria-expanded', 'false');
      this.q('.cwtch-trigger').focus();
    }

    toggle() {
      this.panelOpen ? this.close() : this.open();
    }

    setTab(tab) {
      this.activeTab = tab;
      for (const button of this.shadow.querySelectorAll('[data-tab]')) {
        const active = button.dataset.tab === tab;
        button.dataset.active = String(active);
        button.setAttribute('aria-selected', String(active));
        button.tabIndex = active ? 0 : -1;
      }
      if (tab === 'chat') {
        this.unread = 0;
        this.q('.unread').textContent = '';
      }
      for (const view of this.shadow.querySelectorAll('[data-view]'))
        view.dataset.active = String(view.dataset.view === tab);
      if (tab === 'fixes') this.renderDiagnostics();
    }

    update(patch) {
      Object.assign(this.state, patch);
      this.render();
    }

    render() {
      if (!this.shadow) return;
      const status = this.state.status || 'idle';
      this.q('.cwtch-dot').dataset.state = status;
      this.q('[data-role="status-orb"]').dataset.state = status;
      const statusLabels = {
        idle: 'Not in a room',
        connecting: 'Connecting…',
        reconnecting: 'Reconnecting…',
        joined: this.state.occupants >= 2 ? 'Connected' : 'Waiting for your person',
        error: 'Needs attention',
        closed: 'Room closed',
      };
      this.q('[data-role="status-text"]').textContent = statusLabels[status] || status;
      const latency = this.platform.name;
      this.q('[data-role="sync-status"]').textContent =
        this.state.syncStatus || 'Waiting for playback';
      this.q('[data-role="prompt"]').hidden = this.state.showPrompts === false;
      this.q('[data-role="status-meta"]').textContent = latency;
      const self = this.state.participants.find((p) => p.self) || { name: 'You' };
      const peer = this.state.participants.find((p) => !p.self);
      this.q('[data-role="self-name"]').textContent = self.name || 'You';
      this.q('[data-role="self-avatar"]').textContent = this.initials(self.name || 'You');
      this.q('[data-role="peer-name"]').textContent = peer?.name || 'Waiting…';
      this.q('[data-role="peer-avatar"]').textContent = peer ? this.initials(peer.name) : '?';
      this.q('[data-role="room-eyebrow"]').textContent = this.state.room
        ? `${this.platform.name} · ${this.state.occupants}/2`
        : this.platform.name;
      this.q('[data-role="room-title"]').textContent =
        this.state.room?.name ||
        (this.state.mediaReady ? 'Ready when you are.' : 'Start a video first.');
      this.q('[data-role="room-subtitle"]').textContent = this.state.room
        ? this.state.title
        : 'The film stays on this site. Cwtch only synchronizes controls and private room messages.';
      const roomActions = this.shadow.querySelectorAll(
        '[data-action="copy"],[data-action="resync"],[data-action="resume"],[data-action="leave"],[data-action="nudge"],[data-reaction],[data-role="moment-form"] input,[data-role="moment-form"] button',
      );
      for (const control of roomActions) control.disabled = !this.state.room;
      for (const control of this.shadow.querySelectorAll(
        '[data-role="chat-form"] input, [data-role="chat-form"] button, [data-reaction], [data-action="nudge"]',
      ))
        control.disabled = !this.state.room || status !== 'joined' || this.state.occupants < 2;
      const resyncButton = this.q('[data-action="resync"]');
      if (resyncButton) resyncButton.textContent = status === 'joined' ? 'Resync' : 'Reconnect';
      const mismatch = this.q('[data-role="mismatch"]');
      mismatch.dataset.show = String(Boolean(this.state.pendingContent));
      if (this.state.pendingContent)
        this.q('[data-role="mismatch-copy"]').textContent =
          `${this.state.pendingContent.person || 'Your person'} opened “${this.state.pendingContent.title || 'another title'}”.`;
      this.renderDiagnostics();
    }

    initials(name) {
      return (
        C.utils
          .sanitizeText(name, 30)
          .split(/\s+/)
          .slice(0, 2)
          .map((part) => part[0])
          .join('')
          .toUpperCase() || '?'
      );
    }

    addMessage(message) {
      if (this.messages.some((m) => m.id === message.id)) return;
      this.messages.push(message);
      if (!message.self && (!this.panelOpen || this.activeTab !== 'chat')) {
        this.unread++;
        this.q('.unread').textContent = String(this.unread);
      }
      if (this.messages.length > 100) this.messages.shift();
      this.renderMessages();
    }

    renderMessages() {
      const list = this.q('[data-role="chat-list"]');
      if (!list) return;
      list.textContent = '';
      if (!this.messages.length) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.innerHTML =
          '<strong>No running commentary required.</strong><p>Use chat when a look across the room would normally be enough.</p>';
        list.appendChild(empty);
        return;
      }
      for (const message of this.messages) {
        const bubble = document.createElement('article');
        bubble.className = 'bubble';
        bubble.dataset.self = String(Boolean(message.self));
        const meta = document.createElement('div');
        meta.className = 'bubble-meta';
        const sender = document.createElement('span');
        sender.textContent = message.name;
        const time = document.createElement('span');
        time.textContent = new Date(message.time).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
        });
        meta.append(sender, time);
        const text = document.createElement('div');
        text.className = 'bubble-text';
        text.textContent = message.text;
        bubble.append(meta, text);
        if (message.self) {
          const delivery = document.createElement('div');
          delivery.className = 'delivery';
          delivery.textContent =
            { sending: 'Sending…', delivered: 'Delivered', unconfirmed: 'Delivery not confirmed' }[
              message.status
            ] || 'Delivery not confirmed';
          bubble.appendChild(delivery);
          if (message.status === 'unconfirmed') {
            const retry = document.createElement('button');
            retry.className = 'retry-message';
            retry.textContent = 'Retry';
            retry.dataset.action = 'retry-message';
            retry.dataset.id = message.id;
            bubble.appendChild(retry);
          }
        }
        list.appendChild(bubble);
      }
      list.scrollTop = list.scrollHeight;
    }

    addMoment(moment) {
      if (this.moments.some((m) => m.id === moment.id)) return;
      this.moments.push(moment);
      if (this.moments.length > 80) this.moments.shift();
      this.renderMoments();
    }

    renderMoments() {
      const list = this.q('[data-role="moment-list"]');
      if (!list) return;
      list.textContent = '';
      if (!this.moments.length) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.innerHTML =
          '<strong>Nothing kept yet.</strong><p>Save a timestamp when a scene feels worth returning to.</p>';
        list.appendChild(empty);
        return;
      }
      for (const moment of [...this.moments].reverse()) {
        const card = document.createElement('article');
        card.className = 'moment';
        const top = document.createElement('div');
        top.className = 'moment-top';
        const timestamp = document.createElement('button');
        timestamp.dataset.action = 'seek-moment';
        timestamp.dataset.id = moment.id;
        timestamp.setAttribute('aria-label', `Jump together to ${C.utils.formatTime(moment.at)}`);
        timestamp.className = 'timestamp';
        timestamp.textContent = C.utils.formatTime(moment.at);
        const by = document.createElement('span');
        by.className = 'moment-by';
        by.textContent = moment.name;
        top.append(timestamp, by);
        const note = document.createElement('div');
        note.className = 'moment-note';
        note.textContent = moment.note || 'Keep this moment.';
        const title = document.createElement('div');
        title.className = 'moment-title';
        title.textContent = moment.title || '';
        const delivery = document.createElement('div');
        delivery.className = 'delivery';
        delivery.textContent = moment.self
          ? moment.status === 'delivered'
            ? 'Shared'
            : 'Saved here · sharing not confirmed'
          : '';
        card.append(top, note, title, delivery);
        list.appendChild(card);
      }
    }

    showReaction(reaction) {
      const node = document.createElement('div');
      node.className = 'floating-reaction';
      node.textContent = reaction;
      this.shadow.appendChild(node);
      setTimeout(() => node.remove(), 1900);
    }

    showNudge(name) {
      this.showToast(`${name || 'Your person'} says: I’m here.`);
      this.open('room');
    }

    nextPrompt() {
      const old = this.promptIndex || 0;
      const index =
        (old + 1 + Math.floor(Math.random() * (C.DATE_PROMPTS.length - 1))) % C.DATE_PROMPTS.length;
      this.setPrompt(index);
      C.utils.emit(this, 'prompt', { index });
    }
    setPrompt(index) {
      this.promptIndex = index;
      this.q('[data-role="prompt-copy"]').textContent = C.DATE_PROMPTS[index];
    }
    setDelivery(id, status) {
      for (const item of [...this.messages, ...this.moments])
        if (item.id === id) item.status = status;
      this.renderMessages();
      this.renderMoments();
    }
    resetRoom() {
      this.messages = [];
      this.moments = [];
      this.unread = 0;
      this.q('.unread').textContent = '';
      this.state.pendingContent = null;
      this.setPrompt(0);
      this.renderMessages();
      this.renderMoments();
    }
    destroy() {
      clearTimeout(this.toastTimer);
      document.removeEventListener('fullscreenchange', this.boundFullscreenChange);
      this.diagnostics.removeEventListener('change', this.diagnosticHandler);
      this.host?.remove();
    }

    showToast(message) {
      const toast = this.q('[data-role="toast"]');
      toast.textContent = message;
      toast.dataset.show = 'true';
      clearTimeout(this.toastTimer);
      this.toastTimer = setTimeout(() => {
        toast.dataset.show = 'false';
      }, 2600);
    }

    setSelfTest(results) {
      this.selfTestResults = results;
      this.renderDiagnostics();
    }

    renderDiagnostics() {
      if (!this.shadow) return;
      const metrics = this.q('[data-role="metrics"]');
      if (!metrics) return;
      const values = [
        [this.diagnostics.metrics.connected ? 'Online' : 'Offline', 'Relay'],
        [
          Number.isFinite(this.diagnostics.metrics.latencyMs)
            ? `${this.diagnostics.metrics.latencyMs} ms`
            : '—',
          'Latency',
        ],
        [
          Number.isFinite(this.diagnostics.metrics.driftSeconds)
            ? `${this.diagnostics.metrics.driftSeconds}s`
            : '—',
          'Drift',
        ],
      ];
      metrics.textContent = '';
      for (const [value, label] of values) {
        const node = document.createElement('div');
        node.className = 'metric';
        const strong = document.createElement('strong');
        strong.textContent = value;
        const span = document.createElement('span');
        span.textContent = label;
        node.append(strong, span);
        metrics.appendChild(node);
      }
      const tests = this.q('[data-role="test-results"]');
      tests.textContent = '';
      if (this.selfTestResults.length) {
        for (const result of this.selfTestResults) {
          const row = document.createElement('div');
          row.className = 'test-row';
          const mark = document.createElement('span');
          mark.className = result.ok ? 'test-ok' : 'test-bad';
          mark.textContent = result.ok ? '✓' : '!';
          mark.setAttribute('aria-label', result.ok ? 'Passed' : 'Needs attention');
          const name = document.createElement('span');
          name.textContent = result.name;
          const detail = document.createElement('span');
          detail.className = 'test-detail';
          detail.textContent = result.detail;
          row.append(mark, name, detail);
          tests.appendChild(row);
        }
        tests.style.marginBottom = '12px';
      }
      const list = this.q('[data-role="fix-list"]');
      list.textContent = '';
      if (!this.diagnostics.entries.length) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.innerHTML =
          '<strong>No known problems.</strong><p>Run checks before a date night or whenever a streaming site changes its player.</p>';
        list.appendChild(empty);
        return;
      }
      for (const entry of this.diagnostics.entries.slice(0, 30)) {
        const card = document.createElement('article');
        card.className = 'fix';
        card.dataset.severity = entry.severity;
        const code = document.createElement('div');
        code.className = 'fix-code';
        const label = document.createElement('span');
        label.textContent = entry.code;
        const time = document.createElement('span');
        time.className = 'fix-time';
        time.textContent = new Date(entry.time).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
        });
        code.append(label, time);
        const message = document.createElement('div');
        message.className = 'fix-message';
        message.textContent = entry.message;
        const action = document.createElement('div');
        action.className = 'fix-action';
        action.textContent = entry.fix;
        card.append(code, message, action);
        list.appendChild(card);
      }
    }
  }

  C.CwtchUI = CwtchUI;
})();
