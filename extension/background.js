const BACKEND_HTTP = "http://localhost:4000";
const BACKEND_WS = "ws://localhost:4000/ws";
const GOOGLE_CLIENT_ID = "400373504190-dasf4eoqp7oqaikurtq9b9gqi32oai6t.apps.googleusercontent.com";

let ws;
let currentRoom = null;
let displayName = "Guest";
let retryTimer = null;
let session = null;
let hasNetflixPlayer = false;
let encryptionRequired = true;
const peerPublicKeys = new Map(); // name -> CryptoKey
let keyPairPromise = null;
let publicKeyB64 = null;
let keyPairData = null; // { publicKey, privateKey } raw data for persistence
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const ECDH_CURVE = "P-256";

// Key persistence settings
const KEY_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours in milliseconds
const KEY_STORAGE_PREFIX = "flixers-keys-";
const seenUsers = new Set();
let hasActivePlayback = false;
let lastVideoUrl = null;
let currentParticipants = [];
let connectionStatus = "idle";
const playbackState = new Map(); // roomId -> { paused, t }

// Message queue for offline/reconnecting scenarios
const messageQueue = [];
const MAX_QUEUE_SIZE = 100; // Max messages to queue

// Message retention period (1 day in milliseconds)
const MESSAGE_RETENTION_MS = 24 * 60 * 60 * 1000;

// ============ Key Persistence Functions ============

// Save the local key pair to storage (persists for 2 hours)
async function persistKeyPair(roomId, publicKey, privateKey) {
  if (!roomId) return;
  const key = `${KEY_STORAGE_PREFIX}local-${roomId}`;
  const data = {
    publicKey,
    privateKey,
    createdAt: Date.now(),
    expiresAt: Date.now() + KEY_TTL_MS,
  };
  try {
    await chrome.storage.local.set({ [key]: data });
    console.log("[Keys] Persisted local key pair for room:", roomId);
  } catch (err) {
    console.warn("[Keys] Failed to persist key pair:", err.message);
  }
}

// Load the local key pair from storage if not expired
async function loadPersistedKeyPair(roomId) {
  if (!roomId) return null;
  const key = `${KEY_STORAGE_PREFIX}local-${roomId}`;
  try {
    const result = await chrome.storage.local.get(key);
    const data = result[key];
    if (!data) return null;
    
    // Check expiration
    if (Date.now() > data.expiresAt) {
      console.log("[Keys] Local key pair expired for room:", roomId);
      await chrome.storage.local.remove(key);
      return null;
    }
    
    console.log("[Keys] Loaded persisted key pair for room:", roomId);
    return { publicKey: data.publicKey, privateKey: data.privateKey };
  } catch (err) {
    console.warn("[Keys] Failed to load key pair:", err.message);
    return null;
  }
}

// Save peer public keys to storage
async function persistPeerKeys(roomId) {
  if (!roomId || peerPublicKeys.size === 0) return;
  const key = `${KEY_STORAGE_PREFIX}peers-${roomId}`;
  
  // Export peer keys to storable format
  const peers = {};
  for (const [name, cryptoKey] of peerPublicKeys.entries()) {
    try {
      const exported = await crypto.subtle.exportKey("raw", cryptoKey);
      peers[name] = {
        keyData: bufferToBase64(exported),
        savedAt: Date.now(),
      };
    } catch (err) {
      console.warn("[Keys] Failed to export peer key for:", name);
    }
  }
  
  const data = {
    peers,
    updatedAt: Date.now(),
    expiresAt: Date.now() + KEY_TTL_MS,
  };
  
  try {
    await chrome.storage.local.set({ [key]: data });
    console.log("[Keys] Persisted", Object.keys(peers).length, "peer keys for room:", roomId);
  } catch (err) {
    console.warn("[Keys] Failed to persist peer keys:", err.message);
  }
}

// Load peer public keys from storage
async function loadPersistedPeerKeys(roomId) {
  if (!roomId) return 0;
  const key = `${KEY_STORAGE_PREFIX}peers-${roomId}`;
  
  try {
    const result = await chrome.storage.local.get(key);
    const data = result[key];
    if (!data) return 0;
    
    // Check expiration
    if (Date.now() > data.expiresAt) {
      console.log("[Keys] Peer keys expired for room:", roomId);
      await chrome.storage.local.remove(key);
      return 0;
    }
    
    // Import peer keys
    let loaded = 0;
    for (const [name, peerData] of Object.entries(data.peers || {})) {
      if (peerPublicKeys.has(name)) continue; // Already have this key
      
      try {
        const keyBuffer = base64ToBuffer(peerData.keyData);
        const cryptoKey = await crypto.subtle.importKey(
          "raw",
          keyBuffer,
          { name: "ECDH", namedCurve: ECDH_CURVE },
          true, // extractable for re-export
          []
        );
        peerPublicKeys.set(name, cryptoKey);
        seenUsers.add(name);
        loaded++;
      } catch (err) {
        console.warn("[Keys] Failed to import peer key for:", name, err.message);
      }
    }
    
    if (loaded > 0) {
      console.log("[Keys] Loaded", loaded, "peer keys from storage for room:", roomId);
    }
    return loaded;
  } catch (err) {
    console.warn("[Keys] Failed to load peer keys:", err.message);
    return 0;
  }
}

// Clear persisted keys for a room
async function clearPersistedKeys(roomId) {
  if (!roomId) return;
  const localKey = `${KEY_STORAGE_PREFIX}local-${roomId}`;
  const peersKey = `${KEY_STORAGE_PREFIX}peers-${roomId}`;
  try {
    await chrome.storage.local.remove([localKey, peersKey]);
    console.log("[Keys] Cleared persisted keys for room:", roomId);
  } catch (err) {
    console.warn("[Keys] Failed to clear keys:", err.message);
  }
}

// Clean up expired keys from all rooms
async function cleanupExpiredKeys() {
  try {
    const items = await chrome.storage.local.get(null);
    const keysToRemove = [];
    const now = Date.now();
    
    for (const [key, value] of Object.entries(items)) {
      if (!key.startsWith(KEY_STORAGE_PREFIX)) continue;
      if (value?.expiresAt && now > value.expiresAt) {
        keysToRemove.push(key);
      }
    }
    
    if (keysToRemove.length > 0) {
      await chrome.storage.local.remove(keysToRemove);
      console.log("[Keys] Cleaned up", keysToRemove.length, "expired key entries");
    }
  } catch (err) {
    console.warn("[Keys] Failed to cleanup expired keys:", err.message);
  }
}

