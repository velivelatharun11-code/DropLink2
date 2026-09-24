import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);

// Allow connections from Vite dev server and tunnel/cloud URLs
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  transports: ['polling', 'websocket'],
  pingTimeout: 30000,
  pingInterval: 15000
});

const PORT = process.env.PORT || 3001;
const MAX_PEERS_PER_ROOM = 5;

// Room tracking: roomId -> { passwordHash: string | null, peers: Set<socketId> }
const rooms = new Map();

function hashPassword(password) {
  if (!password || typeof password !== 'string') return null;
  const trimmed = password.trim();
  if (!trimmed) return null;
  return crypto.createHash('sha256').update(trimmed).digest('hex');
}

// Serve static frontend build if dist folder exists
app.use(express.static(path.join(__dirname, 'dist')));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', activeRooms: rooms.size, timestamp: Date.now() });
});

// Fallback all SPA routes to index.html
app.use((req, res) => {
  const indexPath = path.join(__dirname, 'dist', 'index.html');
  res.sendFile(indexPath, (err) => {
    if (err) {
      res.status(200).send('DropLink2 Signaling Server is active.');
    }
  });
});

io.on('connection', (socket) => {
  let currentRoom = null;

  // Query room status without joining
  socket.on('check-room', (roomId, callback) => {
    if (!roomId) return;
    const cleanId = String(roomId).trim().replace(/^#/, '');
    const exists = rooms.has(cleanId);
    const roomData = exists ? rooms.get(cleanId) : null;
    const isProtected = exists && !!roomData.passwordHash;
    const peerCount = exists ? roomData.peers.size : 0;
    const isFull = peerCount >= MAX_PEERS_PER_ROOM;

    const info = {
      roomId: cleanId,
      exists,
      isProtected,
      peerCount,
      isFull
    };

    if (typeof callback === 'function') {
      callback(info);
    } else {
      socket.emit('room-info', info);
    }
  });

  socket.on('join-room', (payload, maybePassword) => {
    let roomId = typeof payload === 'object' && payload !== null ? payload.roomId : payload;
    let password = typeof payload === 'object' && payload !== null ? payload.password : maybePassword;

    if (!roomId) return;
    roomId = String(roomId).trim().replace(/^#/, '');
    if (!roomId) return;

    // Check if room exists
    const roomExists = rooms.has(roomId);

    if (!roomExists) {
      // Create new room with optional password
      const passwordHash = hashPassword(password);
      rooms.set(roomId, {
        passwordHash,
        peers: new Set()
      });
    }

    const roomData = rooms.get(roomId);

    // If room is password-protected, authenticate
    if (roomData.passwordHash) {
      const incomingHash = hashPassword(password);
      if (!incomingHash) {
        socket.emit('room-auth-required', {
          roomId,
          message: 'This room is password-protected. Please enter the password to join.'
        });
        return;
      }
      if (incomingHash !== roomData.passwordHash) {
        socket.emit('room-auth-failed', {
          roomId,
          message: 'Invalid room password. Access denied.'
        });
        return;
      }
    }

    // Leave previous room cleanly if switching
    if (currentRoom && currentRoom !== roomId && rooms.has(currentRoom)) {
      const oldRoomData = rooms.get(currentRoom);
      oldRoomData.peers.delete(socket.id);
      socket.leave(currentRoom);
      socket.to(currentRoom).emit('peer-left', {
        peerId: socket.id,
        totalPeers: oldRoomData.peers.size
      });
      if (oldRoomData.peers.size === 0) {
        rooms.delete(currentRoom);
      }
    }

    // Enforce 5-peer room cap
    if (roomData.peers.size >= MAX_PEERS_PER_ROOM && !roomData.peers.has(socket.id)) {
      socket.emit('room-full', { 
        roomId, 
        maxPeers: MAX_PEERS_PER_ROOM, 
        message: 'Room capacity reached (maximum 5 peers).' 
      });
      return;
    }

    // Join room
    currentRoom = roomId;
    socket.join(roomId);
    roomData.peers.add(socket.id);

    // Send existing peers list to the newly joined peer
    // In Perfect Negotiation: existing peers are impolite, the newly joined peer is polite
    const existingPeers = Array.from(roomData.peers).filter(id => id !== socket.id);
    
    socket.emit('room-joined', {
      roomId,
      peerId: socket.id,
      existingPeers,
      isPolite: true,
      maxPeers: MAX_PEERS_PER_ROOM,
      isProtected: !!roomData.passwordHash
    });

    // Notify other peers in room about the new participant
    socket.to(roomId).emit('peer-joined', {
      peerId: socket.id,
      totalPeers: roomData.peers.size
    });

    console.log(`[Socket] ${socket.id} joined room "${roomId}" (${roomData.peers.size}/${MAX_PEERS_PER_ROOM} peers) [protected: ${!!roomData.passwordHash}]`);
  });

  // Relay WebRTC signals (Offers, Answers, ICE Candidates)
  socket.on('signal', ({ targetPeerId, signal }) => {
    if (targetPeerId) {
      io.to(targetPeerId).emit('signal', {
        senderPeerId: socket.id,
        signal
      });
    }
  });

  // Handle clean disconnections and room exits
  const handleLeave = () => {
    if (currentRoom && rooms.has(currentRoom)) {
      const roomData = rooms.get(currentRoom);
      roomData.peers.delete(socket.id);
      socket.leave(currentRoom);

      // Notify remaining peers
      socket.to(currentRoom).emit('peer-left', {
        peerId: socket.id,
        totalPeers: roomData.peers.size
      });

      console.log(`[Socket] ${socket.id} left room "${currentRoom}" (${roomData.peers.size} remaining)`);

      if (roomData.peers.size === 0) {
        rooms.delete(currentRoom);
      }
      currentRoom = null;
    }
  };

  socket.on('leave-room', handleLeave);
  socket.on('disconnect', handleLeave);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n==================================================`);
  console.log(`  DropLink2 5-Peer Signaling Server`);
  console.log(`  Running on: http://localhost:${PORT}`);
  console.log(`  Room Capacity: ${MAX_PEERS_PER_ROOM} peers per room`);
  console.log(`==================================================\n`);
});