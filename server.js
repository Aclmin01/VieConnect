try {
  require('dotenv').config();
} catch (e) {
  // dotenv is optional, using system environment variables
}

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');


const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));

// Health check endpoint for deployment monitoring
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: Math.floor(process.uptime()) });
});


// ==================== MATCHING MECHANISM ====================
// 
// VieConnect Matching System (designed for stability and fairness):
//
// User object in queue:
// {
//   socketId: string,
//   gender: 'male' | 'female',
//   lookingFor: 'male' | 'female' | 'both',
//   interests: string[],
//   joinedAt: timestamp,
//   username: string
// }
//
// Rules for a valid match between A and B:
// 1. A.lookingFor must accept B.gender (A.lookingFor === 'both' || A.lookingFor === B.gender)
// 2. B.lookingFor must accept A.gender
//
// This ensures mutual consent on gender preference.
//
// Queues:
// - waitingPool: array of users currently looking for a match
// - activeRooms: Map<roomId, { userA: socketId, userB: socketId, startTime, ... }>
//
// When user clicks "Find Stranger":
//   - Remove from any previous room
//   - Try to find compatible partner in waitingPool
//   - If found → create private room + notify both
//   - If not → add to waitingPool
//
// On disconnect or "Leave":
//   - Clean up from waitingPool
//   - Notify partner if in active room
//   - Allow both to search again
//
// This mechanism works across multiple networks/devices as long as they connect to the same server.
// ============================================================

let waitingPool = [];
let activeRooms = new Map(); // roomId -> { userA, userB, userAClientId, userBClientId, startTime, userAInfo, userBInfo, userAOnline, userBOnline, matchScore? }
let connectedUsers = new Map(); // socketId -> userInfo
let totalMatchesServed = 0;
let adminSockets = new Set();
let reports = []; // { id, roomId, reportedBy, reportedUser, reason, timestamp }

let roomMessages = new Map(); // roomId -> array of chat messages
let roomSpectators = new Map(); // roomId -> Set of spectator socket ids (admin)

// Password for admin (uses environment variables with local fallback)
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Hthh770716@@";

// Generate friendly anonymous username
function generateUsername(gender) {
  const prefixes = ['Echo', 'Shadow', 'Nova', 'Pixel', 'Luna', 'Vibe', 'Spark', 'Mist', 'Wave', 'Zen'];
  const suffixes = ['42', '77', '19', '88', 'X', 'Q', '7', '23', '55', '99'];
  const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
  const suffix = suffixes[Math.floor(Math.random() * suffixes.length)];
  return `${prefix}${gender === 'female' ? 'a' : ''}${suffix}`;
}

// Check if two users are compatible
function areCompatible(userA, userB) {
  const aAcceptsB = userA.lookingFor === 'both' || userA.lookingFor === userB.gender;
  const bAcceptsA = userB.lookingFor === 'both' || userB.lookingFor === userA.gender;
  return aAcceptsB && bAcceptsA;
}

// Calculate interest overlap score (0 to 1)
function calculateInterestScore(userA, userB) {
  const interestsA = userA.interests || [];
  const interestsB = userB.interests || [];
  if (interestsA.length === 0 || interestsB.length === 0) return 0.1;

  let matches = 0;
  interestsA.forEach(int => {
    if (interestsB.some(i => i.toLowerCase() === int.toLowerCase())) matches++;
  });
  return matches / Math.max(interestsA.length, interestsB.length);
}

// Find the BEST compatible match (not just first) for higher quality
function findMatch(newUser) {
  let bestMatch = null;
  let bestScore = -1;
  let bestIndex = -1;

  for (let i = 0; i < waitingPool.length; i++) {
    const candidate = waitingPool[i];
    if (areCompatible(newUser, candidate)) {
      const interestScore = calculateInterestScore(newUser, candidate);
      const waitBonus = Math.min((Date.now() - candidate.joinedAt) / 1000 / 30, 1.0); // longer wait = higher priority
      const totalScore = interestScore * 0.7 + waitBonus * 0.3;

      if (totalScore > bestScore) {
        bestScore = totalScore;
        bestMatch = candidate;
        bestIndex = i;
      }
    }
  }

  if (bestMatch) {
    waitingPool.splice(bestIndex, 1);
    // Store the match score for logging / potential display
    bestMatch._matchScore = bestScore;
    return bestMatch;
  }
  return null;
}

