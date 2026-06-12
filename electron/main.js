'use strict'

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, Notification, dialog, shell, desktopCapturer, screen, clipboard } = require('electron')
const path = require('path')
const os = require('os')
const fs = require('fs')
const crypto = require('crypto')
const { P2P } = require('./p2p')
const { Vault } = require('./vault')
const { FileTransfer } = require('./filetransfer')

const isDev = process.env.NODE_ENV === 'development'
const DEV_SERVER_URL = 'http://127.0.0.1:5173'

/** @type {BrowserWindow | null} */
let mainWindow = null
const chatWindows = new Map()
/** @type {P2P | null} */
let p2p = null
/** @type {Vault | null} */
let vault = null
let tray = null
let ft = null
let isQuitting = false
const pendingFiles = new Map()
const runtime = { minimizeToTray: true, notifyEnabled: true, notifyPreview: true, closeAction: 'ask' }

// 应用图标：项目根目录 icon.png，dev 与打包后都可解析
let appIconImg = null
function getAppIcon () {
  if (appIconImg && !appIconImg.isEmpty()) return appIconImg
  try {
    const img = nativeImage.createFromPath(path.join(__dirname, '..', 'icon.png'))
    if (img && !img.isEmpty()) { appIconImg = img; return img }
  } catch (_) {}
  return null
}

function publishableAvatar (avatar) {
  if (!avatar || typeof avatar !== 'object') return null
  const type = avatar.type === 'image' ? 'image' : (avatar.type === 'preset' ? 'preset' : (avatar.type === 'text' ? 'text' : ''))
  if (!type) return null
  const out = { type }
  if (avatar.text) out.text = String(avatar.text).slice(0, 2)
  if (avatar.color) out.color = String(avatar.color).slice(0, 32)
  if (type === 'image' && avatar.imageDataUrl) {
    try {
      const img = nativeImage.createFromDataURL(String(avatar.imageDataUrl))
      if (img && !img.isEmpty()) {
        for (const size of [96, 72, 56]) {
          const thumb = img.resize({ width: size, height: size, quality: 'good' })
          const dataUrl = 'data:image/jpeg;base64,' + thumb.toJPEG(68).toString('base64')
          if (dataUrl.length <= 32 * 1024) {
            out.imageDataUrl = dataUrl
            out.zoom = 120
            out.x = 50
            out.y = 50
            break
          }
        }
      }
    } catch (_) {}
  }
  return out
}

function resolveDataDir () {
  if (process.env.FREEDOM_DATA_DIR) return path.resolve(process.cwd(), process.env.FREEDOM_DATA_DIR)
  if (isDev) return path.join(process.cwd(), 'data')
  return path.join(path.dirname(app.getPath('exe')), 'data')
}

function sendToRenderer (channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

function windowFromEvent (event) {
  return event && event.sender ? BrowserWindow.fromWebContents(event.sender) : null
}

function applyWindowBoundsOptions (opts) {
  return {
    ...opts,
    fullscreen: false,
    kiosk: false,
    fullscreenable: false,
    resizable: true,
    alwaysOnTop: false,
    skipTaskbar: false,
  }
}

function toggleWorkAreaMaximize (win) {
  if (!win || win.isDestroyed()) return false
  if (win.__workAreaMaximized) {
    const restore = win.__restoreBounds
    win.__workAreaMaximized = false
    win.__restoreBounds = null
    if (restore) win.setBounds(restore)
    else win.unmaximize()
    return false
  }
  win.__restoreBounds = win.getBounds()
  const display = screen.getDisplayMatching(win.getBounds())
  win.setBounds(display.workArea)
  win.__workAreaMaximized = true
  return true
}

function ensureWindowOnScreen (win) {
  if (!win || win.isDestroyed()) return
  const bounds = win.getBounds()
  const displays = screen.getAllDisplays()
  const visible = displays.some(({ workArea }) => {
    const right = bounds.x + bounds.width
    const bottom = bounds.y + bounds.height
    return right > workArea.x + 80 &&
      bounds.x < workArea.x + workArea.width - 80 &&
      bottom > workArea.y + 80 &&
      bounds.y < workArea.y + workArea.height - 80
  })
  if (visible && bounds.width >= 400 && bounds.height >= 300) return
  const { workArea } = screen.getPrimaryDisplay()
  const width = Math.min(Math.max(bounds.width || 1100, 900), workArea.width)
  const height = Math.min(Math.max(bounds.height || 720, 560), workArea.height)
  win.setBounds({
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
    width,
    height,
  })
}

function revealWindow (win, focus) {
  if (!win || win.isDestroyed()) return
  ensureWindowOnScreen(win)
  if (win.isMinimized()) win.restore()
  win.show()
  if (focus !== false) {
    win.focus()
    try { win.webContents.focus() } catch (_) {}
  }
}

function mergedPeers () {
  const online = p2p ? p2p.getPeers() : []
  const map = new Map()
  for (const c of (vault && vault.unlocked ? vault.getContacts() : [])) {
    if (!c || !c.id) continue
    map.set(c.id, { ...c, online: false, hasKey: !!c.pub })
  }
  for (const p of online) map.set(p.id, { ...(map.get(p.id) || {}), ...p, online: !!p.online, hasKey: !!p.pub || !!p.hasKey })
  return Array.from(map.values())
}

function emitPeers () {
  sendToRenderer('p2p:peers', mergedPeers())
}

// 用原始位图生成圆点图标，绿色版无需额外图片资源文件
function makeDotIcon (rgb, size) {
  size = size || 32
  const buf = Buffer.alloc(size * size * 4)
  const c = (size - 1) / 2
  const r = size / 2
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      const d = Math.sqrt((x - c) * (x - c) + (y - c) * (y - c))
      if (d <= r) { buf[i] = rgb[2]; buf[i + 1] = rgb[1]; buf[i + 2] = rgb[0]; buf[i + 3] = 255 }
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size })
}

