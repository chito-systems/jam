import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// In dev the API (apps/api, Hono) runs on :3000. Proxy its paths so the browser
// talks to one origin, the same as in the cluster where the API serves this build.
// Set API_URL to use a remote API (the cluster, or a teammate's tunnel) and share its brain.
const API = process.env.API_URL ?? 'http://localhost:3000'

// changeOrigin: a remote host routes on the Host header. The ngrok header skips its
// browser warning page, which would otherwise come back as HTML instead of JSON.
const toApi = { target: API, changeOrigin: true, headers: { 'ngrok-skip-browser-warning': '1' } }

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': toApi,
      '/mcp': toApi,
      // Exactly /c (the bootstrap capture page). A plain '/c' key would also swallow /capture.
      '^/c$': toApi,
      '/healthz': toApi,
      '/readyz': toApi,
    },
  },
})
