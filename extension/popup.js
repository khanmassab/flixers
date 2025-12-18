// Popup logic for Flixers
const API_BASE = "http://localhost:4000";
const GOOGLE_CLIENT_ID = "400373504190-dasf4eoqp7oqaikurtq9b9gqi32oai6t.apps.googleusercontent.com";
// chrome.identity.getRedirectURL() respects the runtime ID for this profile, avoiding mismatches.
const REDIRECT_URI = `https://${chrome.runtime.id}.chromiumapp.org/`;

const roomLinkInput = document.getElementById("room-link");
const statusEl = document.getElementById("status");
const presenceChips = document.getElementById("presence-chips");
const connectionPill = document.getElementById("connection-pill");
const toastStack = document.getElementById("toast-stack");
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
  hasPlayer: false,
  isPlaying: false,
  videoUrl: null,
  // Preview state for pending join confirmation
  previewRoom: null, // { roomId, videoUrl, titleId, initialTime, participantCount }
};

signInBtn.addEventListener("click", handleSignIn);
signOutBtn.addEventListener("click", handleSignOut);

document.getElementById("create").addEventListener("click", async () => {
  const createBtn = document.getElementById("create");
  const originalText = createBtn.textContent;
  
  // Check if user is on a Netflix video page
  if (!state.videoUrl || !state.videoUrl.includes("netflix.com/watch")) {
    pushToast("Open a Netflix video first to create a room", "warn");
    return;
  }
  
  lockControls(true);
  createBtn.textContent = "Creating…";
  createBtn.classList.add("loading");
  const session = requireSession();
  if (!session) {
    lockControls(false);
    createBtn.textContent = originalText;
    createBtn.classList.remove("loading");
    return;
  }
  try {
    // Get current video state from content script
    const videoState = await getVideoState();
    
    const res = await fetch(`${API_BASE}/rooms`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.token}`,
      },
      body: JSON.stringify({ 
        encryptionRequired: true,
        videoUrl: state.videoUrl,
        videoTime: videoState?.t || 0,
      }),
    });
    if (!res.ok) throw new Error("create failed");
    const data = await res.json();
    const shareLink = buildShareLink(data.roomId);
    roomLinkInput.value = shareLink;
    try {
      await navigator.clipboard.writeText(shareLink);
      pushToast("Room link copied", "info");
    } catch (_) {
      // Clipboard may fail in some contexts; ignore
    }
    await joinRoom(data.roomId);
    pushToast(`New room created (${data.roomId})`, "info");
  } catch (err) {
    setStatus("Failed to create room");
    pushToast("Could not create room", "warn");
  } finally {
    lockControls(false);
    createBtn.textContent = originalText;
    createBtn.classList.remove("loading");
  }
});

// Get current video state from Netflix tab
async function getVideoState() {
  return new Promise((resolve) => {
    chrome.tabs.query({ url: "*://*.netflix.com/watch/*" }, (tabs) => {
      if (!tabs || tabs.length === 0) {
        resolve(null);
        return;
      }
      chrome.tabs.sendMessage(tabs[0].id, { type: "get-video-state" }, (response) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(response);
      });
    });
  });
}

roomLinkInput.addEventListener("paste", async (e) => {
  const text = (e.clipboardData || window.clipboardData)?.getData("text")?.trim() || "";
  if (!text) return;
  e.preventDefault();
  roomLinkInput.value = text;
  const targetRoom = parseRoomId(text);
  if (!targetRoom) {
    jitterInput(roomLinkInput);
    // Provide specific feedback based on the input
    if (text.length < 3) {
      pushToast("Room ID too short (min 3 characters)", "warn");
    } else if (text.length > 64) {
      pushToast("Room ID too long (max 64 characters)", "warn");
    } else if (!/^[a-zA-Z0-9_-]+$/.test(text) && !text.includes("room=")) {
      pushToast("Room ID can only contain letters, numbers, hyphens, underscores", "warn");
    } else {
      pushToast("Invalid room link or ID", "warn");
    }
    return;
  }
  if (!state.session) {
    state.pendingRoomId = targetRoom;
    jitterInput(roomLinkInput);
    pushToast("Sign in to join this room", "warn");
    return;
  }
  // Show preview before joining
  await previewRoom(targetRoom);
});

// Preview room info before joining
async function previewRoom(roomId) {
  const session = requireSession();
  if (!session) return;
  
  lockControls(true);
  setStatus("Loading room info...");
  
  try {
    const res = await fetch(`${API_BASE}/rooms/${roomId}/preview`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${session.token}`,
      },
    });
    
    if (!res.ok) {
      if (res.status === 404) {
        throw new Error("Room expired");
      }
      throw new Error("Failed to load room");
    }
    
    const data = await res.json();
    state.previewRoom = {
      roomId: data.roomId,
      videoUrl: data.videoUrl,
      titleId: data.titleId,
      initialTime: data.initialTime || 0,
      participantCount: data.participantCount || 0,
    };
    
    showJoinPreview(state.previewRoom);
    setStatus("Review room details");
  } catch (err) {
    jitterInput(roomLinkInput);
    pushToast(err.message || "Could not load room", "warn");
    setStatus(err?.message || "Room not found");
  } finally {
    lockControls(false);
  }
}

