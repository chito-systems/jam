// JAM desktop: a thin native shell around the hosted web app. The UI updates with every deploy;
// Cmd+R picks it up. Also starts the local terminal bridge when it finds a repo checkout.
const { app, BrowserWindow, Menu, nativeTheme, session, shell, systemPreferences } = require('electron')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')

const JAM_URL = process.env.JAM_URL || 'https://jam.cnh.radarhq.io'
const JAM_ORIGIN = new URL(JAM_URL).origin
const BRIDGE_PORT = 4317
// Same values as apps/web/index.html theme-color, so the window never flashes the wrong color.
const bg = () => (nativeTheme.shouldUseDarkColors ? '#151412' : '#fbfaf6')

let win = null
let bridge = null

const sameOrigin = (url) => {
  try {
    return new URL(url).origin === JAM_ORIGIN
  } catch {
    return false
  }
}

// --- terminal bridge -------------------------------------------------------

function findRepo() {
  const isRepo = (dir) => fs.existsSync(path.join(dir, 'apps/web/bridge/server.ts'))
  if (process.env.JAM_REPO) return isRepo(process.env.JAM_REPO) ? process.env.JAM_REPO : null
  for (const start of [__dirname, app.getAppPath(), process.cwd()]) {
    let dir = path.resolve(start)
    for (;;) {
      if (isRepo(dir)) return dir
      const up = path.dirname(dir)
      if (up === dir) break
      dir = up
    }
  }
  return null
}

function portInUse(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port })
    s.once('connect', () => (s.destroy(), resolve(true)))
    s.once('error', () => resolve(false))
    s.setTimeout(500, () => (s.destroy(), resolve(false)))
  })
}

async function startBridge() {
  const repo = findRepo()
  if (!repo) return console.log('[jam] no repo checkout found; terminal bridge not started')
  if (await portInUse(BRIDGE_PORT)) return console.log(`[jam] bridge already listening on ${BRIDGE_PORT}; leaving it alone`)
  // Apps launched from Finder get a bare PATH; add the usual places pnpm and node live.
  const PATH = [process.env.PATH, '/opt/homebrew/bin', '/usr/local/bin', path.join(process.env.HOME || '', 'Library/pnpm')]
    .filter(Boolean)
    .join(':')
  bridge = spawn('pnpm', ['--filter', '@hh/web', 'bridge'], {
    cwd: repo,
    env: { ...process.env, PATH, JAM_BRIDGE_ORIGINS: JAM_ORIGIN, JAM_BRIDGE_CWD: repo },
    stdio: ['ignore', 'inherit', 'inherit'],
    detached: true, // own process group, so quit can stop pnpm and everything under it
  })
  bridge.on('error', (e) => console.error('[jam] bridge failed to start:', e.message))
  bridge.on('exit', (code) => {
    console.log(`[jam] bridge exited (${code})`)
    bridge = null
  })
  console.log(`[jam] started terminal bridge in ${repo} (pid ${bridge.pid})`)
}

function stopBridge() {
  if (!bridge || bridge.pid == null) return
  try {
    process.kill(-bridge.pid, 'SIGTERM')
  } catch {
    bridge.kill('SIGTERM')
  }
  bridge = null
}

// --- window ----------------------------------------------------------------

function errorPage(code, desc) {
  const dark = nativeTheme.shouldUseDarkColors
  const fg = dark ? '#ece9e2' : '#1d1b18'
  const muted = dark ? '#9a958b' : '#6b665d'
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
  const html = `<!doctype html><meta charset="utf-8"><title>JAM</title>
<style>body{margin:0;height:100vh;display:grid;place-items:center;background:${bg()};color:${fg};font:15px/1.5 -apple-system,system-ui,sans-serif}
main{max-width:420px;padding:24px}h1{font-size:20px;margin:0 0 8px}p{color:${muted};margin:0 0 20px}
button{font:inherit;padding:8px 16px;border-radius:8px;border:1px solid ${muted};background:transparent;color:${fg};cursor:pointer}</style>
<main><h1>JAM can't reach ${esc(JAM_ORIGIN)}</h1><p>${esc(desc)} (${esc(code)}). Check your connection, then retry.</p>
<button onclick="location.href=${esc(JSON.stringify(JAM_URL))}">Retry</button></main>`
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html)
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'JAM',
    backgroundColor: bg(),
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => (win = null))

  const wc = win.webContents
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  wc.on('will-navigate', (e, url) => {
    if (sameOrigin(url) || url.startsWith('data:')) return
    e.preventDefault()
    if (/^https?:/.test(url)) shell.openExternal(url)
  })
  wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3 /* ERR_ABORTED */ || url.startsWith('data:')) return
    console.error(`[jam] load failed: ${desc} (${code}) ${url}`)
    wc.loadURL(errorPage(code, desc))
  })
  wc.on('did-finish-load', () => console.log(`[jam] did-finish-load: "${wc.getTitle()}" ${wc.getURL().slice(0, 80)}`))
  win.loadURL(JAM_URL)
}

function buildMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { label: 'JAM', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { type: 'separator' }, { role: 'quit' }] },
      { role: 'editMenu' },
      {
        label: 'View',
        submenu: [
          { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => win && win.loadURL(JAM_URL) },
          { role: 'togglefullscreen' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
        ],
      },
      { role: 'windowMenu' },
    ]),
  )
}

// --- lifecycle -------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.setName('JAM')
  app.on('second-instance', () => {
    if (!win) return createWindow()
    if (win.isMinimized()) win.restore()
    win.focus()
  })

  app.whenReady().then(async () => {
    // Voice-first: allow the microphone for the JAM origin only.
    const ses = session.defaultSession
    const allowed = (permission, origin, details) =>
      sameOrigin(origin) &&
      (permission === 'media' ? !details || !details.mediaTypes || details.mediaTypes.every((t) => t === 'audio') : ['clipboard-sanitized-write', 'clipboard-read', 'notifications'].includes(permission))
    ses.setPermissionRequestHandler((wc, permission, cb, details) =>
      cb(allowed(permission, details.requestingUrl || wc.getURL(), details)),
    )
    ses.setPermissionCheckHandler((_wc, permission, origin) => allowed(permission, origin))
    if (process.platform === 'darwin') systemPreferences.askForMediaAccess('microphone').catch(() => {})

    buildMenu()
    createWindow()
    startBridge()
    app.on('activate', () => {
      if (!win) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  app.on('before-quit', stopBridge)
  process.on('exit', stopBridge)
}
