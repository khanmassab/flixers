const { PrismaClient } = require("@prisma/client");
const redis = require("./redis");

const prisma = new PrismaClient();

// Cache key prefixes
const CACHE_KEYS = {
  user: (id) => `cache:user:${id}`,
  preferences: (id) => `cache:prefs:${id}`,
  friends: (id) => `cache:friends:${id}`,
  history: (id) => `cache:history:${id}`,
};

/**
 * Upsert a user from Google profile data.
 * Creates user if not exists, updates if exists.
 * Also creates default preferences if new user.
 */
async function upsertUser(profile) {
  const { sub, email, name, picture } = profile;

  const user = await prisma.user.upsert({
    where: { id: sub },
    update: {
      email,
      name,
      picture,
    },
    create: {
      id: sub,
      email,
      name,
      picture,
      preferences: {
        create: {
          theme: "system",
          notificationsEnabled: true,
          defaultEncryption: true,
        },
      },
    },
    include: {
      preferences: true,
    },
  });

  // Invalidate cache on upsert
  await redis.invalidate(CACHE_KEYS.user(sub), CACHE_KEYS.preferences(sub));

  return user;
}

/**
 * Get user by ID (Google sub) - with caching
 */
async function getUserById(userId) {
  return redis.getOrSet(
    CACHE_KEYS.user(userId),
    () => prisma.user.findUnique({
      where: { id: userId },
      include: {
        preferences: true,
      },
    }),
    redis.CACHE_TTL.USER
  );
}

/**
 * Get user by email
 */
async function getUserByEmail(email) {
  return prisma.user.findUnique({
    where: { email },
    include: {
      preferences: true,
    },
  });
}

/**
 * Update user preferences - with cache invalidation
 */
async function updatePreferences(userId, preferences) {
  const result = await prisma.userPreferences.upsert({
    where: { userId },
    update: preferences,
    create: {
      userId,
      ...preferences,
    },
  });

  // Invalidate caches
  await redis.invalidate(CACHE_KEYS.user(userId), CACHE_KEYS.preferences(userId));

  return result;
}

/**
 * Record room join
 */
async function recordRoomJoin(userId, roomId, roomName = null) {
  const result = await prisma.roomHistory.create({
    data: {
      userId,
      roomId,
      roomName,
    },
  });

  // Invalidate history cache
  await redis.invalidate(CACHE_KEYS.history(userId));

  return result;
}

/**
 * Record room leave
 */
async function recordRoomLeave(userId, roomId) {
  const entry = await prisma.roomHistory.findFirst({
    where: {
      userId,
      roomId,
      leftAt: null,
    },
    orderBy: {
      joinedAt: "desc",
    },
  });

  if (entry) {
    const result = await prisma.roomHistory.update({
      where: { id: entry.id },
      data: { leftAt: new Date() },
    });

    // Invalidate history cache
    await redis.invalidate(CACHE_KEYS.history(userId));

    return result;
  }

  return null;
}

/**
 * Get user's room history - with caching
 */
async function getRoomHistory(userId, limit = 20) {
  return redis.getOrSet(
    `${CACHE_KEYS.history(userId)}:${limit}`,
    () => prisma.roomHistory.findMany({
      where: { userId },
      orderBy: { joinedAt: "desc" },
      take: limit,
    }),
    redis.CACHE_TTL.USER // 5 minutes
  );
}

/**
 * Send friend request - with cache invalidation
 */
async function sendFriendRequest(userId, friendId) {
  const existing = await prisma.friendship.findFirst({
    where: {
      OR: [
        { userId, friendId },
        { userId: friendId, friendId: userId },
      ],
    },
  });

  if (existing) {
    return { error: "friendship_exists", existing };
  }

  const result = await prisma.friendship.create({
    data: {
      userId,
      friendId,
      status: "PENDING",
    },
    include: {
      friend: {
        select: { id: true, name: true, email: true, picture: true },
      },
    },
  });

  // Invalidate friends cache for both users
  await redis.invalidate(CACHE_KEYS.friends(userId), CACHE_KEYS.friends(friendId));

  return result;
}