function makeBadgeIcon (badge) {
  const size = 32
  const buf = Buffer.alloc(size * size * 4)
  const c = (size - 1) / 2
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      const d = Math.sqrt((x - c) * (x - c) + (y - c) * (y - c))
      if (d <= size / 2) { buf[i] = 88; buf[i + 1] = 209; buf[i + 2] = 48; buf[i + 3] = 255 } // 缁?BGRA)
      if (badge) {
        const bd = Math.sqrt((x - (size - 8)) * (x - (size - 8)) + (y - 8) * (y - 8))
        if (bd <= 7) { buf[i] = 48; buf[i + 1] = 59; buf[i + 2] = 255; buf[i + 3] = 255 } // 绾㈣鏍?BGRA)
      }
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size })
}

function showWindow () {
  if (!mainWindow) { createWindow(); return }
  revealWindow(mainWindow)
}

function setupTray () {
  if (tray) return
  try {
    const ic = getAppIcon()
    tray = new Tray(ic ? ic.resize({ width: 16, height: 16 }) : makeBadgeIcon(false))
    tray.setToolTip('iLink')
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示主窗口', click: () => showWindow() },
      { type: 'separator' },
      { label: '退出', click: () => { isQuitting = true; app.quit() } },
    ]))
    tray.on('click', () => showWindow())
  } catch (_) {}
}

function applyAutoStart (on) {
  try {
    if (process.platform !== 'win32' || !app.isPackaged) return // 仅打包后生效，路径始终使用当前 exe 重新登记
    app.setLoginItemSettings({ openAtLogin: !!on, path: process.execPath })
  } catch (_) {}
}

function applyRuntimeSettings (s) {
  if (!s) return
  runtime.minimizeToTray = s.minimizeToTray !== false
  runtime.notifyEnabled = s.notifyEnabled !== false
  runtime.notifyPreview = s.notifyPreview !== false
  runtime.closeAction = s.closeAction || 'ask'
  applyAutoStart(!!s.autoStart)
}

function notify (title, body) {
  try {
    if (!runtime.notifyEnabled || !Notification.isSupported()) return
    new Notification({ title: title || 'iLink', body: body || '', silent: true }).show() // 全程无声
  } catch (_) {}
}

function createWindow () {
  mainWindow = new BrowserWindow(applyWindowBoundsOptions({
    width: 1200,
    height: 720,
    minWidth: 980,
    minHeight: 560,
    show: false,
    title: 'iLink',
    frame: false,
    transparent: false,
    hasShadow: true,
    icon: getAppIcon() || undefined,
    backgroundColor: '#11131f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  }))

  let revealed = false
  const revealMainWindow = () => {
    if (revealed) return
    revealed = true
    revealWindow(mainWindow)
  }
  mainWindow.once('ready-to-show', revealMainWindow)
  mainWindow.webContents.once('did-finish-load', revealMainWindow)
  setTimeout(revealMainWindow, isDev ? 2500 : 1200)
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[main-window] renderer process gone:', details)
    revealWindow(mainWindow, false)
  })
  mainWindow.webContents.on('unresponsive', () => console.error('[main-window] renderer unresponsive'))

  if (isDev) {
    mainWindow.loadURL(DEV_SERVER_URL)
    mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
      console.error('[main-window] load failed:', code, desc)
      setTimeout(() => { if (mainWindow) mainWindow.loadURL(DEV_SERVER_URL) }, 500)
    })
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }

  mainWindow.on('minimize', () => { if (runtime.minimizeToTray && mainWindow) mainWindow.hide() })
  mainWindow.on('close', (e) => {
    if (isQuitting || !mainWindow) return
    if (runtime.closeAction === 'quit') { isQuitting = true; return }
    e.preventDefault()
    if (runtime.closeAction === 'tray') { mainWindow.hide(); return }
    dialog.showMessageBox(mainWindow, {
      type: 'question', buttons: ['最小化到托盘', '退出应用'], defaultId: 0, cancelId: 0, noLink: true,
      title: '关闭 iLink', message: '要最小化到托盘，还是退出应用？',
      checkboxLabel: '记住我的选择，下次不再询问', checkboxChecked: false,
    }).then((r) => {
      const toTray = r.response === 0
      if (r.checkboxChecked) {
        runtime.closeAction = toTray ? 'tray' : 'quit'
        if (vault && vault.unlocked) vault.setSettings({ closeAction: runtime.closeAction })
      }
      if (toTray) { if (mainWindow) mainWindow.hide() } else { isQuitting = true; app.quit() }
    }).catch(() => {})
  })
  mainWindow.on('focus', () => { try { mainWindow.flashFrame(false); mainWindow.setOverlayIcon(null, '') } catch (_) {} })
  mainWindow.on('closed', () => { mainWindow = null })
}

function loadAppWindow (win, query) {
  if (isDev) {
    const qs = new URLSearchParams(query || {}).toString()
    win.loadURL(DEV_SERVER_URL + (qs ? '?' + qs : ''))
    win.webContents.on('did-fail-load', () => {
      setTimeout(() => {
        if (!win.isDestroyed()) win.loadURL(DEV_SERVER_URL + (qs ? '?' + qs : ''))
      }, 500)
    })
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'), { query: query || {} })
  }
}

