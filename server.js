import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'dist')));

app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

io.on('connection', (socket) => {
  console.log(`[Connect] ${socket.id}`);

  const handleJoin = (roomId) => {
    socket.join(roomId);
    console.log(`[Room] ${socket.id} joined ${roomId}`);

    // ONLY notify existing peers in the room to initiate the offer.
    // The newly joined socket will wait for the offer to prevent WebRTC glare collision.
    socket.to(roomId).emit('peer-joined', socket.id);
  };

  socket.on('join-room', handleJoin);
  socket.on('join', handleJoin);

  socket.on('signal', (data) => {
    const target = data.to || data.target;
    console.log(`[Signal] From ${socket.id} -> ${target} (type: ${data.signal?.sdp?.type || (data.signal?.candidate ? 'candidate' : 'unknown')})`);
    if (target) {
      io.to(target).emit('signal', { from: socket.id, signal: data.signal });
    }
  });

  socket.on('disconnect', () => {
    console.log(`[Disconnect] ${socket.id}`);
    io.emit('peer-disconnected', socket.id);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`DropLink2 listening on port ${PORT}`);
});
