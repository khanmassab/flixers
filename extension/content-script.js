const PlayerSync = (() => {
  let video = null;
  let suppressNext = false;
  let observer = null;

  const attach = () => {
    const candidate = document.querySelector("video");
    if (!candidate || candidate === video) return;
    video = candidate;
    wirePlayer(video);
  };

  const wirePlayer = (el) => {
    ["play", "pause", "seeking", "ratechange"].forEach((evt) => {
      el.addEventListener(evt, handlePlayerEvent, { passive: true });
    });
    el.addEventListener("timeupdate", throttle(handleTimeUpdate, 250), {
      passive: true,
    });
  };

  const handlePlayerEvent = () => {
    sendState("event");
  };

  const handleTimeUpdate = () => {
    sendState("time");
  };

  const sendState = (reason) => {
    if (!video || suppressNext) return;
    chrome.runtime.sendMessage({
      type: "player-event",
      payload: serializeState(reason),
    });
  };

  const serializeState = (reason) => ({
    t: video.currentTime,
    paused: video.paused,
    rate: video.playbackRate,
    reason,
    ts: Date.now(),
  });

  const applyState = (payload) => {
    if (!video) return;
    suppressNext = true;
    if (Math.abs(video.currentTime - payload.t) > 0.5) {
      video.currentTime = payload.t;
    }
    if (payload.rate && video.playbackRate !== payload.rate) {
      video.playbackRate = payload.rate;
    }
    if (payload.paused !== undefined) {
      payload.paused ? video.pause() : video.play();
    }
    suppressNext = false;
  };

  const startObserving = () => {
    observer = new MutationObserver(() => attach());
    observer.observe(document.body, { childList: true, subtree: true });
    attach();
  };

  return { start: startObserving, applyState };
})();

