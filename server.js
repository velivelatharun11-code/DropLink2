import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';

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

// Room tracking: roomId -> Set of socket IDs
const rooms = new Map();

// Serve static frontend build if dist folder exists
app.use(express.static(path.join(__dirname, 'dist')));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', activeRooms: rooms.size, timestamp: Date.now() });
});

// Fallback all SPA routes to index.html
app.get('*', (req, res) => {
  const indexPath = path.join(__dirname, 'dist', 'index.html');
  res.sendFile(indexPath, (err) => {
    if (err) {
      res.status(200).send('DropLink2 Signaling Server is active.');
    }
  });
});

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('join-room', (roomId) => {
    if (!roomId) return;

    if (!rooms.has(roomId)) {
      rooms.set(roomId, new Set());
    }

    const room = rooms.get(roomId);

    // Enforce 5-peer room cap
    if (room.size >= MAX_PEERS_PER_ROOM && !room.has(socket.id)) {
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
    room.add(socket.id);

    // Send existing peers list to the newly joined peer
    // In Perfect Negotiation: existing peers are impolite, the newly joined peer is polite
    const existingPeers = Array.from(room).filter(id => id !== socket.id);
    
    socket.emit('room-joined', {
      roomId,
      peerId: socket.id,
      existingPeers,
      maxPeers: MAX_PEERS_PER_ROOM
    });

    // Notify other peers in room about the new participant
    socket.to(roomId).emit('peer-joined', {
      peerId: socket.id,
      totalPeers: room.size
    });

    console.log(`[Socket] ${socket.id} joined room "${roomId}" (${room.size}/${MAX_PEERS_PER_ROOM} peers)`);
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

  // Handle clean disconnections
  socket.on('disconnect', () => {
    if (currentRoom && rooms.has(currentRoom)) {
      const room = rooms.get(currentRoom);
      room.delete(socket.id);

      // Notify remaining peers
      socket.to(currentRoom).emit('peer-left', {
        peerId: socket.id,
        totalPeers: room.size
      });

      console.log(`[Socket] ${socket.id} left room "${currentRoom}" (${room.size} remaining)`);

      if (room.size === 0) {
        rooms.delete(currentRoom);
      }
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n==================================================`);
  console.log(`  DropLink2 5-Peer Signaling Server`);
  console.log(`  Running on: http://localhost:${PORT}`);
  console.log(`  Room Capacity: ${MAX_PEERS_PER_ROOM} peers per room`);
  console.log(`==================================================\n`);
});