function openChatWindow (convId) {
  convId = String(convId || '')
  const existing = chatWindows.get(convId)
  if (existing && !existing.isDestroyed()) {
    existing.show()
    existing.focus()
    return { ok: true, reused: true }
  }

  const win = new BrowserWindow(applyWindowBoundsOptions({
    width: 720,
    height: 760,
    minWidth: 460,
    minHeight: 520,
    show: false,
    frame: false,
    transparent: false,
    hasShadow: true,
    icon: getAppIcon() || undefined,
    backgroundColor: '#11131f',
    title: 'iLink 聊天',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  }))

  chatWindows.set(convId, win)
  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) {
      win.show()
      win.focus()
    }
  })
  win.on('closed', () => {
    if (chatWindows.get(convId) === win) chatWindows.delete(convId)
  })
  loadAppWindow(win, { window: 'chat', conv: convId })
  return { ok: true, reused: false }
}

function closeChatWindows () {
  for (const win of chatWindows.values()) {
    try { if (win && !win.isDestroyed()) win.close() } catch (_) {}
  }
  chatWindows.clear()
}

function startP2P () {
  if (p2p) return
  const id = vault.getIdentity()
  const keys = vault.getKeys()
  const settings = vault.getSettings()
  p2p = new P2P({ id: id.id, name: id.name, pub: keys.pub, priv: keys.priv, discoveryPort: settings.udpPort, broadcastAddrs: settings.broadcastAddrs, avatar: publishableAvatar(settings.avatar) })
  p2p.setBlacklist([])
  p2p.anonymous = !!settings.anonymous
  p2p.status = settings.statusText || ''
  p2p.presence = ['online', 'busy', 'away'].includes(settings.presence) ? settings.presence : 'online'
  p2p.on('peers', (list) => {
    if (vault && vault.unlocked) vault.upsertContacts((list || []).filter((p) => p.id))
    emitPeers()
  })
  p2p.on('message', (m) => {
    if (m.scope === 'group') return
    if (m.room && vault && vault.unlocked && m.system === 'member-removed' && !(m.room.members || []).includes(p2p.id)) {
      vault.removeGroup(m.room.id)
      vault.clearConversation(m.room.id)
      vault.setDraft(m.room.id, '')
      sendToRenderer('store:groups', vault.getGroups())
      return
    }
    if (m.room && vault && vault.unlocked) vault.upsertGroup(m.room)
    if (vault && vault.unlocked) vault.upsertContacts([{ id: m.from, name: m.name, avatar: m.avatar || null, lastSeen: Date.now() }])
    const convId = m.scope === 'room' && m.room ? m.room.id : m.from
    const muted = vault && vault.unlocked ? (vault.getSettings().muted || []).includes(convId) : false
    if (!m.burn && vault && vault.unlocked) {
      vault.appendMessage(convId, m)
    }
    sendToRenderer('p2p:message', m)
    if (m.room) sendToRenderer('store:groups', vault.getGroups())
    // 群头像更新只保留聊天框内文字，不闪任务栏、不发系统通知
    const silent = m.system === 'avatar-changed'
    if (!silent && !muted && mainWindow && !mainWindow.isFocused()) {
      try { mainWindow.flashFrame(true) } catch (_) {}
    }
    // 窗口隐藏/最小化时走系统通知，否则交给渲染层 toast
    if (!silent && !muted && mainWindow && (!mainWindow.isVisible() || mainWindow.isMinimized())) {
      const body = runtime.notifyPreview && !m.burn ? (m.text || '') : '收到新消息'
      notify(m.name || 'iLink', body)
    }
  })
  p2p.on('typing', (t) => sendToRenderer('p2p:typing', t))
  p2p.on('recall', (r) => {
    const conv = r.scope === 'room' && r.roomId ? r.roomId : r.from
    if (vault && vault.unlocked) vault.markRecalled(conv, r.mid)
    sendToRenderer('msg:recall', { conv, mid: r.mid })
  })
  p2p.on('reaction', (r) => {
    const conv = r.scope === 'room' && r.roomId ? r.roomId : r.from
    if (vault && vault.unlocked) vault.addReaction(conv, r.mid, r.emoji, r.from)
    sendToRenderer('msg:reaction', { conv, mid: r.mid, emoji: r.emoji, from: r.from })
  })
  p2p.on('room-avatar', (r) => {
    if (!vault || !vault.unlocked) return
    const group = vault.getGroups().find((g) => g.id === r.roomId)
    if (!group || group.ownerId !== r.from) return // 仅接受群主发送的头像更新
    vault.upsertGroup({ ...group, avatar: r.avatar })
    sendToRenderer('store:groups', vault.getGroups())
  })
  p2p.on('nudge', (n) => {
    sendToRenderer('msg:nudge', { from: n.from, text: n.text || '' })
    const muted = vault && vault.unlocked ? (vault.getSettings().muted || []).includes(n.from) : false
    if (!muted && mainWindow) { try { mainWindow.flashFrame(true) } catch (_) {} }
  })
  p2p.on('ready', (self) => { sendToRenderer('p2p:ready', self); emitPeers() })
  p2p.on('neterror', (e) => sendToRenderer('p2p:neterror', e))
  p2p.start()

  ft = new FileTransfer({
    id: id.id, pub: keys.pub, priv: keys.priv,
    resolvePeer: (pid) => p2p && p2p.peers.get(pid),
    isBlocked: () => false,
    ownName: () => (p2p ? p2p.displayName() : ''),
  })
  ft.on('incoming', (info) => sendToRenderer('file:incoming', info))
  ft.on('progress', (p) => sendToRenderer('file:progress', { mid: p.mid, received: p.received, size: p.size, dir: 'in' }))
  ft.on('send-progress', (p) => sendToRenderer('file:progress', { mid: p.mid, received: p.sent, size: p.size, dir: 'out' }))
  ft.on('sent', (p) => sendToRenderer('file:sent', p))
  ft.on('failed', (p) => sendToRenderer('file:failed', p))
  ft.on('done', (info) => onFileDone(info))
  ft.start((tport) => { if (p2p) p2p.setTport(tport) })
}

