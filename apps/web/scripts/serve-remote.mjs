// Serve this build (apps/web/dist) and pass the API through to a remote JAM backend,
// streaming, so the SSE feed stays live. For running the phone app against a teammate's API:
//   API_URL=https://<their-tunnel> PORT=5401 node scripts/serve-remote.mjs
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

const API = process.env.API_URL
if (!API) throw new Error('set API_URL to the backend, e.g. https://xxxx.ngrok-free.app')
const PORT = Number(process.env.PORT ?? 5401)
const DIST = fileURLToPath(new URL('../dist', import.meta.url))
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2', '.json': 'application/json' }
const isApi = (p) => p.startsWith('/api/') || p.startsWith('/mcp') || p === '/c' || p === '/healthz' || p === '/readyz'
// Hop-by-hop, plus encoding: fetch has already decoded the body.
const DROP = new Set(['host', 'connection', 'content-length', 'content-encoding', 'transfer-encoding', 'keep-alive'])

const LOG = process.env.LOG === '1'
const REPORTER = `(function(){function s(m){try{navigator.sendBeacon('/__client-log',String(m))}catch(e){}}
window.addEventListener('error',function(e){s('error: '+e.message+' @ '+e.filename+':'+e.lineno+':'+e.colno+' '+(e.error&&e.error.stack||''))});
window.addEventListener('unhandledrejection',function(e){s('rejection: '+(e.reason&&(e.reason.stack||e.reason.message)||e.reason))});
var ce=console.error;console.error=function(){s('console.error: '+[].map.call(arguments,function(a){return a&&a.stack||String(a)}).join(' '));ce.apply(console,arguments)};
setTimeout(function(){var r=document.getElementById('root');s('after 6s: root children='+(r&&r.children.length)+' html='+(r&&r.innerHTML.slice(0,300)))},6000)})()`

createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname
  if (LOG) console.log(new Date().toISOString().slice(11, 19), req.method, req.url, req.headers['user-agent']?.slice(0, 60) ?? '')
  if (isApi(path)) {
    try {
      const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !DROP.has(k)))
      headers['ngrok-skip-browser-warning'] = '1'
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
      const up = await fetch(API + req.url, { method: req.method, headers, body: hasBody ? Readable.toWeb(req) : undefined, duplex: 'half', redirect: 'manual' })
      res.writeHead(up.status, Object.fromEntries([...up.headers].filter(([k]) => !DROP.has(k))))
      res.flushHeaders()
      if (!up.body) return res.end()
      const body = Readable.fromWeb(up.body)
      req.on('close', () => body.destroy())
      // A long-lived stream (SSE) dropping upstream ends this one response, never the server;
      // the page's EventSource reconnects on its own.
      body.on('error', (e) => {
        console.warn(`upstream ${req.url} ended: ${e.cause?.code ?? e.message}`)
        res.destroy()
      })
      res.on('error', () => body.destroy())
      body.pipe(res)
    } catch (e) {
      console.error(`proxy ${req.method} ${req.url} failed`, e)
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'the JAM backend did not answer' }))
    }
    return
  }
  // With LOG=1, the page reports its own errors here, for debugging a phone with no console.
  if (LOG && path === '/__client-log' && req.method === 'POST') {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      console.log('CLIENT', body.slice(0, 2000))
      res.end()
    })
    return
  }
  let file = join(DIST, normalize(path).replace(/^(\.\.[/\\])+/, ''))
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(DIST, 'index.html')
  const ext = extname(file)
  res.writeHead(200, { 'content-type': TYPES[ext] ?? 'application/octet-stream', 'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable' })
  if (LOG && ext === '.html') {
    const html = readFileSync(file, 'utf8').replace('<head>', `<head><script>${REPORTER}</script>`)
    return res.end(html)
  }
  createReadStream(file).pipe(res)
}).listen(PORT, () => console.log(`JAM on :${PORT}, API → ${API}`))

// One bad socket must not take the phone's whole connection down with it.
process.on('uncaughtException', (e) => console.error('uncaught (kept running):', e))
process.on('unhandledRejection', (e) => console.error('unhandled rejection (kept running):', e))
