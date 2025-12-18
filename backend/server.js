const { createServer } = require("http");
const { randomUUID } = require("crypto");
const express = require("express");
const cors = require("cors");
const { WebSocketServer } = require("ws");
const { OAuth2Client } = require("google-auth-library");
const jwt = require("jsonwebtoken");

// Redis integration with fallback
let redis = null;
if (!process.env.JEST_WORKER_ID) {
  try {
    redis = require("./redis");
    console.log("[Redis] Module loaded, will attempt connection");
  } catch (err) {
    console.warn("[Redis] Module not available, using in-memory storage only");
  }
}

const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const NODE_ENV = process.env.NODE_ENV || "development";

// Validate required environment variables in production
if (NODE_ENV === "production") {
  if (!JWT_SECRET || JWT_SECRET === "dev-secret") {
    console.error("ERROR: JWT_SECRET must be set in production!");
    process.exit(1);
  }
  if (!GOOGLE_CLIENT_ID) {
    console.warn("WARNING: GOOGLE_CLIENT_ID not set - auth will use dev mode");
  }
}

const app = express();

// CORS configuration
const corsOptions = {
  origin: process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(",")
    : NODE_ENV === "production"
      ? [] // Must be set in production
      : "*", // Allow all in development
  credentials: true,
};
app.use(cors(corsOptions));
app.use(express.json());

const oauthClient = new OAuth2Client(GOOGLE_CLIENT_ID || undefined);
// In-memory room storage: roomId -> { clients, encryptionRequired, videoUrl, titleId, initialTime, deletionTimer }
const rooms = new Map();

const { ROOM_CLEANUP_DELAY_MS } = require("./roomLifecycle");

// Room cleanup delay - keep empty rooms for 1 day before deletion
const ROOM_CLEANUP_DELAY = ROOM_CLEANUP_DELAY_MS;