function stopP2P () {
  if (ft) { ft.stop(); ft = null }
  if (p2p) { p2p.stop(); p2p = null }
}

// ---------------- 文件消息落地 ----------------
function uniquePath (p) {
  if (!fs.existsSync(p)) return p
  const dir = path.dirname(p); const ext = path.extname(p); const base = path.basename(p, ext)
  let i = 1
  while (fs.existsSync(path.join(dir, base + '(' + i + ')' + ext))) i++
  return path.join(dir, base + '(' + i + ')' + ext)
}
function moveFile (src, dest) {
  try { fs.renameSync(src, dest) } catch (_) { fs.copyFileSync(src, dest); try { fs.unlinkSync(src) } catch (__) {} }
}
function buildReceivedMsg (info, destPath) {
  const msg = { mid: info.mid, type: 'file', from: info.from, name: info.name, fname: info.fname, size: info.size, mime: info.mime, scope: info.scope, to: info.to || null, batch: info.batch || null, path: destPath, ts: Date.now(), self: false }
  if (info.mime && info.mime.indexOf('image/') === 0 && info.size <= 2 * 1024 * 1024) {
    try { msg.dataUrl = 'data:' + info.mime + ';base64,' + fs.readFileSync(destPath).toString('base64') } catch (_) {}
  }
  return msg
}
function finalizeFile (info) {
  try {
    const s = vault.getSettings()
    const dir = s.downloadDir && fs.existsSync(s.downloadDir) ? s.downloadDir : app.getPath('downloads')
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const dest = uniquePath(path.join(dir, info.fname || ('file-' + info.mid)))
    moveFile(info.tempPath, dest)
    if (info.scope === 'group') return
    const conv = info.scope === 'room' ? info.to : info.from
    const msg = buildReceivedMsg(info, dest)
    if (vault.unlocked) vault.appendMessage(conv, msg)
    sendToRenderer('file:received', { conv, msg })
  } catch (_) { sendToRenderer('file:failed', { mid: info.mid }) }
}
function onFileDone (info) {
  const s = vault.getSettings()
  if ((s.receiveMode || 'auto') === 'manual') {
    pendingFiles.set(info.mid, info)
    sendToRenderer('file:offer', { mid: info.mid, from: info.from, name: info.name, fname: info.fname, size: info.size, mime: info.mime, scope: info.scope, to: info.to || null })
  } else { finalizeFile(info) }
}
function sendFilesInternal (scope, toId, paths, batch) {
  if (!ft || !p2p) return []
  const out = []
  // 目标网络对象：群聊(room)=群内在线成员；广播(group，已弃用)=全部在线；私聊=对方
  let targets
  let convId
  if (scope === 'room') {
    const room = vault && vault.unlocked ? (vault.getGroups().find((g) => g.id === toId) || null) : null
    if (!room) return []
    const selfId = p2p.id
    const online = new Set(p2p.getPeers().filter((p) => p.online).map((p) => p.id))
    targets = (room.members || []).filter((id) => id !== selfId && online.has(id))
    convId = toId
  } else {
    targets = [toId]
    convId = toId
  }
  for (const fp of (paths || [])) {
    const mid = crypto.randomUUID()
    let meta = null
    let okCount = 0
    // 群聊 metaTo = 群 id，确保接收端归入同一会话；统计真正发起成功的目标数
    for (const t of targets) {
      const r = ft.sendFile(t, fp, scope, mid, scope === 'room' ? toId : t, batch || null)
      if (r && !r.error) { meta = r; okCount++ } else if (r && !meta) meta = r
    }
    // 所有目标都失败（离线/不可达）时，文件不存储，不落假消息，通知前端失败
    if (!okCount || !meta) { sendToRenderer('file:failed', { mid }); continue }
    const msg = { mid, type: 'file', from: p2p.id, name: p2p.name, fname: meta.fname, size: meta.size, mime: meta.mime, scope, to: toId, batch: batch || null, path: fp, ts: Date.now(), self: true }
    if (meta.mime && meta.mime.indexOf('image/') === 0 && meta.size <= 2 * 1024 * 1024) {
      try { msg.dataUrl = 'data:' + meta.mime + ';base64,' + fs.readFileSync(fp).toString('base64') } catch (_) {}
    }
    if (vault.unlocked) vault.appendMessage(convId, msg)
    out.push(msg)
  }
  return out
}

// ---------------------------------------------------------------------------
ipcMain.handle('app:ping', async () => ({
  ok: true, appVersion: app.getVersion(),
  versions: { electron: process.versions.electron, node: process.versions.node, chrome: process.versions.chrome },
  platform: process.platform, hostname: os.hostname(), time: new Date().toISOString(),
}))
ipcMain.handle('app:checkUpdate', async () => ({
  ok: true,
  current: app.getVersion(),
  latest: app.getVersion(),
  message: '当前为绿色版构建，暂未配置远程更新源。',
}))

