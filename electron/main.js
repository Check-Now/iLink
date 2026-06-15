'use strict'

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, Notification, dialog, shell, desktopCapturer, screen, clipboard } = require('electron')
const path = require('path')
const os = require('os')
const fs = require('fs')
const crypto = require('crypto')
const { P2P, isTextTooLong, MAX_TEXT_CHARS } = require('./p2p')
const { Vault } = require('./vault')
const { FileTransfer, guessMime } = require('./filetransfer')
const { safeFileName } = require('./pathutil')
const { baseAvatar, avatarCrop, AVATAR_MAX_CHARS } = require('./avatarutil')
const { Logger } = require('./logger')
const logger = new Logger()

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
let suppressTrayOnMinimize = false // 截图等程序性最小化时为 true，避免触发"最小化到托盘"隐藏任务栏卡片
const pendingFiles = new Map()
const runtime = { minimizeToTray: true, notifyEnabled: true, notifyPreview: true, closeAction: 'ask', dnd: false }

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

// 头像可广播化：基础字段(类型/文字/颜色)与裁剪参数复用 ./avatarutil；
// 图片超 AVATAR_MAX_CHARS 时，本进程额外用 nativeImage 生成缩略图兜底（p2p 层无此能力）
function publishableAvatar (avatar) {
  const out = baseAvatar(avatar)
  if (!out) return null
  if (out.type === 'image' && avatar.imageDataUrl) {
    const crop = avatarCrop(avatar)
    const raw = String(avatar.imageDataUrl)
    const stat = typeof avatar.staticDataUrl === 'string' ? avatar.staticDataUrl : ''
    // 原图（含 GIF 动图）够小则原样广播，保证对方看到的与本机一致
    if (raw.length <= AVATAR_MAX_CHARS) return { ...out, imageDataUrl: raw, ...crop }
    // GIF 过大时退回静态首帧缩略图
    if (stat && stat.length <= AVATAR_MAX_CHARS) return { ...out, imageDataUrl: stat, ...crop }
    try {
      const img = nativeImage.createFromDataURL(stat || raw)
      if (img && !img.isEmpty()) {
        for (const size of [96, 72, 56]) {
          const thumb = img.resize({ width: size, height: size, quality: 'good' })
          const dataUrl = 'data:image/jpeg;base64,' + thumb.toJPEG(68).toString('base64')
          if (dataUrl.length <= AVATAR_MAX_CHARS) {
            out.imageDataUrl = dataUrl
            out.zoom = crop.zoom
            out.x = crop.x
            out.y = crop.y
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

// 审计日志：记录在线/离线变化（仅 id/昵称元数据）
let _prevOnline = new Set()
function logPeerTransitions (list) {
  const now = new Set((list || []).filter((p) => p.online).map((p) => p.id))
  for (const p of (list || [])) { if (p.online && !_prevOnline.has(p.id)) logger.log('peer', 'online', { id: p.id, name: p.name }) }
  for (const id of _prevOnline) { if (!now.has(id)) logger.log('peer', 'offline', { id }) }
  _prevOnline = now
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

// 免打扰图标：优先使用项目根目录 noSign.png，加载失败回退为生成的红圆白杠
let dndIconImg = null
function makeDndIcon () {
  if (dndIconImg) return dndIconImg
  try {
    const img = nativeImage.createFromPath(path.join(__dirname, '..', 'noSign.png'))
    if (img && !img.isEmpty()) { dndIconImg = img.resize({ width: 16, height: 16 }); return dndIconImg }
  } catch (_) {}
  const size = 32
  const buf = Buffer.alloc(size * size * 4)
  const c = (size - 1) / 2
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      const d = Math.sqrt((x - c) * (x - c) + (y - c) * (y - c))
      if (d <= size / 2) { buf[i] = 48; buf[i + 1] = 59; buf[i + 2] = 255; buf[i + 3] = 255 } // 红 (BGRA)
      if (y >= 13 && y <= 18 && x >= 7 && x <= 24 && d <= size / 2) { buf[i] = 255; buf[i + 1] = 255; buf[i + 2] = 255; buf[i + 3] = 255 } // 白杠
    }
  }
  dndIconImg = nativeImage.createFromBitmap(buf, { width: size, height: size }).resize({ width: 16, height: 16 })
  return dndIconImg
}
// 透明图标：托盘闪烁的"灭"帧
let blankIconImg = null
function makeBlankIcon () {
  if (blankIconImg) return blankIconImg
  blankIconImg = nativeImage.createFromBitmap(Buffer.alloc(16 * 16 * 4), { width: 16, height: 16 })
  return blankIconImg
}
function trayBaseIcon () {
  if (runtime.dnd) return makeDndIcon()
  const ic = getAppIcon()
  return ic ? ic.resize({ width: 16, height: 16 }) : makeBadgeIcon(false)
}

// 托盘闪烁：窗口不可见时收到新消息，亮/灭交替，显示窗口或清空未读后停止
let trayFlashTimer = null
let trayFlashOn = false
function startTrayFlash () {
  if (!tray || trayFlashTimer || runtime.dnd) return
  trayFlashTimer = setInterval(() => {
    if (!tray) return
    trayFlashOn = !trayFlashOn
    try { tray.setImage(trayFlashOn ? makeBlankIcon() : trayBaseIcon()) } catch (_) {}
  }, 500)
}
function stopTrayFlash () {
  if (trayFlashTimer) { clearInterval(trayFlashTimer); trayFlashTimer = null }
  trayFlashOn = false
  if (tray) { try { tray.setImage(trayBaseIcon()) } catch (_) {} }
}

function buildTrayMenu () {
  return Menu.buildFromTemplate([
    { label: '显示主窗口', click: () => showWindow() },
    { label: '全局免打扰', type: 'checkbox', checked: !!runtime.dnd, click: (item) => setDnd(item.checked) },
    { type: 'separator' },
    { label: '退出', click: () => { isQuitting = true; app.quit() } },
  ])
}
// 同步托盘图标、菜单勾选与提示文字（免打扰样式在这里生效）
function updateTrayState () {
  if (!tray) return
  try {
    tray.setContextMenu(buildTrayMenu())
    if (!trayFlashTimer) tray.setImage(trayBaseIcon())
    tray.setToolTip(runtime.dnd ? 'iLink - 免打扰' : 'iLink')
  } catch (_) {}
}

// 全局免打扰开关（托盘菜单入口）；与状态选择里的"免打扰"同一开关
function setDnd (on) {
  runtime.dnd = !!on
  if (runtime.dnd) stopTrayFlash()
  if (vault && vault.unlocked) {
    const s = vault.setSettings({ presence: on ? 'dnd' : 'online' })
    if (p2p) { p2p.setPresence(s.presence); sendToRenderer('p2p:ready', p2p.getSelf()) }
    sendToRenderer('settings:changed', s)
  }
  updateTrayState()
}

function setupTray () {
  if (tray) return
  try {
    tray = new Tray(trayBaseIcon())
    tray.setToolTip('iLink')
    tray.setContextMenu(buildTrayMenu())
    tray.on('click', () => { stopTrayFlash(); showWindow() })
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
  runtime.dnd = s.presence === 'dnd'
  if (runtime.dnd) stopTrayFlash()
  applyAutoStart(!!s.autoStart)
  updateTrayState()
}

function notify (title, body) {
  try {
    if (runtime.dnd) return // 全局免打扰：禁止一切消息通知
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
    transparent: true,
    hasShadow: false,
    icon: getAppIcon() || undefined,
    backgroundColor: '#00000000',
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

  // 任务栏卡片规则：用户主动选择"最小化到托盘"或退出时才消失；截图等程序性最小化保留卡片
  mainWindow.on('minimize', () => { if (runtime.minimizeToTray && !suppressTrayOnMinimize && mainWindow) mainWindow.hide() })
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
  mainWindow.on('focus', () => { stopTrayFlash(); try { mainWindow.flashFrame(false); mainWindow.setOverlayIcon(null, '') } catch (_) {} })
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
    transparent: true,
    hasShadow: false,
    icon: getAppIcon() || undefined,
    backgroundColor: '#00000000',
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
  p2p.presence = ['online', 'busy', 'away', 'dnd'].includes(settings.presence) ? settings.presence : 'online'
  p2p.on('peers', (list) => {
    if (vault && vault.unlocked) vault.upsertContacts((list || []).filter((p) => p.id))
    logPeerTransitions(list || [])
    emitPeers()
    outboxDrainAll() // 任一对端可达即尝试补发其发件箱（修复"恢复早于离线判定"导致不补发）
  })
  p2p.on('presence', (peer) => {
    if (peer && peer.id) outboxDrain(peer.id)
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
    if (!silent && !muted && !runtime.dnd && mainWindow && !mainWindow.isFocused()) {
      try { mainWindow.flashFrame(true) } catch (_) {}
    }
    // 窗口隐藏/最小化时走系统通知 + 托盘图标闪烁，否则交给渲染层 toast
    if (!silent && !muted && mainWindow && (!mainWindow.isVisible() || mainWindow.isMinimized())) {
      const body = runtime.notifyPreview && !m.burn ? (m.text || '') : '收到新消息'
      notify(m.name || 'iLink', body)
      startTrayFlash() // 免打扰时内部直接忽略
    }
  })
  p2p.on('typing', (t) => sendToRenderer('p2p:typing', t))
  p2p.on('recall', (r) => {
    const conv = r.scope === 'room' && r.roomId ? r.roomId : r.from
    if (vault && vault.unlocked) vault.markRecalled(conv, r.mid)
    sendToRenderer('msg:recall', { conv, mid: r.mid })
  })
  // 对端确认收到撤回 → 从发件箱移除该撤回信号，停止补发
  p2p.on('recall-ack', (r) => { if (vault && vault.unlocked) { vault.outboxRemove(r.from, '__recall__' + r.mid); recallAttempts.delete('__recall__' + r.mid) } })
  p2p.on('reaction', (r) => {
    const conv = r.scope === 'room' && r.roomId ? r.roomId : r.from
    if (vault && vault.unlocked) vault.addReaction(conv, r.mid, r.emoji, r.from)
    sendToRenderer('msg:reaction', { conv, mid: r.mid, emoji: r.emoji, from: r.from })
  })
  // 私聊文本发送状态：delivered→移出发件箱；failed→仍在发件箱则标记"待补发(queued)"，否则真失败
  p2p.on('msg-status', (s) => {
    if (!vault || !vault.unlocked || !s.toId) { sendToRenderer('msg:status', s); return }
    if (s.status === 'delivered') {
      inFlight.delete(s.mid)
      vault.outboxRemove(s.toId, s.mid)
      vault.setMessageStatus(s.toId, s.mid, 'delivered')
      sendToRenderer('msg:status', s)
    } else if (s.status === 'sent') {
      vault.setMessageStatus(s.toId, s.mid, 'sent')
      sendToRenderer('msg:status', s)
    } else { // failed
      inFlight.delete(s.mid)
      const queued = (vault.getOutbox()[s.toId] || []).some((x) => x.mid === s.mid)
      const st = queued ? 'queued' : 'failed'
      if (!queued) logger.log('msg', 'failed', { mid: s.mid, to: s.toId })
      vault.setMessageStatus(s.toId, s.mid, st)
      sendToRenderer('msg:status', { mid: s.mid, toId: s.toId, status: st })
    }
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
    if (!muted && !runtime.dnd && mainWindow) { try { mainWindow.flashFrame(true) } catch (_) {} }
  })
  p2p.on('ready', (self) => { sendToRenderer('p2p:ready', self); emitPeers() })
  p2p.on('neterror', (e) => { sendToRenderer('p2p:neterror', e); logger.log('net', 'neterror', { e: String(e).slice(0, 200) }) })
  p2p.on('reconnect', (r) => logger.log('net', 'reconnect', { reason: (r && r.reason) || '' }))
  p2p.start()
  // 离线发件箱持久化在 vault；对端在 presence 中可达时由 outboxDrainAll 自动补发（文本+文件）

  ft = new FileTransfer({
    id: id.id, pub: keys.pub, priv: keys.priv,
    resolvePeer: (pid) => p2p && p2p.peers.get(pid),
    isBlocked: () => false,
    ownName: () => (p2p ? p2p.displayName() : ''),
  })
  ft.on('incoming', (info) => sendToRenderer('file:incoming', info))
  ft.on('progress', (p) => sendToRenderer('file:progress', { mid: p.mid, received: p.received, size: p.size, dir: 'in' }))
  ft.on('send-progress', (p) => sendToRenderer('file:progress', { mid: p.mid, received: p.sent, size: p.size, dir: 'out' }))
  ft.on('sent', (p) => {
    inFlight.delete(p && p.mid)
    // 文件经 TCP 送达 → 移出发件箱、标记已送达（仅当确为发件箱条目）
    if (vault && vault.unlocked && p && p.toId && (vault.getOutbox()[p.toId] || []).some((x) => x.mid === p.mid)) {
      vault.outboxRemove(p.toId, p.mid)
      vault.setMessageStatus(p.toId, p.mid, 'sent')
    }
    sendToRenderer('file:sent', p)
  })
  ft.on('failed', (p) => {
    inFlight.delete(p && p.mid)
    const pending = p && p.mid ? findOutboxItem(p.mid) : null
    // 用户取消 → 移出发件箱不再补发；其他失败 → 留在发件箱，下次 presence 续传(断点续传)
    if (vault && vault.unlocked && p && p.canceled && p.mid) {
      const ob = vault.getOutbox()
      for (const pid of Object.keys(ob)) { if (ob[pid].some((x) => x.mid === p.mid)) { vault.outboxRemove(pid, p.mid); break } }
    } else if (pending) {
      if (pending.item.kind === 'file') setMsgStatusOut(pending.peerId, p.mid, 'queued')
      sendToRenderer('file:failed', { ...p, queued: true })
      logger.log('file', 'queued', { mid: p.mid, to: pending.peerId })
      return
    }
    sendToRenderer('file:failed', p)
    logger.log('file', p && p.canceled ? 'canceled' : 'failed', { mid: p && p.mid })
  })
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
// 聊天图片预览：小图(≤PREVIEW_INLINE_MAX)直接内嵌原图；大图生成缩放后的 JPEG 缩略图，避免预览丢失
const PREVIEW_INLINE_MAX = 2 * 1024 * 1024 // 内嵌原图预览的大小上限(2MB)，超过则改用缩略图
function imagePreviewDataUrl (fp, mime) {
  if (!mime || mime.indexOf('image/') !== 0) return null
  try {
    const size = fs.statSync(fp).size
    if (size <= PREVIEW_INLINE_MAX) return 'data:' + mime + ';base64,' + fs.readFileSync(fp).toString('base64')
    const img = nativeImage.createFromPath(fp)
    if (!img || img.isEmpty()) return null
    const dim = img.getSize()
    const maxW = 480
    const thumb = dim.width > maxW ? img.resize({ width: maxW, quality: 'good' }) : img
    return 'data:image/jpeg;base64,' + thumb.toJPEG(72).toString('base64')
  } catch (_) { return null }
}
function buildReceivedMsg (info, destPath) {
  const msg = { mid: info.mid, type: 'file', from: info.from, name: info.name, fname: info.fname, size: info.size, mime: info.mime, scope: info.scope, to: info.to || null, batch: info.batch || null, sticker: !!info.sticker, path: destPath, ts: info.ts || Date.now(), self: false }
  const preview = imagePreviewDataUrl(destPath, info.mime)
  if (preview) msg.dataUrl = preview
  return msg
}
function finalizeFile (info) {
  try {
    const s = vault.getSettings()
    const dir = s.downloadDir && fs.existsSync(s.downloadDir) ? s.downloadDir : app.getPath('downloads')
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    // 安全：info.fname 来自对端、可控，必须净化为纯文件名，防止 ../ 越权写到下载目录之外（路径穿越）
    const safeName = safeFileName(info.fname, 'file-' + info.mid)
    const dest = uniquePath(path.join(dir, safeName))
    moveFile(info.tempPath, dest)
    if (info.scope === 'group') return
    const conv = info.scope === 'room' ? info.to : info.from
    const msg = buildReceivedMsg({ ...info, fname: safeName }, dest) // 落库/展示用净化后的名，与磁盘文件名保持一致
    if (vault.unlocked) vault.appendMessage(conv, msg)
    logger.log('file', 'received', { mid: info.mid, fname: safeName, size: info.size, from: info.from, scope: info.scope })
    sendToRenderer('file:received', { conv, msg })
  } catch (e) {
    logger.log('file', 'finalize-error', { mid: info && info.mid, e: String((e && e.message) || e).slice(0, 120) })
    sendToRenderer('file:failed', { mid: info && info.mid })
  }
}
function onFileDone (info) {
  const s = vault.getSettings()
  if ((s.receiveMode || 'auto') === 'manual') {
    pendingFiles.set(info.mid, info)
    sendToRenderer('file:offer', { mid: info.mid, from: info.from, name: info.name, fname: info.fname, size: info.size, mime: info.mime, scope: info.scope, to: info.to || null })
  } else { finalizeFile(info) }
}
// ============ 离线发件箱编排（文本 + 文件，持久化于 vault，确认送达后才移除）============
const inFlight = new Set() // 正在发送/等待确认的 mid，避免重复发
const recallAttempts = new Map() // 撤回信号已尽力次数（无 recallack 的旧端兜底封顶）

function setMsgStatusOut (conv, mid, status) {
  if (vault && vault.unlocked) vault.setMessageStatus(conv, mid, status)
  sendToRenderer('msg:status', { mid, toId: conv, status })
}

function findOutboxItem (mid) {
  if (!vault || !vault.unlocked || !mid) return null
  const ob = vault.getOutbox()
  for (const peerId of Object.keys(ob)) {
    const item = (ob[peerId] || []).find((x) => x.mid === mid)
    if (item) return { peerId, item }
  }
  return null
}

// 把某对端发件箱里未在途的条目按序发出（文本走 UDP+ACK，文件走 TCP，均按 mid 去重）
function outboxDrain (peerId) {
  if (!p2p || !ft || !vault || !vault.unlocked || !p2p.reachable(peerId)) return
  const items = (vault.getOutbox()[peerId] || []).slice()
  for (const it of items) {
    if (inFlight.has(it.mid)) continue
    if (it.kind === 'recall') {
      const a = recallAttempts.get(it.mid) || 0
      if (a >= 8) { vault.outboxRemove(peerId, it.mid); recallAttempts.delete(it.mid); continue } // 旧端无 recallack 时尽力 8 次后放弃
      recallAttempts.set(it.mid, a + 1)
      p2p.sendRecall('private', peerId, it.targetMid) // 幂等：对端重复收到撤回无副作用；recallack 到达即移除
      continue
    }
    if (it.kind === 'roomtext') {
      // 群聊离线文本补达：上线后单发给该成员 + ACK 确认（did=it.mid，与私聊同一套确认/重发机制）
      const currentRoom = (vault.getGroups() || []).find((g) => g.id === it.roomId)
      const room = currentRoom || it.room
      if (!room || (!currentRoom && !it.allowMissingRoom)) { vault.outboxRemove(peerId, it.mid); continue } // 群已删/已退群
      if (currentRoom && !(currentRoom.members || []).includes(peerId) && !it.allowNonMember) { vault.outboxRemove(peerId, it.mid); continue }
      inFlight.add(it.mid)
      const r = p2p.sendRoomMember(peerId, room, it.msgMid, it.mid, it.text, it.opts)
      if (!r || !r.ok) inFlight.delete(it.mid)
    } else if (it.kind === 'roomfile') {
      // 群聊离线文件补达：用 did(it.mid) 作 TCP 传输 mid（每成员唯一，避免同文件多成员串号），复用私聊文件确认路径
      const currentRoom = (vault.getGroups() || []).find((g) => g.id === it.roomId)
      const room = currentRoom || it.room
      if (!room || (!currentRoom && !it.allowMissingRoom)) { vault.outboxRemove(peerId, it.mid); continue }
      if (currentRoom && !(currentRoom.members || []).includes(peerId) && !it.allowNonMember) { vault.outboxRemove(peerId, it.mid); continue }
      if (!fs.existsSync(it.path)) { vault.outboxRemove(peerId, it.mid); continue }
      inFlight.add(it.mid)
      const r = ft.sendFile(peerId, it.path, 'room', it.mid, it.roomId, it.batch || null, !!it.sticker, it.msgMid, it.ts)
      if (r && r.error) inFlight.delete(it.mid)
    } else if (it.kind === 'file') {
      if (!fs.existsSync(it.path)) { vault.outboxRemove(peerId, it.mid); setMsgStatusOut(peerId, it.mid, 'failed'); continue } // 文件已不存在
      inFlight.add(it.mid)
      const r = ft.sendFile(peerId, it.path, 'private', it.mid, peerId, it.batch || null, !!it.sticker, it.mid, it.ts)
      if (r && r.error) inFlight.delete(it.mid) // 对端 TCP 暂不可达 → 保留发件箱，下次再试
    } else {
      inFlight.add(it.mid)
      const r = p2p.resendPrivate(peerId, it.mid, it.text, it.opts)
      if (!r || !r.ok) inFlight.delete(it.mid) // 暂不可达 → 保留，下次 presence 再试
    }
  }
}

function outboxDrainAll () {
  if (!vault || !vault.unlocked) return
  for (const pid of Object.keys(vault.getOutbox())) outboxDrain(pid)
}

function roomDeliverySnapshot (room) {
  if (!room || !room.id) return null
  return {
    id: room.id,
    name: room.name || '群聊',
    ownerId: room.ownerId || '',
    members: Array.from(new Set(room.members || [])).filter(Boolean),
  }
}

function roomDeliveryTargets (room, opts) {
  const ids = new Set((room && room.members) || [])
  for (const id of ((opts && opts.extraRecipients) || [])) ids.add(id)
  if (p2p && p2p.id) ids.delete(p2p.id)
  return Array.from(ids).filter(Boolean)
}

function queueRoomTextDeliveries (room, msg, text, opts) {
  if (!vault || !vault.unlocked || !room || !msg || msg.burn) return
  const snapshot = roomDeliverySnapshot(room)
  const members = new Set((snapshot && snapshot.members) || [])
  const system = opts && opts.system
  for (const peerId of roomDeliveryTargets(room, opts)) {
    vault.outboxAdd(peerId, {
      mid: msg.mid + '@' + peerId,
      kind: 'roomtext',
      msgMid: msg.mid,
      roomId: room.id,
      room: snapshot,
      text,
      opts: opts || {},
      ts: msg.ts,
      allowNonMember: system === 'member-removed' && !members.has(peerId),
      allowMissingRoom: system === 'member-left',
    })
  }
}

function sendRoomStored (room, text, opts, emitLocal) {
  if (!p2p || !vault || !vault.unlocked) return { ok: false, error: '网络未就绪' }
  const o = opts || {}
  const targets = roomDeliveryTargets(room, o)
  const queuedCount = targets.filter((id) => !p2p.reachable(id)).length
  if (o.burn && queuedCount === targets.length) return { ok: false, error: '群成员均离线，阅后即焚消息不支持暂存' }
  const res = p2p.sendRoom(room, text, o)
  if (res.ok && !res.msg.burn) {
    vault.appendMessage(room.id, res.msg)
    queueRoomTextDeliveries(room, res.msg, text, o)
    outboxDrainAll()
    res.queued = queuedCount > 0
    res.queuedCount = queuedCount
  }
  if (res.ok && emitLocal) sendToRenderer('p2p:message', res.msg)
  return res
}

function sendFilesInternal (scope, toId, paths, batch, opts) {
  const sticker = !!(opts && opts.sticker) // 表情包消息：气泡内不展示文件操作
  if (!ft || !p2p || !vault || !vault.unlocked) return []
  const out = []
  const maxMB = vault.getSettings().maxFileMB || 0
  const maxBytes = maxMB > 0 ? maxMB * 1024 * 1024 : 0
  const rejected = []

  if (scope === 'room') {
    // 群聊：所有成员入持久化发件箱；在线成员立即发送，假在线/离线成员上线后补达。
    const room = vault.getGroups().find((g) => g.id === toId) || null
    if (!room) return []
    const selfId = p2p.id
    const targets = (room.members || []).filter((id) => id !== selfId)
    const online = new Set(p2p.getPeers().filter((p) => p.online && p.pub).map((p) => p.id))
    const snapshot = roomDeliverySnapshot(room)
    for (const fp of (paths || [])) {
      let size = 0; try { size = fs.statSync(fp).size } catch (_) { sendToRenderer('file:failed', { mid: crypto.randomUUID() }); continue }
      if (maxBytes > 0 && size > maxBytes) { rejected.push(path.basename(fp)); continue }
      const mid = crypto.randomUUID()
      const fname = path.basename(fp)
      const mime = guessMime(fname)
      const ts = Date.now()
      if (!targets.length) { sendToRenderer('file:failed', { mid }); continue } // 无可投递成员
      // 所有群成员都入发件箱：在线成员立即 drain，假在线/离线成员上线后继续补发。
      for (const mem of targets) vault.outboxAdd(mem, { mid: mid + '@' + mem, kind: 'roomfile', msgMid: mid, roomId: toId, room: snapshot, path: fp, fname, size, mime, batch: batch || null, sticker, ts })
      logger.log('file', 'send', { mid, fname, size, to: toId, scope, recipients: targets.filter((id) => online.has(id)).length, queued: targets.length })
      const msg = { mid, type: 'file', from: p2p.id, name: p2p.name, fname, size, mime, scope, to: toId, batch: batch || null, sticker, path: fp, ts, self: true, status: null }
      const preview = imagePreviewDataUrl(fp, mime); if (preview) msg.dataUrl = preview
      vault.appendMessage(toId, msg)
      out.push(msg)
    }
    outboxDrainAll()
    if (rejected.length) sendToRenderer('file:rejected', { reason: 'oversize', files: rejected, limitMB: maxMB })
    return out
  }

  // 私聊：入持久化发件箱，统一由 outboxDrain 投递（离线暂存 + 上线补发 + 断点续传）
  for (const fp of (paths || [])) {
    let size = 0; let ok = true
    try { size = fs.statSync(fp).size } catch (_) { ok = false }
    if (!ok) { sendToRenderer('file:failed', { mid: crypto.randomUUID() }); continue }
    if (maxBytes > 0 && size > maxBytes) { rejected.push(path.basename(fp)); continue }
    const mid = crypto.randomUUID()
    const fname = path.basename(fp)
    const mime = guessMime(fname)
    const online = p2p.reachable(toId)
    const msg = { mid, type: 'file', from: p2p.id, name: p2p.name, fname, size, mime, scope: 'private', to: toId, batch: batch || null, sticker, path: fp, ts: Date.now(), self: true, status: online ? 'sending' : 'queued' }
    const preview = imagePreviewDataUrl(fp, mime); if (preview) msg.dataUrl = preview
    vault.appendMessage(toId, msg)
    vault.outboxAdd(toId, { mid, kind: 'file', path: fp, fname, size, mime, batch: batch || null, sticker, ts: msg.ts })
    out.push(msg)
  }
  outboxDrain(toId)
  if (rejected.length) sendToRenderer('file:rejected', { reason: 'oversize', files: rejected, limitMB: maxMB })
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
  if ('maxFileMB' in nextPatch) { const v = parseInt(nextPatch.maxFileMB, 10); nextPatch.maxFileMB = (v > 0 && v <= 102400) ? v : 0 }
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
      if (n === 0) stopTrayFlash()
      if (!trayFlashTimer) tray.setImage(trayBaseIcon())
      tray.setToolTip(n > 0 ? ('iLink - ' + n + ' 条未读') : (runtime.dnd ? 'iLink - 免打扰' : 'iLink'))
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
  if (vault && vault.unlocked) vault.markRecalled(toId, mid)
  if (scope === 'room') { p2p.sendRecall(scope, toId, mid); return { ok: true } }
  // 私聊：① 撤回的消息从发件箱移除——绝不再补发（修复"离线/假在线时发的消息被撤回后仍补发"）
  //      ② 撤回信号入发件箱，由 outboxDrain 在对端可达时投递、recallack 确认后移除——可靠覆盖离线/假在线后上线
  inFlight.delete(mid)
  if (vault && vault.unlocked) {
    vault.outboxRemove(toId, mid)
    vault.outboxAdd(toId, { mid: '__recall__' + mid, kind: 'recall', targetMid: mid, ts: Date.now() })
  }
  outboxDrain(toId)
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
ipcMain.handle('sys:revealLog', () => { try { if (logger.file) shell.showItemInFolder(logger.file) } catch (_) {} })
ipcMain.handle('p2p:nudge', (_e, toId) => {
  if (!p2p) return
  const text = vault && vault.unlocked ? (vault.getSettings().nudgeText || '') : ''
  p2p.sendNudge(toId, text)
})
ipcMain.handle('store:getDrafts', () => (vault && vault.unlocked ? vault.getDrafts() : {}))
ipcMain.handle('store:getReads', () => (vault && vault.unlocked ? vault.getReads() : {}))
ipcMain.handle('store:setRead', (_e, convId, ts) => { if (vault && vault.unlocked) vault.setRead(convId, ts) })
ipcMain.handle('store:setDraft', (_e, convId, text) => { if (vault && vault.unlocked) vault.setDraft(convId, text) })
ipcMain.handle('store:clearHistory', () => { if (vault && vault.unlocked) vault.clearHistory(); return { ok: true } })
ipcMain.handle('store:clearConversation', (_e, convId) => { if (vault && vault.unlocked) vault.clearConversation(convId); return { ok: true } })
ipcMain.handle('store:clearDrafts', () => { if (vault && vault.unlocked) vault.clearDrafts(); return { ok: true } })
// 联系人备注：仅本机可见
ipcMain.handle('store:setRemark', (_e, peerId, remark) => {
  if (!vault || !vault.unlocked) return null
  const c = vault.setContactRemark(peerId, remark)
  emitPeers()
  return c
})
ipcMain.handle('store:getGroups', () => (vault && vault.unlocked ? vault.getGroups() : []))
ipcMain.handle('store:createGroup', (_e, name, members) => {
  if (!vault || !vault.unlocked) return null
  const selfId = vault.getIdentity().id
  const group = vault.createGroup(name || '群聊', Array.from(new Set([selfId, ...(members || [])])), selfId)
  if (p2p) {
    sendRoomStored(group, '群聊已创建', { system: 'room-created' }, true)
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
  sendRoomStored(updated, text, { system: 'member-added' }, true)
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
  sendRoomStored(updated, text, { system: 'member-removed', extraRecipients: [memberId] }, true)
  sendToRenderer('store:groups', vault.getGroups())
  return { ok: true, group: updated, removed: memberId }
})
// 群头像载入：选图后输出 96px 压缩 JPEG，小图直接保留，过大才重压缩；失败返回 null 而非空壳对象
function groupAvatarPayload (avatar) {
  if (!avatar || typeof avatar !== 'object') return null
  if (avatar.type === 'image' && typeof avatar.imageDataUrl === 'string' && avatar.imageDataUrl.startsWith('data:image/')) {
    // 32KB 上限：room-avatar 包加密 + base64 膨胀约 4/3，需留足 UDP 报文余量
    const crop = avatarCrop(avatar)
    if (avatar.imageDataUrl.length <= AVATAR_MAX_CHARS) {
      return { type: 'image', imageDataUrl: avatar.imageDataUrl, ...crop } // 含 GIF 动图原样下发
    }
    // GIF 过大退回静态首帧
    if (typeof avatar.staticDataUrl === 'string' && avatar.staticDataUrl.startsWith('data:image/') && avatar.staticDataUrl.length <= AVATAR_MAX_CHARS) {
      return { type: 'image', imageDataUrl: avatar.staticDataUrl, ...crop }
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
  sendRoomStored(next, '更新了群头像', { system: 'avatar-changed' }, true)
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
    sendRoomStored(updated, '退出了群聊', { system: 'member-left' }, false)
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
    sendRoomStored(group, '群主已转让给 ' + name, { system: 'owner-transferred' }, true)
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
  return sendRoomStored(room, text, opts, false)
})
ipcMain.handle('p2p:sendPrivate', (_e, toId, text, opts) => {
  if (!p2p || !vault || !vault.unlocked) return { ok: false, error: '网络未就绪' }
  text = (text || '').toString()
  if (!text.trim()) return { ok: false, error: '空消息' }
  // 超长文本加密后会使单个 UDP 包超限(EMSGSIZE)，须在入发件箱前拦截，避免静默失败或上线后反复重发
  if (isTextTooLong(text)) return { ok: false, error: '消息过长，请精简后发送（上限 ' + MAX_TEXT_CHARS + ' 字）' }
  const o = opts || {}
  const mid = crypto.randomUUID()
  // 阅后即焚：仅在线直发，不入发件箱、不落库
  if (o.burn) {
    if (!p2p.reachable(toId)) return { ok: false, error: '对方离线，阅后即焚消息不支持暂存' }
    const r = p2p.resendPrivate(toId, mid, text, o)
    if (!r || !r.ok) return { ok: false, error: (r && r.error) || '发送失败' }
    return { ok: true, msg: p2p.privateEcho(mid, toId, text, o) }
  }
  const online = p2p.reachable(toId)
  const echo = p2p.privateEcho(mid, toId, text, o)
  echo.status = online ? 'sending' : 'queued'
  vault.appendMessage(toId, echo)
  vault.outboxAdd(toId, { mid, kind: 'text', text, opts: { reply: o.reply || null, fwd: o.fwd || null, batch: o.batch || null, ttl: o.ttl }, ts: echo.ts })
  outboxDrain(toId)
  return { ok: true, msg: echo, queued: !online }
})
// 手动重试：确保在发件箱中并立即尝试补发（在线则发，离线则保持"待补发"）
ipcMain.handle('p2p:resend', (_e, toId, mid, text, opts) => {
  if (!p2p || !vault || !vault.unlocked) return { ok: false, error: '网络未就绪' }
  const o = opts || {}
  if (o.burn) { // 阅后即焚：绝不入发件箱；可达则直发一次，不可达则失败（不暂存、不重发）
    if (!p2p.reachable(toId)) return { ok: false, error: '对方离线，阅后即焚消息不支持暂存' }
    return p2p.resendPrivate(toId, mid, (text || '').toString(), o)
  }
  const inBox = (vault.getOutbox()[toId] || []).some((x) => x.mid === mid)
  if (!inBox) vault.outboxAdd(toId, { mid, kind: 'text', text: (text || '').toString(), opts: { reply: o.reply || null, fwd: o.fwd || null, batch: o.batch || null, ttl: o.ttl }, ts: Date.now() })
  setMsgStatusOut(toId, mid, p2p.reachable(toId) ? 'sending' : 'queued')
  outboxDrain(toId)
  return { ok: true }
})
// 手动重连：重建 UDP socket（自愈失败或用户主动触发时）
ipcMain.handle('p2p:reconnect', () => { if (!p2p) return { ok: false }; p2p.reconnect('manual'); return { ok: true } })

ipcMain.handle('file:send', (_e, scope, toId, paths, batch, opts) => sendFilesInternal(scope, toId, paths, batch, opts))
ipcMain.handle('file:pick', async (_e, scope, toId) => {
  const r = await dialog.showOpenDialog(mainWindow, { properties: ['openFile', 'multiSelections'] })
  if (r.canceled || !r.filePaths.length) return []
  return sendFilesInternal(scope, toId, r.filePaths)
})
ipcMain.handle('file:accept', (_e, mid) => { const info = pendingFiles.get(mid); if (info) { pendingFiles.delete(mid); finalizeFile(info) } })
ipcMain.handle('file:reject', (_e, mid) => { const info = pendingFiles.get(mid); if (info) { pendingFiles.delete(mid); try { fs.unlinkSync(info.tempPath) } catch (_) {} } })
// 取消传输中的文件(收发双向)
ipcMain.handle('file:cancel', (_e, mid) => { if (ft) return { ok: ft.cancel(mid) }; return { ok: false } })
// 重试发送失败的私聊文件(复用同一 mid 重新发送本地文件)
ipcMain.handle('file:retry', (_e, toId, mid, filePath, batch) => {
  if (!ft || !p2p) return { ok: false, error: '网络未就绪' }
  const r = ft.sendFile(toId, filePath, 'private', mid, toId, batch || null, false)
  if (r && r.error) return { ok: false, error: r.error }
  return { ok: true }
})
// 危险可执行类型:打开前弹原生确认框,避免误运行收到的恶意程序
const DANGEROUS_EXT = new Set(['exe', 'msi', 'msp', 'bat', 'cmd', 'com', 'scr', 'pif', 'ps1', 'psm1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'hta', 'jar', 'reg', 'cpl', 'lnk', 'gadget', 'sh'])
ipcMain.handle('file:open', async (e, p) => {
  try {
    const ext = path.extname(String(p || '')).slice(1).toLowerCase()
    if (DANGEROUS_EXT.has(ext)) {
      const win = windowFromEvent(e) || mainWindow
      const r = await dialog.showMessageBox(win, {
        type: 'warning', buttons: ['取消', '仍要打开'], defaultId: 0, cancelId: 0, noLink: true,
        title: '危险文件警告',
        message: '这是可执行文件，打开后可能损坏你的电脑或泄露数据',
        detail: path.basename(String(p)) + '（.' + ext + '）\n\n只有在你完全信任文件来源时才打开。',
      })
      if (r.response !== 1) { console.warn('[file] 用户取消打开危险文件:', p); return { ok: false, canceled: true } }
      console.warn('[file] 用户确认打开危险文件:', p)
    }
    shell.openPath(p)
    return { ok: true }
  } catch (_) { return { ok: false } }
})
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
    if (hide && wasVisible) { suppressTrayOnMinimize = true; mainWindow.minimize(); await new Promise((r) => setTimeout(r, 320)); suppressTrayOnMinimize = false } // 程序性最小化，保留任务栏卡片
    const disp = screen.getPrimaryDisplay()
    const size = { width: Math.round(disp.size.width * disp.scaleFactor), height: Math.round(disp.size.height * disp.scaleFactor) }
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size })
    const src = sources.find((s) => String(s.display_id) === String(disp.id)) || sources[0]
    if (hide && wasVisible) mainWindow.restore()
    if (!src || src.thumbnail.isEmpty()) return { ok: false, error: '截图失败（无可用屏幕源）' }
    shotImageDataUrl = 'data:image/png;base64,' + src.thumbnail.toPNG().toString('base64')
    // 选区窗口必须覆盖整个屏幕（含任务栏），与截到的全屏图 1:1 对齐，否则任务栏会重影
    const bounds = disp.bounds
    shotWin = new BrowserWindow({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      fullscreen: false,
      kiosk: false,
      fullscreenable: false,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      show: false,
      backgroundColor: '#000000',
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
    })
    shotWin.setAlwaysOnTop(true, 'screen-saver') // 提升层级以盖住任务栏
    shotWin.setBounds(bounds) // Windows 可能自动调整，强制还原为全屏 bounds
    shotWin.once('ready-to-show', () => shotWin.show())
    shotWin.on('closed', () => { shotWin = null; shotImageDataUrl = '' })
    loadAppWindow(shotWin, { window: 'shot' })
    return { ok: true }
  } catch (err) {
    try { if (hide && wasVisible) mainWindow.restore() } catch (_) {}
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
    try { const img = nativeImage.createFromDataURL(String(dataUrl)); if (!img.isEmpty()) clipboard.writeImage(img) } catch (_) {} // 同时写入剪贴板，支持 Ctrl+V 粘贴到发送框
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

// 将粘贴的图片 dataURL 落地为临时 PNG，返回路径供待发附件使用
ipcMain.handle('file:saveImage', (_e, dataUrl) => {
  try {
    const b64 = String(dataUrl || '').split(',')[1] || ''
    if (!b64) return null
    const buf = Buffer.from(b64, 'base64')
    const p = path.join(os.tmpdir(), 'ilink-paste-' + Date.now() + '.png')
    fs.writeFileSync(p, buf)
    return { path: p, name: path.basename(p), size: buf.length }
  } catch (_) { return null }
})

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
  const ext = path.extname(filePath).toLowerCase()
  if (stat.size > 4 * 1024 * 1024) return { ok: false, error: '头像图片不能超过 4 MB' }
  // GIF 动图：保留原始字节（不重编码，否则动画丢失）；是否超限转静态由渲染层判断并提示
  if (ext === '.gif') {
    return { ok: true, gif: true, dataUrl: 'data:image/gif;base64,' + fs.readFileSync(filePath).toString('base64') }
  }
  const img = nativeImage.createFromPath(filePath)
  if (img && !img.isEmpty()) {
    const thumb = img.resize({ width: 192, height: 192, quality: 'good' })
    return { ok: true, dataUrl: 'data:image/jpeg;base64,' + thumb.toJPEG(80).toString('base64') }
  }
  const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg'
  return { ok: true, dataUrl: 'data:' + mime + ';base64,' + fs.readFileSync(filePath).toString('base64') }
})

// ---------------- 表情包：导入的图片存于本机 data/stickers，发送时复用文件消息通道 ----------------
function stickersDir () {
  const dir = path.join(resolveDataDir(), 'stickers')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}
function listStickers () {
  try {
    const dir = stickersDir()
    return fs.readdirSync(dir)
      .filter((f) => /\.(png|jpe?g|webp|gif)$/i.test(f))
      .sort()
      .map((f) => {
        const fp = path.join(dir, f)
        const ext = path.extname(f).slice(1).toLowerCase()
        const mime = ext === 'jpg' ? 'image/jpeg' : 'image/' + ext
        try { return { id: f, path: fp, dataUrl: 'data:' + mime + ';base64,' + fs.readFileSync(fp).toString('base64') } } catch (_) { return null }
      })
      .filter(Boolean)
  } catch (_) { return [] }
}
ipcMain.handle('stickers:list', () => listStickers())
ipcMain.handle('stickers:add', async () => {
  const r = await dialog.showOpenDialog(mainWindow, { properties: ['openFile', 'multiSelections'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }] })
  if (r.canceled || !r.filePaths.length) return { ok: true, skipped: 0, stickers: listStickers() }
  const dir = stickersDir()
  let skipped = 0
  for (const fp of r.filePaths) {
    try {
      if (fs.statSync(fp).size > 2 * 1024 * 1024) { skipped++; continue } // 与聊天图片内嵌预览上限一致
      fs.copyFileSync(fp, uniquePath(path.join(dir, path.basename(fp))))
    } catch (_) { skipped++ }
  }
  return { ok: true, skipped, stickers: listStickers() }
})
ipcMain.handle('stickers:remove', (_e, id) => {
  try {
    const fp = path.join(stickersDir(), path.basename(String(id || ''))) // basename 防路径穿越
    if (fs.existsSync(fp)) fs.unlinkSync(fp)
  } catch (_) {}
  return listStickers()
})

app.whenReady().then(() => {
  vault = new Vault(resolveDataDir())
  logger.init(resolveDataDir())
  setupTray()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => { isQuitting = true })

app.on('window-all-closed', () => {
  stopP2P()
  app.quit()
})

// padding: workspace mount sync lags one write behind; this trailing comment absorbs the truncation so real code stays intact when verified from the sandbox. -------------------------------------------------------------------------------------------------------------------------