// Remove user from waiting pool
function removeFromWaiting(socketId) {
  waitingPool = waitingPool.filter(u => u.socketId !== socketId);
}

function removeClientFromWaiting(clientId) {
  if (!clientId) return;
  waitingPool = waitingPool.filter(u => u.clientId !== clientId);
}

function getRoomSideBySocket(room, socketId) {
  if (room.userA === socketId) return 'A';
  if (room.userB === socketId) return 'B';
  return null;
}

function getRoomSideByClient(room, clientId) {
  if (!clientId) return null;
  if (room.userAClientId === clientId || room.userAInfo.clientId === clientId) return 'A';
  if (room.userBClientId === clientId || room.userBInfo.clientId === clientId) return 'B';
  return null;
}

function findActiveRoomByClientId(clientId) {
  if (!clientId) return null;
  for (const [roomId, room] of activeRooms.entries()) {
    const side = getRoomSideByClient(room, clientId);
    if (side) return { roomId, room, side };
  }
  return null;
}

function buildPartnerPayload(room, side) {
  const partnerInfo = side === 'A' ? room.userBInfo : room.userAInfo;
  const partnerOnline = side === 'A' ? room.userBOnline : room.userAOnline;
  return {
    username: partnerInfo.username,
    name: partnerInfo.name || partnerInfo.username,
    gender: partnerInfo.gender,
    interests: partnerInfo.interests || [],
    avatarUrl: partnerInfo.avatarUrl || null,
    matchScore: room.matchScore,
    online: partnerOnline !== false
  };
}

function resumeRoomForClient(socket, clientId, requestedRoomId = null) {
  const found = requestedRoomId && activeRooms.has(requestedRoomId)
    ? (() => {
        const room = activeRooms.get(requestedRoomId);
        const side = getRoomSideByClient(room, clientId);
        return side ? { roomId: requestedRoomId, room, side } : null;
      })()
    : findActiveRoomByClientId(clientId);

  if (!found) return false;

  const { roomId, room, side } = found;
  socket.join(roomId);

  if (side === 'A') {
    room.userA = socket.id;
    room.userAOnline = true;
    room.userAInfo.socketId = socket.id;
  } else {
    room.userB = socket.id;
    room.userBOnline = true;
    room.userBInfo.socketId = socket.id;
  }

  activeRooms.set(roomId, room);
  connectedUsers.set(socket.id, side === 'A' ? room.userAInfo : room.userBInfo);

  const partnerSocketId = side === 'A' ? room.userB : room.userA;
  const partnerOnline = side === 'A' ? room.userBOnline : room.userAOnline;
  const partnerSocket = partnerOnline ? io.sockets.sockets.get(partnerSocketId) : null;
  if (partnerSocket) {
    partnerSocket.emit('partner-online');
  }

  socket.emit('room-resumed', {
    roomId,
    partner: buildPartnerPayload(room, side),
    history: roomMessages.get(roomId) || []
  });

  broadcastStats();
  console.log(`[ROOM RESUMED] ${clientId} -> ${roomId}`);
  return true;
}

