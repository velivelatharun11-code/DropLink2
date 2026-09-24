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

// Room state schema:
// rooms.set(roomId, {
//   passwordHash: string | null,
//   members: Map<socketId, { name: string }>,
//   transferLock: { isLocked: boolean, senderId: string | null, senderName: string | null }
// });
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
    const memberCount = exists ? roomData.members.size : 0;
    const isFull = memberCount >= MAX_PEERS_PER_ROOM;

    const info = {
      roomId: cleanId,
      exists,
      isProtected,
      peerCount: memberCount,
      occupancy: memberCount,
      isFull
    };

    if (typeof callback === 'function') {
      callback(info);
    } else {
      socket.emit('room-info', info);
    }
  });

  socket.on('join-room', (payload, maybePassword, maybeName) => {
    let roomId = typeof payload === 'object' && payload !== null ? payload.roomId : payload;
    let password = typeof payload === 'object' && payload !== null ? payload.password : maybePassword;
    let peerName = typeof payload === 'object' && payload !== null ? payload.peerName : maybeName;

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
        members: new Map(),
        transferLock: { isLocked: false, senderId: null, senderName: null }
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

    // Enforce 5-peer room cap
    if (roomData.members.size >= MAX_PEERS_PER_ROOM && !roomData.members.has(socket.id)) {
      socket.emit('room-full', { 
        roomId, 
        maxPeers: MAX_PEERS_PER_ROOM, 
        message: 'Room capacity reached (maximum 5 peers).' 
      });
      return;
    }

    // Leave previous room cleanly if switching
    if (currentRoom && currentRoom !== roomId && rooms.has(currentRoom)) {
      const oldRoomData = rooms.get(currentRoom);
      const wasLockHolder = oldRoomData.transferLock.isLocked && oldRoomData.transferLock.senderId === socket.id;
      oldRoomData.members.delete(socket.id);
      socket.leave(currentRoom);

      if (wasLockHolder) {
        oldRoomData.transferLock = { isLocked: false, senderId: null, senderName: null };
        io.to(currentRoom).emit('transfer-lock-released', {
          releasedBy: socket.id,
          reason: 'sender-switched-room'
        });
      }

      socket.to(currentRoom).emit('peer-left', {
        peerId: socket.id,
        totalPeers: oldRoomData.members.size,
        occupancy: oldRoomData.members.size,
        maxPeers: MAX_PEERS_PER_ROOM
      });

      io.to(currentRoom).emit('room-occupancy-update', {
        occupancy: oldRoomData.members.size,
        maxPeers: MAX_PEERS_PER_ROOM
      });

      if (oldRoomData.members.size === 0) {
        rooms.delete(currentRoom);
      }
    }

    // Join room
    currentRoom = roomId;
    socket.join(roomId);

    const displayName = peerName ? String(peerName).trim() : `Device-${socket.id.substring(0, 4).toUpperCase()}`;
    roomData.members.set(socket.id, { name: displayName });

    const existingPeers = Array.from(roomData.members.keys()).filter((id) => id !== socket.id);
    
    // Send joined confirmation with initial occupancy and lock state
    socket.emit('room-joined', {
      roomId,
      peerId: socket.id,
      peerName: displayName,
      existingPeers,
      totalPeers: roomData.members.size,
      occupancy: roomData.members.size,
      isPolite: true,
      maxPeers: MAX_PEERS_PER_ROOM,
      isProtected: !!roomData.passwordHash,
      transferLock: roomData.transferLock
    });

    // Notify other peers in room about the new participant
    socket.to(roomId).emit('peer-joined', {
      peerId: socket.id,
      peerName: displayName,
      totalPeers: roomData.members.size,
      occupancy: roomData.members.size,
      maxPeers: MAX_PEERS_PER_ROOM,
      transferLock: roomData.transferLock
    });

    // Emit live occupancy update to everyone in room
    io.to(roomId).emit('room-occupancy-update', {
      roomId,
      occupancy: roomData.members.size,
      maxPeers: MAX_PEERS_PER_ROOM
    });

    console.log(`[Socket] ${socket.id} (${displayName}) joined room "${roomId}" (${roomData.members.size}/${MAX_PEERS_PER_ROOM} peers) [protected: ${!!roomData.passwordHash}]`);
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

  // Mutual-Exclusion Transfer Lock Management
  socket.on('acquire-transfer-lock', (callback) => {
    if (!currentRoom || !rooms.has(currentRoom)) {
      if (typeof callback === 'function') callback({ success: false, error: 'Not in an active room' });
      return;
    }

    const roomData = rooms.get(currentRoom);
    if (roomData.transferLock.isLocked && roomData.transferLock.senderId !== socket.id) {
      if (typeof callback === 'function') {
        callback({
          success: false,
          error: 'Room transfer is currently locked by another peer',
          lock: roomData.transferLock
        });
      }
      return;
    }

    const member = roomData.members.get(socket.id);
    const senderName = member ? member.name : `Peer-${socket.id.substring(0, 4).toUpperCase()}`;
    roomData.transferLock = {
      isLocked: true,
      senderId: socket.id,
      senderName
    };

    io.to(currentRoom).emit('transfer-lock-acquired', {
      senderId: socket.id,
      senderName
    });

    console.log(`[Lock] Transfer lock ACQUIRED by ${socket.id} (${senderName}) in room "${currentRoom}"`);

    if (typeof callback === 'function') {
      callback({ success: true, lock: roomData.transferLock });
    }
  });

  socket.on('release-transfer-lock', (callback) => {
    if (!currentRoom || !rooms.has(currentRoom)) {
      if (typeof callback === 'function') callback({ success: false });
      return;
    }

    const roomData = rooms.get(currentRoom);
    if (roomData.transferLock.isLocked && roomData.transferLock.senderId === socket.id) {
      roomData.transferLock = {
        isLocked: false,
        senderId: null,
        senderName: null
      };

      io.to(currentRoom).emit('transfer-lock-released', {
        releasedBy: socket.id
      });

      console.log(`[Lock] Transfer lock RELEASED by ${socket.id} in room "${currentRoom}"`);

      if (typeof callback === 'function') {
        callback({ success: true });
      }
    } else {
      if (typeof callback === 'function') {
        callback({ success: false, error: 'Socket is not holding the transfer lock' });
      }
    }
  });

  // Handle clean disconnections and room exits
  const handleLeave = () => {
    if (currentRoom && rooms.has(currentRoom)) {
      const roomData = rooms.get(currentRoom);
      const wasLockHolder = roomData.transferLock.isLocked && roomData.transferLock.senderId === socket.id;

      roomData.members.delete(socket.id);
      socket.leave(currentRoom);

      // Safety Fallback: Automatically release lock if the active sender disconnects mid-transfer
      if (wasLockHolder) {
        roomData.transferLock = {
          isLocked: false,
          senderId: null,
          senderName: null
        };
        io.to(currentRoom).emit('transfer-lock-released', {
          releasedBy: socket.id,
          reason: 'sender-disconnected'
        });
        console.log(`[Lock] Safety fallback: Transfer lock auto-released in room "${currentRoom}" as sender ${socket.id} disconnected.`);
      }

      // Notify remaining peers
      socket.to(currentRoom).emit('peer-left', {
        peerId: socket.id,
        totalPeers: roomData.members.size,
        occupancy: roomData.members.size,
        maxPeers: MAX_PEERS_PER_ROOM
      });

      io.to(currentRoom).emit('room-occupancy-update', {
        roomId: currentRoom,
        occupancy: roomData.members.size,
        maxPeers: MAX_PEERS_PER_ROOM
      });

      console.log(`[Socket] ${socket.id} left room "${currentRoom}" (${roomData.members.size} remaining)`);

      if (roomData.members.size === 0) {
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