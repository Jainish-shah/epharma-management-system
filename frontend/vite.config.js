import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The production build is emitted into ../public, which Django serves (one process, one port).
// In development, `npm run dev` runs Vite with hot reload and proxies /api to Django on :3000.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../public',
    emptyOutDir: true,
  },
  server: {
    port: 5174,
    proxy: {
      '/api': { target: process.env.API_TARGET || 'http://127.0.0.1:3000', changeOrigin: true },
    },
  },
});