function formatRoomCleanupDelay(ms) {
  const minutes = Math.round(ms / 60000);
  if (minutes % (60 * 24) === 0) {
    const days = minutes / (60 * 24);
    return `${days} day${days === 1 ? "" : "s"}`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  return `${minutes} min`;
}

// Health check endpoint
app.get("/health", (req, res) => {
  const health = {
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: NODE_ENV,
    services: {
      redis: redis && redis.isRedisConnected() ? "connected" : "disconnected",
    },
  };
  res.json(health);
});

app.post("/auth/google", async (req, res) => {
  const idToken = req.body?.idToken;
  if (!idToken) {
    return res.status(400).json({ error: "idToken required" });
  }

  try {
    const profile = await verifyGoogleIdToken(idToken);
    const token = issueSessionToken(profile);
    res.json({ token, profile: sanitizeProfile(profile) });
  } catch (err) {
    console.error("Auth failed", err.message || err);
    res.status(401).json({ error: "invalid_token" });
  }
});

app.post("/rooms", authRequired, async (req, res) => {
  const roomId = randomUUID().slice(0, 8);
  const encryptionRequired = coerceBoolean(
    req.body?.encryptionRequired,
    defaultEncryptionRequired()
  );
  
  // Extract video metadata from request
  const videoUrl = req.body?.videoUrl || "";
  const titleId = extractTitleId(videoUrl);
  const initialTime = Math.floor(Number(req.body?.videoTime) || 0);
  
  const roomOpts = { encryptionRequired, videoUrl, titleId, initialTime };
  
  // Store in Redis if available
  if (redis && redis.isRedisConnected()) {
    try {
      await redis.createRoom(roomId, roomOpts);
      console.log(`[Room] Created ${roomId} in Redis (video: ${titleId}, time: ${initialTime}s)`);
    } catch (err) {
      console.warn("[Redis] Failed to create room, using memory:", err.message);
    }
  }
  
  // Always store in memory for WebSocket clients
  ensureRoom(roomId, roomOpts);
  
  res.json({
    roomId,
    encryptionRequired,
    videoUrl,
    titleId,
    initialTime,
    user: sanitizeProfile(req.user),
  });
});

app.post("/rooms/:id/join", authRequired, async (req, res) => {
  const { id } = req.params;
  
  // Try Redis first, then memory
  let roomData = null;
  if (redis && redis.isRedisConnected()) {
    try {
      roomData = await redis.getRoom(id);
    } catch (err) {
      console.warn("[Redis] Failed to get room:", err.message);
    }
  }
  
  const room = rooms.get(id);
  if (!room && !roomData) {
    return res.status(404).json({ error: "Room not found" });
  }
  
  // Merge Redis data with memory data (memory takes precedence for live state)
  const videoUrl = room?.videoUrl || roomData?.videoUrl || "";
  const titleId = room?.titleId || roomData?.titleId || extractTitleId(videoUrl);
  const initialTime = room?.initialTime ?? roomData?.videoTime ?? 0;
  const encryptionRequired = room?.encryptionRequired ?? roomData?.encryptionRequired ?? false;
  
  res.json({
    roomId: id,
    name: req.user?.name || "Guest",
    encryptionRequired,
    videoUrl,
    titleId,
    initialTime,
  });
});

// Preview room info without joining (for confirmation step)
app.get("/rooms/:id/preview", authRequired, async (req, res) => {
  const { id } = req.params;
  
  // Try Redis first, then memory
  let roomData = null;
  if (redis && redis.isRedisConnected()) {
    try {
      roomData = await redis.getRoom(id);
    } catch (err) {
      console.warn("[Redis] Failed to get room for preview:", err.message);
    }
  }
  
  const room = rooms.get(id);
  if (!room && !roomData) {
    return res.status(404).json({ error: "Room not found" });
  }
  
  const videoUrl = room?.videoUrl || roomData?.videoUrl || "";
  const titleId = room?.titleId || roomData?.titleId || extractTitleId(videoUrl);
  const initialTime = room?.initialTime ?? roomData?.videoTime ?? 0;
  const participantCount = room?.clients?.size || 0;
  
  res.json({
    roomId: id,
    videoUrl,
    titleId,
    initialTime,
    participantCount,
    exists: true,
  });
});

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

// Connection keepalive configuration
const PING_INTERVAL = 15000; // Send ping every 15 seconds (matching client)
const ACTIVITY_TIMEOUT = 7200000; // Consider connection dead after 2 hours of no activity

let pingInterval = null;

function startPingInterval() {
  if (pingInterval) return;
  // Start server-side ping interval - uses both native ping AND checks activity
  pingInterval = setInterval(() => {
    const now = Date.now();
    
    wss.clients.forEach((socket) => {
      // Check activity timeout first
      const lastActivity = socket.lastActivity || 0;
      const timeSinceActivity = now - lastActivity;
      
      if (timeSinceActivity > ACTIVITY_TIMEOUT) {
        console.log(`[WS] Terminating inactive connection (no activity for ${Math.round(timeSinceActivity / 1000)}s)`);
        return socket.terminate();
      }
      
      // Check if native ping was answered
      if (socket.isAlive === false) {
        console.log("[WS] Terminating stale connection (no pong response)");
        return socket.terminate();
      }
      
      // Send native ping and mark as waiting for pong
      socket.isAlive = false;
      socket.ping();
      
      // Also send JSON ping for clients that may not respond to native pings
      if (socket.readyState === 1) {
        try {
          socket.send(JSON.stringify({ type: "ping", ts: now }));
        } catch (err) {
          console.warn("[WS] Failed to send JSON ping:", err.message);
        }
      }
    });
  }, PING_INTERVAL);
}

wss.on("close", () => {
  if (pingInterval) {
    clearInterval(pingInterval);
    pingInterval = null;
  }
});

wss.on("connection", (socket, req) => {
  const params = new URL(req.url, `http://${req.headers.host}`).searchParams;
  const roomId = params.get("roomId");
  const token = params.get("token");

  if (!roomId || !token) {
    socket.close();
    return;
  }

  const session = verifySessionToken(token);
  if (!session) {
    socket.close();
    return;
  }

  const name = session.name || "Guest";
  const picture = session.picture || null;
  const room = ensureRoom(roomId);
  const client = { socket, name, sub: session.sub, picture };
  room.clients.add(client);
  
  // Mark connection as alive
  socket.isAlive = true;
  socket.lastActivity = Date.now();
  
  console.log(`[join] ${name} -> ${roomId} (enc=${room.encryptionRequired})`);
  broadcastPresence(roomId);

  // Handle WebSocket native pong (response to our ping)
  socket.on("pong", () => {
    socket.isAlive = true;
    socket.lastActivity = Date.now();
  });

  socket.on("message", (raw) => {
    // Mark connection as alive on ANY message received
    socket.isAlive = true;
    socket.lastActivity = Date.now();
    
    try {
      const msg = JSON.parse(raw.toString());
      
      // Handle client-initiated ping - respond AND keep connection alive
      if (msg.type === "ping") {
        if (socket.readyState === 1) {
          socket.send(JSON.stringify({ type: "pong", ts: Date.now() }));
        }
        return;
      }
      
      // Handle pong responses to our server-initiated pings
      if (msg.type === "pong") {
        // CRITICAL: Mark connection as alive when we receive pong
        socket.isAlive = true;
        socket.lastActivity = Date.now();
        return;
      }
      
      handleMessage(roomId, client, msg);
    } catch (err) {
      console.warn("Bad message", err);
    }
  });

  socket.on("close", () => {
    const currentRoom = rooms.get(roomId);
    if (!currentRoom) return;
    currentRoom.clients.delete(client);
    console.log(`[leave] ${name} -> ${roomId}`);
    broadcastPresence(roomId);
    
    // Schedule room cleanup when empty (after ROOM_CLEANUP_DELAY)
    if (currentRoom.clients.size === 0) {
      // Clear any existing deletion timer
      if (currentRoom.deletionTimer) {
        clearTimeout(currentRoom.deletionTimer);
      }
      
      console.log(
        `[Room] ${roomId} is now empty, scheduling deletion in ${formatRoomCleanupDelay(ROOM_CLEANUP_DELAY)}`
      );
      currentRoom.deletionTimer = setTimeout(() => {
        const room = rooms.get(roomId);
        // Only delete if still empty
        if (room && room.clients.size === 0) {
          console.log(`[Room] Deleting empty room ${roomId} after timeout`);
          rooms.delete(roomId);
        }
      }, ROOM_CLEANUP_DELAY);
    }
  });

  socket.on("error", (err) => {
    console.warn(`[WS] Socket error for ${name} in ${roomId}:`, err.message);
  });
});

function start(port = PORT) {
  startPingInterval();
  return server.listen(port, () => {
    console.log(`API listening on :${port}`);
    console.log(`Environment: ${NODE_ENV}`);
    console.log(`Redis: ${redis ? "enabled" : "disabled"}`);
  });
}

// Graceful shutdown handling
process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down gracefully...");
  stop(() => {
    console.log("Server closed");
    process.exit(0);
  });
});

