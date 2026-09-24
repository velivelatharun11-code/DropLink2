import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  base: '/',
  plugins: [react(), tailwindcss()],
  server: {
    host: '0.0.0.0', // Listens on all interfaces (IPv4 and IPv6)
    port: 5173,
    strictPort: true, // Forces port 5173 so it never quietly switches to 5174
    allowedHosts: [
      'kent-edinburgh-admission-dance.trycloudflare.com',
      '.trycloudflare.com'
    ],
    proxy: {
      '/socket.io': {
        target: 'http://127.0.0.1:3001',
        ws: true,
      }
    },
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp'
    }
  },
  worker: {
    format: 'es'
  }
});