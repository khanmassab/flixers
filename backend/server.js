const { createServer } = require("http");
const { randomUUID } = require("crypto");
const express = require("express");
const cors = require("cors");
const { WebSocketServer } = require("ws");
const { OAuth2Client } = require("google-auth-library");
const jwt = require("jsonwebtoken");

const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";

const app = express();
app.use(cors());
app.use(express.json());

const oauthClient = new OAuth2Client(GOOGLE_CLIENT_ID || undefined);
const rooms = new Map(); // roomId -> { clients: Set<{ socket, name, sub }>, encryptionRequired: boolean }

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

app.post("/rooms", authRequired, (req, res) => {
  const roomId = randomUUID().slice(0, 8);
  const encryptionRequired = coerceBoolean(
    req.body?.encryptionRequired,
    defaultEncryptionRequired()
  );
  ensureRoom(roomId, { encryptionRequired });
  res.json({
    roomId,
    encryptionRequired,
    user: sanitizeProfile(req.user),
  });
});

app.post("/rooms/:id/join", authRequired, (req, res) => {
  const { id } = req.params;
  const room = rooms.get(id);
  if (!room) {
    return res.status(404).json({ error: "Room not found" });
  }
  res.json({
    roomId: id,
    name: req.user?.name || "Guest",
    encryptionRequired: room.encryptionRequired,
  });
});

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

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
  const room = ensureRoom(roomId);
  const client = { socket, name, sub: session.sub };
  room.clients.add(client);
  console.log(`[join] ${name} -> ${roomId} (enc=${room.encryptionRequired})`);
  broadcastPresence(roomId);

  socket.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
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
    if (currentRoom.clients.size === 0) {
      rooms.delete(roomId);
    }
  });
});

function start(port = PORT) {
  return server.listen(port, () => {
    console.log(`API listening on :${port}`);
  });
}

function stop(cb) {
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
    rooms.set(roomId, { clients: new Set(), encryptionRequired });
  } else if (opts.encryptionRequired !== undefined) {
    const room = rooms.get(roomId);
    room.encryptionRequired = coerceBoolean(
      opts.encryptionRequired,
      room.encryptionRequired
    );
  }
  return rooms.get(roomId);
}

function handleMessage(roomId, client, msg) {
  if (!msg || typeof msg !== "object") return;

  const encryptionRequired = isEncryptionRequired(roomId);
  const allowsPlaintext =
    msg.type === "encrypted" || msg.type === "key-exchange" || !encryptionRequired;

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
    broadcast(
      roomId,
      { type: "chat", text: msg.text, from: client.name, ts: Date.now() },
      null
    );
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
        ts: Date.now(),
      },
      null
    );
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
  const users = Array.from(room.clients).map((c) => c.name);
  broadcast(
    roomId,
    { type: "presence", users, encryptionRequired: room.encryptionRequired },
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
  const payload = {
    sub: profile.sub,
    name: profile.name,
    email: profile.email,
    picture: profile.picture,
  };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "12h" });
}

function verifySessionToken(token) {
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
