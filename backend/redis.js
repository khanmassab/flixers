const Redis = require("ioredis");

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

// Main Redis client for commands
const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 3,
  retryDelayOnFailover: 100,
  lazyConnect: true,
});

// Separate client for Pub/Sub subscriber (required by Redis)
const subscriber = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 3,
  lazyConnect: true,
});

// Separate client for Pub/Sub publisher
const publisher = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 3,
  lazyConnect: true,
});

// Connection status
let isConnected = false;

redis.on("connect", () => {
  isConnected = true;
  console.log("[Redis] Connected");
});

redis.on("error", (err) => {
  isConnected = false;
  console.error("[Redis] Error:", err.message);
});

// ============ Cache Utilities ============

const CACHE_TTL = {
  USER: 300,           // 5 minutes
  PREFERENCES: 300,    // 5 minutes
  FRIENDS: 60,         // 1 minute
  ROOM: 86400,         // 1 day (24 hours)
};

/**
 * Get cached value, or fetch and cache if not exists
 */
async function getOrSet(key, fetchFn, ttl = 300) {
  try {
    const cached = await redis.get(key);
    if (cached) {
      return JSON.parse(cached);
    }
  } catch (err) {
    console.warn("[Redis] Cache get error:", err.message);
  }

  const value = await fetchFn();
  if (value !== null && value !== undefined) {
    try {
      await redis.setex(key, ttl, JSON.stringify(value));
    } catch (err) {
      console.warn("[Redis] Cache set error:", err.message);
    }
  }
  return value;
}

/**
 * Invalidate cache key(s)
 */
async function invalidate(...keys) {
  try {
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  } catch (err) {
    console.warn("[Redis] Cache invalidate error:", err.message);
  }
}

/**
 * Invalidate all keys matching pattern
 */
async function invalidatePattern(pattern) {
  try {
    const keys = await redis.keys(pattern);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  } catch (err) {
    console.warn("[Redis] Cache invalidate pattern error:", err.message);
  }
}

// ============ Session Management ============

const SESSION_TTL = 43200; // 12 hours in seconds

/**
 * Store session token
 */
async function setSession(userId, token, ttl = SESSION_TTL) {
  try {
    await redis.setex(`session:${userId}`, ttl, token);
    // Also store token -> userId mapping for validation
    await redis.setex(`token:${token}`, ttl, userId);
  } catch (err) {
    console.warn("[Redis] Session set error:", err.message);
  }
}

/**
 * Check if session is valid
 */
async function isSessionValid(userId, token) {
  try {
    const storedToken = await redis.get(`session:${userId}`);
    return storedToken === token;
  } catch (err) {
    console.warn("[Redis] Session check error:", err.message);
    return true; // Fail open if Redis is down
  }
}

/**
 * Invalidate session (logout)
 */
async function invalidateSession(userId) {
  try {
    const token = await redis.get(`session:${userId}`);
    if (token) {
      await redis.del(`token:${token}`);
    }
    await redis.del(`session:${userId}`);
  } catch (err) {
    console.warn("[Redis] Session invalidate error:", err.message);
  }
}

/**
 * Invalidate all sessions for a user
 */
async function invalidateAllSessions(userId) {
  await invalidateSession(userId);
}

// ============ Room State Management ============

/**
 * Create or update room in Redis
 */
async function createRoom(roomId, options = {}) {
  const roomKey = `room:${roomId}`;
  const roomData = {
    id: roomId,
    encryptionRequired: options.encryptionRequired || false,
    videoUrl: options.videoUrl || "",
    videoTime: options.videoTime || 0,
    createdAt: Date.now(),
  };
  
  try {
    await redis.hset(roomKey, roomData);
    await redis.expire(roomKey, CACHE_TTL.ROOM);
  } catch (err) {
    console.warn("[Redis] Create room error:", err.message);
  }
  
  return roomData;
}

/**
 * Update room video state
 */
