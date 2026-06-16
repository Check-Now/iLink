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
const shareMod = require('./sharespace')
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
    // 共享空间广播（随群系统消息同步，仅聊天框展示）：更新本地已知空间/失效缓存快照
    if (m.system && typeof m.system === 'string' && m.system.indexOf('share-') === 0 && m.share && vault && vault.unlocked) {
      try { applyShareBroadcast(m) } catch (e) { logger.log('share', 'apply-broadcast-error', { e: String((e && e.message) || e).slice(0, 120) }) }
    }
    if (vault && vault.unlocked) vault.upsertContacts([{ id: m.from, name: m.name, avatar: m.avatar || null, lastSeen: Date.now() }])
    const convId = m.scope === 'room' && m.room ? m.room.id : m.from
    const muted = vault && vault.unlocked ? (vault.getSettings().muted || []).includes(convId) : false
    if (!m.burn && vault && vault.unlocked) {
      vault.appendMessage(convId, m)
    }
    sendToRenderer('p2p:message', m)
    if (m.room) sendToRenderer('store:groups', vault.getGroups())
    // 群头像更新、共享空间广播只保留聊天框内文字，不闪任务栏、不发系统通知
    const silent = m.system === 'avatar-changed' || (typeof m.system === 'string' && m.system.indexOf('share-') === 0)
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
  p2p.on('share', (msg) => { try { onShareSignal(msg) } catch (e) { logger.log('share', 'signal-error', { e: String((e && e.message) || e).slice(0, 120) }) } })
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
  loadShareHosts() // 加载本机作为共享主机的空间
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
  // 群共享空间传输：不走聊天落地，单独路由（上传→宿主入库；下载→成员落地）
  if (info && info.share && info.share.op) { try { onShareFileDone(info) } catch (e) { logger.log('share', 'file-done-error', { e: String((e && e.message) || e).slice(0, 120) }); try { fs.unlinkSync(info.tempPath) } catch (_) {} } return }
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

// ============================ 群共享空间（纯 P2P，无中心服务器）============================
// 宿主端：本机持有 ShareStore（磁盘 meta + 物理多版本文件）；成员端：缓存目录快照，离线只读。
// 控制信令走 p2p.sendShare 加密单播请求/响应；文件内容走 FileTransfer TCP（复用 sha256/.part/续传）。
const shareHosts = new Map()       // spaceId -> ShareStore（仅本机作为宿主的空间）
const sharePending = new Map()     // reqId -> { resolve, timer }  控制信令/上传等待响应
const shareDownloads = new Map()   // transferMid -> { resolve, timer }  下载等待落地