// Create a private room for two users
function createRoom(userA, userB) {
  const roomId = `room_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  const roomData = {
    userA: userA.socketId,
    userB: userB.socketId,
    userAClientId: userA.clientId,
    userBClientId: userB.clientId,
    userAOnline: true,
    userBOnline: true,
    startTime: Date.now(),
    userAInfo: { ...userA },
    userBInfo: { ...userB },
    matchScore: userB._matchScore || 0.5
  };

  activeRooms.set(roomId, roomData);

  // Initialize message storage
  if (!roomMessages.has(roomId)) roomMessages.set(roomId, []);

  // Join both sockets to the room
  const socketA = io.sockets.sockets.get(userA.socketId);
  const socketB = io.sockets.sockets.get(userB.socketId);

  if (socketA) socketA.join(roomId);
  if (socketB) socketB.join(roomId);

  totalMatchesServed++;

  // Notify both users + include gender for display
  const partnerA = {
    ...buildPartnerPayload(roomData, 'A')
  };

  const partnerB = {
    ...buildPartnerPayload(roomData, 'B')
  };

  const history = roomMessages.get(roomId) || [];

  if (socketA) {
    socketA.emit('match-found', { roomId, partner: partnerA, history });
  }
  if (socketB) {
    socketB.emit('match-found', { roomId, partner: partnerB, history });
  }

  // Broadcast stats update
  broadcastStats();

  console.log(`[MATCH] ${userA.username} (${userA.gender}) ↔ ${userB.username} (${userB.gender}) | Room: ${roomId}`);

  return roomId;
}

// End a room
function endRoom(roomId, reason = 'user-left') {
  const room = activeRooms.get(roomId);
  if (!room) return;

  const { userA, userB } = room;

  const socketA = io.sockets.sockets.get(userA);
  const socketB = io.sockets.sockets.get(userB);

  if (socketA) {
    socketA.leave(roomId);
    socketA.emit('partner-left', { reason });
  }
  if (socketB) {
    socketB.leave(roomId);
    socketB.emit('partner-left', { reason });
  }

  activeRooms.delete(roomId);
  roomMessages.delete(roomId);
  roomSpectators.delete(roomId);

  broadcastStats();

  console.log(`[ROOM CLOSED] ${roomId} | Reason: ${reason}`);
}

// Broadcast current stats to all clients (especially useful for admin)
function broadcastStats() {
  const stats = {
    online: connectedUsers.size,
    waiting: waitingPool.length,
    activeChats: activeRooms.size,
    totalMatches: totalMatchesServed
  };

  io.emit('stats-update', stats);

  // Send detailed data to admins
  if (adminSockets.size > 0) {
    const detailed = {
      waitingUsers: waitingPool.map(u => ({
        username: u.username,
        gender: u.gender,
        lookingFor: u.lookingFor,
        interests: u.interests
      })),
      activeRooms: Array.from(activeRooms.entries()).map(([id, r]) => ({
        roomId: id,
        userA: r.userAInfo.username,
        userB: r.userBInfo.username,
        duration: Math.floor((Date.now() - r.startTime) / 1000),
        matchScore: r.matchScore
      })),
      recentReports: reports.slice(0, 10)
    };
    adminSockets.forEach(adminId => {
      const adminSocket = io.sockets.sockets.get(adminId);
      if (adminSocket) adminSocket.emit('admin-data', detailed);
    });
  }
}

// ==================== SOCKET HANDLING ====================

io.on('connection', (socket) => {
  console.log(`[CONNECT] ${socket.id}`);

  // Store basic connection
  connectedUsers.set(socket.id, { socketId: socket.id, connectedAt: Date.now() });

  // Send initial stats
  socket.emit('stats-update', {
    online: connectedUsers.size,
    waiting: waitingPool.length,
    activeChats: activeRooms.size,
    totalMatches: totalMatchesServed
  });

  socket.on('client-ready', ({ clientId, roomId } = {}) => {
    if (!clientId) return;
    resumeRoomForClient(socket, clientId, roomId);
  });

  // User wants to start searching for a match
  socket.on('find-stranger', (data) => {
    const { gender, lookingFor, interests = [], clientId = null } = data;

    if (!gender || !lookingFor) {
      socket.emit('error', { message: 'Please select gender and preference' });
      return;
    }

    // Remove from previous state
    removeFromWaiting(socket.id);
    removeClientFromWaiting(clientId);
    // Leave any previous rooms
    for (const [roomId, room] of activeRooms.entries()) {
      if (room.userA === socket.id || room.userB === socket.id || getRoomSideByClient(room, clientId)) {
        endRoom(roomId, 're-search');
      }
    }

    const displayName = (data.name && data.name.trim()) ? data.name.trim().substring(0, 20) : generateUsername(gender);

    const user = {
      socketId: socket.id,
      clientId,
      gender,
      lookingFor,
      interests: interests.slice(0, 3),
      joinedAt: Date.now(),
      username: displayName,
      name: displayName,
      avatarUrl: data.avatarUrl || null
    };

    connectedUsers.set(socket.id, user);

    // Try to find match immediately
    const match = findMatch(user);

    if (match) {
      createRoom(user, match);
    } else {
      waitingPool.push(user);
      socket.emit('waiting', {
        message: 'Looking for someone...',
        queuePosition: waitingPool.length
      });
      broadcastStats();
    }
  });

  // Simple per-user rate limiter for stability (anti-spam)
  const messageRateLimit = new Map(); // socketId -> lastMessageTimestamp

  // Basic profanity filter (expandable list for safety)
  const bannedWords = ['fuck', 'shit', 'bitch', 'asshole', 'cunt', 'nigger', 'faggot'];
  function sanitizeMessage(text) {
    let cleaned = text;
    bannedWords.forEach(word => {
      const regex = new RegExp(`\\b${word}\\b`, 'gi');
      cleaned = cleaned.replace(regex, '***');
    });
    return cleaned;
  }

  // Send chat message
  socket.on('send-message', ({ roomId, message }) => {
    if (!roomId || !message || !message.trim()) return;

    const now = Date.now();
    const last = messageRateLimit.get(socket.id) || 0;
    if (now - last < 350) {
      // Too fast - drop silently or warn once
      return;
    }
    messageRateLimit.set(socket.id, now);

    const room = activeRooms.get(roomId);
    if (!room) {
      socket.emit('error', { message: 'Chat session ended' });
      return;
    }

    const isUserA = room.userA === socket.id;
    const isUserB = room.userB === socket.id;
    if (!isUserA && !isUserB) {
      socket.emit('error', { message: 'Chat session ended' });
      return;
    }

    const senderInfo = isUserA ? room.userAInfo : room.userBInfo;
    const receiverSocketId = isUserA ? room.userB : room.userA;
    const receiverOnline = isUserA ? room.userBOnline : room.userAOnline;

    const sanitizedText = sanitizeMessage(message.trim().substring(0, 2000));

    const chatMessage = {
      id: Date.now() + Math.random().toString(36).substr(2, 5),
      text: sanitizedText,
      sender: senderInfo.username,
      senderClientId: senderInfo.clientId || null,
      senderGender: senderInfo.gender,
      timestamp: Date.now(),
      isSelf: false
    };

    // Save message history
    if (!roomMessages.has(roomId)) roomMessages.set(roomId, []);
    roomMessages.get(roomId).push(chatMessage);

    // Send directly to the other participant only.
    if (receiverOnline && io.sockets.sockets.get(receiverSocketId)) {
      io.to(receiverSocketId).emit('new-message', {
        ...chatMessage,
        isSelf: false
      });
    }

    // Send to admin spectators (undetected)
    const specs = roomSpectators.get(roomId);
    if (specs) {
      specs.forEach(specId => {
        const specSocket = io.sockets.sockets.get(specId);
        if (specSocket) {
          specSocket.emit('new-message', { ...chatMessage, isSpectator: true });
        }
      });
    }
  });

  // User is typing
  socket.on('typing', ({ roomId }) => {
    const room = activeRooms.get(roomId);
    if (!room) return;
    socket.to(roomId).emit('typing', { username: (room.userA === socket.id ? room.userAInfo : room.userBInfo).username });
  });

  socket.on('stop-typing', ({ roomId }) => {
    socket.to(roomId).emit('stop-typing');
  });

  // User wants to leave current chat and find someone new
  socket.on('leave-chat', ({ roomId }) => {
    if (roomId) {
      endRoom(roomId, 'user-left');
    }
    removeFromWaiting(socket.id);
    socket.emit('left-chat');
  });

  // Quick "Next" button - leave and immediately search again
  socket.on('next-person', (userPrefs) => {
    // End current if any
    for (const [roomId, room] of activeRooms.entries()) {
      if (room.userA === socket.id || room.userB === socket.id) {
        endRoom(roomId, 'next-person');
      }
    }
    removeFromWaiting(socket.id);

    // Re-trigger search with same preferences
    setTimeout(() => {
      socket.emit('auto-search', userPrefs);
    }, 300);
  });

  // Admin authentication
  socket.on('admin-login', (password) => {
    if (password === ADMIN_PASSWORD) {
      adminSockets.add(socket.id);
      socket.emit('admin-auth-success');
      console.log(`[ADMIN] Admin connected: ${socket.id}`);

      // Send current detailed data immediately
      const detailed = {
        waitingUsers: waitingPool.map(u => ({
          username: u.username,
          gender: u.gender,
          lookingFor: u.lookingFor,
          interests: u.interests
        })),
        activeRooms: Array.from(activeRooms.entries()).map(([id, r]) => ({
          roomId: id,
          userA: r.userAInfo.username,
          userB: r.userBInfo.username,
          duration: Math.floor((Date.now() - r.startTime) / 1000),
          matchScore: r.matchScore
        })),
        recentReports: reports.slice(0, 10)
      };
      socket.emit('admin-data', detailed);
    } else {
      socket.emit('admin-auth-failed');
    }
  });

  socket.on('admin-force-end', (roomId) => {
    if (adminSockets.has(socket.id) && activeRooms.has(roomId)) {
      endRoom(roomId, 'admin-ended');
      socket.emit('admin-action', { success: true, message: `Room ${roomId} ended` });
    }
  });

  socket.on('admin-broadcast', (message) => {
    if (adminSockets.has(socket.id)) {
      io.emit('admin-broadcast', { message, from: 'Admin' });
    }
  });

  // Admin secretly monitors a room (undetected by users)
  socket.on('admin-snoop-room', (roomId) => {
    if (!adminSockets.has(socket.id) || !activeRooms.has(roomId)) return;

    socket.join(roomId);
    if (!roomSpectators.has(roomId)) roomSpectators.set(roomId, new Set());
    roomSpectators.get(roomId).add(socket.id);

    const history = roomMessages.get(roomId) || [];
    socket.emit('snoop-history', { roomId, history });
    console.log(`[ADMIN SNOOP] ${socket.id} is now monitoring ${roomId}`);
  });

  // Report a user (safety feature)
  socket.on('report-user', ({ roomId, reason }) => {
    const room = activeRooms.get(roomId);
    if (!room) return;

    const reporterId = socket.id;
    const reportedId = room.userA === reporterId ? room.userB : room.userA;
    const reporterInfo = room.userA === reporterId ? room.userAInfo : room.userBInfo;
    const reportedInfo = room.userA === reporterId ? room.userBInfo : room.userAInfo;

    const report = {
      id: 'rep_' + Date.now(),
      roomId,
      reportedBy: reporterInfo.username,
      reportedUser: reportedInfo.username,
      reason: reason || 'No reason provided',
      timestamp: Date.now()
    };

    reports.unshift(report);
    if (reports.length > 50) reports.pop(); // keep last 50

    console.log(`[REPORT] ${reporterInfo.username} reported ${reportedInfo.username} in ${roomId}`);

    socket.emit('report-received', { success: true });

    // Notify admins live
    adminSockets.forEach(adminId => {
      const adminSocket = io.sockets.sockets.get(adminId);
      if (adminSocket) adminSocket.emit('new-report', report);
    });
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    console.log(`[DISCONNECT] ${socket.id}`);

    // Remove from waiting
    removeFromWaiting(socket.id);

    // Do NOT auto end room. Just notify partner they went offline.
    // Messages are preserved.
    for (const [roomId, room] of activeRooms.entries()) {
      if (room.userA === socket.id || room.userB === socket.id) {
        const otherId = room.userA === socket.id ? room.userB : room.userA;
        const side = getRoomSideBySocket(room, socket.id);
        if (side === 'A') {
          room.userAOnline = false;
        } else if (side === 'B') {
          room.userBOnline = false;
        }

        const otherOnline = side === 'A' ? room.userBOnline : room.userAOnline;
        const otherSocket = otherOnline ? io.sockets.sockets.get(otherId) : null;
        if (otherSocket) {
          otherSocket.emit('partner-offline', { roomId });
        }
        // Keep the room and messages alive
      }
    }

    // Clean admin spectators if any
    roomSpectators.forEach((specs, rId) => {
      if (specs.has(socket.id)) specs.delete(socket.id);
    });

    connectedUsers.delete(socket.id);
    adminSockets.delete(socket.id);

    broadcastStats();
  });
});

// Periodic cleanup and stats broadcast (every 8 seconds)
setInterval(() => {
  // Remove stale waiting users (older than 5 minutes - safety)
  const now = Date.now();
  const before = waitingPool.length;
  waitingPool = waitingPool.filter(u => (now - u.joinedAt) < 5 * 60 * 1000);
  if (waitingPool.length !== before) {
    broadcastStats();
  }

  // Broadcast stats regularly
  broadcastStats();
}, 8000);

// ==================== START SERVER ====================

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════╗
║                                                    ║
║   🚀 VieConnect Server is running!                 ║
║                                                    ║
║   Open in browser:                                 ║
║   → http://localhost:${PORT}                         ║
║                                                    ║
║   Admin test link:                                 ║
║   → http://localhost:${PORT}?admin                   ║
║   Password: Hthh770716@@                            ║
║                                                    ║
╚════════════════════════════════════════════════════╝
  `);
});
