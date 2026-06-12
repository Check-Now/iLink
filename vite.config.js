import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Electron renderer is loaded from file:// in production, so assets must use
// relative paths -> base: './'. Dev server is fixed to 127.0.0.1:5173 so the
// main process and wait-on agree on the URL.
export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