ipcMain.handle('auth:status', () => ({ state: vault && vault.unlocked ? 'unlocked' : (vault && vault.exists() ? 'locked' : 'setup') }))
ipcMain.handle('auth:setup', async (_e, pw) => {
  try { const identity = await vault.setup(pw); startP2P(); applyRuntimeSettings(vault.getSettings()); return { ok: true, identity } }
  catch (e) { return { ok: false, error: String(e.message || e) } }
})
ipcMain.handle('auth:unlock', async (_e, pw) => {
  try { const identity = await vault.unlock(pw); startP2P(); applyRuntimeSettings(vault.getSettings()); return { ok: true, identity } }
  catch (e) { return { ok: false, error: String(e.message || e) } }
})
ipcMain.handle('auth:changePassword', async (_e, oldPw, newPw) => {
  try { await vault.changePassword(oldPw, newPw); return { ok: true } } catch (e) { return { ok: false, error: String(e.message || e) } }
})
ipcMain.handle('auth:resetIdentity', () => { closeChatWindows(); stopP2P(); vault.reset(); return { ok: true } })
ipcMain.handle('auth:lock', () => { closeChatWindows(); stopP2P(); if (vault) vault.lock(); return { ok: true } })

ipcMain.handle('store:getHistory', () => (vault && vault.unlocked ? vault.getHistory() : {}))

ipcMain.handle('settings:get', () => (vault && vault.unlocked ? vault.getSettings() : {}))
ipcMain.handle('settings:set', (_e, patch) => {
  if (!vault || !vault.unlocked) return {}
  const nextPatch = { ...(patch || {}) }
  if ('udpPort' in nextPatch) {
    const port = parseInt(nextPatch.udpPort, 10)
    nextPatch.udpPort = port >= 1024 && port <= 65535 ? port : 51888
  }
  if ('broadcastAddrs' in nextPatch) nextPatch.broadcastAddrs = String(nextPatch.broadcastAddrs || '').slice(0, 300)
  if ('blacklist' in nextPatch) nextPatch.blacklist = []
  const networkChanged = 'udpPort' in nextPatch || 'broadcastAddrs' in nextPatch
  const s = vault.setSettings(nextPatch)
  if (patch && 'anonymous' in patch && p2p) p2p.setAnonymous(!!patch.anonymous)
  if (patch && 'avatar' in patch && p2p) p2p.setAvatar(publishableAvatar(s.avatar))
  if (patch && 'retentionDays' in patch) vault.pruneHistory(s.retentionDays)
  if (patch && 'statusText' in patch && p2p) { p2p.setStatus(patch.statusText); sendToRenderer('p2p:ready', p2p.getSelf()) }
  if (patch && 'presence' in patch && p2p) { p2p.setPresence(patch.presence); sendToRenderer('p2p:ready', p2p.getSelf()) }
  if (networkChanged) { stopP2P(); startP2P() }
  applyRuntimeSettings(s)
  return s
})
// 无边框窗口控制
ipcMain.handle('win:minimize', (e) => {
  const win = windowFromEvent(e) || mainWindow
  if (win && !win.isDestroyed()) win.minimize()
})
ipcMain.handle('win:maximize', (e) => {
  const win = windowFromEvent(e) || mainWindow
  if (!win || win.isDestroyed()) return false
  return toggleWorkAreaMaximize(win)
})
ipcMain.handle('win:focus', (e) => {
  const win = windowFromEvent(e) || mainWindow
  if (!win || win.isDestroyed()) return false
  if (win === mainWindow) showWindow()
  else { win.show(); win.focus() }
  try { win.webContents.focus() } catch (_) {}
  return true
})
ipcMain.handle('win:close', (e) => {
  const win = windowFromEvent(e) || mainWindow
  if (win && !win.isDestroyed()) win.close()
})
ipcMain.handle('chat:openWindow', (_e, convId) => openChatWindow(convId))

// 任务栏未读红点
ipcMain.handle('ui:setUnread', (e, n) => {
  try {
    if (windowFromEvent(e) !== mainWindow) return
    if (mainWindow) {
      if (n > 0) mainWindow.setOverlayIcon(makeDotIcon([255, 59, 48], 16), n + ' 条未读')
      else mainWindow.setOverlayIcon(null, '')
    }
    if (tray) {
      const ic = getAppIcon()
      tray.setImage(ic ? ic.resize({ width: 16, height: 16 }) : makeBadgeIcon(n > 0))
      tray.setToolTip(n > 0 ? ('iLink - ' + n + ' 条未读') : 'iLink')
    }
  } catch (_) {}
})