async function updateRoomVideoState(roomId, videoUrl, videoTime) {
  const roomKey = `room:${roomId}`;
  try {
    await redis.hset(roomKey, { videoUrl: videoUrl || "", videoTime: videoTime || 0 });
  } catch (err) {
    console.warn("[Redis] Update room video state error:", err.message);
  }
}

/**
 * Get room data from Redis
 */
async function getRoom(roomId) {
  try {
    const data = await redis.hgetall(`room:${roomId}`);
    if (!data || Object.keys(data).length === 0) {
      return null;
    }
    return {
      id: data.id,
      encryptionRequired: data.encryptionRequired === "true",
      videoUrl: data.videoUrl || "",
      videoTime: parseFloat(data.videoTime) || 0,
      createdAt: parseInt(data.createdAt, 10),
    };
  } catch (err) {
    console.warn("[Redis] Get room error:", err.message);
    return null;
  }
}

/**
 * Add user to room
 */
async function addUserToRoom(roomId, userId, userName) {
  const userKey = `room:${roomId}:users`;
  try {
    await redis.hset(userKey, userId, JSON.stringify({ name: userName, joinedAt: Date.now() }));
    await redis.expire(userKey, CACHE_TTL.ROOM);
  } catch (err) {
    console.warn("[Redis] Add user to room error:", err.message);
  }
}

/**
 * Remove user from room
 */
async function removeUserFromRoom(roomId, userId) {
  try {
    await redis.hdel(`room:${roomId}:users`, userId);
    
    // Check if room is empty
    const users = await redis.hlen(`room:${roomId}:users`);
    if (users === 0) {
      // Clean up empty room after delay
      await redis.expire(`room:${roomId}`, 60);
      await redis.expire(`room:${roomId}:users`, 60);
    }
  } catch (err) {
    console.warn("[Redis] Remove user from room error:", err.message);
  }
}

/**
 * Get users in room
 */
async function getRoomUsers(roomId) {
  try {
    const users = await redis.hgetall(`room:${roomId}:users`);
    if (!users) return [];
    
    return Object.entries(users).map(([id, data]) => {
      const parsed = JSON.parse(data);
      return { id, name: parsed.name, joinedAt: parsed.joinedAt };
    });
  } catch (err) {
    console.warn("[Redis] Get room users error:", err.message);
    return [];
  }
}

/**
 * Check if room exists
 */
async function roomExists(roomId) {
  try {
    return await redis.exists(`room:${roomId}`) === 1;
  } catch (err) {
    console.warn("[Redis] Room exists check error:", err.message);
    return false;
  }
}

// ============ Pub/Sub for Multi-Instance Scaling ============

const messageHandlers = new Map();

/**
 * Subscribe to room messages
 */
async function subscribeToRoom(roomId, handler) {
  const channel = `room:${roomId}:messages`;
  
  if (!messageHandlers.has(channel)) {
    messageHandlers.set(channel, new Set());
    await subscriber.subscribe(channel);
  }
  
  messageHandlers.get(channel).add(handler);
}

/**
 * Unsubscribe from room messages
 */
async function unsubscribeFromRoom(roomId, handler) {
  const channel = `room:${roomId}:messages`;
  const handlers = messageHandlers.get(channel);
  
  if (handlers) {
    handlers.delete(handler);
    if (handlers.size === 0) {
      messageHandlers.delete(channel);
      await subscriber.unsubscribe(channel);
    }
  }
}

/**
 * Publish message to room (broadcasts to all instances)
 */
async function publishToRoom(roomId, message) {
  const channel = `room:${roomId}:messages`;
  try {
    await publisher.publish(channel, JSON.stringify(message));
  } catch (err) {
    console.warn("[Redis] Publish error:", err.message);
  }
}

// Handle incoming Pub/Sub messages
subscriber.on("message", (channel, message) => {
  const handlers = messageHandlers.get(channel);
  if (handlers) {
    try {
      const parsed = JSON.parse(message);
      handlers.forEach((handler) => handler(parsed));
    } catch (err) {
      console.warn("[Redis] Message parse error:", err.message);
    }
  }
});