// Connection stability variables
let heartbeatInterval = null;
let lastPongTime = Date.now();
let reconnectAttempts = 0;
const HEARTBEAT_INTERVAL = 25000; // Send ping every 25 seconds
const HEARTBEAT_TIMEOUT = 35000; // Consider connection dead if no pong in 35s
const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_RECONNECT_DELAY = 1000; // Start with 1 second
const MAX_RECONNECT_DELAY = 30000; // Max 30 seconds between attempts

// Sync handshake state
let pendingSyncRequest = false;
let syncRequestTimestamp = 0;
let hasRespondedToSync = false;

chrome.storage.local.get(["flixersSession"]).then((res) => {
  if (res.flixersSession) {
    session = res.flixersSession;
    displayName = session.profile?.name || "Guest";
  }
});

// Clean up old messages and expired keys on startup
cleanupOldRoomMessages();
cleanupExpiredKeys();

// Periodically clean up old messages and expired keys (every hour)
setInterval(() => {
  cleanupOldRoomMessages(currentRoom);
  cleanupExpiredKeys();
}, 60 * 60 * 1000);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case "auth-google-start":
      // Handle OAuth flow in background (survives popup close)
      handleGoogleSignIn()
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ ok: false, reason: err.message }));
      return true;
    case "join-room":
      // Legacy join (for room creator who's already on video)
      handleJoin(message.roomId, message.name, message.token)
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ ok: false, reason: err.message }));
      return true;
    case "confirm-join":
      // User-gesture-gated join with video navigation
      handleConfirmJoin(message.roomId, message.name, message.token, message.videoUrl, message.initialTime)
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ ok: false, reason: err.message }));
      return true;
    case "leave-room":
      // Clear keys when explicitly leaving a room
      if (currentRoom) {
        clearPersistedKeys(currentRoom);
      }
      teardownSocket(false, true); // Clear all keys and reset attempts
      currentRoom = null;
      sendToNetflixTabs({ type: "room-update", roomId: null, name: displayName });
      sendResponse({ ok: true });
      return true;
    case "player-event":
      forwardState(message.payload);
      updatePlayerStatus(true, !message.payload?.paused, message.payload?.url);
      return true;
    case "chat":
      sendChat(message.text);
      return true;
    case "typing":
      sendTyping(!!message.active);
      return true;
    case "get-room":
      sendResponse({ roomId: currentRoom, name: displayName });
      return true;
    case "get-presence":
      sendResponse({ users: currentParticipants, roomId: currentRoom });
      return true;
    case "get-connection-status":
      // When popup asks for status, also verify connection is healthy
      if (currentRoom && connectionStatus === "connected") {
        // Quick check if WS is actually open
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          console.log("[WS] Popup status check: connection state mismatch, triggering reconnect");
          scheduleReconnect();
          sendResponse({ status: "reconnecting", roomId: currentRoom });
          return true;
        }
      }
      sendResponse({ status: connectionStatus, roomId: currentRoom });
      return true;
    case "auth-set":
      session = message.session;
      displayName = session?.profile?.name || "Guest";
      chrome.storage.local.set({ flixersSession: session || null });
      broadcastPopup({ type: "auth", session });
      sendToNetflixTabs({ type: "auth", session });
      return true;
    case "auth-clear":
      session = null;
      displayName = "Guest";
      // Clear all keys when signing out
      if (currentRoom) {
        clearPersistedKeys(currentRoom);
      }
      teardownSocket(false, true); // Clear all keys and reset attempts
      currentRoom = null;
      chrome.storage.local.remove(["flixersSession"]);
      broadcastPopup({ type: "auth", session: null });
      broadcastPopup({ type: "ws-status", status: "disconnected" });
      sendToNetflixTabs({ type: "auth", session: null });
      return true;
    case "auth-get":
      sendResponse({ session });
      return true;
    case "player-present":
      updatePlayerStatus(true, !!message.playing, message.url);
      return true;
    case "player-status":
      sendResponse({
        present: hasNetflixPlayer,
        playing: hasActivePlayback,
        url: lastVideoUrl,
      });
      return true;
    case "request-sync":
      // Content script is ready and requesting sync (initial or manual resync)
      // Force pendingSyncRequest to true for manual resync
      pendingSyncRequest = true;
      sendSyncRequest();
      return true;
    case "show-sync-hint":
      // Show sync hint as a system message in chat
      if (message.diff > 5) {
        const mins = Math.floor(message.targetTime / 60);
        const secs = Math.floor(message.targetTime % 60);
        const targetTimeStr = `${mins}:${secs.toString().padStart(2, "0")}`;
        emitLocalSystem(`📍 Others are at ${targetTimeStr} (${Math.round(message.diff)}s different) - seek manually to sync`);
      }
      return true;
    default:
      return false;
  }
});

