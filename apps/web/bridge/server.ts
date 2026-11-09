// JAM terminal bridge: gives the Terminal tab a real shell on THIS computer.
// Run it on your laptop: pnpm --filter @hh/web bridge. Nothing here runs on the server.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { BRIDGE_PORT, isAllowedOrigin, parseClientMessage } from './protocol'

const HOST = '127.0.0.1'
const PORT = Number(process.env.JAM_BRIDGE_PORT) || BRIDGE_PORT
const EXTRA = process.env.JAM_BRIDGE_ORIGINS ?? ''
// pnpm runs scripts from apps/web; INIT_CWD is where the user typed the command.
const CWD = process.env.JAM_BRIDGE_CWD || process.env.INIT_CWD || process.cwd()
const SHELL = process.env.SHELL || ['/bin/zsh', '/bin/bash'].find((s) => existsSync(s)) || '/bin/sh'
const HELPER = fileURLToPath(new URL('./pty_helper.py', import.meta.url))
const PYTHON = spawnSync('python3', ['-c', ''], { stdio: 'ignore' }).status === 0
if (!PYTHON) console.error('python3 not found: falling back to `script`, so the terminal will not follow window resizes.')

const children = new Set<ChildProcess>()
const allowed = (req: IncomingMessage) => isAllowedOrigin(req.headers.origin, EXTRA) && /^(127\.0\.0\.1|localhost):\d+$/.test(req.headers.host ?? '')

function health(req: IncomingMessage, res: ServerResponse) {
  if (!allowed(req)) return res.writeHead(403).end()
  const origin = req.headers.origin as string
  const cors = { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' }
  if (req.method === 'OPTIONS') {
    // Chrome asks before a public page may reach a private address.
    return res.writeHead(204, { ...cors, 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Allow-Private-Network': 'true' }).end()
  }
  res.writeHead(200, { ...cors, 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, cwd: CWD, shell: SHELL }))
}

function startShell(): ChildProcess {
  const env = { ...process.env, TERM: 'xterm-256color' }
  // detached: our own process group, so Ctrl+C in the bridge's terminal reaches only the bridge.
  if (PYTHON) return spawn('python3', [HELPER, SHELL, '80', '24'], { cwd: CWD, env, detached: true, stdio: ['pipe', 'pipe', 'inherit', 'pipe'] })
  return spawn('script', ['-q', '/dev/null', SHELL, '-l', '-i'], { cwd: CWD, env, detached: true, stdio: ['pipe', 'pipe', 'inherit'] })
}

const server = createServer((req, res) => {
  if (req.url === '/health') return health(req, res)
  res.writeHead(404).end()
})
const wss = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  if (!allowed(req)) {
    console.error(`refused a terminal connection from origin ${req.headers.origin ?? '(none)'}`)
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
    return
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const child = startShell()
    children.add(child)
    const resize = child.stdio[3] as NodeJS.WritableStream | undefined
    // A shell that exits mid-write, or a dropped socket, emits 'error' on these streams.
    // Unhandled, that would take the whole bridge down: log once and end this session only.
    const fail = (what: string) => (e: Error) => {
      console.error(`terminal session: ${what} failed`, e.message)
      if (ws.readyState === ws.OPEN) ws.close(1011, 'session error')
    }
    child.stdin?.on('error', fail('writing to the shell'))
    child.stdout?.on('error', fail('reading from the shell'))
    resize?.on('error', fail('resizing the shell'))
    ws.on('error', fail('the socket'))
    child.stdout?.on('data', (b: Buffer) => {
      if (ws.readyState === ws.OPEN) ws.send(b)
    })
    child.on('exit', () => {
      children.delete(child)
      ws.close(1000, 'shell exited')
    })
    child.on('error', (e) => {
      console.error('starting the shell failed', e)
      ws.close(1011, 'shell failed')
    })
    ws.on('message', (data, binary) => {
      const m = binary ? null : parseClientMessage(data.toString())
      if (m?.t === 'in' && child.stdin?.writable) child.stdin.write(m.d)
      if (m?.t === 'resize' && resize?.writable) resize.write(`${m.cols} ${m.rows}\n`)
    })
    ws.on('close', () => {
      child.stdin?.end()
      child.kill('SIGTERM')
    })
  })
})

const shutdown = () => {
  for (const c of children) c.kill('SIGTERM')
  server.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

server.listen(PORT, HOST, () => {
  console.log(`JAM bridge on ws://${HOST}:${PORT} · shell ${SHELL} in ${CWD} · accepts connections from this computer only`)
})