function shareDataRoot () { return path.join(resolveDataDir(), 'group_shares') }
function defaultSpaceRoot (groupId, spaceId) {
  const safeGroup = String(groupId || 'group').replace(/[\\/:*?"<>|]/g, '_')
  const safeSpace = String(spaceId || 'space').replace(/[\\/:*?"<>|]/g, '_')
  return path.join(shareDataRoot(), safeGroup, safeSpace)
}
function selfId () { return vault && vault.unlocked ? vault.getIdentity().id : (p2p ? p2p.id : '') }
function selfDeviceId () { try { return os.hostname() } catch (_) { return 'device' } }

// 解锁/启动后加载本机宿主空间
function loadShareHosts () {
  shareHosts.clear()
  if (!vault || !vault.unlocked) return
  for (const sp of vault.getShareSpaces()) {
    if (!sp.isHost || !sp.rootPath || sp.status === 'deleted') continue
    try { shareHosts.set(sp.spaceId, shareMod.ShareStore.open(sp.rootPath)) } catch (e) { logger.log('share', 'host-open-failed', { spaceId: sp.spaceId, e: String((e && e.message) || e).slice(0, 100) }) }
  }
}

// 空间在线 = 本机是宿主 或 宿主对端在线
function isSpaceOnline (sp) {
  if (!sp) return false
  if (sp.hostUserId === selfId()) return true
  const peer = (p2p ? p2p.getPeers() : []).find((p) => p.id === sp.hostUserId)
  return !!(peer && peer.online)
}
function shareSpaceView (sp) { return { ...sp, online: isSpaceOnline(sp) } }
function isHostSelf (sp) { return sp && sp.hostUserId === selfId() }

// 删除/重命名权限：宿主本人 或 空间创建者 或 群主
function shareCanManage (sp, operatorId) {
  if (!sp) return false
  if (operatorId === sp.hostUserId || operatorId === sp.createdBy) return true
  const group = vault.getGroups().find((g) => g.id === sp.groupId)
  return !!(group && group.ownerId === operatorId)
}

// 发起到宿主的控制信令请求并等待响应（带超时）
function shareRequest (hostId, action, data, timeoutMs) {
  return new Promise((resolve) => {
    if (!p2p) return resolve({ ok: false, error: '网络未就绪' })
    const reqId = crypto.randomUUID()
    const r = p2p.sendShare(hostId, { kind: 'req', reqId, action, data: data || {} })
    if (!r.ok) return resolve({ ok: false, error: r.error || '共享主机离线，暂时不可访问' })
    const timer = setTimeout(() => { sharePending.delete(reqId); resolve({ ok: false, error: '请求超时（共享主机无响应）' }) }, timeoutMs || 8000)
    sharePending.set(reqId, { resolve, timer })
  })
}

// 收到 share 信令：响应→解析挂起请求；请求→本机作为宿主处理
function onShareSignal (msg) {
  if (!vault || !vault.unlocked) return
  if (msg.kind === 'res') {
    const p = sharePending.get(msg.reqId)
    if (!p) return
    clearTimeout(p.timer); sharePending.delete(msg.reqId)
    p.resolve(msg.data || { ok: false, error: '空响应' })
    return
  }
  if (msg.kind !== 'req') return
  const data = msg.data || {}
  const store = shareHosts.get(data.spaceId)
  const reply = (d) => { if (p2p) p2p.sendShare(msg.from, { kind: 'res', reqId: msg.reqId, action: msg.action, data: d }) }
  if (!store) return reply({ ok: false, error: '共享空间不存在或本机非宿主' })
  const sp = vault.getShareSpace(data.spaceId)
  const group = vault.getGroups().find((g) => g.id === (sp && sp.groupId))
  if (group && !(group.members || []).includes(msg.from)) return reply({ ok: false, error: '非群成员，无权访问' })
  try {
    if (msg.action === 'dir_list') return reply(store.listDir(data.parentId))
    if (msg.action === 'history') return reply(store.listHistory(data.entryId))
    if (msg.action === 'folder_create') {
      const r = store.createFolder(msg.from, data.parentId, data.name)
      if (r.ok) { broadcastShare(sp, 'share-folder-created', displayNameForId(msg.from) + ' 新建文件夹「' + r.entry.name + '」', { type: 'folder-created', parentId: data.parentId }); persistHostSpace(sp) }
      return reply(r)
    }
    if (msg.action === 'rename') {
      if (!shareCanManage(sp, msg.from)) return reply({ ok: false, error: '无权限（仅宿主或群主可重命名）' })
      const r = store.rename(msg.from, data.entryId, data.newName)
      if (r.ok) { broadcastShare(sp, 'share-renamed', displayNameForId(msg.from) + ' 重命名为「' + r.entry.name + '」', { type: 'renamed' }); persistHostSpace(sp) }
      return reply(r)
    }
    if (msg.action === 'delete') {
      if (!shareCanManage(sp, msg.from)) return reply({ ok: false, error: '无权限（仅宿主或群主可删除）' })
      const r = store.remove(msg.from, data.entryId)
      if (r.ok) { broadcastShare(sp, 'share-deleted', displayNameForId(msg.from) + ' 删除了一项内容', { type: 'deleted' }); persistHostSpace(sp) }
      return reply(r)
    }
    if (msg.action === 'download') {
      const vp = store.versionAbsPath(data.entryId, data.versionId)
      if (!vp) return reply({ ok: false, error: '版本不存在' })
      const mid = crypto.randomUUID()
      reply({ ok: true, mid, fname: vp.fileName, size: vp.size, hash: vp.hash })
      ft.sendFile(msg.from, vp.abs, 'share', mid, sp.spaceId, null, false, mid, Date.now(), { op: 'download', spaceId: sp.spaceId, entryId: data.entryId, versionId: vp.versionId, fname: vp.fileName })
      return
    }
  } catch (e) {
    logger.log('share', 'host-action-error', { action: msg.action, e: String((e && e.message) || e).slice(0, 120) })
    return reply({ ok: false, error: '宿主处理失败:' + ((e && e.message) || e) })
  }
  reply({ ok: false, error: '未知操作' })
}

// 宿主把磁盘空间信息同步回 vault（文件数/更新时间）并通知渲染层
function persistHostSpace (sp) {
  const store = shareHosts.get(sp.spaceId)
  if (!store) return
  const info = store.spaceInfo()
  vault.upsertShareSpace({ ...vault.getShareSpace(sp.spaceId), fileCount: info.fileCount, updatedAt: info.updatedAt })
  sendToRenderer('share:changed', { spaceId: sp.spaceId })
}

// 文件传输完成（共享空间）：上传→宿主入库并广播+回执；下载→成员落地
function onShareFileDone (info) {
  const sh = info.share || {}
  if (sh.op === 'upload') {
    const store = shareHosts.get(sh.spaceId)
    const sp = vault.getShareSpace(sh.spaceId)
    if (!store || !sp) { try { fs.unlinkSync(info.tempPath) } catch (_) {} ; if (sh.reqId && p2p) p2p.sendShare(info.from, { kind: 'res', reqId: sh.reqId, action: 'upload', data: { ok: false, error: '共享空间不存在' } }); return }
    const r = store.placeUpload({ fileName: info.fname, tempPath: info.tempPath, uploadedBy: info.from, intent: sh.intent, entryId: sh.entryId, parentId: sh.parentId, changeNote: sh.changeNote, rename: sh.rename })
    if (!r.ok) { try { fs.unlinkSync(info.tempPath) } catch (_) {} }
    if (sh.reqId && p2p) p2p.sendShare(info.from, { kind: 'res', reqId: sh.reqId, action: 'upload', data: r })
    if (r.ok) {
      const who = displayNameForId(info.from)
      if (sh.intent === 'version') broadcastShare(sp, 'share-file-version-uploaded', who + ' 上传了「' + r.entry.name + '」新版本 V' + shareMod.padVersion(r.version.versionNo), { type: 'version' })
      else broadcastShare(sp, 'share-file-uploaded', who + ' 上传了「' + r.entry.name + '」', { type: 'file', parentId: sh.parentId })
      persistHostSpace(sp)
      logger.log('share', sh.intent === 'version' ? 'upload_version' : 'upload_file', { spaceId: sp.spaceId, by: info.from, name: r.entry.name })
    }
    return
  }
  if (sh.op === 'download') {
    try {
      const s = vault.getSettings()
      const dir = s.downloadDir && fs.existsSync(s.downloadDir) ? s.downloadDir : app.getPath('downloads')
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      const safe = safeFileName(sh.fname || info.fname, 'file-' + info.mid)
      const dest = uniquePath(path.join(dir, safe))
      moveFile(info.tempPath, dest)
      logger.log('share', 'download', { spaceId: sh.spaceId, fname: safe })
      sendToRenderer('share:downloaded', { spaceId: sh.spaceId, entryId: sh.entryId, versionId: sh.versionId, path: dest, fname: safe })
      const pend = shareDownloads.get(info.transferMid || info.mid)
      if (pend) { clearTimeout(pend.timer); shareDownloads.delete(info.transferMid || info.mid); pend.resolve({ ok: true, path: dest, fname: safe }) }
    } catch (e) {
      try { fs.unlinkSync(info.tempPath) } catch (_) {}
      sendToRenderer('share:downloadFailed', { spaceId: sh.spaceId, error: String((e && e.message) || e) })
    }
  }
}

// 广播共享空间事件（复用群聊系统消息可靠投递，仅聊天框展示，不弹通知）
function broadcastShare (sp, system, text, payload) {
  const group = vault.getGroups().find((g) => g.id === sp.groupId)
  if (!group) return
  sendRoomStored(group, '[共享空间] ' + text, { system, share: { ...(payload || {}), spaceId: sp.spaceId, groupId: sp.groupId, name: sp.name, hostUserId: sp.hostUserId, hostDeviceId: sp.hostDeviceId, createdBy: sp.createdBy, createdAt: sp.createdAt } }, true)
}

// 成员收到共享空间广播：更新已知空间/失效缓存
function applyShareBroadcast (m) {
  const sh = m.share || {}
  const spaceId = sh.spaceId
  if (!spaceId) return
  if (m.system === 'share-space-created') {
    if (!vault.getShareSpace(spaceId)) {
      vault.upsertShareSpace({
        spaceId, groupId: sh.groupId, name: sh.name, hostUserId: sh.hostUserId, hostDeviceId: sh.hostDeviceId || '',
        hostIp: '', rootPath: '', createdBy: sh.createdBy, createdAt: sh.createdAt || Date.now(), updatedAt: Date.now(),
        status: 'normal', fileCount: 0, isHost: sh.hostUserId === selfId(),
      })
    }
  } else if (m.system === 'share-space-deleted') {
    vault.removeShareSpace(spaceId)
  } else {
    const sp = vault.getShareSpace(spaceId)
    if (sp) vault.upsertShareSpace({ ...sp, updatedAt: Date.now() })
    vault.clearShareSnapshot(spaceId)
  }
  sendToRenderer('share:changed', { spaceId })
}

// 本机宿主自传：把源文件复制为临时文件后入库（不删用户原文件）
function hostSelfUpload (sp, parentId, filePath, intent, entryId, rename) {
  const store = shareHosts.get(sp.spaceId)
  if (!store) return { ok: false, error: '本机存储未加载' }
  let tmp
  try { tmp = path.join(os.tmpdir(), 'freedom-share-' + crypto.randomUUID()); fs.copyFileSync(filePath, tmp) } catch (e) { return { ok: false, error: '读取源文件失败' } }
  const r = store.placeUpload({ fileName: path.basename(filePath), tempPath: tmp, uploadedBy: selfId(), intent, entryId, parentId, rename })
  if (!r.ok) { try { fs.unlinkSync(tmp) } catch (_) {} ; return r }
  const who = displayNameForId(selfId())
  if (intent === 'version') broadcastShare(sp, 'share-file-version-uploaded', who + ' 上传了「' + r.entry.name + '」新版本 V' + shareMod.padVersion(r.version.versionNo), { type: 'version' })
  else broadcastShare(sp, 'share-file-uploaded', who + ' 上传了「' + r.entry.name + '」', { type: 'file', parentId })
  persistHostSpace(sp)
  return r
}

// 成员上传一个文件到宿主（FileTransfer + 等待回执）
function shareUploadOne (sp, parentId, filePath, intent, entryId, rename) {
  return new Promise((resolve) => {
    if (!ft || !p2p) return resolve({ ok: false, error: '网络未就绪' })
    const reqId = crypto.randomUUID()
    const mid = crypto.randomUUID()
    const timer = setTimeout(() => { sharePending.delete(reqId); resolve({ ok: false, error: '上传超时' }) }, 30 * 60 * 1000)
    sharePending.set(reqId, { resolve, timer })
    const r = ft.sendFile(sp.hostUserId, filePath, 'share', mid, sp.spaceId, null, false, mid, Date.now(), { op: 'upload', spaceId: sp.spaceId, groupId: sp.groupId, parentId, intent, entryId, reqId, rename: !!rename })
    if (r && r.error) { clearTimeout(timer); sharePending.delete(reqId); resolve({ ok: false, error: r.error }) }
  })
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
// ---------------- 群共享空间 IPC ----------------
ipcMain.handle('share:list', (_e, groupId) => {
  if (!vault || !vault.unlocked) return []
  return vault.getShareSpacesByGroup(groupId).map(shareSpaceView)
})
ipcMain.handle('share:chooseDir', async () => {
  const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
  if (r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false }
  return { ok: true, dir: r.filePaths[0] }
})
ipcMain.handle('share:pickFiles', async () => {
  const r = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] })
  if (r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false }
  return { ok: true, paths: r.filePaths }
})
ipcMain.handle('share:pickFolder', async () => {
  const r = await dialog.showOpenDialog({ properties: ['openDirectory'] })
  if (r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false }
  return { ok: true, path: r.filePaths[0] }
})
ipcMain.handle('share:create', (_e, groupId, name, dir) => {
  if (!vault || !vault.unlocked || !p2p) return { ok: false, error: '应用未就绪' }
  const group = vault.getGroups().find((g) => g.id === groupId)
  if (!group) return { ok: false, error: '群聊不存在' }
  if (!(group.mem