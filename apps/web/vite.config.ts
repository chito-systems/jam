import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// In dev the API (apps/api, Hono) runs on :3000. Proxy its paths so the browser
// talks to one origin, the same as in the cluster where the API serves this build.
const API = process.env.API_URL ?? 'http://localhost:3000'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': API,
      '/mcp': API,
      '/c': API,
      '/healthz': API,
      '/readyz': API,
    },
  },
})