process.on("SIGINT", () => {
  console.log("SIGINT received, shutting down gracefully...");
  stop(() => {
    console.log("Server closed");
    process.exit(0);
  });
});

function stop(cb) {
  if (pingInterval) {
    clearInterval(pingInterval);
    pingInterval = null;
  }
  wss.close(() => server.close(cb));
}

if (require.main === module) {
  start();
}

function ensureRoom(roomId, opts = {}) {
  if (!rooms.has(roomId)) {
    const encryptionRequired = coerceBoolean(
      opts.encryptionRequired,
      defaultEncryptionRequired()
    );
    rooms.set(roomId, {
      clients: new Set(),
      encryptionRequired,
      videoUrl: opts.videoUrl || "",
      titleId: opts.titleId || "",
      initialTime: opts.initialTime || 0,
      deletionTimer: null,
    });
  } else {
    const room = rooms.get(roomId);
    
    // Cancel any pending deletion timer (someone is joining)
    if (room.deletionTimer) {
      console.log(`[Room] Cancelling deletion timer for ${roomId} - user joining`);
      clearTimeout(room.deletionTimer);
      room.deletionTimer = null;
    }
    
    if (opts.encryptionRequired !== undefined) {
      room.encryptionRequired = coerceBoolean(
        opts.encryptionRequired,
        room.encryptionRequired
      );
    }
    // Update video metadata if provided
    if (opts.videoUrl !== undefined) room.videoUrl = opts.videoUrl;
    if (opts.titleId !== undefined) room.titleId = opts.titleId;
    if (opts.initialTime !== undefined) room.initialTime = opts.initialTime;
  }
  return rooms.get(roomId);
}