ipcMain.handle('p2p:typing', (_e, toId) => {
  if (!p2p) return
  const room = vault && vault.unlocked ? (vault.getGroups() || []).find((g) => g.id === toId) : null
  if (room) p2p.sendTypingRoom(room)
  else p2p.sendTyping(toId)
})
ipcMain.handle('msg:recall', (_e, scope, toId, mid) => {
  if (!p2p) return { ok: false }
  const conv = toId
  if (vault && vault.unlocked) vault.markRecalled(conv, mid)
  p2p.sendRecall(scope, toId, mid)
  return { ok: true }
})
ipcMain.handle('msg:react', (_e, scope, toId, mid, emoji) => {
  if (!p2p) return { ok: false }
  const conv = toId
  if (vault && vault.unlocked) vault.addReaction(conv, mid, emoji, p2p.id)
  p2p.sendReaction(scope, toId, mid, emoji)
  return { ok: true }
})
ipcMain.handle('sys:openExternal', (_e, url) => { try { if (/^https?:\/\//.test(url)) shell.openExternal(url) } catch (_) {} })
ipcMain.handle('p2p:nudge', (_e, toId) => {
  if (!p2p) return
  const text = vault && vault.unlocked ? (vault.getSettings().nudgeText || '') : ''
  p2p.sendNudge(toId, text)
})
ipcMain.handle('store:getDrafts', () => (vault && vault.unlocked ? vault.getDrafts() : {}))
ipcMain.handle('store:setDraft', (_e, convId, text) => { if (vault && vault.unlocked) vault.setDraft(convId, text) })
ipcMain.handle('store:clearHistory', () => { if (vault && vault.unlocked) vault.clearHistory(); return { ok: true } })
ipcMain.handle('store:clearConversation', (_e, convId) => { if (vault && vault.unlocked) vault.clearConversation(convId); return { ok: true } })
ipcMain.handle('store:clearDrafts', () => { if (vault && vault.unlocked) vault.clearDrafts(); return { ok: true } })
ipcMain.handle('store:getGroups', () => (vault && vault.unlocked ? vault.getGroups() : []))
ipcMain.handle('store:createGroup', (_e, name, members) => {
  if (!vault || !vault.unlocked) return null
  const selfId = vault.getIdentity().id
  const group = vault.createGroup(name || '群聊', Array.from(new Set([selfId, ...(members || [])])), selfId)
  if (p2p) {
    const res = p2p.sendRoom(group, '群聊已创建', { system: 'room-created' })
    if (res.ok) { vault.appendMessage(group.id, res.msg); sendToRenderer('p2p:message', res.msg) }
  }
  sendToRenderer('store:groups', vault.getGroups())
  return group
})
function displayNameForId (id) {
  if (!id) return ''
  const self = vault && vault.unlocked ? vault.getIdentity() : null
  if (self && self.id === id) return self.name || '?'
  const peer = mergedPeers().find((p) => p.id === id)
  return (peer && peer.name) || String(id).slice(0, 6)
}
ipcMain.handle('store:addGroupMembers', (_e, groupId, memberIds) => {
  if (!vault || !vault.unlocked || !p2p) return { ok: false, error: '应用尚未就绪' }
  const group = vault.getGroups().find((g) => g.id === groupId)
  if (!group) return { ok: false, error: '群聊不存在' }
  const selfId = vault.getIdentity().id
  if (!(group.members || []).includes(selfId)) return { ok: false, error: '你不是群成员，不能添加成员' }
  const known = new Set(mergedPeers().map((p) => p.id))
  const incoming = Array.from(new Set((memberIds || []).map((id) => String(id || '').trim()).filter(Boolean)))
  const missing = incoming.filter((id) => !known.has(id))
  if (missing.length) return { ok: false, error: '用户不存在: ' + missing.map(displayNameForId).join(', ') }
  const existing = new Set(group.members || [])
  const added = incoming.filter((id) => !existing.has(id))
  if (!added.length) return { ok: false, error: '成员已在群聊中' }
  const updated = vault.upsertGroup({ ...group, members: [...(group.members || []), ...added] })
  const text = added.map(displayNameForId).join(', ') + ' 加入了群聊'
  const res = p2p.sendRoom(updated, text, { system: 'member-added' })
  if (res.ok) { vault.appendMessage(updated.id, res.msg); sendToRenderer('p2p:message', res.msg) }
  sendToRenderer('store:groups', vault.getGroups())
  return { ok: true, group: updated, added }
})
ipcMain.handle('store:removeGroupMember', (_e, groupId, memberId) => {
  if (!vault || !vault.unlocked || !p2p) return { ok: false, error: '应用尚未就绪' }
  const group = vault.getGroups().find((g) => g.id === groupId)
  if (!group) return { ok: false, error: '群聊不存在' }
  const selfId = vault.getIdentity().id
  if (group.ownerId !== selfId) return { ok: false, error: '只有群主可以移出成员' }
  memberId = String(memberId || '').trim()
  if (!memberId || !(group.members || []).includes(memberId)) return { ok: false, error: '成员不存在' }
  if (memberId === group.ownerId) return { ok: false, error: '不能移出群主' }
  const updated = vault.upsertGroup({ ...group, members: (group.members || []).filter((id) => id !== memberId) })
  const text = displayNameForId(memberId) + ' 已被群主移出群聊'
  const res = p2p.sendRoom(updated, text, { system: 'member-removed', extraRecipients: [memberId] })
  if (res.ok) { vault.appendMessage(updated.id, res.msg); sendToRenderer('p2p:message', res.msg) }
  sendToRenderer('store:groups', vault.getGroups())
  return { ok: true, group: updated, removed: memberId }
})
// 群头像载入：选图后输出 96px 压缩 JPEG，小图直接保留，过大才重压缩；失败返回 null 而非空壳对象
function groupAvatarPayload (avatar) {
  if (!avatar || typeof avatar !== 'object') return null
  if (avatar.type === 'image' && typeof avatar.imageDataUrl === 'string' && avatar.imageDataUrl.startsWith('data:image/')) {
    if (avatar.imageDataUrl.length <= 48 * 1024) {
      return { type: 'image', imageDataUrl: avatar.imageDataUrl, zoom: 120, x: 50, y: 50 }
    }
    const pub = publishableAvatar(avatar)
    return (pub && pub.imageDataUrl) ? pub : null
  }
  return publishableAvatar(avatar)
}
// 修改群头像，仅群主可操作；头像同步给成员
ipcMain.handle('store:setGroupAvatar', (_e, groupId, avatar) => {
  if (!vault || !vault.unlocked || !p2p) return null
  const group = vault.getGroups().find((g) => g.id === groupId)
  if (!group) return null
  if (group.ownerId !== vault.getIdentity().id) return null
  const pub = avatar ? groupAvatarPayload(avatar) : null
  if (avatar && !pub) return null // 图片处理失败，不落空壳头像
  const next = vault.upsertGroup({ ...group, avatar: pub })
  p2p.sendRoomAvatar(next, pub)
  const res = p2p.sendRoom(next, '更新了群头像', { system: 'avatar-changed' })
  if (res.ok) { vault.appendMessage(next.id, res.msg); sendToRenderer('p2p:message', res.msg) }
  sendToRenderer('store:groups', vault.getGroups())
  return next
})
// 退出群聊：通知其他成员（带更新后的成员表）；群主退出时自动移交给第一位成员，本地删除群记录
ipcMain.handle('store:leaveGroup', (_e, groupId) => {
  if (!vault || !vault.unlocked) return { ok: false }
  const group = vault.getGroups().find((g) => g.id === groupId)
  if (!group) return { ok: false }
  const selfId = vault.getIdentity().id
  const rest = (group.members || []).filter((id) => id !== selfId)
  if (p2p && rest.length) {
    const updated = { ...group, members: rest, ownerId: group.ownerId === selfId ? rest[0] : group.ownerId }
    p2p.sendRoom(updated, '退出了群聊', { system: 'member-left' })
  }
  vault.removeGroup(groupId)
  vault.clearConversation(groupId)
  vault.setDraft(groupId, '')
  sendToRenderer('store:groups', vault.getGroups())
  return { ok: true }
})
ipcMain.handle('store:transferGroupOwner', (_e, groupId, ownerId) => {
  if (!vault || !vault.unlocked) return null
  const group = vault.transferGroupOwner(groupId, ownerId)
  if (group && p2p) {
    const name = (mergedPeers().find((p) => p.id === ownerId) || {}).name || '新群主'
    const res = p2p.sendRoom(group, '群主已转让给 ' + name, { system: 'owner-transferred' })
    if (res.ok) { vault.appendMessage(group.id, res.msg); sendToRenderer('p2p:message', res.msg) }
  }
  sendToRenderer('store:groups', vault.getGroups())
  return group
})
ipcMain.handle('p2p:getSelf', () => (p2p ? p2p.getSelf() : null))
ipcMain.handle('p2p:getPeers', () => mergedPeers())
ipcMain.handle('p2p:setName', (_e, name) => {
  if (!p2p) return null
  if (vault && vault.unlocked) vault.setNickname(name)
  p2p.setName(name)
  return p2p.getSelf()
})
ipcMain.handle('p2p:sendRoom', (_e, roomId, text, opts) => {
  if (!p2p || !vault || !vault.unlocked) return { ok: false, error: '网络未就绪' }
  const room = vault.getGroups().find((g) => g.id === roomId)
  if (!room) return { ok: false, error: '群聊不存在' }
  if (!(room.members || []).includes(p2p.id)) return { ok: false, error: '你不是群成员' }
  const res = p2p.sendRoom(room, text, opts)
  if (res.ok && !res.msg.burn) vault.appendMessage(room.id, res.msg)
  return res
})
ipcMain.handle('p2p:sendPrivate', (_e, toId, text, opts) => {
  if (!p2p) return { ok: false, error: '网络未就绪' }
  const res = p2p.sendPrivate(toId, text, opts)
  if (res.ok && !res.msg.burn && vault && vault.unlocked) vault.appendMessage(toId, res.msg)
  return res
})

ipcMain.handle('file:send', (_e, scope, toId, paths, batch) => sendFilesInternal(scope, toId, paths, batch))
ipcMain.handle('file:pick', async (_e, scope, toId) => {
  const r = await dialog.showOpenDialog(mainWindow, { properties: ['openFile', 'multiSelections'] })
  if (r.canceled || !r.filePaths.length) return []
  return sendFilesInternal(scope, toId, r.filePaths)
})
ipcMain.handle('file:accept', (_e, mid) => { const info = pendingFiles.get(mid); if (info) { pendingFiles.delete(mid); finalizeFile(info) } })
ipcMain.handle('file:reject', (_e, mid) => { const info = pendingFiles.get(mid); if (info) { pendingFiles.delete(mid); try { fs.unlinkSync(info.tempPath) } catch (_) {} } })
ipcMain.handle('file:open', (_e, p) => { try { shell.openPath(p) } catch (_) {} })
ipcMain.handle('file:showInFolder', (_e, p) => { try { shell.showItemInFolder(p) } catch (_) {} })
ipcMain.handle('file:chooseDir', async () => {
  const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] })
  if (r.canceled || !r.filePaths.length) return null
  return r.filePaths[0]
})
// ---------------- 自助截图：冻结屏幕 -> 全屏选区窗口 -> 用户框选 -> 复制/保存/发送 ----------------
let shotWin = null
let shotImageDataUrl = ''
let shotRequester = null // 发起截图的窗口，选区结果只发给它
function closeShot () {
  try { if (shotWin && !shotWin.isDestroyed()) shotWin.close() } catch (_) {}
  shotWin = null
  shotImageDataUrl = ''
}
ipcMain.handle('shot:begin', async (e, mode) => {
  if (shotWin && !shotWin.isDestroyed()) { shotWin.focus(); return { ok: true } }
  const hide = mode === 'hide'
  const wasVisible = mainWindow && mainWindow.isVisible()
  try {
    shotRequester = e.sender
    if (hide && wasVisible) { mainWindow.hide(); await new Promise((r) => setTimeout(r, 320)) }
    const disp = screen.getPrimaryDisplay()
    const size = { width: Math.round(disp.size.width * disp.scaleFactor), height: Math.round(disp.size.height * disp.scaleFactor) }
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size })
    const src = sources.find((s) => String(s.display_id) === String(disp.id)) || sources[0]
    if (hide && wasVisible) mainWindow.show()
    if (!src || src.thumbnail.isEmpty()) return { ok: false, error: '截图失败（无可用屏幕源）' }
    shotImageDataUrl = 'data:image/png;base64,' + src.thumbnail.toPNG().toString('base64')
    const workArea = disp.workArea
    shotWin = new BrowserWindow({
      x: workArea.x,
      y: workArea.y,
      width: workArea.width,
      height: workArea.height,
      fullscreen: false,
      kiosk: false,
      fullscreenable: false,
      frame: false,
      alwaysOnTop: false,
      skipTaskbar: false,
      resizable: false,
      show: false,
      backgroundColor: '#000000',
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
    })
    shotWin.once('ready-to-show', () => shotWin.show())
    shotWin.on('closed', () => { shotWin = null; shotImageDataUrl = '' })
    loadAppWindow(shotWin, { window: 'shot' })
    return { ok: true }
  } catch (err) {
    try { if (hide && wasVisible) mainWindow.show() } catch (_) {}
    closeShot()
    return { ok: false, error: String(err.message || err) }
  }
})
ipcMain.handle('shot:getImage', () => shotImageDataUrl)
ipcMain.handle('shot:done', (_e, dataUrl) => {
  try {
    const b64 = String(dataUrl || '').split(',')[1] || ''
    if (!b64) { closeShot(); return { ok: false } }
    const buf = Buffer.from(b64, 'base64')
    const p = path.join(os.tmpdir(), 'ilink-shot-' + Date.now() + '.png')
    fs.writeFileSync(p, buf)
    if (shotRequester && !shotRequester.isDestroyed()) shotRequester.send('shot:result', { path: p, name: path.basename(p), size: buf.length, dataUrl })
    closeShot()
    return { ok: true }
  } catch (err) { closeShot(); return { ok: false, error: String(err.message || err) } }
})
ipcMain.handle('shot:copy', (_e, dataUrl) => {
  try { const img = nativeImage.createFromDataURL(String(dataUrl || '')); if (!img.isEmpty()) clipboard.writeImage(img) } catch (_) {}
  closeShot()
  return { ok: true }
})
ipcMain.handle('shot:save', async (_e, dataUrl) => {
  try {
    const r = await dialog.showSaveDialog(shotWin, { defaultPath: 'iLink截图-' + Date.now() + '.png', filters: [{ name: 'PNG', extensions: ['png'] }] })
    if (!r.canceled && r.filePath) {
      const b64 = String(dataUrl || '').split(',')[1] || ''
      fs.writeFileSync(r.filePath, Buffer.from(b64, 'base64'))
    }
  } catch (_) {}
  closeShot()
  return { ok: true }
})
ipcMain.handle('shot:cancel', () => { closeShot(); return { ok: true } })

