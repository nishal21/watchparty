import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
import {
  getPool,
  testConnection,
  saveRoom,
  getRoom,
  deleteRoom,
  saveParticipant,
  removeParticipant,
  saveMessage,
  getRecentMessages,
  cleanupInactiveRooms
} from './db/index.js';

dotenv.config();

// Initialize database connection
let dbAvailable = false;
if (process.env.NEON_DB_URL) {
  dbAvailable = await testConnection();
  if (dbAvailable) {
    console.log('💾 Database persistence enabled');
  } else {
    console.log('⚠️  Database connection failed, using in-memory storage');
  }
} else {
  console.log('⚠️  No database URL provided, using in-memory storage');
}

const app = express();
const server = createServer(app);
const PORT = process.env.PORT || 3002;

// Initialize Socket.io with CORS
const io = new Server(server, {
  cors: {
    origin: [
      "http://localhost:5173",
      "http://localhost:4173",
      "https://otazumi.netlify.app",
      "https://otazumi.page",
      "https://www.otazumi.page"
    ],
    methods: ["GET", "POST"],
    credentials: true
  }
});

// Security middleware
app.use(helmet());

// CORS configuration
const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || [
  'http://localhost:5173',
  'http://localhost:4173',
  'https://otazumi.netlify.app',
  'https://otazumi.page',
  'https://www.otazumi.page'
];

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) === -1) {
      const msg = 'The CORS policy for this site does not allow access from the specified Origin.';
      return callback(new Error(msg), false);
    }
    return callback(null, true);
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization'],
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));

// Body parser
app.use(express.json({ limit: '10mb' }));

// In-memory storage for rooms (fallback when no DB)
let rooms = new Map();
let roomTimeouts = new Map();

// Room timeout cleanup (30 minutes of inactivity)
const ROOM_TIMEOUT = 30 * 60 * 1000; // 30 minutes

function cleanupMemoryRooms() {
  const now = Date.now();
  for (const [roomId, timeoutId] of roomTimeouts) {
    if (!rooms.has(roomId)) {
      clearTimeout(timeoutId);
      roomTimeouts.delete(roomId);
    }
  }

  for (const [roomId, room] of rooms) {
    if (now - room.lastActivity > ROOM_TIMEOUT) {
      console.log(`🧹 Cleaning up inactive room: ${roomId}`);
      rooms.delete(roomId);
      if (roomTimeouts.has(roomId)) {
        clearTimeout(roomTimeouts[roomId]);
        roomTimeouts.delete(roomId);
      }
    }
  }

  // Also cleanup database if available
  if (dbAvailable) {
    cleanupInactiveRooms(ROOM_TIMEOUT / (60 * 1000));
  }
}

// Run cleanup every 5 minutes
setInterval(cleanupMemoryRooms, 5 * 60 * 1000);

// API Routes
app.get('/', (req, res) => {
  res.json({
    service: 'Otazumi Watch Party Server',
    version: '1.0.0',
    status: 'running',
    endpoints: {
      'GET /': 'API documentation (this page)',
      'GET /health': 'Health check endpoint',
      'GET /api/rooms': 'Get active rooms (dev only)',
      'POST /api/rooms': 'Create a new room'
    },
    websocket: {
      events: {
        'join-room': 'Join a watch party room',
        'leave-room': 'Leave current room',
        'send-message': 'Send chat message',
        'update-playback': 'Update playback state',
        'kick-participant': 'Kick a participant (host only)',
        'transfer-host': 'Transfer host to another participant'
      }
    },
    timestamp: new Date().toISOString(),
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Otazumi Watch Party Server',
    activeRooms: rooms.size,
    timestamp: new Date().toISOString(),
  });
});

// Get active rooms (development only)
app.get('/api/rooms', (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({ error: 'Not available in production' });
  }

  const roomList = Array.from(rooms.entries()).map(([id, room]) => ({
    id,
    name: room.name,
    host: room.host,
    participants: room.participants.size,
    anime: room.anime,
    episode: room.episode,
    created: room.created,
    lastActivity: room.lastActivity
  }));

  res.json({ rooms: roomList });
});