// Extract Netflix title ID from URL
function extractTitleId(url) {
  if (!url) return "";
  try {
    const match = url.match(/netflix\.com\/watch\/(\d+)/);
    return match ? match[1] : "";
  } catch (_) {
    return "";
  }
}

function handleMessage(roomId, client, msg) {
  if (!msg || typeof msg !== "object") return;

  const encryptionRequired = isEncryptionRequired(roomId);
  const allowsPlaintext =
    msg.type === "encrypted" ||
    msg.type === "key-exchange" ||
    msg.type === "system" ||
    msg.type === "episode-changed" ||
    msg.type === "sync-request" ||  // Allow sync messages even in encrypted rooms
    msg.type === "sync-state" ||     // Allow sync messages even in encrypted rooms
    !encryptionRequired;

  if (!allowsPlaintext) {
    console.warn(
      `Dropped plaintext message type=${msg.type} for encrypted room ${roomId}`
    );
    return;
  }

  if (msg.type === "state") {
    broadcast(roomId, { type: "state", payload: msg.payload }, client);
    return;
  }
  if (msg.type === "chat") {
    const ts = typeof msg.ts === "number" ? msg.ts : Date.now();
    broadcast(
      roomId,
      {
        type: "chat",
        text: msg.text,
        from: client.name,
        fromId: client.sub,
        avatar: msg.avatar || client.picture || null,
        ts,
      },
      null
    );
    return;
  }
  if (msg.type === "system") {
    const ts = typeof msg.ts === "number" ? msg.ts : Date.now();
    broadcast(roomId, { type: "system", text: msg.text, ts }, null);
    return;
  }
  if (msg.type === "typing") {
    broadcast(
      roomId,
      { type: "typing", from: client.name, fromId: client.sub, active: !!msg.active, ts: Date.now() },
      client
    );
    return;
  }
  if (msg.type === "episode-changed") {
    const url = isNonEmptyString(msg.url) ? msg.url : "";
    if (!url) return;
    const ts = typeof msg.ts === "number" ? msg.ts : Date.now();
    const seq = Number.isFinite(msg.seq) ? Number(msg.seq) : undefined;
    const payload = { type: "episode-changed", url, from: client.name, fromId: client.sub, ts };
    if (isNonEmptyString(msg.title)) {
      payload.title = msg.title;
    }
    if (seq !== undefined) {
      payload.seq = seq;
    }
    broadcast(roomId, payload, client);
    return;
  }
  if (msg.type === "key-exchange") {
    const { publicKey, curve } = msg;
    if (!isNonEmptyString(publicKey)) return;
    broadcast(
      roomId,
      {
        type: "key-exchange",
        publicKey,
        curve: isNonEmptyString(curve) ? curve : "secp256k1",
        from: client.name,
        fromId: client.sub,
      },
      client
    );
    return;
  }
  if (msg.type === "encrypted") {
    const { ciphertext, iv, tag, alg, salt } = msg;
    if (!isNonEmptyString(ciphertext) || !isNonEmptyString(iv)) return;
    broadcast(
      roomId,
      {
        type: "encrypted",
        ciphertext,
        iv,
        tag: isNonEmptyString(tag) ? tag : undefined,
        salt: isNonEmptyString(salt) ? salt : undefined,
        alg: isNonEmptyString(alg) ? alg : "aes-256-gcm",
        from: client.name,
        fromId: client.sub,
        ts: Date.now(),
      },
      null
    );
    return;
  }
  
  // Sync handshake: joiner requests current state from peers
  if (msg.type === "sync-request") {
    console.log(`[Sync] ${client.name} requesting sync in ${roomId}`);
    broadcast(
      roomId,
      {
        type: "sync-request",
        from: client.name,
        fromId: client.sub,
        ts: Date.now(),
      },
      client
    );
    return;
  }
  
  // Sync handshake: peer responds with current playback state
  if (msg.type === "sync-state") {
    const { time, paused, url } = msg;
    console.log(`[Sync] ${client.name} responding with state: t=${time}, paused=${paused}`);
    broadcast(
      roomId,
      {
        type: "sync-state",
        time: typeof time === "number" ? time : 0,
        paused: typeof paused === "boolean" ? paused : true,
        url: isNonEmptyString(url) ? url : "",
        from: client.name,
        fromId: client.sub,
        ts: Date.now(),
      },
      client
    );
    
    // Update room's video state in Redis if available
    if (redis && redis.isRedisConnected() && url) {
      redis.updateRoomVideoState(roomId, url, time).catch(() => {});
    }
    return;
  }
}

