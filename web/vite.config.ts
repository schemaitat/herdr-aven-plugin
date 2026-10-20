import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist/client' },
  // Vite is middleware behind the authenticated local Fastify server, never a second listener.
  server: { middlewareMode: true, hmr: false, allowedHosts: ['127.0.0.1'] },
});