// Get specific room data
app.get('/api/room', async (req, res) => {
  try {
    const { id: roomId } = req.query;

    if (!roomId) {
      return res.status(400).json({ error: 'Room ID is required as query parameter ?id=' });
    }

    let room = rooms.get(roomId);

    // Try to load from database if not in memory and DB is available
    if (!room && dbAvailable) {
      room = await getRoom(roomId);
      if (room) {
        // Reconstruct room in memory
        rooms.set(roomId, {
          ...room,
          participants: new Map(room.participants.map(p => [p.id, p]))
        });
      }
    }

    if (!room) {
      return res.status(404).json({ error: 'Room not found' });
    }

    // Return room data
    res.json({
      id: room.id,
      name: room.name,
      anime: room.anime,
      episode: room.episode,
      episodeId: room.episodeId,
      host: room.host,
      participants: Array.from(room.participants.values()),
      messages: room.messages.slice(-50), // Last 50 messages
      playbackState: room.playbackState,
      settings: room.settings,
      created: room.created,
      lastActivity: room.lastActivity
    });
  } catch (error) {
    console.error('❌ Error getting room:', error);
    res.status(500).json({ error: 'Failed to get room data' });
  }
});

// Add message to room (for polling mode)
app.post('/api/room/:roomId/message', async (req, res) => {
  try {
    const { roomId } = req.params;
    const { content, userName, userId } = req.body;

    if (!content || !userName) {
      return res.status(400).json({ error: 'Content and userName are required' });
    }

    let room = rooms.get(roomId);

    // Try to load from database if not in memory
    if (!room && dbAvailable) {
      room = await getRoom(roomId);
      if (room) {
        rooms.set(roomId, {
          ...room,
          participants: new Map(room.participants.map(p => [p.id, p]))
        });
      }
    }

    if (!room) {
      return res.status(404).json({ error: 'Room not found' });
    }

    if (!room.settings.allowChat) {
      return res.status(403).json({ error: 'Chat is disabled in this room' });
    }

    // Find participant (or create anonymous)
    let participant = Array.from(room.participants.values()).find(p => p.id === userId || p.name === userName);
    if (!participant) {
      participant = { id: userId || uuidv4(), name: userName, isHost: false };
      room.participants.set(participant.id, participant);
      if (dbAvailable) {
        await saveParticipant(roomId, participant);
      }
    }

    const message = {
      id: uuidv4(),
      userId: participant.id,
      userName: participant.name,
      content,
      timestamp: new Date().toISOString()
    };

    room.messages.push(message);
    room.lastActivity = Date.now();

    // Save message to database if available
    if (dbAvailable) {
      await saveMessage(roomId, message);
    }

    // Keep only last 100 messages
    if (room.messages.length > 100) {
      room.messages = room.messages.slice(-100);
    }

    // Broadcast via socket.io if connected clients
    io.to(roomId).emit('new-message', message);

    res.json({ success: true, message });
  } catch (error) {
    console.error('❌ Error adding message:', error);
    res.status(500).json({ error: 'Failed to add message' });
  }
});

// Update playback state (for polling mode)
app.post('/api/room/:roomId/playback', async (req, res) => {
  try {
    const { roomId } = req.params;
    const playbackData = req.body;

    let room = rooms.get(roomId);

    // Try to load from database if not in memory
    if (!room && dbAvailable) {
      room = await getRoom(roomId);
      if (room) {
        rooms.set(roomId, {
          ...room,
          participants: new Map(room.participants.map(p => [p.id, p]))
        });
      }
    }

    if (!room) {
      return res.status(404).json({ error: 'Room not found' });
    }

    if (!room.settings.syncPlayback) {
      return res.status(403).json({ error: 'Playback sync is disabled in this room' });
    }

    room.playbackState = {
      ...room.playbackState,
      ...playbackData,
      lastUpdated: Date.now()
    };

    room.lastActivity = Date.now();

    // Broadcast via socket.io if connected clients
    io.to(roomId).emit('playback-updated', room.playbackState);

    res.json({ success: true, playbackState: room.playbackState });
  } catch (error) {
    console.error('❌ Error updating playback:', error);
    res.status(500).json({ error: 'Failed to update playback' });
  }
});