async function handleJoin(roomId, name, token) {
  if (token) {
    session = session || {};
    session.token = token;
  }
  if (!session || !session.token) {
    broadcastPopup({ type: "ws-status", status: "auth-required" });
    return { ok: false, reason: "auth-required" };
  }
  displayName = name || session?.profile?.name || "Guest";
  
  // Verify room exists (but don't auto-navigate)
  try {
    const res = await fetch(`${BACKEND_HTTP}/rooms/${roomId}/join`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.token}`,
      },
    });
    
    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: "join_failed" }));
      return { ok: false, reason: error.error || "join_failed" };
    }
    
    // Room exists, proceed (don't auto-navigate - room creator is already on video)
  } catch (err) {
    console.warn("[Sync] Failed to verify room:", err);
    // Continue anyway - room might still exist in memory
  }
  
  // Clear keys from old room if changing rooms
  if (currentRoom && currentRoom !== roomId) {
    clearPersistedKeys(currentRoom);
    teardownSocket(false, true); // Clear all keys and reset attempts for room change
  } else {
    teardownSocket(true, true); // Preserve keys but reset attempts for rejoining
  }
  
  clearMessageQueue(); // Clear any messages from previous room
  clearOtherRoomMessages(roomId); // Clear messages from other rooms
  currentRoom = roomId;
  pendingSyncRequest = false;
  hasRespondedToSync = false;
  sendToNetflixTabs({ type: "room-update", roomId, name: displayName });
  connectSocket();
  emitLocalSystem("Joined the room");
  console.log(`[Sync] Joined room ${roomId} as creator/host`);
  return { ok: true, roomId };
}

// User-gesture-gated join: opens Netflix tab then joins
async function handleConfirmJoin(roomId, name, token, videoUrl, initialTime) {
  if (token) {
    session = session || {};
    session.token = token;
  }
  if (!session || !session.token) {
    broadcastPopup({ type: "ws-status", status: "auth-required" });
    return { ok: false, reason: "auth-required" };
  }
  displayName = name || session?.profile?.name || "Guest";
  
  console.log(`[Sync] Confirm join: room=${roomId}, video=${videoUrl}, time=${initialTime}`);
  
  // Verify room exists
  try {
    const res = await fetch(`${BACKEND_HTTP}/rooms/${roomId}/join`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.token}`,
      },
    });
    
    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: "join_failed" }));
      return { ok: false, reason: error.error || "join_failed" };
    }
  } catch (err) {
    console.warn("[Sync] Failed to verify room:", err);
    return { ok: false, reason: "network_error" };
  }
  
  // Open Netflix tab with the video (user-gesture triggered from popup)
  if (videoUrl && videoUrl.includes("netflix.com/watch")) {
    await openNetflixVideo(videoUrl);
  }
  
  // Clear keys from old room if changing rooms
  if (currentRoom && currentRoom !== roomId) {
    clearPersistedKeys(currentRoom);
    teardownSocket(false, true); // Clear all keys and reset attempts for room change
  } else {
    teardownSocket(true, true); // Preserve keys but reset attempts for rejoining
  }
  
  clearMessageQueue(); // Clear any messages from previous room
  clearOtherRoomMessages(roomId); // Clear messages from other rooms
  currentRoom = roomId;
  pendingSyncRequest = true; // Will request sync once connected
  hasRespondedToSync = false;
  
  // Send room-update with retries (content script might not be ready immediately)
  sendToNetflixTabs({ type: "room-update", roomId, name: displayName });
  setTimeout(() => sendToNetflixTabs({ type: "room-update", roomId, name: displayName }), 1000);
  setTimeout(() => sendToNetflixTabs({ type: "room-update", roomId, name: displayName }), 3000);
  setTimeout(() => sendToNetflixTabs({ type: "room-update", roomId, name: displayName }), 5000);
  
  connectSocket();
  emitLocalSystem("Joined the room");
  console.log(`[Sync] Joined room ${roomId}, will request sync when video ready`);
  return { ok: true, roomId };
}

// Open Netflix video tab (called from user gesture in popup)
async function openNetflixVideo(url) {
  return new Promise((resolve) => {
    let cleanUrl;
    try {
      const parsed = new URL(url);
      cleanUrl = `https://www.netflix.com${parsed.pathname}`;
    } catch (_) {
      cleanUrl = url;
    }
    
    chrome.tabs.query({ url: "*://*.netflix.com/*" }, (tabs) => {
      if (tabs.length === 0) {
        // No Netflix tab - create one
        console.log("[Sync] Creating new Netflix tab:", cleanUrl);
        chrome.tabs.create({ url: cleanUrl, active: true }, () => resolve());
        return;
      }
      
      const [first] = tabs;
      const currentUrl = first.url || "";
      
      try {
        const targetPath = new URL(cleanUrl).pathname;
        const currentPath = currentUrl.includes("netflix.com") ? new URL(currentUrl).pathname : "";
        
        if (currentPath !== targetPath && targetPath.includes("/watch/")) {
          console.log("[Sync] Navigating existing tab to:", cleanUrl);
          chrome.tabs.update(first.id, { url: cleanUrl, active: true }, () => resolve());
        } else {
          console.log("[Sync] Already on correct video, focusing tab");
          chrome.tabs.update(first.id, { active: true }, () => resolve());
        }
      } catch (_) {
        resolve();
      }
    });
  });
}

async function connectSocket() {
  // Don't tear down if already connecting (prevent double-connect race)
  if (connectionStatus === "connecting") return;
  
  teardownSocket(true); // Preserve keys during reconnection
  if (!currentRoom) return;
  if (!session || !session.token) {
    broadcastPopup({ type: "ws-status", status: "auth-required" });
    return;
  }

  connectionStatus = "connecting";
  broadcastPopup({ type: "ws-status", status: "connecting" });
  sendToNetflixTabs({ type: "ws-status", status: "connecting" });
  
  // Restore persisted peer keys before connecting
  const loadedPeerKeys = await loadPersistedPeerKeys(currentRoom);
  if (loadedPeerKeys > 0) {
    console.log(`[Keys] Restored ${loadedPeerKeys} peer keys from storage`);
  }

  const url = `${BACKEND_WS}?roomId=${encodeURIComponent(
    currentRoom
  )}&token=${encodeURIComponent(session.token)}`;

  try {
    ws = new WebSocket(url);
  } catch (err) {
    console.error("[WS] Failed to create WebSocket:", err);
    scheduleReconnect();
    return;
  }

  ws.addEventListener("open", () => {
    console.log("[WS] Connected to room:", currentRoom);
    clearTimeout(retryTimer);
    retryTimer = null;
    connectionStatus = "connected";
    reconnectAttempts = 0; // Reset on successful connection
    lastPongTime = Date.now();
    broadcastPopup({ type: "ws-status", status: "connected" });
    sendToNetflixTabs({ type: "ws-status", status: "connected" });
    announceKeyExchange();
    startHeartbeat();
    
    // Flush any queued messages after a short delay (wait for key exchange)
    setTimeout(() => {
      if (messageQueue.length > 0) {
        emitLocalSystem(`Sending ${messageQueue.length} queued message${messageQueue.length > 1 ? 's' : ''}...`);
        flushMessageQueue();
      }
    }, 1000);
  });

  ws.addEventListener("message", (event) => {
    try {
      const data = event.data;
      
      // Handle pong responses (server sends back our ping)
      if (data === "pong" || data === '{"type":"pong"}') {
        lastPongTime = Date.now();
        return;
      }
      
      const payload = JSON.parse(data);
      
      // Handle pong as JSON message (response to our ping)
      if (payload.type === "pong") {
        lastPongTime = Date.now();
        return;
      }
      
      // Handle server-initiated ping (respond with pong)
      if (payload.type === "ping") {
        lastPongTime = Date.now(); // Server is alive if it's pinging us
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "pong", ts: Date.now() }));
        }
        return;
      }
      
      routeIncoming(payload);
    } catch (err) {
      console.warn("Bad WS message", err);
    }
  });

  ws.addEventListener("close", (event) => {
    console.log("[WS] Connection closed:", event.code, event.reason);
    stopHeartbeat();
    scheduleReconnect();
  });

  ws.addEventListener("error", (err) => {
    console.error("[WS] Connection error:", err);
    stopHeartbeat();
    // Don't call scheduleReconnect here - 'close' event will fire after 'error'
  });
}

