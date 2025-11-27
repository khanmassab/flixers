// Popup logic for Flixers
const API_BASE = "http://localhost:4000";
const GOOGLE_CLIENT_ID = ""; // TODO: set your OAuth client ID
const REDIRECT_URI = `https://${chrome.runtime.id}.chromiumapp.org/`;

const nameInput = document.getElementById("name");
const roomInput = document.getElementById("room");
const statusEl = document.getElementById("status");
const presenceChips = document.getElementById("presence-chips");
const connectionPill = document.getElementById("connection-pill");
const messagesEl = document.getElementById("messages");
const chatInput = document.getElementById("chat-input");
const toastStack = document.getElementById("toast-stack");
const roomLinkInput = document.getElementById("room-link");
const copyLinkBtn = document.getElementById("copy-link");
const avatarEl = document.getElementById("user-avatar");
const userNameEl = document.getElementById("user-name");
const userEmailEl = document.getElementById("user-email");
const signInBtn = document.getElementById("signin");
const signOutBtn = document.getElementById("signout");

const state = {
  roomId: null,
  connected: false,
  participants: [],
  session: null,
  pendingRoomId: null,
};

signInBtn.addEventListener("click", handleSignIn);
signOutBtn.addEventListener("click", handleSignOut);

document.getElementById("create").addEventListener("click", async () => {
  lockControls(true);
  const session = requireSession();
  if (!session) {
    lockControls(false);
    return;
  }
  try {
    const res = await fetch(`${API_BASE}/rooms`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.token}`,
      },
      body: JSON.stringify({ encryptionRequired: true }),
    });
    if (!res.ok) throw new Error("create failed");
    const data = await res.json();
    roomInput.value = data.roomId;
    roomLinkInput.value = buildShareLink(data.roomId);
    await joinRoom(data.roomId);
    pushToast(`New room created (${data.roomId})`, "info");
  } catch (err) {
    setStatus("Failed to create room");
    pushToast("Could not create room", "warn");
  } finally {
    lockControls(false);
  }
});

document.getElementById("join").addEventListener("click", async () => {
  lockControls(true);
  const candidate = roomLinkInput.value.trim() || roomInput.value.trim();
  const targetRoom = parseRoomId(candidate) || state.pendingRoomId;
  if (!targetRoom) {
    pushToast("Paste a room link or create one first", "warn");
    lockControls(false);
    return;
  }
  if (!state.session) {
    state.pendingRoomId = targetRoom;
    pushToast("Sign in to join this room", "warn");
    lockControls(false);
    return;
  }
  await joinRoom(targetRoom);
  lockControls(false);
});

document.getElementById("leave").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "leave-room" });
  setRoom(null);
  setStatus("Left the room");
  setConnectionPill("idle", "Idle");
  pushToast("Disconnected from room", "info");
});

document.getElementById("clear-chat").addEventListener("click", () => {
  messagesEl.innerHTML = "";
});

copyLinkBtn.addEventListener("click", () => {
  if (!state.roomId) {
    pushToast("Create or join a room first", "warn");
    return;
  }
  const link = buildShareLink(state.roomId);
  roomLinkInput.value = link;
  navigator.clipboard.writeText(link).then(
    () => pushToast("Link copied", "info"),
    () => pushToast("Copy failed", "warn")
  );
});

async function handleSignIn() {
  if (!GOOGLE_CLIENT_ID) {
    pushToast("Set GOOGLE_CLIENT_ID in popup.js to enable sign-in", "warn");
    return;
  }
  try {
    const authUrl = buildGoogleAuthUrl();
    const redirectUrl = await launchWebAuthFlow(authUrl);
    const idToken = extractIdToken(redirectUrl);
    if (!idToken) throw new Error("no_token");
    const session = await exchangeIdToken(idToken);
    await setSession(session);
    pushToast(`Signed in as ${session.profile?.name || "user"}`, "info");
  } catch (err) {
    console.warn("Sign-in failed", err);
    pushToast("Google sign-in failed", "warn");
  }
}

async function handleSignOut() {
  await chrome.runtime.sendMessage({ type: "auth-clear" });
  await chrome.storage.local.remove(["flixersSession"]);
  state.session = null;
  applySession(null);
  setStatus("Signed out");
  pushToast("Signed out", "info");
}

document.getElementById("chat-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  const session = requireSession();
  if (!session) return;
  chatInput.value = "";
  await chrome.runtime.sendMessage({ type: "chat", text });
  pushMessage(session.profile?.name || "You", text, Date.now());
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "ws-status") {
    const isConnected = msg.status === "connected";
    state.connected = isConnected;
    setConnectionPill(isConnected ? "ok" : "bad", msg.status);
    if (!isConnected) pushToast("Trying to reconnect…", "warn");
  }
  if (msg.type === "chat") {
    pushMessage(msg.from || "Anon", msg.text, msg.ts);
    if (
      (msg.from || "").toLowerCase() !==
      (state.session?.profile?.name || "").toLowerCase()
    ) {
      pushToast(`${msg.from || "Someone"} sent a message`, "info");
    }
  }
  if (msg.type === "presence") {
    renderPresence(msg.users || []);
    const count = msg.users?.length ?? 0;
    setStatus(`Room ${msg.roomId || ""} · ${count} online`);
  }
});

function buildGoogleAuthUrl() {
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "id_token",
    scope: "openid email profile",
    prompt: "select_account",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

function launchWebAuthFlow(url) {
  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url, interactive: true }, (redirectUrl) => {
      if (chrome.runtime.lastError || !redirectUrl) {
        reject(chrome.runtime.lastError || new Error("auth_error"));
      } else {
        resolve(redirectUrl);
      }
    });
  });
}

function extractIdToken(redirectUrl) {
  try {
    const fragment = redirectUrl.split("#")[1] || "";
    const params = new URLSearchParams(fragment);
    return params.get("id_token");
  } catch (err) {
    return null;
  }
}

async function exchangeIdToken(idToken) {
  const res = await fetch(`${API_BASE}/auth/google`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idToken }),
  });
  if (!res.ok) throw new Error("exchange_failed");
  const data = await res.json();
  return { token: data.token, profile: data.profile };
}

async function setSession(session) {
  state.session = session;
  await chrome.storage.local.set({ flixersSession: session });
  await chrome.runtime.sendMessage({ type: "auth-set", session });
  applySession(session);
  if (state.pendingRoomId) {
    await joinRoom(state.pendingRoomId);
    state.pendingRoomId = null;
  }
}

function applySession(session) {
  const profile = session?.profile;
  nameInput.value = profile?.name || "";
  nameInput.disabled = !!profile?.name;
  userNameEl.textContent = profile?.name || "Not signed in";
  userEmailEl.textContent = profile?.email || "Sign in to load your Google name";
  avatarEl.textContent = (profile?.name || "?").slice(0, 1).toUpperCase();
  const authed = !!session;
  signOutBtn.disabled = !authed;
  signInBtn.disabled = authed;
  signOutBtn.classList.toggle("hidden", !authed);
  signInBtn.classList.toggle("hidden", authed);
  document.getElementById("create").disabled = !authed;
  document.getElementById("join").disabled = !authed;
}

function requireSession() {
  if (!state.session || !state.session.token) {
    pushToast("Sign in with Google first", "warn");
    return null;
  }
  return state.session;
}

async function joinRoom(roomId) {
  const session = requireSession();
  if (!session) return;
  if (!roomId) {
    setStatus("Paste a room link first");
    pushToast("Paste a room link first", "warn");
    return;
  }
  const displayName = session.profile?.name || "Guest";
  try {
    await chrome.runtime.sendMessage({
      type: "join-room",
      roomId,
      name: displayName,
      token: session.token,
    });
    setRoom(roomId, displayName);
    setStatus(`Joined room ${roomId}`);
    setConnectionPill("bad", "connecting");
    pushToast(`Joining ${roomId} as ${displayName}`, "info");
  } catch (err) {
    setStatus("Failed to join room");
    pushToast("Could not join room", "warn");
  }
}

function setStatus(text) {
  statusEl.textContent = text;
}

function setConnectionPill(kind, text) {
  connectionPill.textContent = text;
  connectionPill.classList.remove("pill--idle", "pill--ok", "pill--bad");
  connectionPill.classList.add(
    kind === "ok" ? "pill--ok" : kind === "bad" ? "pill--bad" : "pill--idle"
  );
}

function lockControls(disabled) {
  const authed = !!state.session;
  document.getElementById("create").disabled = disabled || !authed;
  document.getElementById("join").disabled = disabled || !authed;
  document.getElementById("leave").disabled = disabled;
}

function pushMessage(from, text, ts) {
  const time = ts ? new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  const div = document.createElement("div");
  div.className = "message";
  div.innerHTML = `
    <div class="meta">
      <span class="from">${from}</span>
      ${time ? `<span class="time">${time}</span>` : ""}
    </div>
    <div class="body">${escapeHtml(text)}</div>
  `;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderPresence(users) {
  state.participants = users;
  presenceChips.innerHTML = "";
  if (!users.length) {
    presenceChips.innerHTML = `<span class="chip">No one online</span>`;
    return;
  }
  users.forEach((u) => {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = u;
    presenceChips.appendChild(chip);
  });
}

function setRoom(roomId, name = state.session?.profile?.name) {
  state.roomId = roomId;
  state.roomName = name || "Guest";
  roomInput.value = roomId || "";
  roomLinkInput.value = roomId ? buildShareLink(roomId) : "";
  if (roomId) {
    setStatus(`Reattached to room ${roomId}`);
  } else {
    renderPresence([]);
  }
}

function buildShareLink(roomId) {
  return `chrome-extension://${chrome.runtime.id}/popup.html?room=${encodeURIComponent(
    roomId
  )}`;
}

function parseRoomId(input) {
  if (!input) return null;
  const trimmed = input.trim();
  try {
    const asUrl = new URL(trimmed);
    const fromQuery = asUrl.searchParams.get("room");
    if (fromQuery) return fromQuery;
  } catch (_) {
    // not a URL, continue
  }
  if (trimmed.includes("room=")) {
    const match = trimmed.match(/room=([^&]+)/i);
    if (match) return match[1];
  }
  return trimmed.length ? trimmed : null;
}

function pushToast(text, variant = "info") {
  const toast = document.createElement("div");
  toast.className = `toast toast--${variant}`;
  toast.textContent = text;
  toastStack.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("show"));
  setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => toast.remove(), 180);
  }, 2600);
}

function escapeHtml(str = "") {
  return str.replace(/[&<>"']/g, (ch) => {
    const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return map[ch] || ch;
  });
}

// Restore session and last joined room if any.
(async function bootstrap() {
  const stored = await chrome.storage.local.get(["flixersSession"]);
  const session = stored.flixersSession || null;
  if (session) {
    state.session = session;
    applySession(session);
  } else {
    applySession(null);
  }
  const urlRoom = parseRoomId(new URL(window.location.href).searchParams.get("room"));
  if (urlRoom) {
    state.pendingRoomId = urlRoom;
    roomInput.value = urlRoom;
    roomLinkInput.value = buildShareLink(urlRoom);
    pushToast(`Link detected for room ${urlRoom}`, "info");
    if (state.session) {
      await joinRoom(urlRoom);
      state.pendingRoomId = null;
    }
  }
  chrome.runtime.sendMessage({ type: "get-room" }, (res) => {
    if (res?.roomId) {
      roomInput.value = res.roomId;
      setRoom(res.roomId, session?.profile?.name || res.name || "Guest");
      setStatus(`Reattached to room ${res.roomId}`);
    }
  });
})();