// ============ Online Presence ============

const PRESENCE_TTL = 60; // 60 seconds

/**
 * Set user online
 */
async function setUserOnline(userId) {
  try {
    await redis.setex(`online:${userId}`, PRESENCE_TTL, "1");
    await redis.sadd("online:users", userId);
  } catch (err) {
    console.warn("[Redis] Set online error:", err.message);
  }
}

/**
 * Set user offline
 */
async function setUserOffline(userId) {
  try {
    await redis.del(`online:${userId}`);
    await redis.srem("online:users", userId);
  } catch (err) {
    console.warn("[Redis] Set offline error:", err.message);
  }
}

/**
 * Check if user is online
 */
async function isUserOnline(userId) {
  try {
    return await redis.exists(`online:${userId}`) === 1;
  } catch (err) {
    console.warn("[Redis] Check online error:", err.message);
    return false;
  }
}

/**
 * Heartbeat to maintain online status
 */
async function heartbeat(userId) {
  try {
    await redis.expire(`online:${userId}`, PRESENCE_TTL);
  } catch (err) {
    console.warn("[Redis] Heartbeat error:", err.message);
  }
}

/**
 * Get online users from a list of user IDs
 */
async function getOnlineUsers(userIds) {
  if (!userIds || userIds.length === 0) return [];
  
  try {
    const pipeline = redis.pipeline();
    userIds.forEach((id) => pipeline.exists(`online:${id}`));
    const results = await pipeline.exec();
    
    return userIds.filter((_, i) => results[i][1] === 1);
  } catch (err) {
    console.warn("[Redis] Get online users error:", err.message);
    return [];
  }
}

// ============ Rate Limiting ============

/**
 * Check rate limit
 * @returns {boolean} true if allowed, false if rate limited
 */
async function checkRateLimit(key, limit, windowSeconds) {
  try {
    const current = await redis.incr(key);
    if (current === 1) {
      await redis.expire(key, windowSeconds);
    }
    return current <= limit;
  } catch (err) {
    console.warn("[Redis] Rate limit error:", err.message);
    return true; // Fail open
  }
}

// ============ Connection Management ============

/**
 * Connect all Redis clients
 */
async function connect() {
  try {
    await Promise.all([
      redis.connect(),
      subscriber.connect(),
      publisher.connect(),
    ]);
    console.log("[Redis] All clients connected");
  } catch (err) {
    console.error("[Redis] Connection failed:", err.message);
  }
}

/**
 * Disconnect all Redis clients
 */
async function disconnect() {
  try {
    await Promise.all([
      redis.quit(),
      subscriber.quit(),
      publisher.quit(),
    ]);
    console.log("[Redis] Disconnected");
  } catch (err) {
    console.warn("[Redis] Disconnect error:", err.message);
  }
}

/**
 * Check if Redis is connected
 */
function isRedisConnected() {
  return isConnected;
}

module.exports = {
  redis,
  subscriber,
  publisher,
  
  // Cache
  getOrSet,
  invalidate,
  invalidatePattern,
  CACHE_TTL,
  
  // Sessions
  setSession,
  isSessionValid,
  invalidateSession,
  invalidateAllSessions,
  
  // Rooms
  createRoom,
  getRoom,
  addUserToRoom,
  removeUserFromRoom,
  getRoomUsers,
  roomExists,
  updateRoomVideoState,
  
  // Pub/Sub
  subscribeToRoom,
  unsubscribeFromRoom,
  publishToRoom,
  
  // Presence
  setUserOnline,
  setUserOffline,
  isUserOnline,
  heartbeat,
  getOnlineUsers,
  
  // Rate limiting
  checkRateLimit,
  
  // Connection
  connect,
  disconnect,
  isRedisConnected,
};