// 选择文件但不立即发送，进入输入框待发区
ipcMain.handle('file:choose', async () => {
  const r = await dialog.showOpenDialog(mainWindow, { properties: ['openFile', 'multiSelections'] })
  if (r.canceled || !r.filePaths.length) return []
  return r.filePaths.map((p) => {
    let size = 0
    try { size = fs.statSync(p).size } catch (_) {}
    return { path: p, name: path.basename(p), size }
  })
})

ipcMain.handle('avatar:pickImage', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
  })
  if (r.canceled || !r.filePaths.length) return null
  const filePath = r.filePaths[0]
  const stat = fs.statSync(filePath)
  if (stat.size > 4 * 1024 * 1024) return { ok: false, error: '头像图片不能超过 4 MB' }
  const img = nativeImage.createFromPath(filePath)
  if (img && !img.isEmpty()) {
    const thumb = img.resize({ width: 96, height: 96, quality: 'good' })
    return { ok: true, dataUrl: 'data:image/jpeg;base64,' + thumb.toJPEG(70).toString('base64') }
  }
  const ext = path.extname(filePath).toLowerCase()
  const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/jpeg'
  return { ok: true, dataUrl: 'data:' + mime + ';base64,' + fs.readFileSync(filePath).toString('base64') }
})

app.whenReady().then(() => {
  try { app.setAppUserModelId('com.freedom.lan') } catch (_) {}
  vault = new Vault(resolveDataDir())
  setupTray()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    else showWindow()
  })
})

app.on('before-quit', () => { isQuitting = true; if (p2p) p2p.sayBye(); if (vault) vault.flush() })

app.on('window-all-closed', () => {
  stopP2P()
  if (vault) vault.lock()
  if (process.platform !== 'darwin') app.quit()
})
