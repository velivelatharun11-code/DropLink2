import { createServer } from 'http';
import { Server } from 'socket.io';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DIST_DIR = path.join(__dirname, 'dist');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    let pathname = decodeURIComponent(url.pathname);

    if (pathname === '/') {
      pathname = '/index.html';
    }

    let filePath = path.join(DIST_DIR, pathname);

    // Prevent directory traversal attacks
    if (!filePath.startsWith(DIST_DIR)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    try {
      const stats = await fs.stat(filePath);
      if (stats.isDirectory()) {
        filePath = path.join(filePath, 'index.html');
      }
    } catch {
      // SPA Fallback: route not found directly -> serve index.html
      filePath = path.join(DIST_DIR, 'index.html');
    }

    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    // Service Worker should not be cached aggressively by browsers
    const cacheControl = pathname === '/sw.js'
      ? 'no-cache, no-store, must-revalidate'
      : 'public, max-age=31536000, immutable';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': ext === '.html' ? 'no-cache' : cacheControl,
    });
    res.end(data);
  } catch (err) {
    res.writeHead(500);
    res.end('Server Error');
  }
});

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
        if (rooms.get(roomId).size === 0) {
          rooms.delete(roomId);
        }
      }
    }
  });

  socket.on('disconnect', () => {
    console.log(`Socket disconnected: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`DropLink2 server running at http://localhost:${PORT}`);
});