// Create room via API
app.post('/api/rooms', async (req, res) => {
  try {
    const { name, anime, episode, episodeId, hostName, settings } = req.body;

    if (!name || !anime || !episode || !hostName) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: name, anime, episode, hostName'
      });
    }

    const roomId = uuidv4();
    const room = {
      id: roomId,
      name,
      anime,
      episode,
      episodeId: episodeId || episode, // Store episodeId if provided, fallback to episode
      host: { id: uuidv4(), name: hostName },
      participants: new Map([[roomId, { id: roomId, name: hostName, isHost: true }]]),
      messages: [],
      playbackState: {
        isPlaying: false,
        currentTime: 0,
        duration: 0,
        lastUpdated: Date.now()
      },
      settings: settings || {
        syncPlayback: true,
        allowChat: true,
        maxParticipants: 10
      },
      created: new Date().toISOString(),
      lastActivity: Date.now()
    };

    rooms.set(roomId, room);

    // Save to database if available
    if (dbAvailable) {
      await saveRoom(room);
      await saveParticipant(roomId, room.participants.get(roomId));
    }

    // Set timeout for room cleanup
    const timeoutId = setTimeout(async () => {
      if (rooms.has(roomId)) {
        console.log(`⏰ Room ${roomId} timed out`);
        rooms.delete(roomId);
        if (dbAvailable) {
          await deleteRoom(roomId);
        }
      }
    }, ROOM_TIMEOUT);

    roomTimeouts.set(roomId, timeoutId);

    console.log(`🏠 Created room: ${roomId} - ${name}`);

    res.json({
      success: true,
      room: {
        id: roomId,
        name,
        anime,
        episode,
        episodeId: episodeId || episode,
        host: room.host,
        participantCount: 1
      }
    });
  } catch (error) {
    console.error('❌ Error creating room:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create room'
    });
  }
});

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log(`🔌 User connected: ${socket.id}`);

  let currentRoom = null;
  let userInfo = null;

  // Join room
  socket.on('join-room', async (data) => {
    try {
      const { roomId, userName, userId } = data;

      if (!roomId || !userName) {
        socket.emit('error', { message: 'Room ID and user name are required' });
        return;
      }

      let room = rooms.get(roomId);

      // Try to load from database if not in memory
      if (!room && dbAvailable) {
        const dbRoom = await getRoom(roomId);
        if (dbRoom) {
          // Reconstruct room from database
          room = {
            ...dbRoom,
            participants: new Map(dbRoom.participants.map(p => [p.id, p])),
            messages: await getRecentMessages(roomId, 50)
          };
          rooms.set(roomId, room);

          // Reset timeout
          if (roomTimeouts.has(roomId)) {
            clearTimeout(roomTimeouts[roomId]);
          }
          const timeoutId = setTimeout(async () => {
            if (rooms.has(roomId)) {
              console.log(`⏰ Room ${roomId} timed out`);
              rooms.delete(roomId);
              if (dbAvailable) {
                await deleteRoom(roomId);
              }
            }
          }, ROOM_TIMEOUT);
          roomTimeouts.set(roomId, timeoutId);
        }
      }

      if (!room) {
        socket.emit('error', { message: 'Room not found' });
        return;
      }

      // Check participant limit
      if (room.participants.size >= room.settings.maxParticipants) {
        socket.emit('error', { message: 'Room is full' });
        return;
      }

      // Leave current room if any
      if (currentRoom) {
        socket.leave(currentRoom);
        const oldRoom = rooms.get(currentRoom);
        if (oldRoom && oldRoom.participants.has(socket.id)) {
          oldRoom.participants.delete(socket.id);
          if (dbAvailable) {
            await removeParticipant(socket.id);
          }
          io.to(currentRoom).emit('participant-left', { userId: socket.id });
        }
      }

      // Join new room
      socket.join(roomId);
      currentRoom = roomId;
      userInfo = { id: userId || socket.id, name: userName };

      // Add participant
      const participant = {
        id: socket.id,
        name: userName,
        isHost: false,
        joinedAt: Date.now()
      };
      room.participants.set(socket.id, participant);

      // Save participant to database if available
      if (dbAvailable) {
        await saveParticipant(roomId, participant);
      }

      room.lastActivity = Date.now();

      // Send room info to user
      socket.emit('room-joined', {
        room: {
          id: room.id,
          name: room.name,
          anime: room.anime,
          episode: room.episode,
          episodeId: room.episodeId,
          host: room.host,
          participants: Array.from(room.participants.values()),
          messages: room.messages.slice(-50), // Last 50 messages
          playbackState: room.playbackState,
          settings: room.settings
        }
      });

      // Notify others
      socket.to(roomId).emit('participant-joined', {
        participant: room.participants.get(socket.id)
      });

      console.log(`👥 ${userName} joined room: ${roomId}`);

    } catch (error) {
      console.error('❌ Error joining room:', error);
      socket.emit('error', { message: 'Failed to join room' });
    }
  });

  // Leave room
  socket.on('leave-room', () => {
    if (currentRoom) {
      const room = rooms.get(currentRoom);
      if (room && room.participants.has(socket.id)) {
        const participant = room.participants.get(socket.id);
        room.participants.delete(socket.id);

        // If host left, assign new host
        if (room.host.id === socket.id && room.participants.size > 0) {
          const newHost = Array.from(room.participants.values())[0];
          room.host = { id: newHost.id, name: newHost.name };
          io.to(currentRoom).emit('host-changed', { newHost: room.host });
        }

        // If room is empty, clean up
        if (room.participants.size === 0) {
          rooms.delete(currentRoom);
          if (roomTimeouts.has(currentRoom)) {
            clearTimeout(roomTimeouts[currentRoom]);
            roomTimeouts.delete(currentRoom);
          }
        } else {
          io.to(currentRoom).emit('participant-left', { userId: socket.id });
        }

        socket.leave(currentRoom);
        console.log(`👋 ${participant?.name || socket.id} left room: ${currentRoom}`);
        currentRoom = null;
        userInfo = null;
      }
    }
  });

  // Send message
  socket.on('send-message', async (data) => {
    if (!currentRoom) return;

    const room = rooms.get(currentRoom);
    if (!room || !room.settings.allowChat) return;

    const participant = room.participants.get(socket.id);
    if (!participant) return;

    const message = {
      id: uuidv4(),
      userId: socket.id,
      userName: participant.name,
      content: data.content,
      timestamp: new Date().toISOString()
    };

    room.messages.push(message);
    room.lastActivity = Date.now();

    // Save message to database if available
    if (dbAvailable) {
      await saveMessage(currentRoom, message);
    }

    // Keep only last 100 messages
    if (room.messages.length > 100) {
      room.messages = room.messages.slice(-100);
    }

    io.to(currentRoom).emit('new-message', message);
  });

  // Update playback state
  socket.on('update-playback', (data) => {
    if (!currentRoom) return;

    const room = rooms.get(currentRoom);
    if (!room || !room.settings.syncPlayback) return;

    const participant = room.participants.get(socket.id);
    if (!participant) return;

    room.playbackState = {
      ...room.playbackState,
      ...data,
      lastUpdated: Date.now()
    };

    room.lastActivity = Date.now();

    // Broadcast to all participants except sender
    socket.to(currentRoom).emit('playback-updated', {
      ...room.playbackState,
      updatedBy: socket.id
    });
  });

  // Kick participant (host only)
  socket.on('kick-participant', (data) => {
    if (!currentRoom) return;

    const room = rooms.get(currentRoom);
    if (!room) return;

    const participant = room.participants.get(socket.id);
    if (!participant || !participant.isHost) return;

    const { userId } = data;
    if (!userId || !room.participants.has(userId)) return;

    // Remove participant
    room.participants.delete(userId);
    room.lastActivity = Date.now();

    // Notify kicked user and others
    io.to(userId).emit('kicked');
    io.to(currentRoom).emit('participant-kicked', { userId });

    console.log(`🚫 ${participant.name} kicked user ${userId} from room ${currentRoom}`);
  });

  // Transfer host
  socket.on('transfer-host', (data) => {
    if (!currentRoom) return;

    const room = rooms.get(currentRoom);
    if (!room) return;

    const participant = room.participants.get(socket.id);
    if (!participant || !participant.isHost) return;

    const { userId } = data;
    if (!userId || !room.participants.has(userId)) return;

    const newHost = room.participants.get(userId);
    room.host = { id: newHost.id, name: newHost.name };

    // Update host status
    room.participants.get(socket.id).isHost = false;
    newHost.isHost = true;

    room.lastActivity = Date.now();

    io.to(currentRoom).emit('host-changed', { newHost: room.host });

    console.log(`👑 ${participant.name} transferred host to ${newHost.name} in room ${currentRoom}`);
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    console.log(`🔌 User disconnected: ${socket.id}`);

    if (currentRoom) {
      const room = rooms.get(currentRoom);
      if (room && room.participants.has(socket.id)) {
        const participant = room.participants.get(socket.id);
        room.participants.delete(socket.id);

        // If host disconnected, assign new host
        if (room.host.id === socket.id && room.participants.size > 0) {
          const newHost = Array.from(room.participants.values())[0];
          room.host = { id: newHost.id, name: newHost.name };
          newHost.isHost = true;
          io.to(currentRoom).emit('host-changed', { newHost: room.host });
        }

        // If room is empty, clean up
        if (room.participants.size === 0) {
          rooms.delete(currentRoom);
          if (roomTimeouts.has(currentRoom)) {
            clearTimeout(roomTimeouts[currentRoom]);
            roomTimeouts.delete(currentRoom);
          }
        } else {
          io.to(currentRoom).emit('participant-left', { userId: socket.id });
        }
      }
    }
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('❌ Server Error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
  });
});

// Start server
server.listen(PORT, () => {
  console.log('🚀 Otazumi Watch Party Server running on port', PORT);
  console.log('🌐 Allowed origins:', allowedOrigins.join(', '));
  console.log('🏠 Active rooms will be cleaned up after', ROOM_TIMEOUT / (60 * 1000), 'minutes of inactivity');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('✅ HTTP server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('🛑 SIGINT signal received: closing HTTP server');
  server.close(() => {
    console.log('✅ HTTP server closed');
    process.exit(0);
  });
});