/**
 * Accept friend request - with cache invalidation
 */
async function acceptFriendRequest(userId, friendshipId) {
  const friendship = await prisma.friendship.findUnique({
    where: { id: friendshipId },
  });

  if (!friendship || friendship.friendId !== userId) {
    return { error: "not_found" };
  }

  const result = await prisma.friendship.update({
    where: { id: friendshipId },
    data: { status: "ACCEPTED" },
    include: {
      user: {
        select: { id: true, name: true, email: true, picture: true },
      },
    },
  });

  // Invalidate friends cache for both users
  await redis.invalidate(
    CACHE_KEYS.friends(friendship.userId),
    CACHE_KEYS.friends(friendship.friendId)
  );

  return result;
}

/**
 * Reject/cancel friend request - with cache invalidation
 */
async function removeFriendship(userId, friendshipId) {
  const friendship = await prisma.friendship.findUnique({
    where: { id: friendshipId },
  });

  if (!friendship) {
    return { error: "not_found" };
  }

  if (friendship.userId !== userId && friendship.friendId !== userId) {
    return { error: "not_authorized" };
  }

  const result = await prisma.friendship.delete({
    where: { id: friendshipId },
  });

  // Invalidate friends cache for both users
  await redis.invalidate(
    CACHE_KEYS.friends(friendship.userId),
    CACHE_KEYS.friends(friendship.friendId)
  );

  return result;
}

/**
 * Get user's friends (accepted) - with caching
 */
async function getFriends(userId) {
  return redis.getOrSet(
    CACHE_KEYS.friends(userId),
    async () => {
      const friendships = await prisma.friendship.findMany({
        where: {
          OR: [
            { userId, status: "ACCEPTED" },
            { friendId: userId, status: "ACCEPTED" },
          ],
        },
        include: {
          user: {
            select: { id: true, name: true, email: true, picture: true },
          },
          friend: {
            select: { id: true, name: true, email: true, picture: true },
          },
        },
      });

      return friendships.map((f) => ({
        friendshipId: f.id,
        friend: f.userId === userId ? f.friend : f.user,
        since: f.updatedAt,
      }));
    },
    redis.CACHE_TTL.FRIENDS
  );
}

/**
 * Get pending friend requests (received)
 */
async function getPendingRequests(userId) {
  return prisma.friendship.findMany({
    where: {
      friendId: userId,
      status: "PENDING",
    },
    include: {
      user: {
        select: { id: true, name: true, email: true, picture: true },
      },
    },
  });
}

/**
 * Get sent friend requests (pending)
 */
async function getSentRequests(userId) {
  return prisma.friendship.findMany({
    where: {
      userId,
      status: "PENDING",
    },
    include: {
      friend: {
        select: { id: true, name: true, email: true, picture: true },
      },
    },
  });
}

/**
 * Search users by email or name (for adding friends)
 */
async function searchUsers(query, excludeUserId, limit = 10) {
  return prisma.user.findMany({
    where: {
      AND: [
        { id: { not: excludeUserId } },
        {
          OR: [
            { email: { contains: query, mode: "insensitive" } },
            { name: { contains: query, mode: "insensitive" } },
          ],
        },
      ],
    },
    select: {
      id: true,
      name: true,
      email: true,
      picture: true,
    },
    take: limit,
  });
}

/**
 * Graceful shutdown
 */
async function disconnect() {
  await prisma.$disconnect();
}

module.exports = {
  prisma,
  upsertUser,
  getUserById,
  getUserByEmail,
  updatePreferences,
  recordRoomJoin,
  recordRoomLeave,
  getRoomHistory,
  sendFriendRequest,
  acceptFriendRequest,
  removeFriendship,
  getFriends,
  getPendingRequests,
  getSentRequests,
  searchUsers,
  disconnect,
};