const Overlay = (() => {
  let container;
  let messagesEl;
  let presenceEl;
  let statusEl;
  let roomLabelEl;
  let inputEl;
  let toggleBtn;
  let pillEl;
  let toastStack;
  let roomInfo = { roomId: null, name: "Guest" };

  const init = () => {
    injectStyles();
    container = document.createElement("div");
    container.className = "flixers-overlay";
    container.innerHTML = `
      <div class="flixers-panel">
        <div class="flixers-header">
          <div>
            <div class="flixers-title">Flixers</div>
            <div class="flixers-room" id="flixers-room">Not joined</div>
          </div>
          <div class="flixers-pill flixers-pill--idle" id="flixers-connection">Idle</div>
        </div>
        <div class="flixers-meta">
          <div class="flixers-presence-title">People</div>
          <div class="flixers-chips" id="flixers-presence"></div>
        </div>
        <div class="flixers-status" id="flixers-status">Connection: idle</div>
        <div class="flixers-messages" id="flixers-messages"></div>
        <form class="flixers-input-row" id="flixers-form">
          <input id="flixers-input" type="text" placeholder="Send a message" autocomplete="off" />
          <button type="submit">Send</button>
        </form>
      </div>
      <div class="flixers-toast-stack" id="flixers-toast-stack"></div>
      <button class="flixers-toggle" aria-label="Toggle overlay">Flixers</button>
    `;
    document.body.appendChild(container);
    messagesEl = container.querySelector("#flixers-messages");
    presenceEl = container.querySelector("#flixers-presence");
    statusEl = container.querySelector("#flixers-status") || null;
    roomLabelEl = container.querySelector("#flixers-room");
    inputEl = container.querySelector("#flixers-input");
    toggleBtn = container.querySelector(".flixers-toggle");
    pillEl = container.querySelector("#flixers-connection");
    toastStack = container.querySelector("#flixers-toast-stack");

    container.querySelector("form").addEventListener("submit", onSend);
    toggleBtn.addEventListener("click", togglePanel);
  };

  const onSend = (e) => {
    e.preventDefault();
    const text = inputEl.value.trim();
    if (!text || !roomInfo.roomId) return;
    inputEl.value = "";
    chrome.runtime.sendMessage({ type: "chat", text });
    pushMessage(roomInfo.name || "You", text, Date.now());
  };

  const pushMessage = (from, text, ts) => {
    const el = document.createElement("div");
    el.className = "flixers-message";
    const time = ts
      ? new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : "";
    el.innerHTML = `
      <div class="flixers-message-meta">
        <span class="flixers-from">${from}</span>
        ${time ? `<span class="flixers-time">${time}</span>` : ""}
      </div>
      <div class="flixers-message-body">${escapeHtml(text || "")}</div>
    `;
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  };

  const setPresence = (users, roomId) => {
    presenceEl.innerHTML = "";
    if (!users || users.length === 0 || !roomId) {
      presenceEl.innerHTML = `<span class="flixers-chip">No one online</span>`;
      return;
    }
    users.forEach((u) => {
      const chip = document.createElement("span");
      chip.className = "flixers-chip";
      chip.textContent = u;
      presenceEl.appendChild(chip);
    });
  };

  const setStatus = (text) => {
    if (statusEl) statusEl.textContent = text;
  };

  const setRoom = (roomId, name) => {
    roomInfo = { roomId, name: name || "Guest" };
    roomLabelEl.textContent = roomId
      ? `Room ${roomId} — ${roomInfo.name}`
      : "Not joined";
    if (!roomId) {
      setPresence([], null);
    }
  };

  const setConnection = (status) => {
    const ok = status === "connected";
    const cls = ok ? "flixers-pill--ok" : status === "connecting" ? "flixers-pill--warm" : "flixers-pill--bad";
    pillEl.textContent = status;
    pillEl.className = `flixers-pill ${cls}`;
  };

  const togglePanel = () => {
    container.classList.toggle("flixers-hidden");
  };

  const showToast = (text, variant = "info") => {
    const toast = document.createElement("div");
    toast.className = `flixers-toast flixers-toast--${variant}`;
    toast.textContent = text;
    toastStack.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add("show"));
    setTimeout(() => {
      toast.classList.remove("show");
      setTimeout(() => toast.remove(), 180);
    }, 2600);
  };

  const injectStyles = () => {
    if (document.getElementById("flixers-styles")) return;
    const style = document.createElement("style");
    style.id = "flixers-styles";
    style.textContent = `
      .flixers-overlay { position: fixed; bottom: 24px; right: 24px; z-index: 999999; font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #f8fafc; }
      .flixers-panel { width: 300px; background: rgba(10, 12, 20, 0.9); border: 1px solid rgba(255,255,255,0.06); border-radius: 14px; box-shadow: 0 18px 48px rgba(0,0,0,0.4); padding: 14px; backdrop-filter: blur(12px); }
      .flixers-header { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
      .flixers-title { font-weight: 700; letter-spacing: 0.5px; font-size: 15px; }
      .flixers-room { font-size: 12px; color: #cbd5e1; }
      .flixers-pill { padding: 6px 12px; border-radius: 999px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; border: 1px solid rgba(255,255,255,0.08); }
      .flixers-pill--idle { background: #161d2e; color: #9aa5c4; }
      .flixers-pill--ok { background: rgba(110, 242, 196, 0.2); border-color: #6ef2c4; color: #6ef2c4; }
      .flixers-pill--bad { background: rgba(255, 111, 97, 0.15); border-color: #ff6f61; color: #ff6f61; }
      .flixers-pill--warm { background: rgba(255, 178, 122, 0.14); border-color: #ffb27a; color: #ffb27a; }
      .flixers-meta { margin: 10px 0 6px; }
      .flixers-presence-title { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: #9aa5c4; margin-bottom: 6px; }
      .flixers-chips { display: flex; flex-wrap: wrap; gap: 6px; }
      .flixers-chip { padding: 6px 10px; border-radius: 999px; border: 1px solid rgba(255,255,255,0.08); background: rgba(255,255,255,0.04); font-size: 12px; color: #f8fafc; }
      .flixers-status { font-size: 11px; color: #cbd5e1; margin: 6px 0 10px; letter-spacing: 0.01em; }
      .flixers-messages { height: 180px; overflow-y: auto; border: 1px solid rgba(255,255,255,0.06); border-radius: 10px; padding: 10px; background: rgba(6,10,20,0.6); font-size: 12px; display: flex; flex-direction: column; gap: 8px; }
      .flixers-message { padding: 8px 10px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.06); background: rgba(255,255,255,0.03); box-shadow: 0 8px 24px rgba(0,0,0,0.32); }
      .flixers-message-meta { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; color: #a5b4fc; font-size: 11px; }
      .flixers-from { font-weight: 700; color: #ffb86c; }
      .flixers-time { color: #94a3b8; }
      .flixers-message-body { color: #f8fafc; line-height: 1.4; }
      .flixers-input-row { display: grid; grid-template-columns: 1fr 70px; gap: 8px; margin-top: 10px; }
      .flixers-input-row input { border-radius: 10px; border: 1px solid rgba(255,255,255,0.14); background: rgba(255,255,255,0.06); color: #f8fafc; padding: 10px; }
      .flixers-input-row button { border: none; border-radius: 10px; background: linear-gradient(135deg, #ff6f61, #ffb27a); color: #0f1117; font-weight: 700; cursor: pointer; }
      .flixers-toggle { margin-top: 10px; width: 100%; background: rgba(255,255,255,0.08); color: #f8fafc; border: 1px solid rgba(255,255,255,0.12); border-radius: 10px; padding: 8px; cursor: pointer; }
      .flixers-hidden .flixers-panel { display: none; }
      .flixers-toast-stack { position: absolute; bottom: -8px; right: 0; display: flex; flex-direction: column; gap: 8px; pointer-events: none; }
      .flixers-toast { min-width: 200px; background: rgba(10,12,20,0.95); border: 1px solid rgba(255,255,255,0.1); color: #f8fafc; padding: 10px 12px; border-radius: 10px; box-shadow: 0 10px 30px rgba(0,0,0,0.35); opacity: 0; transform: translateY(6px); transition: opacity 0.2s ease, transform 0.2s ease; }
      .flixers-toast.show { opacity: 1; transform: translateY(0); }
      .flixers-toast--info { border-color: #6ef2c4; }
      .flixers-toast--warn { border-color: #ff6f61; }
    `;
    document.head.appendChild(style);
  };

  return {
    init,
    pushMessage,
    setPresence,
    setStatus,
    setRoom,
    setConnection,
    showToast,
    getName: () => roomInfo.name || "Guest",
  };
})();

