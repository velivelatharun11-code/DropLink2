import { createServer } from 'http';
import { Server } from 'socket.io';

const server = createServer();
const io = new Server(server, {
  cors: { origin: '*' }
});

const rooms = new Map(); // roomId -> Set of socket IDs

io.on('connection', (socket) => {
  socket.on('join-room', (roomId) => {
    socket.join(roomId);
    if (!rooms.has(roomId)) {
      rooms.set(roomId, new Set());
    }
    const room = rooms.get(roomId);
    
    // Notify existing peers that a new peer arrived
    socket.to(roomId).emit('peer-joined', socket.id);
    room.add(socket.id);

    console.log(`Socket ${socket.id} joined room: ${roomId}`);
  });

  // Relay WebRTC signals (Offers, Answers, ICE Candidates)
  socket.on('signal', ({ to, signal }) => {
    io.to(to).emit('signal', { from: socket.id, signal });
  });

  socket.on('disconnecting', () => {
    for (const roomId of socket.rooms) {
      if (rooms.has(roomId)) {
        rooms.get(roomId).delete(socket.id);
        socket.to(roomId).emit('peer-left', socket.id);
      }
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`droplink2 signaling active on http://localhost:${PORT}`);
});