function startHeartbeat() {
  stopHeartbeat();
  lastPongTime = Date.now();
  
  heartbeatInterval = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      stopHeartbeat();
      return;
    }
    
    // Check if we've received a pong recently
    const timeSinceLastPong = Date.now() - lastPongTime;
    if (timeSinceLastPong > HEARTBEAT_TIMEOUT) {
      console.warn("[WS] Heartbeat timeout - no pong received in", timeSinceLastPong, "ms");
      stopHeartbeat();
      ws.close(4000, "Heartbeat timeout");
      return;
    }
    
    // Send ping
    try {
      ws.send(JSON.stringify({ type: "ping", ts: Date.now() }));
    } catch (err) {
      console.warn("[WS] Failed to send ping:", err);
    }
  }, HEARTBEAT_INTERVAL);
}

// Check connection health - useful for detecting zombie connections
function checkConnectionHealth() {
  if (!currentRoom) return;
  
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.log("[WS] Connection health check: not connected, scheduling reconnect");
    scheduleReconnect();
    return;
  }
  
  // Check if pong is overdue
  const timeSinceLastPong = Date.now() - lastPongTime;
  if (timeSinceLastPong > HEARTBEAT_TIMEOUT) {
    console.warn("[WS] Connection health check: stale connection detected, reconnecting");
    ws.close(4001, "Stale connection");
    scheduleReconnect();
  }
}

// Periodically check connection health (catches zombie connections)
setInterval(checkConnectionHealth, 45000);

// Listen for alarm to help with system wake detection
// Service workers can be suspended, this helps recover connections
chrome.alarms?.create?.("flixers-keepalive", { periodInMinutes: 0.5 });
chrome.alarms?.onAlarm?.addListener?.((alarm) => {
  if (alarm.name === "flixers-keepalive" && currentRoom) {
    checkConnectionHealth();
  }
});

function stopHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

// teardownSocket: preserveKeys = true means keep encryption keys (for reconnection)
// preserveKeys = false means clear everything (for room change or explicit leave)
// resetAttempts = true means reset reconnect counter (for explicit leave/room change)
function teardownSocket(preserveKeys = true, resetAttempts = false) {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
  
  // Only clear keys when explicitly changing rooms, not on reconnection
  if (!preserveKeys) {
    console.log("[Keys] Clearing in-memory keys (room change)");
    peerPublicKeys.clear();
    seenUsers.clear();
    keyPairPromise = null;
    publicKeyB64 = null;
    keyPairData = null;
  } else {
    // Persist current keys before reconnection
    if (currentRoom && peerPublicKeys.size > 0) {
      persistPeerKeys(currentRoom);
    }
    console.log("[Keys] Preserving keys for reconnection");
  }
  
  currentParticipants = [];
  connectionStatus = "idle";
  
  // Only reset reconnect attempts when explicitly requested (room change, leave, etc.)
  // NOT during reconnection attempts
  if (resetAttempts) {
    reconnectAttempts = 0;
  }
  
  if (ws) {
    ws.close();
    ws = null;
  }
  playbackState.delete(currentRoom);
}

function scheduleReconnect() {
  stopHeartbeat();
  
  // Don't reconnect if we've left the room intentionally
  if (!currentRoom) {
    connectionStatus = "idle";
    broadcastPopup({ type: "ws-status", status: "idle" });
    sendToNetflixTabs({ type: "ws-status", status: "idle" });
    return;
  }
  
  // Already have a reconnect scheduled or already connecting
  if (retryTimer || connectionStatus === "connecting") {
    console.log("[WS] Reconnect already scheduled or in progress, skipping");
    return;
  }
  
  // Check if we've exceeded max attempts
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.error("[WS] Max reconnect attempts reached, giving up");
    connectionStatus = "disconnected";
    broadcastPopup({ type: "ws-status", status: "disconnected" });
    sendToNetflixTabs({ type: "ws-status", status: "disconnected" });
    emitLocalSystem("Connection lost. Please leave and rejoin the room.");
    
    // After giving up, reset attempts after a delay so manual retry works
    setTimeout(() => {
      if (connectionStatus === "disconnected") {
        reconnectAttempts = 0;
        console.log("[WS] Reset reconnect attempts for future manual retry");
      }
    }, 60000);
    return;
  }
  
  // Calculate exponential backoff delay with jitter to avoid thundering herd
  const baseDelay = Math.min(
    BASE_RECONNECT_DELAY * Math.pow(2, reconnectAttempts),
    MAX_RECONNECT_DELAY
  );
  const jitter = Math.random() * 1000; // Add up to 1s of random jitter
  const delay = Math.floor(baseDelay + jitter);
  reconnectAttempts++;
  
  console.log(`[WS] Scheduling reconnect attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms`);
  connectionStatus = "reconnecting";
  broadcastPopup({ type: "ws-status", status: "reconnecting" });
  sendToNetflixTabs({ type: "ws-status", status: "reconnecting" });
  
  retryTimer = setTimeout(() => {
    retryTimer = null;
    attemptReconnect();
  }, delay);
}