PlayerSync.start();
Overlay.init();

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "apply-state") {
    PlayerSync.applyState(message.payload);
  }
  if (message.type === "chat") {
    Overlay.pushMessage(message.from || "Anon", message.text || "", message.ts);
    if ((message.from || "").toLowerCase() !== (Overlay.getName() || "").toLowerCase()) {
      Overlay.showToast(`${message.from || "Someone"} sent a message`, "info");
    }
  }
  if (message.type === "presence") {
    Overlay.setPresence(message.users || [], message.roomId);
  }
  if (message.type === "ws-status") {
    Overlay.setStatus(`Connection: ${message.status}`);
    Overlay.setConnection(message.status);
    if (message.status !== "connected") {
      Overlay.showToast("Reconnecting…", "warn");
    } else {
      Overlay.showToast("Connected", "info");
    }
  }
});

chrome.runtime.sendMessage({ type: "get-room" }, (res) => {
  Overlay.setRoom(res?.roomId || null, res?.name || "Guest");
});

// Simple throttle to limit chatter back to the background script.
function throttle(fn, delay) {
  let last = 0;
  return (...args) => {
    const now = Date.now();
    if (now - last < delay) return;
    last = now;
    fn(...args);
  };
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (ch) => {
    const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return map[ch] || ch;
  });
}
