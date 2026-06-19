import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// El server EventOS escucha en 127.0.0.1:4010 (CONTRACT §7).
// En dev, proxiamos /api y /socket.io hacia él (incluyendo el upgrade WebSocket).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4010',
        changeOrigin: true,
      },
      '/socket.io': {
        target: 'http://127.0.0.1:4010',
        changeOrigin: true,
        ws: true,
      },
    },
  },
})