// Show the join preview panel
function showJoinPreview(preview) {
  const previewEl = document.getElementById("join-preview");
  const videoEl = document.getElementById("preview-video");
  const timeEl = document.getElementById("preview-time");
  const participantsEl = document.getElementById("preview-participants");
  
  // Format video title from URL
  let videoTitle = "Netflix Video";
  if (preview.titleId) {
    videoTitle = `Netflix Title #${preview.titleId}`;
  }
  
  // Format time
  const mins = Math.floor(preview.initialTime / 60);
  const secs = Math.floor(preview.initialTime % 60);
  const timeStr = `Starting at ${mins}:${String(secs).padStart(2, "0")}`;
  
  // Format participants
  const participantStr = preview.participantCount === 1 
    ? "1 person watching" 
    : `${preview.participantCount} people watching`;
  
  videoEl.textContent = videoTitle;
  timeEl.textContent = timeStr;
  participantsEl.textContent = participantStr;
  
  previewEl.classList.remove("hidden");
  document.querySelector(".field-grid").classList.add("hidden");
}

// Hide the join preview panel
function hideJoinPreview() {
  const previewEl = document.getElementById("join-preview");
  previewEl.classList.add("hidden");
  document.querySelector(".field-grid").classList.remove("hidden");
  state.previewRoom = null;
}

// Confirm join button handler
document.getElementById("confirm-join")?.addEventListener("click", async () => {
  if (!state.previewRoom) return;
  
  const { roomId, videoUrl, initialTime } = state.previewRoom;
  hideJoinPreview();
  
  // Join the room via background (which will open Netflix tab)
  await confirmJoinRoom(roomId, videoUrl, initialTime);
});

// Cancel join button handler
document.getElementById("cancel-join")?.addEventListener("click", () => {
  hideJoinPreview();
  roomLinkInput.value = "";
  setStatus("Join cancelled");
});

// Join room with video navigation (user-gesture-gated)
async function confirmJoinRoom(roomId, videoUrl, initialTime) {
  const session = requireSession();
  if (!session) return;
  
  lockControls(true);
  setConnectionPill("bad", "joining");
  const displayName = session.profile?.name || "Guest";
  
  try {
    const res = await new Promise((resolve) => {
      chrome.runtime.sendMessage(
        {
          type: "confirm-join",
          roomId,
          name: displayName,
          token: session.token,
          videoUrl,
          initialTime,
        },
        (response) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, reason: chrome.runtime.lastError.message });
            return;
          }
          resolve(response);
        }
      );
    });
    
    if (!res?.ok) {
      const reason = res?.reason === "auth-required" ? "Sign in first" : "Join failed";
      throw new Error(reason);
    }
    
    setRoom(roomId, displayName);
    setStatus(`Joined room ${roomId}`);
    setConnectionPill("bad", "connecting");
    pushToast(`Joining ${roomId} as ${displayName}`, "info");
  } catch (err) {
    setStatus("Failed to join room");
    setConnectionPill("idle", "Idle");
    jitterInput(roomLinkInput);
    pushToast("Could not join room", "warn");
  } finally {
    lockControls(false);
  }
}

