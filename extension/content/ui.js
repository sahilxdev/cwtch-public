(() => {
  "use strict";
  const C = globalThis.Cwtch;

  class CwtchUI extends EventTarget {
    constructor({ diagnostics, platform }) {
      super();
      this.diagnostics = diagnostics;
      this.platform = platform;
      this.host = null;
      this.shadow = null;
      this.panelOpen = false;
      this.activeTab = "room";
      this.messages = [];
      this.moments = [];
      this.selfTestResults = [];
      this.boundFullscreenChange = () => this.syncFullscreenParent();
      this.state = {
        room: null,
        status: "idle",
        occupants: 0,
        participants: [],
        inviteUrl: "",
        mediaReady: false,
        title: platform.getTitle?.() || document.title,
        latencyMs: null,
        driftSeconds: null,
        pendingContent: null
      };
    }

    mount() {
      if (this.host?.isConnected) return;
      this.host = document.createElement("div");
      this.host.id = "cwtch-extension-root";
      this.host.style.cssText = "all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647";
      this.shadow = this.host.attachShadow({ mode: "closed" });
      this.shadow.innerHTML = `<style>${this.styles()}</style>${this.template()}`;
      document.documentElement.appendChild(this.host);
      document.addEventListener("fullscreenchange", this.boundFullscreenChange);
      this.bind();
      this.diagnostics.addEventListener("change", () => this.renderDiagnostics());
      this.render();
    }

    styles() {
      return `
        :host{--plum:#3b1f32;--plum2:#24121f;--rose:#c56a6f;--blush:#ebc7c2;--cream:#fbf5ee;--charcoal:#1c1c1e;--muted:#a99ba5;--line:rgba(255,255,255,.11);--shadow:0 26px 80px rgba(0,0,0,.48);font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--cream)}
        *{box-sizing:border-box}
        button,input,textarea{font:inherit}
        button{cursor:pointer}
        .cwtch-trigger{pointer-events:auto;position:fixed;right:22px;bottom:22px;width:54px;height:54px;border:1px solid rgba(255,255,255,.18);border-radius:18px;background:linear-gradient(145deg,#4d283f,#21121e);box-shadow:0 14px 40px rgba(0,0,0,.4);display:grid;place-items:center;transition:transform .2s ease,box-shadow .2s ease}
        .cwtch-trigger:hover{transform:translateY(-2px);box-shadow:0 18px 44px rgba(0,0,0,.5)}
        .cwtch-trigger img{width:34px;height:34px}
        .cwtch-dot{position:absolute;top:-3px;right:-3px;width:12px;height:12px;border-radius:50%;background:#777;border:2px solid #1b1119}
        .cwtch-dot[data-state="joined"]{background:#6fd39c}.cwtch-dot[data-state="connecting"],.cwtch-dot[data-state="reconnecting"]{background:#e8bf6a}.cwtch-dot[data-state="error"]{background:#ef7a7a}
        .cwtch-panel{pointer-events:auto;position:fixed;right:22px;bottom:88px;width:min(390px,calc(100vw - 24px));height:min(620px,calc(100vh - 116px));border:1px solid rgba(255,255,255,.14);border-radius:26px;overflow:hidden;background:radial-gradient(circle at 85% -10%,rgba(197,106,111,.22),transparent 34%),linear-gradient(180deg,#21151e,#121014 72%);box-shadow:var(--shadow);display:none;flex-direction:column;color:var(--cream);backdrop-filter:blur(22px)}
        .cwtch-panel[data-open="true"]{display:flex;animation:cwtch-in .18s ease-out}
        @keyframes cwtch-in{from{opacity:0;transform:translateY(8px) scale(.985)}to{opacity:1;transform:none}}
        .cwtch-head{display:flex;align-items:center;gap:11px;padding:15px 16px 12px;border-bottom:1px solid var(--line)}
        .cwtch-brand{display:flex;align-items:center;gap:9px;min-width:0}.cwtch-brand img{width:29px;height:29px}.cwtch-brand strong{font-family:Georgia,"Times New Roman",serif;font-size:23px;font-weight:500;letter-spacing:-.02em}.cwtch-brand small{display:block;color:var(--muted);font-size:10px;letter-spacing:.08em;text-transform:uppercase;margin-top:1px}
        .cwtch-spacer{flex:1}.icon-btn{width:34px;height:34px;border-radius:11px;border:1px solid var(--line);background:rgba(255,255,255,.04);color:var(--cream);display:grid;place-items:center}.icon-btn:hover{background:rgba(255,255,255,.09)}
        .cwtch-tabs{display:grid;grid-template-columns:repeat(4,1fr);padding:8px 10px;border-bottom:1px solid var(--line);gap:4px}
        .cwtch-tab{border:0;background:transparent;color:#9f929b;padding:9px 4px;border-radius:10px;font-size:12px}.cwtch-tab[data-active="true"]{color:var(--cream);background:rgba(255,255,255,.08)}
        .cwtch-body{position:relative;flex:1;overflow:auto;padding:15px;scrollbar-width:thin;scrollbar-color:#5c4353 transparent}
        .view{display:none}.view[data-active="true"]{display:block}
        .eyebrow{font-size:10px;text-transform:uppercase;letter-spacing:.15em;color:#bdaeb7;margin-bottom:7px}
        h2,h3,p{margin:0}.room-title{font-family:Georgia,"Times New Roman",serif;font-weight:500;font-size:27px;line-height:1.05;letter-spacing:-.025em}.subtitle{font-size:12px;color:#b6a8b1;line-height:1.45;margin-top:7px}
        .status-card{padding:14px;border:1px solid var(--line);background:rgba(255,255,255,.035);border-radius:18px;margin-bottom:12px}.status-line{display:flex;align-items:center;gap:8px}.status-orb{width:8px;height:8px;border-radius:50%;background:#777}.status-orb[data-state="joined"]{background:#6fd39c;box-shadow:0 0 0 5px rgba(111,211,156,.1)}.status-orb[data-state="connecting"],.status-orb[data-state="reconnecting"]{background:#e8bf6a}.status-orb[data-state="error"]{background:#ef7a7a}.status-text{font-size:12px;font-weight:650}.status-meta{margin-left:auto;font-size:11px;color:#a99ba5}
        .pair{display:grid;grid-template-columns:1fr 34px 1fr;align-items:center;margin-top:13px}.person{text-align:center}.avatar{width:52px;height:52px;border-radius:50%;margin:0 auto 7px;display:grid;place-items:center;background:linear-gradient(145deg,#6a3c56,#3b1f32);border:1px solid rgba(255,255,255,.2);font-family:Georgia,serif;font-size:20px}.person-name{font-size:11px;color:#cfc4ca;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.pair-heart{text-align:center;color:#df8c91;font-size:19px}
        .button-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px}.primary,.secondary,.danger{border-radius:13px;padding:11px 12px;font-size:12px;font-weight:700}.primary{border:0;color:#24121f;background:linear-gradient(135deg,#efaaa4,#c56a6f)}.primary:hover{filter:brightness(1.05)}.secondary{color:var(--cream);border:1px solid var(--line);background:rgba(255,255,255,.045)}.secondary:hover{background:rgba(255,255,255,.09)}.danger{color:#f1b2b2;border:1px solid rgba(239,122,122,.25);background:rgba(239,122,122,.07)}
        .section{margin-top:16px}.section-head{display:flex;align-items:center;margin-bottom:9px}.section-head h3{font-size:12px;font-weight:700}.section-head small{margin-left:auto;color:#8f828b;font-size:10px}
        .reactions{display:grid;grid-template-columns:repeat(6,1fr);gap:6px}.reaction-btn{height:40px;border:1px solid var(--line);border-radius:12px;background:rgba(255,255,255,.04);color:white;font-size:19px}.reaction-btn:hover{background:rgba(197,106,111,.16);transform:translateY(-1px)}
        .prompt{border:1px solid rgba(197,106,111,.2);background:linear-gradient(135deg,rgba(197,106,111,.11),rgba(255,255,255,.03));border-radius:17px;padding:13px}.prompt p{font-family:Georgia,"Times New Roman",serif;font-size:16px;line-height:1.35;color:#f3e9e3}.prompt button{margin-top:11px}
        .empty{padding:35px 12px;text-align:center;color:#9f929b}.empty strong{display:block;color:#d7ccd2;font-size:13px;margin-bottom:5px}.empty p{font-size:11px;line-height:1.5}
        .chat-list,.moment-list,.fix-list{display:flex;flex-direction:column;gap:9px}.bubble{max-width:86%;border-radius:15px 15px 15px 5px;padding:9px 11px;background:rgba(255,255,255,.075);align-self:flex-start}.bubble[data-self="true"]{align-self:flex-end;border-radius:15px 15px 5px 15px;background:rgba(197,106,111,.2)}.bubble-meta{display:flex;gap:7px;color:#aa9da5;font-size:9px;margin-bottom:4px}.bubble-text{font-size:12px;line-height:1.4;color:#f4ece8;white-space:pre-wrap;overflow-wrap:anywhere}
        .composer{display:grid;grid-template-columns:1fr auto;gap:7px;position:sticky;bottom:-15px;background:linear-gradient(transparent,#121014 27%);padding-top:22px;padding-bottom:1px}.composer input{min-width:0;border:1px solid var(--line);background:#211921;color:white;border-radius:13px;padding:11px 12px;outline:none}.composer input:focus{border-color:rgba(235,199,194,.55)}.composer button{width:43px;border:0;border-radius:13px;background:#c56a6f;color:#1d1018;font-weight:900}
        .moment-composer{display:grid;gap:8px;margin-bottom:12px;padding:12px;border:1px solid var(--line);border-radius:16px;background:rgba(255,255,255,.035)}.moment-composer input{width:100%;border:1px solid var(--line);background:#211921;color:white;border-radius:12px;padding:10px 11px;outline:none}.moment-composer input:focus{border-color:rgba(235,199,194,.55)}
        .moment{padding:11px 12px;border:1px solid var(--line);background:rgba(255,255,255,.035);border-radius:15px}.moment-top{display:flex;gap:8px;align-items:center}.timestamp{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#edaaa5;font-size:11px}.moment-by{margin-left:auto;color:#8e828a;font-size:9px}.moment-note{font-family:Georgia,serif;font-size:14px;line-height:1.35;margin-top:7px;color:#eee3de}
        .fix{padding:11px 12px;border:1px solid var(--line);background:rgba(255,255,255,.035);border-radius:15px}.fix[data-severity="error"]{border-color:rgba(239,122,122,.28)}.fix-code{display:flex;gap:7px;align-items:center;font-size:10px;color:#d49aa0;font-family:ui-monospace,monospace}.fix-time{margin-left:auto;color:#786b74}.fix-message{font-size:12px;font-weight:650;margin-top:6px}.fix-action{font-size:11px;line-height:1.45;color:#bcaeb7;margin-top:5px}.metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:7px;margin-bottom:12px}.metric{border:1px solid var(--line);background:rgba(255,255,255,.03);border-radius:13px;padding:10px}.metric strong{display:block;font-size:13px}.metric span{font-size:9px;text-transform:uppercase;letter-spacing:.08em;color:#8d8089}
        .test-row{display:flex;gap:8px;padding:8px 0;border-bottom:1px solid rgba(255,255,255,.06);font-size:11px}.test-ok{color:#6fd39c}.test-bad{color:#ef8d8d}.test-detail{margin-left:auto;color:#90838b;text-align:right;max-width:55%}
        .toast{position:absolute;left:16px;right:16px;bottom:16px;padding:11px 13px;border-radius:13px;background:#f7e4dc;color:#25131f;font-size:11px;font-weight:650;box-shadow:0 12px 35px rgba(0,0,0,.35);opacity:0;transform:translateY(8px);pointer-events:none;transition:.18s}.toast[data-show="true"]{opacity:1;transform:none}
        .floating-reaction{position:fixed;right:74px;bottom:110px;font-size:34px;pointer-events:none;animation:float-heart 1.8s ease-out forwards;text-shadow:0 8px 25px rgba(0,0,0,.4)}@keyframes float-heart{0%{opacity:0;transform:translateY(16px) scale(.7)}20%{opacity:1}100%{opacity:0;transform:translateY(-120px) rotate(8deg) scale(1.2)}}
        .mismatch{display:none;padding:12px;border-radius:15px;border:1px solid rgba(232,191,106,.25);background:rgba(232,191,106,.08);margin-bottom:12px}.mismatch[data-show="true"]{display:block}.mismatch strong{font-size:12px}.mismatch p{font-size:11px;color:#bfaeaa;line-height:1.4;margin:5px 0 9px}
        @media(max-width:520px){.cwtch-trigger{right:12px;bottom:12px}.cwtch-panel{right:12px;bottom:76px;height:min(650px,calc(100vh - 92px))}}
        @media(prefers-reduced-motion:reduce){*,*:before,*:after{animation:none!important;transition:none!important}}
      `;
    }

    template() {
      const logo = chrome.runtime.getURL("assets/logo.svg");
      return `
        <button class="cwtch-trigger" aria-label="Open Cwtch" aria-expanded="false"><img src="${logo}" alt=""><span class="cwtch-dot" data-state="idle"></span></button>
        <section class="cwtch-panel" role="dialog" aria-label="Cwtch watch party" data-open="false">
          <header class="cwtch-head">
            <div class="cwtch-brand"><img src="${logo}" alt=""><div><strong>Cwtch</strong><small>watch parties for two</small></div></div>
            <div class="cwtch-spacer"></div>
            <button class="icon-btn" data-action="settings" aria-label="Open settings">⚙</button>
            <button class="icon-btn" data-action="close" aria-label="Close Cwtch">×</button>
          </header>
          <nav class="cwtch-tabs" aria-label="Cwtch sections">
            <button class="cwtch-tab" data-tab="room" data-active="true">Room</button>
            <button class="cwtch-tab" data-tab="chat">Chat</button>
            <button class="cwtch-tab" data-tab="moments">Moments</button>
            <button class="cwtch-tab" data-tab="fixes">Fixes</button>
          </nav>
          <main class="cwtch-body">
            <section class="view" data-view="room" data-active="true">
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
              <div class="button-grid">
                <button class="primary" data-action="copy">Copy invite</button>
                <button class="secondary" data-action="resync">Resync</button>
                <button class="secondary" data-action="resume">Resume together</button>
                <button class="danger" data-action="leave">Leave room</button>
              </div>
              <div class="section"><div class="section-head"><h3>Say it without interrupting</h3><small>quiet reactions</small></div><div class="reactions">${C.REACTIONS.map((r) => `<button class="reaction-btn" data-reaction="${r}" aria-label="Send ${r}">${r}</button>`).join("")}</div></div>
              <div class="section"><div class="section-head"><h3>A small nudge</h3><small>for the other tab</small></div><button class="secondary" style="width:100%" data-action="nudge">Send “I’m here”</button></div>
              <div class="section prompt"><div class="eyebrow">Date-night card</div><p data-role="prompt-copy">${C.DATE_PROMPTS[0]}</p><button class="secondary" data-action="new-prompt">Another card</button></div>
            </section>
            <section class="view" data-view="chat"><div class="chat-list" data-role="chat-list"></div><form class="composer" data-role="chat-form"><input maxlength="500" autocomplete="off" placeholder="Say something…" aria-label="Chat message"><button aria-label="Send message">↗</button></form></section>
            <section class="view" data-view="moments"><form class="moment-composer" data-role="moment-form"><input maxlength="180" autocomplete="off" placeholder="Why keep it? (optional)" aria-label="Moment note"><button class="primary" type="submit">Keep current moment</button></form><div class="moment-list" data-role="moment-list"></div></section>
            <section class="view" data-view="fixes"><div class="metrics" data-role="metrics"></div><div class="button-grid" style="margin:0 0 12px"><button class="primary" data-action="checks">Run checks</button><button class="secondary" data-action="report">Download report</button></div><div data-role="test-results"></div><div class="fix-list" data-role="fix-list"></div></section>
            <div class="toast" data-role="toast"></div>
          </main>
        </section>
      `;
    }

    bind() {
      const q = (selector) => this.shadow.querySelector(selector);
      q(".cwtch-trigger").addEventListener("click", () => this.toggle());
      this.shadow.addEventListener("click", (event) => {
        const button = event.target.closest("button");
        if (!button) return;
        const tab = button.dataset.tab;
        if (tab) return this.setTab(tab);
        const action = button.dataset.action;
        if (action === "close") return this.close();
        if (action === "settings") return C.utils.emit(this, "settings");
        if (action === "copy") return C.utils.emit(this, "copy-invite");
        if (action === "resync") return C.utils.emit(this, "resync");
        if (action === "resume") return C.utils.emit(this, "resume");
        if (action === "leave") return C.utils.emit(this, "leave");
        if (action === "nudge") return C.utils.emit(this, "nudge");
        if (action === "moment") return C.utils.emit(this, "moment");
        if (action === "checks") return C.utils.emit(this, "checks");
        if (action === "report") return C.utils.emit(this, "report");
        if (action === "follow") return C.utils.emit(this, "follow", { content: this.state.pendingContent });
        if (action === "new-prompt") return this.nextPrompt();
        if (button.dataset.reaction) C.utils.emit(this, "reaction", { reaction: button.dataset.reaction });
      });
      q('[data-role="chat-form"]').addEventListener("submit", (event) => {
        event.preventDefault();
        const input = event.currentTarget.querySelector("input");
        const text = C.utils.sanitizeText(input.value, 500);
        if (!text) return;
        C.utils.emit(this, "chat", { text });
        input.value = "";
      });
      q('[data-role="moment-form"]').addEventListener("submit", (event) => {
        event.preventDefault();
        const input = event.currentTarget.querySelector("input");
        const note = C.utils.sanitizeText(input.value, 180);
        C.utils.emit(this, "moment", { note });
        input.value = "";
      });
      this.shadow.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && this.panelOpen) this.close();
      });
    }

    syncFullscreenParent() {
      if (!this.host) return;
      const fullscreen = document.fullscreenElement;
      if (fullscreen && fullscreen.tagName !== "VIDEO") {
        if (this.host.parentNode !== fullscreen) fullscreen.appendChild(this.host);
      } else if (this.host.parentNode !== document.documentElement) {
        document.documentElement.appendChild(this.host);
      }
    }

    q(selector) { return this.shadow.querySelector(selector); }

    open(tab) {
      this.panelOpen = true;
      this.q(".cwtch-panel").dataset.open = "true";
      this.q(".cwtch-trigger").setAttribute("aria-expanded", "true");
      if (tab) this.setTab(tab);
    }

    close() {
      this.panelOpen = false;
      this.q(".cwtch-panel").dataset.open = "false";
      this.q(".cwtch-trigger").setAttribute("aria-expanded", "false");
    }

    toggle() { this.panelOpen ? this.close() : this.open(); }

    setTab(tab) {
      this.activeTab = tab;
      for (const button of this.shadow.querySelectorAll("[data-tab]")) button.dataset.active = String(button.dataset.tab === tab);
      for (const view of this.shadow.querySelectorAll("[data-view]")) view.dataset.active = String(view.dataset.view === tab);
      if (tab === "fixes") this.renderDiagnostics();
    }

    update(patch) {
      Object.assign(this.state, patch);
      this.render();
    }

    render() {
      if (!this.shadow) return;
      const status = this.state.status || "idle";
      this.q(".cwtch-dot").dataset.state = status;
      this.q('[data-role="status-orb"]').dataset.state = status;
      const statusLabels = {
        idle: "Not in a room",
        connecting: "Connecting…",
        reconnecting: "Reconnecting…",
        joined: this.state.occupants >= 2 ? "Together" : "Waiting for your person",
        error: "Needs attention",
        closed: "Room closed"
      };
      this.q('[data-role="status-text"]').textContent = statusLabels[status] || status;
      const latency = Number.isFinite(this.state.latencyMs) ? `${Math.round(this.state.latencyMs)} ms` : this.platform.name;
      this.q('[data-role="status-meta"]').textContent = latency;
      const self = this.state.participants.find((p) => p.self) || { name: "You" };
      const peer = this.state.participants.find((p) => !p.self);
      this.q('[data-role="self-name"]').textContent = self.name || "You";
      this.q('[data-role="self-avatar"]').textContent = this.initials(self.name || "You");
      this.q('[data-role="peer-name"]').textContent = peer?.name || "Waiting…";
      this.q('[data-role="peer-avatar"]').textContent = peer ? this.initials(peer.name) : "?";
      this.q('[data-role="room-eyebrow"]').textContent = this.state.room ? `${this.platform.name} · ${this.state.occupants}/2` : this.platform.name;
      this.q('[data-role="room-title"]').textContent = this.state.room?.name || (this.state.mediaReady ? "Ready when you are." : "Start a video first.");
      this.q('[data-role="room-subtitle"]').textContent = this.state.room
        ? this.state.title
        : "The film stays on this site. Cwtch only synchronizes controls and private room messages.";
      const roomActions = this.shadow.querySelectorAll('[data-action="copy"],[data-action="resync"],[data-action="resume"],[data-action="leave"],[data-action="nudge"],[data-reaction],[data-role="moment-form"] input,[data-role="moment-form"] button');
      for (const control of roomActions) control.disabled = !this.state.room;
      const resyncButton = this.q('[data-action="resync"]');
      if (resyncButton) resyncButton.textContent = status === "joined" ? "Resync" : "Retry relay";
      const mismatch = this.q('[data-role="mismatch"]');
      mismatch.dataset.show = String(Boolean(this.state.pendingContent));
      if (this.state.pendingContent) this.q('[data-role="mismatch-copy"]').textContent = `${this.state.pendingContent.person || "Your person"} opened “${this.state.pendingContent.title || "another title"}”.`;
      this.renderMessages();
      this.renderMoments();
      this.renderDiagnostics();
    }

    initials(name) {
      return C.utils.sanitizeText(name, 30).split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "?";
    }

    addMessage(message) {
      this.messages.push(message);
      if (this.messages.length > 100) this.messages.shift();
      this.renderMessages();
    }

    renderMessages() {
      const list = this.q('[data-role="chat-list"]');
      if (!list) return;
      list.textContent = "";
      if (!this.messages.length) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.innerHTML = "<strong>No running commentary required.</strong><p>Use chat when a look across the room would normally be enough.</p>";
        list.appendChild(empty);
        return;
      }
      for (const message of this.messages) {
        const bubble = document.createElement("article");
        bubble.className = "bubble";
        bubble.dataset.self = String(Boolean(message.self));
        const meta = document.createElement("div");
        meta.className = "bubble-meta";
        const sender = document.createElement("span");
        sender.textContent = message.name;
        const time = document.createElement("span");
        time.textContent = new Date(message.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        meta.append(sender, time);
        const text = document.createElement("div");
        text.className = "bubble-text";
        text.textContent = message.text;
        bubble.append(meta, text);
        list.appendChild(bubble);
      }
      list.scrollTop = list.scrollHeight;
    }

    addMoment(moment) {
      this.moments.push(moment);
      if (this.moments.length > 80) this.moments.shift();
      this.renderMoments();
    }

    renderMoments() {
      const list = this.q('[data-role="moment-list"]');
      if (!list) return;
      list.textContent = "";
      if (!this.moments.length) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.innerHTML = "<strong>Nothing kept yet.</strong><p>Save a timestamp when a scene feels worth returning to.</p>";
        list.appendChild(empty);
        return;
      }
      for (const moment of [...this.moments].reverse()) {
        const card = document.createElement("article");
        card.className = "moment";
        const top = document.createElement("div");
        top.className = "moment-top";
        const timestamp = document.createElement("span");
        timestamp.className = "timestamp";
        timestamp.textContent = C.utils.formatTime(moment.at);
        const by = document.createElement("span");
        by.className = "moment-by";
        by.textContent = moment.name;
        top.append(timestamp, by);
        const note = document.createElement("div");
        note.className = "moment-note";
        note.textContent = moment.note || "Keep this moment.";
        card.append(top, note);
        list.appendChild(card);
      }
    }

    showReaction(reaction) {
      const node = document.createElement("div");
      node.className = "floating-reaction";
      node.textContent = reaction;
      this.shadow.appendChild(node);
      setTimeout(() => node.remove(), 1900);
    }

    showNudge(name) {
      this.showToast(`${name || "Your person"} says: I’m here.`);
      this.open("room");
    }

    nextPrompt() {
      const current = this.q('[data-role="prompt-copy"]').textContent;
      const options = C.DATE_PROMPTS.filter((prompt) => prompt !== current);
      this.q('[data-role="prompt-copy"]').textContent = options[Math.floor(Math.random() * options.length)];
    }

    showToast(message) {
      const toast = this.q('[data-role="toast"]');
      toast.textContent = message;
      toast.dataset.show = "true";
      clearTimeout(this.toastTimer);
      this.toastTimer = setTimeout(() => { toast.dataset.show = "false"; }, 2600);
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
        [this.diagnostics.metrics.connected ? "Online" : "Offline", "Relay"],
        [Number.isFinite(this.diagnostics.metrics.latencyMs) ? `${this.diagnostics.metrics.latencyMs} ms` : "—", "Latency"],
        [Number.isFinite(this.diagnostics.metrics.driftSeconds) ? `${this.diagnostics.metrics.driftSeconds}s` : "—", "Drift"]
      ];
      metrics.textContent = "";
      for (const [value, label] of values) {
        const node = document.createElement("div");
        node.className = "metric";
        const strong = document.createElement("strong"); strong.textContent = value;
        const span = document.createElement("span"); span.textContent = label;
        node.append(strong, span); metrics.appendChild(node);
      }
      const tests = this.q('[data-role="test-results"]');
      tests.textContent = "";
      if (this.selfTestResults.length) {
        for (const result of this.selfTestResults) {
          const row = document.createElement("div"); row.className = "test-row";
          const mark = document.createElement("span"); mark.className = result.ok ? "test-ok" : "test-bad"; mark.textContent = result.ok ? "●" : "●";
          const name = document.createElement("span"); name.textContent = result.name;
          const detail = document.createElement("span"); detail.className = "test-detail"; detail.textContent = result.detail;
          row.append(mark, name, detail); tests.appendChild(row);
        }
        tests.style.marginBottom = "12px";
      }
      const list = this.q('[data-role="fix-list"]');
      list.textContent = "";
      if (!this.diagnostics.entries.length) {
        const empty = document.createElement("div"); empty.className = "empty";
        empty.innerHTML = "<strong>No known problems.</strong><p>Run checks before a date night or whenever a streaming site changes its player.</p>";
        list.appendChild(empty); return;
      }
      for (const entry of this.diagnostics.entries.slice(0, 30)) {
        const card = document.createElement("article"); card.className = "fix"; card.dataset.severity = entry.severity;
        const code = document.createElement("div"); code.className = "fix-code";
        const label = document.createElement("span"); label.textContent = entry.code;
        const time = document.createElement("span"); time.className = "fix-time"; time.textContent = new Date(entry.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        code.append(label, time);
        const message = document.createElement("div"); message.className = "fix-message"; message.textContent = entry.message;
        const action = document.createElement("div"); action.className = "fix-action"; action.textContent = entry.fix;
        card.append(code, message, action); list.appendChild(card);
      }
    }
  }

  C.CwtchUI = CwtchUI;
})();