function broadcast(roomId, message, skipClient) {
  const room = rooms.get(roomId);
  if (!room) return;
  const payload = JSON.stringify(message);
  room.clients.forEach((member) => {
    if (skipClient && member === skipClient) return;
    if (member.socket.readyState === 1) {
      member.socket.send(payload);
    }
  });
}

function broadcastPresence(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  const participants = Array.from(room.clients).map((c) => ({
    id: c.sub,
    name: c.name,
    picture: c.picture || null,
  }));
  // Backwards-compatible shape (display-only, may contain duplicates).
  const users = participants.map((p) => p.name);
  const avatars = {};
  participants.forEach((p) => {
    if (p.picture) {
      avatars[p.id] = p.picture;
    }
  });
  broadcast(
    roomId,
    {
      type: "presence",
      participants,
      users,
      avatars,
      encryptionRequired: room.encryptionRequired,
    },
    null
  );
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function coerceBoolean(value, fallback) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") return true;
    if (value.toLowerCase() === "false") return false;
  }
  return fallback;
}

function defaultEncryptionRequired() {
  return process.env.REQUIRE_ENCRYPTION === "true";
}

function isEncryptionRequired(roomId) {
  const room = rooms.get(roomId);
  if (room && typeof room.encryptionRequired === "boolean") {
    return room.encryptionRequired;
  }
  return defaultEncryptionRequired();
}

async function verifyGoogleIdToken(idToken) {
  if (!GOOGLE_CLIENT_ID) {
    const decoded = safeDecode(idToken);
    console.warn("GOOGLE_CLIENT_ID not set; skipping Google verification (dev mode)");
    if (decoded?.name) return decoded;
    return { sub: "dev-user", name: "Dev User", email: "dev@example.com" };
  }
  const ticket = await oauthClient.verifyIdToken({
    idToken,
    audience: GOOGLE_CLIENT_ID,
  });
  return ticket.getPayload();
}

function issueSessionToken(profile) {
  if (!JWT_SECRET) {
    throw new Error("JWT_SECRET not configured");
  }
  const payload = {
    sub: profile.sub,
    name: profile.name,
    email: profile.email,
    picture: profile.picture,
  };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "12h" });
}

function verifySessionToken(token) {
  if (!JWT_SECRET) {
    console.warn("JWT_SECRET not configured, cannot verify tokens");
    return null;
  }
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (err) {
    console.warn("Invalid session token", err.message || err);
    return null;
  }
}

function sanitizeProfile(profile = {}) {
  return {
    sub: profile.sub,
    name: profile.name || "Guest",
    email: profile.email,
    picture: profile.picture,
  };
}

function authRequired(req, res, next) {
  const header = req.headers.authorization || "";
  const token = extractBearer(header);
  if (!token) return res.status(401).json({ error: "auth_required" });
  const session = verifySessionToken(token);
  if (!session) return res.status(401).json({ error: "invalid_token" });
  req.user = session;
  next();
}

function extractBearer(header) {
  if (!header) return null;
  const [scheme, value] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer") return null;
  return value;
}

function safeDecode(token) {
  try {
    return jwt.decode(token) || null;
  } catch (err) {
    return null;
  }
}

module.exports = {
  app,
  server,
  start,
  stop,
  rooms,
  ensureRoom,
  handleMessage,
  verifySessionToken,
  issueSessionToken,
};