document.getElementById("leave").addEventListener("click", async () => {
  try {
    await chrome.runtime.sendMessage({ type: "leave-room" });
  } catch (_) {
    // Ignore if background isn't ready
  }
  state.connected = false;
  setRoom(null);
  setStatus("Left the room");
  setConnectionPill("idle", "Idle");
  updateVisibility();
  pushToast("Disconnected from room", "info");
});

async function handleSignIn() {
  if (!GOOGLE_CLIENT_ID) {
    pushToast("Set GOOGLE_CLIENT_ID in popup.js to enable sign-in", "warn");
    return;
  }
  
  // Disable button and show loading state
  signInBtn.disabled = true;
  signInBtn.textContent = "Signing in...";
  
  try {
    // Delegate OAuth to background script (survives popup close)
    const result = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "auth-google-start" }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response || !response.ok) {
          reject(new Error(response?.reason || "auth_failed"));
          return;
        }
        resolve(response);
      });
    });
    
    // Session is already saved by background, just update UI
    if (result.session) {
      state.session = result.session;
      applySession(result.session);
      pushToast(`Signed in as ${result.session.profile?.name || "user"}`, "info");
      
      // Handle pending room join
      if (state.pendingRoomId) {
        await previewRoom(state.pendingRoomId);
        state.pendingRoomId = null;
      }
    }
  } catch (err) {
    const reason = err?.message || String(err);
    pushToast(`Google sign-in failed: ${reason}`, "warn");
  } finally {
    // Restore button state
    signInBtn.disabled = !!state.session;
    signInBtn.textContent = "Sign in with Google";
  }
}

async function handleSignOut() {
  try {
    await chrome.runtime.sendMessage({ type: "auth-clear" });
  } catch (_) {
    // Ignore if background isn't ready
  }
  await chrome.storage.local.remove(["flixersSession"]);
  state.session = null;
  state.connected = false;
  applySession(null);
  setConnectionPill("idle", "Idle");
  setStatus("Signed out");
  pushToast("Signed out", "info");
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "ws-status") {
    const isConnected = msg.status === "connected";
    const isReconnecting = msg.status === "reconnecting" || msg.status === "connecting";
    state.connected = isConnected;
    setConnectionPill(isConnected ? "ok" : isReconnecting ? "warn" : "bad", msg.status);
    setStatus(`Connection: ${msg.status}`);
    updateVisibility();
    if (msg.status === "reconnecting") {
      pushToast("Reconnecting to room…", "warn");
    } else if (msg.status === "disconnected") {
      pushToast("Connection lost", "warn");
    }
  }
  if (msg.type === "room-deleted") {
    if (state.roomId && msg.roomId && state.roomId === msg.roomId) {
      state.connected = false;
      setRoom(null);
      setConnectionPill("bad", "disconnected");
      setStatus("Room expired");
      pushToast("Room expired. Please create or join a new room.", "warn");
    }
  }
  if (msg.type === "presence") {
    const participants = Array.isArray(msg.participants)
      ? msg.participants
      : (msg.users || []).map((name) => ({ id: name, name }));
    renderPresence(participants);
    const count = participants.length ?? 0;
    setStatus(`Room ${msg.roomId || ""} · ${count} online`);
  }
  if (msg.type === "player-present") {
    state.hasPlayer = !!msg.present;
    state.isPlaying = !!msg.playing;
    state.videoUrl = msg.url || null;
    updateVisibility();
  }
  if (msg.type === "auth") {
    state.session = msg.session || null;
    applySession(state.session);
    if (!state.session) {
      setRoom(null);
      setStatus("Signed out");
      setConnectionPill("idle", "Idle");
    }
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes.flixersSession) return;
  const session = changes.flixersSession.newValue || null;
  state.session = session;
  applySession(session);
  if (!session) {
    setRoom(null);
    setStatus("Signed out");
  }
});