// Attempt to reconnect - verify room still exists before connecting
async function attemptReconnect() {
  if (!currentRoom || !session?.token) {
    connectionStatus = "disconnected";
    broadcastPopup({ type: "ws-status", status: "disconnected" });
    sendToNetflixTabs({ type: "ws-status", status: "disconnected" });
    return;
  }
  
  console.log(`[WS] Attempting reconnect to room ${currentRoom}`);
  
  // Verify room still exists on server
  try {
    const res = await fetch(`${BACKEND_HTTP}/rooms/${currentRoom}/preview`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${session.token}`,
      },
    });
    
    if (!res.ok) {
      // Room no longer exists
      console.error("[WS] Room no longer exists, cannot reconnect");
      connectionStatus = "disconnected";
      broadcastPopup({ type: "ws-status", status: "disconnected" });
      sendToNetflixTabs({ type: "ws-status", status: "disconnected" });
      emitLocalSystem("Room expired. Please create or join a new room.");
      currentRoom = null;
      sendToNetflixTabs({ type: "room-update", roomId: null, name: displayName });
      return;
    }
    
    // Room exists, proceed with WebSocket connection
    console.log("[WS] Room verified, connecting WebSocket...");
  } catch (err) {
    console.warn("[WS] Failed to verify room:", err.message);
    // Continue anyway - might be a network blip
  }
  
  connectSocket();
}

function routeIncoming(message) {
  if (message.type === "state") {
    // Forward state updates to content script for sync
    if (message.payload?.url) {
      lastVideoUrl = message.payload.url;
    }
    console.log("[Sync] Received state - t:", message.payload?.t?.toFixed(1), "paused:", message.payload?.paused);
    sendToNetflixTabs({
      type: "apply-state",
      payload: {
        ...message.payload,
        reason: "sync",  // Mark as sync so content script applies it
        from: message.from || "peer",
      },
    });
  }
  if (message.type === "chat") {
    broadcastPopup({ type: "chat", from: message.from, text: message.text, ts: message.ts });
    sendToNetflixTabs({ type: "chat", from: message.from, text: message.text, ts: message.ts });
  }
  if (message.type === "system") {
    const sys = { type: "system", text: message.text, ts: message.ts || Date.now() };
    broadcastPopup(sys);
    sendToNetflixTabs(sys);
  }
  if (message.type === "presence") {
    const next = message.users || [];
    broadcastPopup({
      type: "presence",
      users: next,
      roomId: currentRoom,
      encryptionRequired: message.encryptionRequired,
    });
    sendToNetflixTabs({
      type: "presence",
      users: next,
      roomId: currentRoom,
      encryptionRequired: message.encryptionRequired,
    });
    if (typeof message.encryptionRequired === "boolean") {
      encryptionRequired = message.encryptionRequired;
    }
    
    // Track participant changes (no system messages - just update count)
    currentParticipants = next;
    
    // DON'T auto-send state when someone joins - they will request sync explicitly
    // This prevents DRM issues from automatic video manipulation
    
    // Announce key exchange for new users
    let announce = false;
    next.forEach((u) => {
      if (!u) return;
      if (!seenUsers.has(u) || !peerPublicKeys.has(u)) {
        announce = true;
      }
      seenUsers.add(u);
    });
    if (announce) {
      announceKeyExchange();
    }
  }
  if (message.type === "key-exchange") {
    handleKeyExchange(message);
  }
  if (message.type === "encrypted") {
    handleEncrypted(message);
  }
  if (message.type === "typing") {
    const typingMsg = {
      type: "typing",
      from: message.from,
      active: !!message.active,
      ts: message.ts || Date.now(),
    };
    broadcastPopup(typingMsg);
    sendToNetflixTabs(typingMsg);
  }
  
  // Sync handshake: someone is requesting sync state
  if (message.type === "sync-request") {
    console.log(`[Sync] Received sync-request from ${message.from}`);
    // Only respond if we haven't already (first responder pattern)
    // Use random delay to avoid multiple peers responding at once
    if (!hasRespondedToSync) {
      const delay = Math.random() * 500 + 100; // 100-600ms random delay
      setTimeout(() => respondToSyncRequest(message.from), delay);
    }
  }
  
  // Sync handshake: received sync state from a peer
  if (message.type === "sync-state") {
    console.log(`[Sync] Received sync-state from ${message.from}: t=${message.time}, paused=${message.paused}`);
    
    // ONLY apply if we were the one who requested sync (joiner)
    // This prevents existing room members from having their video manipulated
    if (!pendingSyncRequest) {
      console.log("[Sync] Ignoring sync-state - we didn't request it (pendingSyncRequest=false)");
      return;
    }
    
    pendingSyncRequest = false;
    
    console.log(`[Sync] Applying sync-state: seeking to ${message.time}s`);
    
    // Apply the sync state to our video (initial sync only)
    sendToNetflixTabs({
      type: "apply-state",
      payload: {
        t: message.time,
        paused: message.paused,
        url: message.url,
        reason: "sync",
        ts: message.ts,
      },
    });
  }
}

// Send sync request to room (called when joiner's video is ready)
function sendSyncRequest() {
  if (!ws || ws.readyState !== WebSocket.OPEN || !currentRoom) {
    console.log("[Sync] Cannot send sync-request: not connected");
    return;
  }
  
  console.log("[Sync] Sending sync-request to room (pendingSyncRequest=" + pendingSyncRequest + ")");
  pendingSyncRequest = true;
  syncRequestTimestamp = Date.now();
  ws.send(JSON.stringify({ type: "sync-request" }));
  
  // Set timeout for sync response
  setTimeout(() => {
    if (pendingSyncRequest && Date.now() - syncRequestTimestamp > 4500) {
      console.log("[Sync] Sync request timed out, no response from peers");
      pendingSyncRequest = false;
      emitLocalSystem("No sync response - play the video to start");
    }
  }, 5000);
}

// Respond to sync request with current playback state
function respondToSyncRequest(requesterName) {
  if (!ws || ws.readyState !== WebSocket.OPEN || !currentRoom) return;
  if (hasRespondedToSync) return; // Already responded
  
  chrome.tabs.query({ url: "*://*.netflix.com/watch/*" }, (tabs) => {
    if (!tabs || tabs.length === 0) {
      console.log("[Sync] Cannot respond to sync-request: no video tab");
      return;
    }
    
    chrome.tabs.sendMessage(tabs[0].id, { type: "get-video-state" }, (response) => {
      if (chrome.runtime.lastError || !response) {
        console.log("[Sync] Cannot respond to sync-request: no video state");
        return;
      }
      
      // Mark as responded to prevent duplicate responses
      hasRespondedToSync = true;
      setTimeout(() => { hasRespondedToSync = false; }, 2000); // Reset after 2s
      
      console.log(`[Sync] Responding to ${requesterName} with state: t=${response.t}`);
      ws.send(JSON.stringify({
        type: "sync-state",
        time: response.t,
        paused: response.paused,
        url: response.url,
      }));
    });
  });
}

function forwardState(payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  emitPlaybackSystem(payload);
  sendEncryptedPayload({ type: "state", payload }).then((sent) => {
    if (!sent && !encryptionRequired) {
      ws.send(JSON.stringify({ type: "state", payload }));
    }
  });
}

// Send current playback state to sync new joiners
function sendCurrentStateToRoom() {
  if (!ws || ws.readyState !== WebSocket.OPEN || !currentRoom) return;
  
  chrome.tabs.query({ url: "*://*.netflix.com/watch/*" }, (tabs) => {
    if (!tabs || tabs.length === 0) return;
    
    chrome.tabs.sendMessage(tabs[0].id, { type: "get-video-state" }, (response) => {
      if (chrome.runtime.lastError || !response) return;
      
      const payload = {
        t: response.t,
        paused: response.paused,
        url: response.url,
        reason: "sync",
        ts: Date.now(),
      };
      
      console.log("[Flixers] Sending state to sync new joiner:", payload.t);
      
      // Send as plaintext state message for immediate sync
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "state", payload }));
      }
    });
  });
}

function sendChat(text) {
  if (!text) return;
  
  const payload = {
    type: "chat",
    text,
    ts: Date.now(),
    avatar: session?.profile?.picture || null,
  };
  
  // If not connected, queue the message
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    queueMessage(payload);
    console.log("[Chat] Message queued (offline):", text.substring(0, 20));
    return;
  }
  
  sendEncryptedPayload(payload).then((sent) => {
    if (!sent) {
      if (!encryptionRequired) {
        // Room doesn't require encryption, send plaintext
        ws.send(JSON.stringify({ type: "chat", text, ts: payload.ts, avatar: payload.avatar }));
      } else if (peerPublicKeys.size === 0) {
        // No peer keys yet - queue and retry after key exchange
        console.log("[Chat] No peer keys yet, queuing message for retry");
        queueMessage(payload);
        // Re-announce our key to request peer keys
        announceKeyExchange();
      }
    }
  });
}

// Queue a message for later delivery
function queueMessage(payload) {
  if (messageQueue.length >= MAX_QUEUE_SIZE) {
    // Remove oldest message if queue is full
    messageQueue.shift();
  }
  messageQueue.push(payload);
}

// Flush queued messages when reconnected
function flushMessageQueue() {
  if (messageQueue.length === 0) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  
  console.log(`[Chat] Flushing ${messageQueue.length} queued messages`);
  
  while (messageQueue.length > 0) {
    const payload = messageQueue.shift();
    
    // Send with slight delay to avoid overwhelming
    setTimeout(() => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        // Re-queue if connection lost
        messageQueue.unshift(payload);
        return;
      }
      
      sendEncryptedPayload(payload).then((sent) => {
        if (!sent && !encryptionRequired) {
          ws.send(JSON.stringify({ 
            type: "chat", 
            text: payload.text, 
            ts: payload.ts, 
            avatar: payload.avatar 
          }));
        }
      });
    }, messageQueue.length * 50); // Stagger by 50ms each
  }
  
  if (messageQueue.length === 0) {
    emitLocalSystem("Queued messages sent");
  }
}

// Clear message queue (when joining new room)
function clearMessageQueue() {
  messageQueue.length = 0;
}

// Clean up old room messages from local storage
async function cleanupOldRoomMessages(exceptRoomId = null) {
  try {
    const items = await chrome.storage.local.get(null);
    const now = Date.now();
    const keysToRemove = [];
    
    for (const [key, value] of Object.entries(items)) {
      // Only process flixers message keys
      if (!key.startsWith("flixers-messages-")) continue;
      
      // Skip current room
      const roomId = key.replace("flixers-messages-", "");
      if (roomId === exceptRoomId) continue;
      
      // Check if messages are old
      if (Array.isArray(value) && value.length > 0) {
        // Get the most recent message timestamp
        const latestTs = Math.max(...value.map(m => m.ts || 0));
        
        // If all messages are older than retention period, remove
        if (now - latestTs > MESSAGE_RETENTION_MS) {
          keysToRemove.push(key);
          console.log(`[Storage] Marking old room messages for cleanup: ${roomId}`);
        }
      }
    }
    
    if (keysToRemove.length > 0) {
      await chrome.storage.local.remove(keysToRemove);
      console.log(`[Storage] Cleaned up ${keysToRemove.length} old room message store(s)`);
    }
  } catch (err) {
    console.warn("[Storage] Failed to cleanup old messages:", err.message);
  }
}

// Clear messages for a specific room
async function clearRoomMessages(roomId) {
  if (!roomId) return;
  try {
    const key = `flixers-messages-${roomId}`;
    await chrome.storage.local.remove(key);
    console.log(`[Storage] Cleared messages for room: ${roomId}`);
  } catch (err) {
    console.warn("[Storage] Failed to clear room messages:", err.message);
  }
}

// Clear all room messages except current
async function clearOtherRoomMessages(currentRoomId) {
  try {
    const items = await chrome.storage.local.get(null);
    const keysToRemove = [];
    
    for (const key of Object.keys(items)) {
      if (!key.startsWith("flixers-messages-")) continue;
      
      const roomId = key.replace("flixers-messages-", "");
      if (roomId !== currentRoomId) {
        keysToRemove.push(key);
      }
    }
    
    if (keysToRemove.length > 0) {
      await chrome.storage.local.remove(keysToRemove);
      console.log(`[Storage] Cleared ${keysToRemove.length} old room message store(s)`);
    }
  } catch (err) {
    console.warn("[Storage] Failed to clear other room messages:", err.message);
  }
}

function sendTyping(active) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const payload = { type: "typing", active, ts: Date.now() };
  sendEncryptedPayload(payload).then((sent) => {
    if (!sent && !encryptionRequired) {
      ws.send(JSON.stringify({ type: "typing", active, ts: payload.ts }));
    }
  });
}

function sendSystem(text) {
  if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
  const payload = { type: "system", text, ts: Date.now() };
  // System messages (play/pause/skip notifications) are always sent as plaintext
  // since they're not sensitive and need to be reliably delivered to all participants
  // regardless of encryption key exchange status
  ws.send(JSON.stringify(payload));
}

function emitPlaybackSystem(payload = {}) {
  if (!currentRoom) return;
  const prev = playbackState.get(currentRoom) || {};
  const next = {
    paused: payload.paused,
    t: typeof payload.t === "number" ? payload.t : prev.t,
  };
  playbackState.set(currentRoom, next);
  if (payload.reason === "time") return;
  const changes = [];
  
  // Detect play/pause changes
  if (typeof payload.paused === "boolean" && payload.paused !== prev.paused) {
    changes.push(payload.paused ? `${displayName} paused` : `${displayName} started playing`);
  }
  
  // Detect significant seeks (> 3 seconds)
  if (
    typeof payload.t === "number" &&
    typeof prev.t === "number" &&
    Math.abs(payload.t - prev.t) > 3
  ) {
    changes.push(`${displayName} skipped to ${formatTime(payload.t)}`);
  }
  
  // Emit locally and broadcast to room
  changes.forEach((text) => {
    emitLocalSystem(text);
    sendSystem(text);
  });
}

function emitLocalSystem(text) {
  const sys = { type: "system", text, ts: Date.now() };
  broadcastPopup(sys);
  sendToNetflixTabs(sys);
}

function formatTime(seconds = 0) {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function broadcastPopup(msg) {
  chrome.runtime.sendMessage(msg, () => {
    // Suppress "Receiving end does not exist" errors when no popup is open
    void chrome.runtime.lastError;
  });
}

chrome.tabs.onRemoved.addListener(() => checkNetflixTabs());
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.url && tab.url.includes("netflix.com")) {
    checkNetflixTabs();
  }
});

// When a tab becomes active, check connection health
// This helps detect zombie connections after system sleep/resume
chrome.tabs.onActivated.addListener((activeInfo) => {
  chrome.tabs.get(activeInfo.tabId, (tab) => {
    if (chrome.runtime.lastError) return;
    if (tab?.url?.includes("netflix.com") && currentRoom) {
      console.log("[WS] Netflix tab activated, checking connection health");
      checkConnectionHealth();
    }
  });
});

function checkNetflixTabs() {
  chrome.tabs
    .query({ url: "*://*.netflix.com/*" })
    .then((tabs) => {
      const present = tabs.length > 0;
      const playing = present ? hasActivePlayback : false;
      updatePlayerStatus(present, playing, lastVideoUrl);
    })
    .catch(() => {});
}

function sendToNetflixTabs(msg) {
  chrome.tabs
    .query({ url: "*://*.netflix.com/*" })
    .then((tabs) =>
      tabs.forEach((tab) => {
        chrome.tabs.sendMessage(tab.id, msg, () => {
          // Suppress "Receiving end does not exist" errors when content script isn't ready
          void chrome.runtime.lastError;
        });
      })
    )
    .catch(() => {});
}

function updatePlayerStatus(present, playing, url) {
  hasNetflixPlayer = !!present;
  hasActivePlayback = !!url && url.includes("netflix.com/watch");
  if (url) {
    lastVideoUrl = url;
  }
  broadcastPopup({
    type: "player-present",
    present: hasNetflixPlayer,
    playing: hasActivePlayback,
    url: lastVideoUrl,
  });
}

function navigateToVideo(url) {
  if (!url || !url.includes("netflix.com/watch")) return;
  chrome.tabs
    .query({ url: "*://*.netflix.com/*" })
    .then((tabs) => {
      if (tabs.length === 0) {
        chrome.tabs.create({ url });
        return;
      }
      const [first] = tabs;
      if (first && first.id) {
        chrome.tabs.update(first.id, { url });
      }
    })
    .catch(() => {});
}

async function announceKeyExchange() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  await ensureKeyPair();
  ws.send(
    JSON.stringify({
      type: "key-exchange",
      publicKey: publicKeyB64,
      curve: ECDH_CURVE,
    })
  );
}

async function ensureKeyPair() {
  if (keyPairPromise) return keyPairPromise;
  
  keyPairPromise = (async () => {
    // Try to load persisted key pair first
    if (currentRoom) {
      const persisted = await loadPersistedKeyPair(currentRoom);
      if (persisted) {
        try {
          // Import the persisted keys
          const publicKeyBuffer = base64ToBuffer(persisted.publicKey);
          const privateKeyBuffer = base64ToBuffer(persisted.privateKey);
          
          const publicKey = await crypto.subtle.importKey(
            "raw",
            publicKeyBuffer,
            { name: "ECDH", namedCurve: ECDH_CURVE },
            true,
            []
          );
          
          const privateKey = await crypto.subtle.importKey(
            "pkcs8",
            privateKeyBuffer,
            { name: "ECDH", namedCurve: ECDH_CURVE },
            true,
            ["deriveKey", "deriveBits"]
          );
          
          publicKeyB64 = persisted.publicKey;
          keyPairData = persisted;
          console.log("[Keys] Using persisted key pair for room:", currentRoom);
          return { publicKey, privateKey };
        } catch (err) {
          console.warn("[Keys] Failed to import persisted keys, generating new:", err.message);
        }
      }
    }
    
    // Generate new key pair
    console.log("[Keys] Generating new key pair");
    const kp = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: ECDH_CURVE },
      true,
      ["deriveKey", "deriveBits"]
    );
    
    // Export keys for persistence
    const publicKeyRaw = await crypto.subtle.exportKey("raw", kp.publicKey);
    const privateKeyPkcs8 = await crypto.subtle.exportKey("pkcs8", kp.privateKey);
    
    publicKeyB64 = bufferToBase64(publicKeyRaw);
    keyPairData = {
      publicKey: publicKeyB64,
      privateKey: bufferToBase64(privateKeyPkcs8),
    };
    
    // Persist the new key pair
    if (currentRoom) {
      await persistKeyPair(currentRoom, keyPairData.publicKey, keyPairData.privateKey);
    }
    
    return kp;
  })();
  
  return keyPairPromise;
}

async function handleKeyExchange(message) {
  if (!message?.publicKey || !message.from || message.from === displayName) return;
  
  const hadNoPeers = peerPublicKeys.size === 0;
  
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      base64ToBuffer(message.publicKey),
      { name: "ECDH", namedCurve: message.curve || ECDH_CURVE },
      true, // extractable so we can persist
      []
    );
    peerPublicKeys.set(message.from, key);
    console.log("[Keys] Received and stored key from:", message.from);
    
    // Persist peer keys after update
    if (currentRoom) {
      // Debounce persistence to avoid too many writes
      if (handleKeyExchange._persistTimer) {
        clearTimeout(handleKeyExchange._persistTimer);
      }
      handleKeyExchange._persistTimer = setTimeout(() => {
        persistPeerKeys(currentRoom);
      }, 500);
    }
    
    // If we just got our first peer key and have queued messages, flush them
    if (hadNoPeers && peerPublicKeys.size > 0 && messageQueue.length > 0) {
      console.log("[Keys] First peer key received, flushing queued messages");
      setTimeout(() => flushMessageQueue(), 200);
    }
  } catch (err) {
    console.warn("Failed to store peer key", err);
  }
}
handleKeyExchange._persistTimer = null;

async function handleEncrypted(message) {
  if (message.recipient && message.recipient !== displayName) return;
  if (!message.from) return;
  const peerKey = peerPublicKeys.get(message.from);
  const keyPair = await ensureKeyPair();
  if (!peerKey || !keyPair) return;

  try {
    const salt = message.salt ? base64ToBuffer(message.salt) : new Uint8Array();
    const aesKey = await deriveAesKeyFromPeer(keyPair.privateKey, peerKey, salt);
    const decrypted = await decryptWithAes(message, aesKey);
    routeDecryptedPayload(decrypted, message.from);
  } catch (err) {
    // Ignore decrypt failures; message may have targeted another peer.
  }
}

function routeDecryptedPayload(payload, from) {
  if (!payload || typeof payload !== "object") return;
  if (payload.type === "chat") {
    const msg = {
      type: "chat",
      from,
      text: payload.text,
      ts: payload.ts || Date.now(),
      avatar: payload.avatar,
    };
    broadcastPopup(msg);
    sendToNetflixTabs(msg);
    return;
  }
  if (payload.type === "typing") {
    const typingMsg = { type: "typing", from, active: !!payload.active, ts: payload.ts || Date.now() };
    broadcastPopup(typingMsg);
    sendToNetflixTabs(typingMsg);
    return;
  }
  if (payload.type === "state") {
    // Forward state updates to content script for sync
    console.log("[Sync] Received state from", from, "- t:", payload.payload?.t?.toFixed(1), "paused:", payload.payload?.paused);
    sendToNetflixTabs({
      type: "apply-state",
      payload: {
        ...payload.payload,
        reason: "sync",  // Mark as sync so content script applies it
        from,
      },
    });
    return;
  }
}

async function sendEncryptedPayload(payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  await ensureKeyPair();
  const peers = Array.from(peerPublicKeys.keys());
  if (!peers.length) return false;

  let sent = 0;
  await Promise.all(
    peers.map(async (peer) => {
      const peerKey = peerPublicKeys.get(peer);
      if (!peerKey) return;
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const keyPair = await ensureKeyPair();
      const aesKey = await deriveAesKeyFromPeer(keyPair.privateKey, peerKey, salt);
      const { ciphertext, tag } = await encryptWithAes(payload, aesKey, iv);
      sent += 1;
      ws.send(
        JSON.stringify({
          type: "encrypted",
          ciphertext,
          iv: bufferToBase64(iv),
          tag,
          salt: bufferToBase64(salt),
          alg: "aes-256-gcm",
          recipient: peer,
        })
      );
    })
  );
  return sent > 0;
}

async function deriveAesKeyFromPeer(privateKey, peerKey, salt) {
  const secret = await crypto.subtle.deriveBits(
    { name: "ECDH", public: peerKey },
    privateKey,
    256
  );
  const hkdfKey = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      salt,
      info: encoder.encode("flixers-e2e"),
      hash: "SHA-256",
    },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function encryptWithAes(payload, key, iv) {
  const combined = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, tagLength: 128 },
      key,
      encoder.encode(JSON.stringify(payload))
    )
  );
  const tag = combined.slice(combined.length - 16);
  const ciphertext = combined.slice(0, combined.length - 16);
  return {
    ciphertext: bufferToBase64(ciphertext),
    tag: bufferToBase64(tag),
  };
}

async function decryptWithAes(message, key) {
  const ciphertext = base64ToBuffer(message.ciphertext || "");
  const tag = base64ToBuffer(message.tag || "");
  const iv = base64ToBuffer(message.iv || "");
  const combined = new Uint8Array(ciphertext.byteLength + tag.byteLength);
  combined.set(new Uint8Array(ciphertext), 0);
  combined.set(new Uint8Array(tag), ciphertext.byteLength);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, tagLength: 128 },
    key,
    combined
  );
  return JSON.parse(decoder.decode(plaintext));
}

function bufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = "";
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary);
}

function base64ToBuffer(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

// Lightweight helper to call backend REST endpoints from popup (create room).
chrome.runtime.onMessageExternal?.addListener((_message, _sender, sendResponse) => {
  // Reserved for future integrations.
  sendResponse({ ok: false, reason: "not-implemented" });
});

// ============ Google OAuth Flow (runs in background, survives popup close) ============

async function handleGoogleSignIn() {
  if (!GOOGLE_CLIENT_ID) {
    throw new Error("GOOGLE_CLIENT_ID not configured");
  }
  
  console.log("[Auth] Starting Google OAuth flow in background");
  
  try {
    // Build OAuth URL
    const redirectUri = `https://${chrome.runtime.id}.chromiumapp.org/`;
    const nonce = generateNonce();
    const params = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: "id_token",
      scope: "openid email profile",
      nonce: nonce,
      prompt: "select_account",
    });
    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
    
    console.log("[Auth] Launching web auth flow");
    
    // Launch OAuth flow
    const redirectUrl = await new Promise((resolve, reject) => {
      chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true }, (result) => {
        if (chrome.runtime.lastError) {
          console.error("[Auth] launchWebAuthFlow error:", chrome.runtime.lastError);
          reject(new Error(chrome.runtime.lastError.message || "auth_error"));
        } else if (!result) {
          reject(new Error("no_redirect_url"));
        } else {
          resolve(result);
        }
      });
    });
    
    console.log("[Auth] Got redirect URL, extracting token");
    
    // Extract ID token from redirect URL
    const idToken = extractIdToken(redirectUrl);
    if (!idToken) {
      throw new Error("no_token_in_redirect");
    }
    
    console.log("[Auth] Exchanging token with backend");
    
    // Exchange with backend
    const res = await fetch(`${BACKEND_HTTP}/auth/google`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken }),
    });
    
    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      throw new Error(errorData.error || "exchange_failed");
    }
    
    const data = await res.json();
    const newSession = { token: data.token, profile: data.profile };
    
    console.log("[Auth] Token exchanged successfully, saving session");
    
    // Save session
    session = newSession;
    displayName = session.profile?.name || "Guest";
    await chrome.storage.local.set({ flixersSession: newSession });
    
    // Notify popup and content scripts
    broadcastPopup({ type: "auth", session: newSession });
    sendToNetflixTabs({ type: "auth", session: newSession });
    
    console.log("[Auth] Sign-in complete:", displayName);
    
    return { ok: true, session: newSession };
  } catch (err) {
    console.error("[Auth] Sign-in failed:", err);
    throw err;
  }
}

function generateNonce() {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
}

function extractIdToken(redirectUrl) {
  try {
    const fragment = redirectUrl.split("#")[1] || "";
    const params = new URLSearchParams(fragment);
    return params.get("id_token");
  } catch (err) {
    console.error("[Auth] Failed to extract ID token:", err);
    return null;
  }
}
