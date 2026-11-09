import react from '@vitejs/plugin-react'
import { defineConfig, type ProxyOptions } from 'vite'

// In dev the API (apps/api, Hono) runs on :3000. Proxy its paths so the browser
// talks to one origin, the same as in the cluster where the API serves this build.
// Set API_URL to use a remote API (the cluster, or a teammate's tunnel) and share its brain.
const API = process.env.API_URL ?? 'http://localhost:3000'

// changeOrigin: a remote host routes on the Host header. The ngrok header skips its
// browser warning page, which would otherwise come back as HTML instead of JSON.
// configure: EventSource.onopen fires when response headers arrive, but the proxy only sends
// them with the first body write, and the API stays quiet until its 15 s ping. Flush them now
// (after http-proxy has copied the upstream headers) so the status bar leaves "connecting".
const toApi: ProxyOptions = {
  target: API,
  changeOrigin: true,
  headers: { 'ngrok-skip-browser-warning': '1' },
  configure: (proxy) =>
    proxy.on('proxyRes', (pr, _req, res) => {
      if (pr.headers['content-type']?.startsWith('text/event-stream')) queueMicrotask(() => res.flushHeaders())
    }),
}

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
