const BACKEND_HTTP = "http://localhost:4000";
const BACKEND_WS = "ws://localhost:4000/ws";

let ws;
let currentRoom = null;
let displayName = "Guest";
let retryTimer = null;
let session = null;
let hasNetflixPlayer = false;

chrome.storage.local.get(["flixersSession"]).then((res) => {
  if (res.flixersSession) {
    session = res.flixersSession;
    displayName = session.profile?.name || "Guest";
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case "join-room":
      handleJoin(message.roomId, message.name, message.token);
      sendResponse({ ok: true, roomId: message.roomId });
      return true;
    case "leave-room":
      teardownSocket();
      currentRoom = null;
      sendToNetflixTabs({ type: "room-update", roomId: null, name: displayName });
      sendResponse({ ok: true });
      return true;
    case "player-event":
      forwardState(message.payload);
      return true;
    case "chat":
      sendChat(message.text);
      return true;
    case "get-room":
      sendResponse({ roomId: currentRoom, name: displayName });
      return true;
    case "auth-set":
      session = message.session;
      displayName = session?.profile?.name || "Guest";
      chrome.storage.local.set({ flixersSession: session || null });
      broadcastPopup({ type: "auth", session });
      return true;
    case "auth-clear":
      session = null;
      displayName = "Guest";
      teardownSocket();
      currentRoom = null;
      chrome.storage.local.remove(["flixersSession"]);
      broadcastPopup({ type: "auth", session: null });
      broadcastPopup({ type: "ws-status", status: "disconnected" });
      return true;
    case "auth-get":
      sendResponse({ session });
      return true;
    case "player-present":
      hasNetflixPlayer = true;
      broadcastPopup({ type: "player-present", present: true });
      return true;
    case "player-status":
      sendResponse({ present: hasNetflixPlayer });
      return true;
    default:
      return false;
  }
});

function handleJoin(roomId, name, token) {
  if (token) {
    session = session || {};
    session.token = token;
  }
  if (!session || !session.token) {
    broadcastPopup({ type: "ws-status", status: "auth-required" });
    return;
  }
  displayName = name || session?.profile?.name || "Guest";
  currentRoom = roomId;
  sendToNetflixTabs({ type: "room-update", roomId, name: displayName });
  connectSocket();
}

function connectSocket() {
  teardownSocket();
  if (!currentRoom) return;
  if (!session || !session.token) {
    broadcastPopup({ type: "ws-status", status: "auth-required" });
    return;
  }

  const url = `${BACKEND_WS}?roomId=${encodeURIComponent(
    currentRoom
  )}&token=${encodeURIComponent(session.token)}`;

  ws = new WebSocket(url);

  ws.addEventListener("open", () => {
    clearTimeout(retryTimer);
    broadcastPopup({ type: "ws-status", status: "connected" });
    sendToNetflixTabs({ type: "ws-status", status: "connected" });
  });

  ws.addEventListener("message", (event) => {
    try {
      const payload = JSON.parse(event.data);
      routeIncoming(payload);
    } catch (err) {
      console.warn("Bad WS message", err);
    }
  });

  ws.addEventListener("close", () => {
    scheduleReconnect();
  });

  ws.addEventListener("error", () => {
    scheduleReconnect();
  });
}

function teardownSocket() {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  if (ws) {
    ws.close();
    ws = null;
  }
}

function scheduleReconnect() {
  broadcastPopup({ type: "ws-status", status: "disconnected" });
  sendToNetflixTabs({ type: "ws-status", status: "disconnected" });
  if (!currentRoom || retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    connectSocket();
  }, 1500);
}

function routeIncoming(message) {
  if (message.type === "state") {
    sendToNetflixTabs({ type: "apply-state", payload: message.payload });
  }
  if (message.type === "chat") {
    broadcastPopup({ type: "chat", from: message.from, text: message.text, ts: message.ts });
    sendToNetflixTabs({ type: "chat", from: message.from, text: message.text, ts: message.ts });
  }
  if (message.type === "presence") {
    broadcastPopup({
      type: "presence",
      users: message.users || [],
      roomId: currentRoom,
    });
    sendToNetflixTabs({
      type: "presence",
      users: message.users || [],
      roomId: currentRoom,
    });
  }
}

function forwardState(payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(
    JSON.stringify({
      type: "state",
      payload,
    })
  );
}

function sendChat(text) {
  if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(
    JSON.stringify({
      type: "chat",
      text,
    })
  );
}

function broadcastPopup(msg) {
  chrome.runtime.sendMessage(msg, () => {
    // Service workers ignore errors when no listener is present.
  });
}

chrome.tabs.onRemoved.addListener(() => checkNetflixTabs());
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.url && tab.url.includes("netflix.com")) {
    checkNetflixTabs();
  }
});

function checkNetflixTabs() {
  chrome.tabs
    .query({ url: "*://*.netflix.com/*" })
    .then((tabs) => {
      const present = tabs.length > 0;
      if (present !== hasNetflixPlayer) {
        hasNetflixPlayer = present;
        broadcastPopup({ type: "player-present", present });
      }
    })
    .catch(() => {});
}

function sendToNetflixTabs(msg) {
  chrome.tabs
    .query({ url: "*://*.netflix.com/*" })
    .then((tabs) => tabs.forEach((tab) => chrome.tabs.sendMessage(tab.id, msg)))
    .catch(() => {});
}

// Lightweight helper to call backend REST endpoints from popup (create room).
chrome.runtime.onMessageExternal?.addListener((_message, _sender, sendResponse) => {
  // Reserved for future integrations.
  sendResponse({ ok: false, reason: "not-implemented" });
});
