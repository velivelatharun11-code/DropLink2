import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

// 1. Mandatory OPFS & SharedArrayBuffer Security Headers
app.use((req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  next();
});

const distPath = path.join(__dirname, 'dist');

// 2. Serve static assets from dist/assets with caching
app.use('/assets', express.static(path.join(distPath, 'assets'), {
  immutable: true,
  maxAge: '1y',
}));

// 3. Serve other static files (favicon, manifest, etc.)
app.use(express.static(distPath, { index: false }));

// 4. Socket.IO Signaling Mesh
const rooms = new Map();

io.on('connection', (socket) => {
  socket.on('join-room', (roomId) => {
    socket.join(roomId);
    if (!rooms.has(roomId)) {
      rooms.set(roomId, new Set());
    }
    const room = rooms.get(roomId);
    socket.to(roomId).emit('peer-joined', socket.id);
    room.add(socket.id);

    socket.on('signal', ({ to, signal }) => {
      io.to(to).emit('signal', { from: socket.id, signal });
    });

    socket.on('disconnect', () => {
      room.delete(socket.id);
      if (room.size === 0) {
        rooms.delete(roomId);
      }
      socket.to(roomId).emit('peer-left', socket.id);
    });
  });
});

// 5. Express 5 SPA Fallback: Catch-all handler without broken '*' syntax
app.use((req, res) => {
  if (path.extname(req.path)) {
    return res.status(404).type('text/plain').send(`Not found: ${req.path}`);
  }
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.sendFile(path.join(distPath, 'index.html'));
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`droplink2 server running on port ${PORT}`);
});