function buildGoogleAuthUrl() {
  const nonce = generateNonce();
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "id_token",
    scope: "openid email profile",
    nonce: nonce,
    prompt: "select_account",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

function generateNonce() {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
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
  try {
    await chrome.runtime.sendMessage({ type: "auth-set", session });
  } catch (_) {
    // Ignore if background isn't ready
  }
  applySession(session);
  if (state.pendingRoomId) {
    // Show preview instead of directly joining
    await previewRoom(state.pendingRoomId);
    state.pendingRoomId = null;
  }
}

function applySession(session) {
  const profile = session?.profile;
  userNameEl.textContent = profile?.name || "Not signed in";
  userEmailEl.textContent = profile?.email || "Sign in to load your Google name";
  const initial = (profile?.name || "?").slice(0, 1).toUpperCase();
  avatarEl.textContent = initial;
  if (profile?.picture) {
    avatarEl.style.backgroundImage = `url(${profile.picture})`;
    avatarEl.classList.add("avatar--image");
  } else {
    avatarEl.style.backgroundImage = "";
    avatarEl.classList.remove("avatar--image");
  }
  const authed = !!session;
  signOutBtn.disabled = !authed;
  signInBtn.disabled = authed;
  signOutBtn.classList.toggle("hidden", !authed);
  signInBtn.classList.toggle("hidden", authed);
  document.getElementById("create").disabled = !authed;
  updateVisibility();
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
  lockControls(true);
  setConnectionPill("bad", "joining");
  const displayName = session.profile?.name || "Guest";
  try {
    const res = await new Promise((resolve) => {
      chrome.runtime.sendMessage(
        {
          type: "join-room",
          roomId,
          name: displayName,
          token: session.token,
        },
        (response) => {
          // Check lastError to prevent unchecked error
          if (chrome.runtime.lastError) {
            resolve({ ok: false, reason: chrome.runtime.lastError.message });
            return;
          }
          resolve(response);
        }
      );
    });
    if (!res?.ok) {
      const reason = res?.reason === "auth-required" ? "Sign in first" : "Join failed";
      throw new Error(reason);
    }
    setRoom(roomId, displayName);
    setStatus(`Joined room ${roomId}`);
    setConnectionPill("bad", "connecting");
    pushToast(`Joining ${roomId} as ${displayName}`, "info");
  } catch (err) {
    setStatus("Failed to join room");
    setConnectionPill("idle", "Idle");
    jitterInput(roomLinkInput);
    pushToast("Could not join room", "warn");
  } finally {
    lockControls(false);
  }
}

function setStatus(text) {
  statusEl.textContent = text;
}

function setConnectionPill(kind, text) {
  connectionPill.textContent = text;
  connectionPill.classList.remove("pill--idle", "pill--ok", "pill--bad", "pill--warn");
  if (kind === "ok") {
    connectionPill.classList.add("pill--ok");
  } else if (kind === "warn") {
    connectionPill.classList.add("pill--warn");
  } else if (kind === "bad") {
    connectionPill.classList.add("pill--bad");
  } else {
    connectionPill.classList.add("pill--idle");
  }
}

function lockControls(disabled) {
  const authed = !!state.session;
  document.getElementById("create").disabled = disabled || !authed;
  document.getElementById("leave").disabled = disabled;
  roomLinkInput.disabled = disabled;
}

function renderPresence(participants) {
  const list = Array.isArray(participants) ? participants : [];
  state.participants = list;
  presenceChips.innerHTML = "";
  if (!list.length) {
    presenceChips.innerHTML = `<span class="chip">No one online</span>`;
    return;
  }
  list.forEach((p) => {
    const name = typeof p === "string" ? p : p?.name;
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = name || "Guest";
    presenceChips.appendChild(chip);
  });
}

function setRoom(roomId, name = state.session?.profile?.name) {
  state.roomId = roomId;
  state.roomName = name || "Guest";
  roomLinkInput.value = roomId ? buildShareLink(roomId) : "";
  if (roomId) {
    setStatus(`Reattached to room ${roomId}`);
  } else {
    renderPresence([]);
  }
  updateVisibility();
}

function buildShareLink(roomId) {
  return `chrome-extension://${chrome.runtime.id}/popup.html?room=${encodeURIComponent(
    roomId
  )}`;
}

function updateVisibility() {
  const inRoom = !!state.roomId;
  const onVideo = state.videoUrl && state.videoUrl.includes("netflix.com/watch");
  const createBtn = document.getElementById("create");
  
  document.getElementById("leave").classList.toggle("hidden", !inRoom);
  
  // Update create button state based on whether user is on a Netflix video
  if (createBtn && state.session) {
    createBtn.disabled = !onVideo;
    if (!onVideo && !inRoom) {
      createBtn.title = "Open a Netflix video to create a room";
    } else {
      createBtn.title = "";
    }
  }
}

function isValidRoomId(roomId) {
  // Room ID should be alphanumeric with optional hyphens/underscores, 3-64 chars
  if (!roomId || typeof roomId !== "string") return false;
  const cleaned = roomId.trim();
  if (cleaned.length < 3 || cleaned.length > 64) return false;
  // Allow alphanumeric, hyphens, underscores
  return /^[a-zA-Z0-9_-]+$/.test(cleaned);
}

function parseRoomId(input) {
  if (!input) return null;
  const trimmed = input.trim();
  
  // Try to parse as URL first
  try {
    const asUrl = new URL(trimmed);
    const fromQuery = asUrl.searchParams.get("room");
    if (fromQuery && isValidRoomId(fromQuery)) return fromQuery;
  } catch (_) {
    // not a URL, continue
  }
  
  // Check for room= parameter in non-URL format
  if (trimmed.includes("room=")) {
    const match = trimmed.match(/room=([^&]+)/i);
    if (match && isValidRoomId(match[1])) return match[1];
  }
  
  // Treat as plain room ID if valid
  if (isValidRoomId(trimmed)) {
    return trimmed;
  }
  
  return null;
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

function jitterInput(el) {
  if (!el) return;
  el.classList.remove("jitter");
  void el.offsetWidth; // force reflow
  el.classList.add("jitter");
}

function escapeHtml(str = "") {
  return str.replace(/[&<>"']/g, (ch) => {
    const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return map[ch] || ch;
  });
}

// Helper to safely send messages and handle lastError
function safeSendMessage(message, callback) {
  try {
    chrome.runtime.sendMessage(message, (res) => {
      if (chrome.runtime.lastError) {
        // Silently ignore - background may not be ready
        return;
      }
      if (callback) callback(res);
    });
  } catch (_) {
    // Ignore if extension context invalidated
  }
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
    roomLinkInput.value = buildShareLink(urlRoom);
    pushToast(`Link detected for room ${urlRoom}`, "info");
    if (state.session) {
      // Show preview instead of directly joining
      await previewRoom(urlRoom);
      state.pendingRoomId = null;
    }
  }
  safeSendMessage({ type: "get-room" }, (res) => {
    if (res?.roomId) {
      roomLinkInput.value = res.roomId;
      setRoom(res.roomId, session?.profile?.name || res.name || "Guest");
      setStatus(`Reattached to room ${res.roomId}`);
    }
  });
  safeSendMessage({ type: "get-presence" }, (res) => {
    const participants = Array.isArray(res?.participants)
      ? res.participants
      : (res?.users || []).map((name) => ({ id: name, name }));
    renderPresence(participants);
  });
  safeSendMessage({ type: "get-connection-status" }, (res) => {
    if (res?.status) {
      const isConnected = res.status === "connected";
      const isReconnecting = res.status === "reconnecting" || res.status === "connecting";
      state.connected = isConnected;
      setConnectionPill(isConnected ? "ok" : isReconnecting ? "warn" : "bad", res.status);
      if (res.roomId) {
        setStatus(`Connection: ${res.status}`);
      }
    }
  });
  safeSendMessage({ type: "player-status" }, (res) => {
    if (res && typeof res.present === "boolean") {
      state.hasPlayer = res.present;
      state.isPlaying = !!res.playing;
      state.videoUrl = res.url || null;
      updateVisibility();
    }
  });
})();
