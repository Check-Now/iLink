'use strict'

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, Notification, dialog, shell, desktopCapturer, screen, clipboard } = require('electron')
const path = require('path')
const os = require('os')
const fs = require('fs')
const crypto = require('crypto')
const { P2P, isTextTooLong, MAX_TEXT_CHARS } = require('./p2p')
const { Vault, PINNED_MESSAGE_CAP } = require('./vault')
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
let suppressTrayOnMinimize = false // 截图等程序性最小化仍复用该标记；最小化不再隐藏任务栏卡片
const pendingFiles = new Map()
const runtime = { minimizeToTray: true, notifyEnabled: true, notifyPreview: true, closeAction: 'ask', dnd: false }
const pinnedSyncLastRequest = new Map()
const PINNED_SYNC_THROTTLE_MS = 10000
const PINNED_THUMB_MAX_CHARS = 16 * 1024
const TEMP_IMAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000

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

function selfId () {
  const identity = vault && vault.unlocked ? vault.getIdentity() : null
  return (identity && identity.id) || (p2p && p2p.id) || ''
}

function emitGroups () {
  if (vault && vault.unlocked) sendToRenderer('store:groups', vault.getGroups())
}

function getGroupById (groupId) {
  if (!vault || !vault.unlocked || !groupId) return null
  return (vault.getGroups() || []).find((g) => g && g.id === groupId) || null
}

function groupMembers (group) {
  return Array.isArray(group && group.members) ? group.members : []
}

function isGroupMember (group, userId) {
  return !!(group && userId && groupMembers(group).includes(userId))
}

function isGroupOwner (group, userId) {
  return !!(group && userId && group.ownerId === userId)
}

function requireGroupMember (groupId, userId, notFoundError, notMemberError) {
  const group = getGroupById(groupId)
  if (!group) return { ok: false, error: notFoundError || '群聊不存在' }
  if (!isGroupMember(group, userId)) return { ok: false, error: notMemberError || '你不是群成员' }
  return { ok: true, group }
}

function requireGroupOwner (groupId, userId, notFoundError, notOwnerError) {
  const group = getGroupById(groupId)
  if (!group) return { ok: false, error: notFoundError || '群聊不存在' }
  if (!isGroupOwner(group, userId)) return { ok: false, error: notOwnerError || '只有群主可以操作' }
  return { ok: true, group }
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

  // 任务栏卡片规则：最小化只交给系统处理，保留任务栏卡片；关闭到托盘仍走 close 逻辑。
  mainWindow.on('minimize', () => { if (!suppressTrayOnMinimize) updateTrayState() })
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
  p2p.anonymous = !!settings.anonymous
  p2p.status = settings.statusText || ''
  p2p.presence = ['online', 'busy', 'away', 'dnd'].includes(settings.presence) ? settings.presence : 'online'
  p2p.on('peers', (list) => {
    if (vault && vault.unlocked) vault.upsertContacts((list || []).filter((p) => p.id))
    logPeerTransitions(list || [])
    emitPeers()
    outboxDrainAll() // 任一对端可达即尝试补发其发件箱（修复"恢复早于离线判定"导致不补发）
    requestPinnedListsFromPeers(list || [])
  })
  p2p.on('presence', (peer) => {
    if (peer && peer.id) outboxDrain(peer.id)
    if (peer && peer.id) requestPinnedListFromPeer(peer.id)
  })
  p2p.on('message', (m) => {
    if (m.scope === 'group') return
    if (m.room && vault && vault.unlocked && m.system === 'group-dismissed') {
      const known = getGroupById(m.room.id)
      const ownerId = (known && known.ownerId) || m.room.ownerId
      if (ownerId && ownerId === m.from) {
        removeLocalGroupData(m.room.id)
        emitGroups()
        sendToRenderer('share:changed', { groupId: m.room.id })
      }
      return
    }
    if (m.room && vault && vault.unlocked && m.system === 'member-removed' && !isGroupMember(m.room, selfId())) {
      removeLocalGroupData(m.room.id)
      emitGroups()
      sendToRenderer('share:changed', { groupId: m.room.id })
      return
    }
    if (m.room && vault && vault.unlocked) vault.upsertGroup(m.room)
    if (m.room && m.pin && vault && vault.unlocked) applyPinnedRoomEvent(m)
    // 共享空间广播（随群系统消息同步，仅聊天框展示）：更新本地已知空间/失效缓存快照
    if (m.system && typeof m.system === 'string' && m.system.indexOf('share-') === 0 && m.share && vault && vault.unlocked) {
      try { applyShareBroadcast(m) } catch (e) { logger.log('share', 'apply-broadcast-error', { e: String((e && e.message) || e).slice(0, 120) }) }
    }
    if (vault && vault.unlocked) vault.upsertContacts([{ id: m.from, name: m.name, avatar: m.avatar || null, lastSeen: Date.now() }])
    const convId = m.scope === 'room' && m.room ? m.room.id : m.from
    const muted = vault && vault.unlocked ? (vault.getSettings().muted || []).includes(convId) : false
    const mutedByMention = muted && messageMentionsSelf(m)
    if (!m.burn && vault && vault.unlocked) {
      vault.appendMessage(convId, m)
    }
    sendToRenderer('p2p:message', m)
    if (m.room) emitGroups()
    // 群头像更新、共享空间广播、取消置顶只保留聊天框内文字，不闪任务栏、不发系统通知
    const silent = m.system === 'avatar-changed' || m.system === 'message_unpinned' || (typeof m.system === 'string' && m.system.indexOf('share-') === 0)
    if (!silent && (!muted || mutedByMention) && !runtime.dnd && mainWindow && !mainWindow.isFocused()) {
      try { mainWindow.flashFrame(true) } catch (_) {}
    }
    if (!silent && mutedByMention && !runtime.dnd && mainWindow && !mainWindow.isFocused()) startTrayFlash()
    // 窗口隐藏/最小化时走系统通知 + 托盘图标闪烁，否则交给渲染层 toast
    if (!silent && (!muted || mutedByMention) && mainWindow && (!mainWindow.isVisible() || mainWindow.isMinimized())) {
      const body = runtime.notifyPreview && !m.burn ? (m.text || '') : '收到新消息'
      notify(localDisplayNameForId(m.from, m.name || 'iLink'), body)
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
    const group = getGroupById(r.roomId)
    if (!group || group.ownerId !== r.from) return // 仅接受群主发送的头像更新
    vault.upsertGroup({ ...group, avatar: r.avatar })
    emitGroups()
  })
  p2p.on('nudge', (n) => {
    sendToRenderer('msg:nudge', { from: n.from, text: n.text || '' })
    const muted = vault && vault.unlocked ? (vault.getSettings().muted || []).includes(n.from) : false
    if (!muted && !runtime.dnd && mainWindow) { try { mainWindow.flashFrame(true) } catch (_) {} }
  })
  p2p.on('share', (msg) => { try { onShareSignal(msg) } catch (e) { logger.log('share', 'signal-error', { e: String((e && e.message) || e).slice(0, 120) }) } })
  p2p.on('pin', (msg) => { try { onPinnedSignal(msg) } catch (e) { logger.log('pin', 'signal-error', { e: String((e && e.message) || e).slice(0, 120) }) } })
  p2p.on('ready', (self) => { sendToRenderer('p2p:ready', self); emitPeers() })
  p2p.on('neterror', (e) => { sendToRenderer('p2p:neterror', e); logger.log('net', 'neterror', { e: String(e).slice(0, 200) }) })
  p2p.on('reconnect', (r) => logger.log('net', 'reconnect', { reason: (r && r.reason) || '' }))
  p2p.start()
  // 离线发件箱持久化在 vault；对端在 presence 中可达时由 outboxDrainAll 自动补发（文本+文件）

  ft = new FileTransfer({
    id: id.id, pub: keys.pub, priv: keys.priv,
    resolvePeer: (pid) => p2p && p2p.peers.get(pid),
    ownName: () => (p2p ? p2p.displayName() : ''),
  })
  ft.on('incoming', (info) => sendToRenderer('file:incoming', info))
  ft.on('progress', (p) => { sendToRenderer('file:progress', { mid: p.mid, received: p.received, size: p.size, dir: 'in' }); if (shareXferMids.has(p.mid)) sendToRenderer('share:progress', { mid: p.mid, received: p.received, size: p.size, dir: 'in' }) })
  ft.on('send-progress', (p) => { sendToRenderer('file:progress', { mid: p.mid, received: p.sent, size: p.size, dir: 'out' }); if (shareXferMids.has(p.mid)) sendToRenderer('share:progress', { mid: p.mid, received: p.sent, size: p.size, dir: 'out' }) })
  ft.on('sent', (p) => {
    inFlight.delete(p && p.mid)
    if (p) shareXferMids.delete(p.mid)
    // 文件经 TCP 送达 → 移出发件箱、标记已送达（仅当确为发件箱条目）
    if (vault && vault.unlocked && p && p.toId && (vault.getOutbox()[p.toId] || []).some((x) => x.mid === p.mid)) {
      vault.outboxRemove(p.toId, p.mid)
      vault.setMessageStatus(p.toId, p.mid, 'sent')
    }
    sendToRenderer('file:sent', p)
  })
  ft.on('failed', (p) => {
    inFlight.delete(p && p.mid)
    if (p) shareXferMids.delete(p.mid)
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
  inFlight.clear()
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

function purgeTempImages () {
  try {
    const dir = os.tmpdir()
    const now = Date.now()
    for (const f of fs.readdirSync(dir)) {
      if (!/^ilink-(shot|paste)-\d+\.png$/.test(f)) continue
      const fp = path.join(dir, f)
      try { if (now - fs.statSync(fp).mtimeMs > TEMP_IMAGE_TTL_MS) fs.unlinkSync(fp) } catch (_) {}
    }
  } catch (_) {}
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
  if (info && info.share && info.share.op) { Promise.resolve().then(() => onShareFileDone(info)).catch((e) => { logger.log('share', 'file-done-error', { e: String((e && e.message) || e).slice(0, 120) }); try { fs.unlinkSync(info.tempPath) } catch (_) {} }); return }
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
      const currentRoom = getGroupById(it.roomId)
      const room = currentRoom || it.room
      if (!room || (!currentRoom && !it.allowMissingRoom)) { vault.outboxRemove(peerId, it.mid); continue } // 群已删/已退群
      if (currentRoom && !isGroupMember(currentRoom, peerId) && !it.allowNonMember) { vault.outboxRemove(peerId, it.mid); continue }
      inFlight.add(it.mid)
      const r = p2p.sendRoomMember(peerId, room, it.msgMid, it.mid, it.text, it.opts)
      if (!r || !r.ok) inFlight.delete(it.mid)
    } else if (it.kind === 'roomfile') {
      // 群聊离线文件补达：用 did(it.mid) 作 TCP 传输 mid（每成员唯一，避免同文件多成员串号），复用私聊文件确认路径
      const currentRoom = getGroupById(it.roomId)
      const room = currentRoom || it.room
      if (!room || (!currentRoom && !it.allowMissingRoom)) { vault.outboxRemove(peerId, it.mid); continue }
      if (currentRoom && !isGroupMember(currentRoom, peerId) && !it.allowNonMember) { vault.outboxRemove(peerId, it.mid); continue }
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
    members: Array.from(new Set(groupMembers(room))).filter(Boolean),
  }
}

function roomDeliveryTargets (room, opts) {
  const ids = new Set(groupMembers(room))
  for (const id of ((opts && opts.extraRecipients) || [])) ids.add(id)
  ids.delete(selfId())
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
      allowMissingRoom: system === 'member-left' || system === 'group-dismissed',
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

function removeLocalGroupData (groupId) {
  if (!vault || !vault.unlocked || !groupId) return
  const spaces = vault.getShareSpacesByGroup ? vault.getShareSpacesByGroup(groupId) : []
  for (const sp of spaces) {
    shareHosts.delete(sp.spaceId)
    vault.removeShareSpace(sp.spaceId)
  }
  vault.removeGroup(groupId)
  vault.clearConversation(groupId)
  vault.setDraft(groupId, '')
}

// ============================ 群共享空间（纯 P2P，无中心服务器）============================
// 宿主端：本机持有 ShareStore（磁盘 meta + 物理文件）；成员端：缓存目录快照，离线只读。
// 控制信令走 p2p.sendShare 加密单播请求/响应；文件内容走 FileTransfer TCP（复用 sha256/.part/续传）。
const shareHosts = new Map()       // spaceId -> ShareStore（仅本机作为宿主的空间）
const sharePending = new Map()     // reqId -> { resolve, timer }  控制信令/上传等待响应
const shareDownloads = new Map()   // transferMid -> { resolve, timer, savePath }  下载等待落地
const shareEarlyDownloads = new Map() // transferMid -> done info，处理下载完成早于 pending 登记的竞态
const shareXferMids = new Set()     // 共享空间相关传输 mid，用于单独上报 share:progress 进度
const SHARE_MAX_BYTES = 5 * 1024 * 1024 * 1024 // 群文件单文件上限 5GB
function shareOversize (fp) { try { return fs.statSync(fp).size > SHARE_MAX_BYTES } catch (_) { return false } }

function shareDataRoot () { return path.join(resolveDataDir(), 'group_shares') }
function defaultSpaceRoot (groupId, spaceId) {
  const safeGroup = String(groupId || 'group').replace(/[\\/:*?"<>|]/g, '_')
  const safeSpace = String(spaceId || 'space').replace(/[\\/:*?"<>|]/g, '_')
  return path.join(shareDataRoot(), safeGroup, safeSpace)
}
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

// 群空间删除权限：仅空间创建者。
function shareCanDeleteSpace (sp, operatorId) {
  if (!sp || !operatorId) return false
  return operatorId === sp.createdBy
}
function shareGroup (sp) {
  return sp ? getGroupById(sp.groupId) : null
}
function shareIsGroupMember (sp, operatorId) {
  const group = shareGroup(sp)
  return isGroupMember(group, operatorId)
}
function safeShareRelativePath (rel, fallback) {
  const parts = String(rel || '').split(/[\\/]+/).filter(Boolean).map((part) => safeFileName(part, 'item')).filter(Boolean)
  return parts.length ? parts.join(path.sep) : safeFileName(fallback || 'download')
}
async function copyShareDownloadFiles (files, saveDir) {
  const out = []
  for (const f of files || []) {
    const rel = safeShareRelativePath(f.relativePath || f.fileName, f.fileName)
    const dest = uniquePath(path.join(saveDir, rel))
    await fs.promises.mkdir(path.dirname(dest), { recursive: true })
    await fs.promises.copyFile(f.abs, dest)
    out.push({ path: dest, fname: path.basename(dest), entryId: f.entryId })
  }
  return out
}
function makeShareDownloadWaiter (transfers, saveDir) {
  return new Promise((resolve) => {
    if (!transfers.length) return resolve({ ok: true, files: [] })
    const files = []
    let done = 0; let fail = 0; let settled = false
    const finish = () => {
      if (settled || done + fail < transfers.length) return
      settled = true
      resolve({ ok: fail === 0, files, failed: fail, error: fail ? '部分文件下载失败' : '' })
    }
    for (const t of transfers) {
      const rel = safeShareRelativePath(t.relativePath || t.fname, t.fname)
      const saveTo = uniquePath(path.join(saveDir, rel))
      const timer = setTimeout(() => {
        shareXferMids.delete(t.mid)
        shareDownloads.delete(t.mid)
        fail++
        finish()
      }, 30 * 60 * 1000)
      shareXferMids.add(t.mid)
      registerShareDownload(t.mid, {
        timer,
        saveTo,
        resolve: (r) => {
          if (r && r.ok) { done++; files.push(r) } else fail++
          finish()
        },
      })
    }
  })
}
function registerShareDownload (mid, pending) {
  shareDownloads.set(mid, pending)
  const early = shareEarlyDownloads.get(mid)
  if (early) {
    shareEarlyDownloads.delete(mid)
    if (early.__earlyTimer) clearTimeout(early.__earlyTimer)
    delete early.__earlyTimer
    setImmediate(() => onShareFileDone(early))
  }
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
  // 静默同步：宿主在目录/空间变更后推送，成员同步本地状态并刷新面板，不产生聊天消息、不弹通知
  if (msg.kind === 'sync') {
    if (msg.spaceId) {
      if (msg.op === 'deleted') vault.removeShareSpace(msg.spaceId) // 群文件已被宿主删除 → 本地移除
      else {
        vault.clearShareSnapshot(msg.spaceId)
        const sp = vault.getShareSpace(msg.spaceId) // 更新成员侧文件数/更新时间
        if (sp && typeof msg.fileCount === 'number') vault.upsertShareSpace({ ...sp, fileCount: msg.fileCount, updatedAt: msg.updatedAt || sp.updatedAt })
      }
      sendToRenderer('share:changed', { spaceId: msg.spaceId })
    }
    return
  }
  if (msg.kind !== 'req') return
  const data = msg.data || {}
  const store = shareHosts.get(data.spaceId)
  const reply = (d) => { if (p2p) p2p.sendShare(msg.from, { kind: 'res', reqId: msg.reqId, action: msg.action, data: d }) }
  if (!store) return reply({ ok: false, gone: true, error: '群文件不存在或已被删除' })
  const sp = vault.getShareSpace(data.spaceId)
  const group = shareGroup(sp)
  if (!isGroupMember(group, msg.from)) return reply({ ok: false, error: '非群成员，无权访问' })
  try {
    if (msg.action === 'space_info') return reply({ ok: true, info: store.spaceInfo() })
    if (msg.action === 'dir_list') return reply(store.listDir(data.parentId))
    if (msg.action === 'search') return reply(store.search(data.query))
    if (msg.action === 'folder_create') {
      const r = store.createFolder(msg.from, data.parentId, data.name)
      if (r.ok) persistHostSpace(sp)
      return reply(r)
    }
    if (msg.action === 'rename') {
      const r = store.rename(msg.from, data.entryId, data.newName)
      if (r.ok) persistHostSpace(sp)
      return reply(r)
    }
    if (msg.action === 'delete') {
      const r = store.remove(msg.from, data.entryId)
      if (r.ok) persistHostSpace(sp)
      return reply(r)
    }
    if (msg.action === 'download') {
      const dl = store.downloadList(data.entryId)
      if (!dl.ok) return reply(dl)
      const transfers = (dl.files || []).map((f) => ({ mid: crypto.randomUUID(), entryId: f.entryId, fname: f.fileName, size: f.size, hash: f.hash, relativePath: f.relativePath }))
      reply({ ok: true, type: dl.type, rootName: dl.rootName, transfers })
      for (let i = 0; i < transfers.length; i++) {
        const t = transfers[i]
        const f = dl.files[i]
        ft.sendFile(msg.from, f.abs, 'share', t.mid, sp.spaceId, null, false, t.mid, Date.now(), { op: 'download', spaceId: sp.spaceId, entryId: f.entryId, fname: f.fileName, relativePath: f.relativePath })
      }
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
  notifyShareSync(sp) // 静默推送在线成员刷新面板（不发聊天消息、不弹通知）
}

// 宿主目录/空间变更后，向在线群成员单播静默同步信令（best-effort；离线成员下次打开/刷新时自然拉取最新）
// op: '' 目录变更(失效缓存并刷新) / 'deleted' 群文件已删除(成员本地移除该空间)
function notifyShareSync (sp, op) {
  if (!p2p || !sp) return
  const group = shareGroup(sp)
  if (!group) return
  const store = shareHosts.get(sp.spaceId)
  const info = store ? store.spaceInfo() : null // 随同步带上最新文件数/更新时间，成员据此更新列表
  const reqId = crypto.randomUUID() // 同一次变更复用一个 reqId，接收端按 reqId 去重避免重复刷新
  for (const id of groupMembers(group)) {
    if (id === selfId()) continue
    p2p.sendShare(id, { kind: 'sync', reqId, spaceId: sp.spaceId, op: op || '', fileCount: info ? info.fileCount : undefined, updatedAt: info ? info.updatedAt : undefined })
  }
}

// 文件传输完成（共享空间）：上传→宿主入库并广播+回执；下载→成员落地
async function onShareFileDone (info) {
  const sh = info.share || {}
  if (sh.op === 'upload') {
    const store = shareHosts.get(sh.spaceId)
    const sp = vault.getShareSpace(sh.spaceId)
    if (!store || !sp) { try { fs.unlinkSync(info.tempPath) } catch (_) {} ; if (sh.reqId && p2p) p2p.sendShare(info.from, { kind: 'res', reqId: sh.reqId, action: 'upload', data: { ok: false, error: '群文件不存在' } }); return }
    // hash 复用传输层已校验的 SHA-256，避免对大文件二次同步哈希；落盘异步进行，不阻塞主进程
    const r = await store.placeUpload({ fileName: info.fname, tempPath: info.tempPath, uploadedBy: info.from, parentId: sh.parentId, rename: sh.rename, hash: info.sha256 })
    if (!r.ok) { try { fs.unlinkSync(info.tempPath) } catch (_) {} }
    if (sh.reqId && p2p) p2p.sendShare(info.from, { kind: 'res', reqId: sh.reqId, action: 'upload', data: r })
    if (r.ok) {
      persistHostSpace(sp)
      logger.log('share', 'upload_file', { spaceId: sp.spaceId, by: info.from, name: r.entry.name })
    }
    return
  }
  if (sh.op === 'download') {
    const key = info.transferMid || info.mid
    const pend = shareDownloads.get(key)
    if (!pend) {
      const early = { ...info }
      early.__earlyTimer = setTimeout(() => {
        const cur = shareEarlyDownloads.get(key)
        if (cur) {
          shareEarlyDownloads.delete(key)
          try { fs.unlinkSync(cur.tempPath) } catch (_) {}
        }
      }, 60 * 1000)
      shareEarlyDownloads.set(key, early)
      return
    }
    shareXferMids.delete(key)
    try {
      let dest
      if (pend && pend.saveTo) {
        // 用户已在“另存为”对话框选定位置（含同名覆盖确认）
        dest = pend.saveTo
        const pdir = path.dirname(dest)
        if (!fs.existsSync(pdir)) fs.mkdirSync(pdir, { recursive: true })
      } else {
        const s = vault.getSettings()
        const dir = s.downloadDir && fs.existsSync(s.downloadDir) ? s.downloadDir : app.getPath('downloads')
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
        dest = uniquePath(path.join(dir, safeFileName(sh.fname || info.fname, 'file-' + info.mid)))
      }
      moveFile(info.tempPath, dest)
      logger.log('share', 'download', { spaceId: sh.spaceId, fname: path.basename(dest) })
      sendToRenderer('share:downloaded', { spaceId: sh.spaceId, entryId: sh.entryId, path: dest, fname: path.basename(dest) })
      if (pend) { clearTimeout(pend.timer); shareDownloads.delete(key); pend.resolve({ ok: true, path: dest, fname: path.basename(dest) }) }
    } catch (e) {
      try { fs.unlinkSync(info.tempPath) } catch (_) {}
      if (pend) { clearTimeout(pend.timer); shareDownloads.delete(key); pend.resolve({ ok: false, error: String((e && e.message) || e) }) }
      sendToRenderer('share:downloadFailed', { spaceId: sh.spaceId, error: String((e && e.message) || e) })
    }
  }
}

// 广播群文件事件（复用群聊系统消息可靠投递，仅聊天框展示，不弹通知）。
// 按需求：仅「创建群文件」广播到群聊，其余操作不再广播。
function broadcastShare (sp, system, text, payload) {
  if (system !== 'share-space-created') return // 仅“创建群文件”在聊天框广播；上传/新建/重命名/删除等不发群消息
  const group = shareGroup(sp)
  if (!group) return
  sendRoomStored(group, text, { system, share: { ...(payload || {}), spaceId: sp.spaceId, groupId: sp.groupId, name: sp.name, hostUserId: sp.hostUserId, hostDeviceId: sp.hostDeviceId, createdBy: sp.createdBy, createdAt: sp.createdAt } }, true)
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

// 本机宿主自传：直接把源文件异步复制进库（copyOnly 保留用户原文件），不再额外做一次同步临时拷贝
async function hostSelfUpload (sp, parentId, filePath, rename) {
  const store = shareHosts.get(sp.spaceId)
  if (!store) return { ok: false, error: '本机存储未加载' }
  // 本机上传是本地复制（无网络传输事件），用流式复制进度上报 share:progress，让宿主也看到进度条
  const onProgress = (b, total) => sendToRenderer('share:progress', { mid: 'self', received: b, size: total || 1, dir: 'out' })
  const r = await store.placeUpload({ fileName: path.basename(filePath), srcPath: filePath, copyOnly: true, uploadedBy: selfId(), parentId, rename, onProgress })
  if (!r.ok) return r
  sendToRenderer('share:progress', { mid: 'self', received: 1, size: 1, dir: 'out' }) // 100% → 渲染层清除进度条
  persistHostSpace(sp)
  return r
}

// 成员上传一个文件到宿主（FileTransfer + 等待回执）
function shareUploadOne (sp, parentId, filePath, rename) {
  return new Promise((resolve) => {
    if (!ft || !p2p) return resolve({ ok: false, error: '网络未就绪' })
    const reqId = crypto.randomUUID()
    const mid = crypto.randomUUID()
    shareXferMids.add(mid) // 标记为共享空间传输，进度走 share:progress
    const timer = setTimeout(() => { sharePending.delete(reqId); resolve({ ok: false, error: '上传超时' }) }, 30 * 60 * 1000)
    sharePending.set(reqId, { resolve, timer })
    const r = ft.sendFile(sp.hostUserId, filePath, 'share', mid, sp.spaceId, null, false, mid, Date.now(), { op: 'upload', spaceId: sp.spaceId, groupId: sp.groupId, parentId, reqId, rename: !!rename })
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
    const room = getGroupById(toId)
    if (!room) return []
    const ownId = selfId()
    const targets = groupMembers(room).filter((id) => id !== ownId)
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
      const msg = { mid, type: 'file', from: selfId(), name: p2p.name, fname, size, mime, scope, to: toId, batch: batch || null, sticker, path: fp, ts, self: true, status: null }
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
    const msg = { mid, type: 'file', from: selfId(), name: p2p.name, fname, size, mime, scope: 'private', to: toId, batch: batch || null, sticker, path: fp, ts: Date.now(), self: true, status: online ? 'sending' : 'queued' }
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
ipcMain.handle('ui:attention', (e, opts) => {
  if (runtime.dnd) return false
  const win = windowFromEvent(e) || mainWindow
  const o = opts || {}
  try {
    if (win && !win.isDestroyed() && o.flash !== false) win.flashFrame(true)
    if (o.trayFlash !== false) startTrayFlash()
  } catch (_) {}
  return true
})

ipcMain.handle('p2p:typing', (_e, toId) => {
  if (!p2p) return
  const room = getGroupById(toId)
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
  if (vault && vault.unlocked) vault.addReaction(conv, mid, emoji, selfId())
  p2p.sendReaction(scope, toId, mid, emoji)
  return { ok: true }
})
ipcMain.handle('msg:pin', (_e, groupId, message) => {
  if (!p2p || !vault || !vault.unlocked) return { ok: false, error: '应用尚未就绪' }
  const guard = requireGroupMember(groupId, selfId(), '群聊不存在', '你不是群成员，不能置顶消息')
  if (!guard.ok) return guard
  const group = guard.group
  const mid = message && message.mid
  if (!mid) return { ok: false, error: '消息不存在' }
  const stored = ((vault.getHistory() || {})[groupId] || []).find((m) => m && m.mid === mid)
  const m = stored || message
  if (!m || m.system) return { ok: false, error: '系统消息不能置顶' }
  if (m.recalled) return { ok: false, error: '该消息已撤回，不能置顶' }
  if (m.burn) return { ok: false, error: '阅后即焚消息不能置顶' }
  if (m.type === 'file-offer') return { ok: false, error: '文件未接收完成，不能置顶' }
  const snapshot = buildPinnedSnapshot(m)
  const now = Date.now()
  const pin = {
    pinId: 'pin:' + crypto.randomUUID(),
    groupId,
    messageId: mid,
    messageSnapshot: snapshot,
    senderId: snapshot.senderId,
    senderName: snapshot.senderName,
    messageType: snapshot.messageType,
    contentPreview: snapshot.contentPreview,
    pinnedBy: selfId(),
    pinnedByName: currentDisplayName(),
    pinnedAt: now,
    status: 'pinned',
    updatedAt: now,
  }
  const res = vault.addPinnedMessage(pin)
  if (!res || !res.ok) return { ok: false, error: (res && res.error) || '置顶失败', max: PINNED_MESSAGE_CAP }
  emitPinnedMessages()
  sendToRenderer('msg:pinned', res.pin)
  sendRoomStored(group, currentDisplayName() + '置顶了一条消息', { system: 'message_pinned', pin: { event: 'message_pinned', record: publicPinnedRecord(res.pin) } }, true)
  return { ok: true, pin: res.pin, max: PINNED_MESSAGE_CAP }
})
ipcMain.handle('msg:unpin', (_e, groupId, pinId) => {
  if (!p2p || !vault || !vault.unlocked) return { ok: false, error: '应用尚未就绪' }
  const guard = requireGroupMember(groupId, selfId(), '群聊不存在', '你不是群成员，不能取消置顶')
  if (!guard.ok) return guard
  const group = guard.group
  const res = vault.unpinMessage(groupId, pinId, selfId(), currentDisplayName())
  if (!res || !res.ok) return { ok: false, error: (res && res.error) || '取消置顶失败' }
  emitPinnedMessages()
  sendToRenderer('msg:unpinned', res.pin)
  sendRoomStored(group, currentDisplayName() + '取消了一条置顶消息', { system: 'message_unpinned', pin: { event: 'message_unpinned', record: publicPinnedRecord(res.pin) } }, true)
  return { ok: true, pin: res.pin }
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
ipcMain.handle('store:getRecent', () => (vault && vault.unlocked ? vault.getRecent() : {}))
ipcMain.handle('store:setRecent', (_e, convId, meta) => { if (vault && vault.unlocked) vault.setRecent(convId, meta) })
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
ipcMain.handle('store:getPinnedMessages', (_e, groupId) => {
  if (!vault || !vault.unlocked) return groupId ? [] : {}
  return groupId ? vault.getPinnedMessages(groupId) : vault.getPinnedMessagesByGroup()
})
ipcMain.handle('store:createGroup', (_e, name, members) => {
  if (!vault || !vault.unlocked) return null
  const ownId = selfId()
  const group = vault.createGroup(name || '群聊', Array.from(new Set([ownId, ...(members || [])])), ownId)
  if (p2p) {
    sendRoomStored(group, '群聊已创建', { system: 'room-created' }, true)
  }
  emitGroups()
  return group
})
function displayNameForId (id) {
  if (!id) return ''
  const self = vault && vault.unlocked ? vault.getIdentity() : null
  if (self && self.id === id) return self.name || '?'
  const peer = mergedPeers().find((p) => p.id === id)
  return (peer && peer.name) || String(id).slice(0, 6)
}

function localDisplayNameForId (id, fallback) {
  if (!id) return fallback || ''
  const self = vault && vault.unlocked ? vault.getIdentity() : null
  if (self && self.id === id) return self.name || fallback || '?'
  const peer = mergedPeers().find((p) => p.id === id)
  return (peer && (peer.remark || peer.name)) || fallback || String(id).slice(0, 6)
}

function currentDisplayName () {
  if (p2p && typeof p2p.displayName === 'function') return p2p.displayName()
  const id = vault && vault.unlocked ? vault.getIdentity() : null
  return (id && id.name) || '我'
}

function messageMentionsSelf (m) {
  if (!m || m.scope !== 'room' || !m.room || !m.text) return false
  const text = String(m.text || '')
  const names = new Set(['所有人', '全体成员', 'all', 'everyone'])
  const current = currentDisplayName()
  const identity = vault && vault.unlocked ? vault.getIdentity() : null
  if (current) names.add(String(current).trim())
  if (identity && identity.name) names.add(String(identity.name).trim())
  const tokens = text.match(/@[^\s@]{1,32}/g) || []
  return tokens.some((tok) => {
    const name = tok.slice(1).trim().replace(/[，,。.!！?？:：;；）)]$/g, '')
    if (!name) return false
    const low = name.toLowerCase()
    for (const it of names) {
      if (it && (name === it || low === String(it).toLowerCase())) return true
    }
    return false
  })
}

function canUseGroupPinnedMessages (group, userId) {
  return isGroupMember(group, userId)
}

function pinnedMessageTypeOf (m) {
  if (!m) return 'text'
  if (m.type === 'file' || m.type === 'file-offer') return (m.mime || '').indexOf('image/') === 0 ? 'image' : 'file'
  const text = (m.text || '').toString()
  if (/```/.test(text)) return 'code'
  return m.type || 'text'
}

function pinnedContentPreview (m) {
  const type = pinnedMessageTypeOf(m)
  if (type === 'image') return '[图片]'
  if (type === 'file') return '[文件] ' + (m.fname || '未命名文件')
  if (type === 'code') {
    const body = (m.text || '').toString().replace(/```/g, '').trim()
    const s = body ? ('[代码] ' + body) : '[代码]'
    return s.length > 80 ? s.slice(0, 80) + '…' : s
  }
  const text = (m.text || '').toString().trim()
  if (!text) return '[消息]'
  return text.length > 80 ? text.slice(0, 80) + '…' : text
}

function pinnedImageThumbnail (m) {
  if (!m || pinnedMessageTypeOf(m) !== 'image') return ''
  try {
    let img = null
    if (m.path && fs.existsSync(m.path)) img = nativeImage.createFromPath(m.path)
    if ((!img || img.isEmpty()) && m.dataUrl) img = nativeImage.createFromDataURL(String(m.dataUrl))
    if (!img || img.isEmpty()) return ''
    for (const size of [180, 140, 96]) {
      const thumb = img.resize({ width: size, quality: 'good' })
      const dataUrl = 'data:image/jpeg;base64,' + thumb.toJPEG(64).toString('base64')
      if (dataUrl.length <= PINNED_THUMB_MAX_CHARS) return dataUrl
    }
  } catch (_) {}
  return ''
}

function publicPinnedRecord (pin) {
  if (!pin) return pin
  const out = JSON.parse(JSON.stringify(pin))
  if (out.messageSnapshot) delete out.messageSnapshot.localPath
  return out
}

function publicPinnedGroups (groups) {
  return (groups || []).map((g) => ({ ...g, pins: (g.pins || []).map(publicPinnedRecord) }))
}

function buildPinnedSnapshot (m) {
  const type = pinnedMessageTypeOf(m)
  const originalContent = type === 'text' || type === 'code'
    ? (m.text || '').toString()
    : { fileName: m.fname || '', fileSize: m.size || 0, mime: m.mime || '' }
  const snap = {
    messageId: m.mid,
    senderId: m.from || '',
    senderName: m.name || displayNameForId(m.from) || '',
    messageType: type,
    contentPreview: pinnedContentPreview(m),
    originalContent,
    sentAt: m.ts || Date.now(),
  }
  if (m.fname) snap.fileName = m.fname
  if (m.size) snap.fileSize = m.size
  if (m.mime) snap.mime = m.mime
  if (type === 'image') {
    const thumb = pinnedImageThumbnail(m)
    if (thumb) snap.thumbnailDataUrl = thumb
  }
  if ((type === 'image' || type === 'file') && m.path && fs.existsSync(m.path)) snap.localPath = m.path
  return snap
}

function emitPinnedMessages () {
  if (!vault || !vault.unlocked) return
  sendToRenderer('msg:pinned-list', vault.getPinnedMessagesByGroup())
}

function applyPinnedRoomEvent (m) {
  if (!m || !m.room || !m.pin || !vault || !vault.unlocked || !p2p) return
  if (!canUseGroupPinnedMessages(m.room, selfId()) || !canUseGroupPinnedMessages(m.room, m.from)) return
  const event = m.pin.event || m.system
  const record = m.pin.record || m.pin.pin || null
  if (!record || !record.pinId || !record.groupId) return
  if (event !== 'message_pinned' && event !== 'message_unpinned') return
  const res = vault.mergePinnedMessages([record])
  if (res.changed) {
    emitPinnedMessages()
    sendToRenderer(event === 'message_pinned' ? 'msg:pinned' : 'msg:unpinned', record)
  }
}

function pinnedGroupIdsForPeer (peerId) {
  if (!vault || !vault.unlocked || !p2p || !peerId) return []
  return (vault.getGroups() || [])
    .filter((g) => canUseGroupPinnedMessages(g, selfId()) && canUseGroupPinnedMessages(g, peerId))
    .map((g) => g.id)
}

function requestPinnedListFromPeer (peerId) {
  if (!p2p || !vault || !vault.unlocked || !peerId || !p2p.reachable(peerId)) return
  const groupIds = pinnedGroupIdsForPeer(peerId)
  if (!groupIds.length) return
  const key = peerId + ':' + groupIds.sort().join(',')
  const now = Date.now()
  if (now - (pinnedSyncLastRequest.get(key) || 0) < PINNED_SYNC_THROTTLE_MS) return
  pinnedSyncLastRequest.set(key, now)
  p2p.sendPinSignal(peerId, { kind: 'pinned_message_list_request', reqId: 'pinreq:' + crypto.randomUUID(), groupIds, ts: now })
}

function requestPinnedListsFromPeers (peers) {
  for (const peer of peers || []) {
    if (peer && peer.id && peer.online) requestPinnedListFromPeer(peer.id)
  }
}

function onPinnedSignal (msg) {
  if (!msg || !msg.from || !vault || !vault.unlocked || !p2p) return
  if (msg.kind === 'pinned_message_list_request') {
    const allowed = new Set(pinnedGroupIdsForPeer(msg.from))
    const requested = Array.isArray(msg.groupIds) && msg.groupIds.length ? msg.groupIds.filter((id) => allowed.has(id)) : Array.from(allowed)
    const groups = publicPinnedGroups(vault.getPinnedSyncState(requested))
    p2p.sendPinSignal(msg.from, { kind: 'pinned_message_list_response', reqId: msg.reqId || ('pinres:' + crypto.randomUUID()), groups, ts: Date.now() })
    return
  }
  if (msg.kind !== 'pinned_message_list_response') return
  const allowed = new Set(pinnedGroupIdsForPeer(msg.from))
  const pins = []
  for (const g of msg.groups || []) {
    if (!g || !allowed.has(g.groupId)) continue
    for (const p of g.pins || []) pins.push(p)
  }
  const res = vault.mergePinnedMessages(pins)
  if (res.changed) emitPinnedMessages()
}

ipcMain.handle('store:addGroupMembers', (_e, groupId, memberIds) => {
  if (!vault || !vault.unlocked || !p2p) return { ok: false, error: '应用尚未就绪' }
  const guard = requireGroupMember(groupId, selfId(), '群聊不存在', '你不是群成员，不能添加成员')
  if (!guard.ok) return guard
  const group = guard.group
  const known = new Set(mergedPeers().map((p) => p.id))
  const incoming = Array.from(new Set((memberIds || []).map((id) => String(id || '').trim()).filter(Boolean)))
  const missing = incoming.filter((id) => !known.has(id))
  if (missing.length) return { ok: false, error: '用户不存在: ' + missing.map(displayNameForId).join(', ') }
  const existing = new Set(groupMembers(group))
  const added = incoming.filter((id) => !existing.has(id))
  if (!added.length) return { ok: false, error: '成员已在群聊中' }
  const updated = vault.upsertGroup({ ...group, members: [...groupMembers(group), ...added] })
  const text = added.map(displayNameForId).join(', ') + ' 加入了群聊'
  sendRoomStored(updated, text, { system: 'member-added' }, true)
  emitGroups()
  return { ok: true, group: updated, added }
})
ipcMain.handle('store:removeGroupMember', (_e, groupId, memberId) => {
  if (!vault || !vault.unlocked || !p2p) return { ok: false, error: '应用尚未就绪' }
  const guard = requireGroupOwner(groupId, selfId(), '群聊不存在', '只有群主可以移出成员')
  if (!guard.ok) return guard
  const group = guard.group
  memberId = String(memberId || '').trim()
  if (!memberId || !isGroupMember(group, memberId)) return { ok: false, error: '成员不存在' }
  if (memberId === group.ownerId) return { ok: false, error: '不能移出群主' }
  const updated = vault.upsertGroup({ ...group, members: groupMembers(group).filter((id) => id !== memberId) })
  const text = displayNameForId(memberId) + ' 已被群主移出群聊'
  sendRoomStored(updated, text, { system: 'member-removed', extraRecipients: [memberId] }, true)
  emitGroups()
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
  const guard = requireGroupOwner(groupId, selfId())
  if (!guard.ok) return null
  const group = guard.group
  const pub = avatar ? groupAvatarPayload(avatar) : null
  if (avatar && !pub) return null // 图片处理失败，不落空壳头像
  const next = vault.upsertGroup({ ...group, avatar: pub })
  p2p.sendRoomAvatar(next, pub)
  sendRoomStored(next, '更新了群头像', { system: 'avatar-changed' }, true)
  emitGroups()
  return next
})
// 退出群聊：通知其他成员（带更新后的成员表）；群主退出时自动移交给第一位成员，本地删除群记录
ipcMain.handle('store:leaveGroup', (_e, groupId) => {
  if (!vault || !vault.unlocked) return { ok: false }
  const group = getGroupById(groupId)
  if (!group) return { ok: false }
  const ownId = selfId()
  const rest = groupMembers(group).filter((id) => id !== ownId)
  if (p2p && rest.length) {
    const updated = { ...group, members: rest, ownerId: group.ownerId === ownId ? rest[0] : group.ownerId }
    sendRoomStored(updated, '退出了群聊', { system: 'member-left' }, false)
  }
  removeLocalGroupData(groupId)
  emitGroups()
  sendToRenderer('share:changed', { groupId })
  return { ok: true }
})
ipcMain.handle('store:dismissGroup', (_e, groupId) => {
  if (!vault || !vault.unlocked || !p2p) return { ok: false, error: '应用尚未就绪' }
  const guard = requireGroupOwner(groupId, selfId(), '群聊不存在', '只有群主可以解散群聊')
  if (!guard.ok) return guard
  const group = guard.group
  const res = sendRoomStored(group, '群聊已解散', { system: 'group-dismissed' }, false)
  if (!res || !res.ok) return res || { ok: false, error: '解散群聊失败' }
  removeLocalGroupData(groupId)
  emitGroups()
  sendToRenderer('share:changed', { groupId })
  return { ok: true }
})
ipcMain.handle('store:transferGroupOwner', (_e, groupId, ownerId) => {
  // 权限校验在主进程 + 领域层双重落实（前端限制不是安全边界）：
  // 仅现群主可转让；群须存在且本人仍是群主；新群主须为群成员且不能是现群主本人。
  if (!vault || !vault.unlocked) return { ok: false, error: '应用尚未就绪' }
  const ownId = selfId()
  const guard = requireGroupOwner(groupId, ownId, '群聊不存在或已解散', '仅群主可转让群主权限')
  if (!guard.ok) return guard
  const group = guard.group
  ownerId = String(ownerId || '').trim()
  if (!ownerId || !isGroupMember(group, ownerId)) return { ok: false, error: '新群主必须是当前群成员' }
  if (ownerId === group.ownerId) return { ok: false, error: '不能将群主转让给当前群主本人' }
  const updated = vault.transferGroupOwner(groupId, ownerId, ownId)
  if (!updated) return { ok: false, error: '转让失败' }
  if (p2p) {
    const name = (mergedPeers().find((p) => p.id === ownerId) || {}).name || '新群主'
    sendRoomStored(updated, '群主已转让给 ' + name, { system: 'owner-transferred' }, true)
  }
  emitGroups()
  return { ok: true, group: updated }
})
// ---------------- 群共享空间 IPC ----------------
ipcMain.handle('share:list', (_e, groupId) => {
  if (!vault || !vault.unlocked) return []
  const list = vault.getShareSpacesByGroup(groupId)
  // 后台向在线宿主拉取最新文件数/更新时间；仅在确有变化时通知刷新（避免 share:changed→list→info 循环）
  for (const sp of list) {
    if (sp.hostUserId === selfId() || !isSpaceOnline(sp)) continue
    shareRequest(sp.hostUserId, 'space_info', { spaceId: sp.spaceId }).then((r) => {
      if (!r || !r.ok || !r.info) return
      const prev = vault.getShareSpace(sp.spaceId)
      if (prev && (prev.fileCount !== r.info.fileCount || prev.updatedAt !== r.info.updatedAt)) {
        vault.upsertShareSpace({ ...prev, fileCount: r.info.fileCount, updatedAt: r.info.updatedAt })
        sendToRenderer('share:changed', { spaceId: sp.spaceId })
      }
    }).catch(() => {})
  }
  return list.map(shareSpaceView)
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
  const guard = requireGroupMember(groupId, selfId(), '群聊不存在', '你不是群成员')
  if (!guard.ok) return guard
  name = String(name || '').trim().slice(0, 60) || '共享空间'
  const spaceId = 'space:' + crypto.randomUUID()
  const rootPath = dir ? path.join(dir, String(spaceId).replace(/[\\/:*?"<>|]/g, '_')) : defaultSpaceRoot(groupId, spaceId)
  let store
  try { store = shareMod.ShareStore.create(rootPath, { spaceId, groupId, name, hostUserId: selfId(), hostDeviceId: selfDeviceId(), createdBy: selfId() }) } catch (e) { return { ok: false, error: '创建本地存储失败:' + ((e && e.message) || e) } }
  shareHosts.set(spaceId, store)
  const now = Date.now()
  const sp = { spaceId, groupId, name, hostUserId: selfId(), hostDeviceId: selfDeviceId(), hostIp: (p2p.getSelf() || {}).localIp || '', rootPath, createdBy: selfId(), createdAt: now, updatedAt: now, status: 'normal', fileCount: 0, isHost: true }
  vault.upsertShareSpace(sp)
  broadcastShare(sp, 'share-space-created', displayNameForId(selfId()) + ' 创建了群文件「' + name + '」', { type: 'space-created' })
  logger.log('share', 'create_space', { spaceId, groupId, name })
  sendToRenderer('share:changed', { spaceId })
  return { ok: true, space: shareSpaceView(sp) }
})
ipcMain.handle('share:deleteSpace', (_e, spaceId) => {
  if (!vault || !vault.unlocked) return { ok: false }
  const sp = vault.getShareSpace(spaceId)
  if (!sp) return { ok: false, error: '空间不存在' }
  if (!shareCanDeleteSpace(sp, selfId())) return { ok: false, error: '无权限（仅创建者可删除群文件）' }
  if (isHostSelf(sp)) {
    try {
      if (sp.rootPath) fs.rmSync(sp.rootPath, { recursive: true, force: true })
    } catch (e) {
      return { ok: false, error: '删除本地文件失败:' + ((e && e.message) || e) }
    }
    shareHosts.delete(spaceId)
  }
  notifyShareSync(sp, 'deleted') // 同步删除给所有在线成员（从其列表移除）
  vault.removeShareSpace(spaceId)
  sendToRenderer('share:changed', { spaceId })
  logger.log('share', 'delete_space', { spaceId, groupId: sp.groupId })
  return { ok: true }
})
ipcMain.handle('share:dir', async (_e, spaceId, parentId) => {
  if (!vault || !vault.unlocked) return { ok: false, error: '未就绪' }
  const sp = vault.getShareSpace(spaceId)
  if (!sp) return { ok: false, error: '共享空间不存在' }
  parentId = parentId || 'root'
  if (isHostSelf(sp)) {
    const store = shareHosts.get(spaceId)
    if (!store) return { ok: false, error: '本机存储未加载' }
    const r = store.listDir(parentId)
    if (r.ok) vault.setShareSnapshot(spaceId, parentId, r)
    return r
  }
  if (!isSpaceOnline(sp)) {
    const snap = vault.getShareSnapshot(spaceId, parentId)
    if (snap) return { ...snap, ok: true, offline: true, cached: true }
    return { ok: false, offline: true, error: '共享主机离线，暂时不可访问' }
  }
  const r = await shareRequest(sp.hostUserId, 'dir_list', { spaceId, parentId })
  // 宿主已删除该群文件（离线成员错过同步信令时的兜底清理）
  if (r && r.gone) { vault.removeShareSpace(spaceId); sendToRenderer('share:changed', { spaceId }) }
  if (r && r.ok) vault.setShareSnapshot(spaceId, parentId, r)
  return r
})
ipcMain.handle('share:search', async (_e, groupId, query, spaceId) => {
  if (!vault || !vault.unlocked) return { ok: false, error: '未就绪' }
  const q = String(query || '').trim()
  if (!q) return { ok: true, results: [] }
  const guard = requireGroupMember(groupId, selfId(), '你不是群成员', '你不是群成员')
  if (!guard.ok) return guard
  const spaces = (spaceId ? [vault.getShareSpace(spaceId)] : vault.getShareSpacesByGroup(groupId))
    .filter((sp) => sp && sp.groupId === groupId)
  const results = []
  const addResults = (sp, entries, extra) => {
    for (const e of entries || []) {
      results.push({
        ...e,
        ...(extra || {}),
        spaceId: sp.spaceId,
        spaceName: sp.name,
        space: shareSpaceView(sp),
      })
    }
  }
  for (const sp of spaces) {
    if (isHostSelf(sp)) {
      const store = shareHosts.get(sp.spaceId)
      const r = store ? store.search(q) : { ok: false }
      if (r && r.ok) addResults(sp, r.entries)
      continue
    }
    if (isSpaceOnline(sp)) {
      const r = await shareRequest(sp.hostUserId, 'search', { spaceId: sp.spaceId, query: q })
      if (r && r.gone) { vault.removeShareSpace(sp.spaceId); sendToRenderer('share:changed', { spaceId: sp.spaceId }); continue }
      if (r && r.ok) { addResults(sp, r.entries); continue }
    }
    addResults(sp, vault.searchShareSnapshots(groupId, q, sp.spaceId), { cached: true, offline: !isSpaceOnline(sp) })
  }
  return { ok: true, results }
})
ipcMain.handle('share:createFolder', async (_e, spaceId, parentId, name) => {
  const sp = vault.getShareSpace(spaceId)
  if (!sp) return { ok: false, error: '共享空间不存在' }
  if (!shareIsGroupMember(sp, selfId())) return { ok: false, error: '你不是群成员' }
  const chk = shareMod.checkSegment(name)
  if (!chk.ok) return { ok: false, error: chk.error } // 本地先校验非法字符/穿越，给即时反馈
  if (isHostSelf(sp)) {
    const r = shareHosts.get(spaceId).createFolder(selfId(), parentId, name)
    if (r.ok) persistHostSpace(sp)
    return r
  }
  if (!isSpaceOnline(sp)) return { ok: false, offline: true, error: '共享主机离线，暂时不可访问' }
  return shareRequest(sp.hostUserId, 'folder_create', { spaceId, parentId, name })
})
ipcMain.handle('share:rename', async (_e, spaceId, entryId, newName) => {
  const sp = vault.getShareSpace(spaceId)
  if (!sp) return { ok: false, error: '共享空间不存在' }
  if (!shareIsGroupMember(sp, selfId())) return { ok: false, error: '你不是群成员' }
  const chk = shareMod.checkSegment(newName)
  if (!chk.ok) return { ok: false, error: chk.error }
  if (isHostSelf(sp)) {
    const r = shareHosts.get(spaceId).rename(selfId(), entryId, newName)
    if (r.ok) persistHostSpace(sp)
    return r
  }
  if (!isSpaceOnline(sp)) return { ok: false, offline: true, error: '共享主机离线，暂时不可访问' }
  return shareRequest(sp.hostUserId, 'rename', { spaceId, entryId, newName })
})
ipcMain.handle('share:delete', async (_e, spaceId, entryId) => {
  const sp = vault.getShareSpace(spaceId)
  if (!sp) return { ok: false, error: '共享空间不存在' }
  if (!shareIsGroupMember(sp, selfId())) return { ok: false, error: '你不是群成员' }
  if (isHostSelf(sp)) {
    const r = shareHosts.get(spaceId).remove(selfId(), entryId)
    if (r.ok) persistHostSpace(sp)
    return r
  }
  if (!isSpaceOnline(sp)) return { ok: false, offline: true, error: '共享主机离线，暂时不可访问' }
  return shareRequest(sp.hostUserId, 'delete', { spaceId, entryId })
})
ipcMain.handle('share:upload', async (_e, spaceId, parentId, paths, rename) => {
  const sp = vault.getShareSpace(spaceId)
  if (!sp) return { ok: false, error: '共享空间不存在' }
  if (!shareIsGroupMember(sp, selfId())) return { ok: false, error: '你不是群成员' }
  paths = Array.isArray(paths) ? paths : (paths ? [paths] : [])
  if (!paths.length) return { ok: false, error: '未选择文件' }
  if (!isHostSelf(sp) && !isSpaceOnline(sp)) return { ok: false, offline: true, error: '共享主机离线，暂时不可访问' }
  const results = []
  for (const fp of paths) {
    if (shareOversize(fp)) { results.push({ ok: false, oversize: true, name: path.basename(fp), error: '文件超过 5GB 上限，未上传' }); continue }
    if (isHostSelf(sp)) results.push(await hostSelfUpload(sp, parentId, fp, rename))
    else results.push(await shareUploadOne(sp, parentId, fp, rename))
  }
  return { ok: results.every((r) => r && r.ok), results }
})
ipcMain.handle('share:uploadFolder', async (_e, spaceId, parentId, dirPath) => {
  const sp = vault.getShareSpace(spaceId)
  if (!sp) return { ok: false, error: '共享空间不存在' }
  if (!shareIsGroupMember(sp, selfId())) return { ok: false, error: '你不是群成员' }
  if (!dirPath || !fs.existsSync(dirPath)) return { ok: false, error: '文件夹不存在' }
  if (!isHostSelf(sp) && !isSpaceOnline(sp)) return { ok: false, offline: true, error: '共享主机离线，暂时不可访问' }
  const summary = { folders: 0, files: 0, failed: 0, total: 0 }
  const countFiles = (fsDir) => {
    let total = 0
    let items = []
    try { items = fs.readdirSync(fsDir, { withFileTypes: true }) } catch (_) { return total }
    for (const it of items) {
      const full = path.join(fsDir, it.name)
      if (it.isDirectory()) total += countFiles(full)
      else if (it.isFile()) total++
    }
    return total
  }
  const totalFiles = countFiles(dirPath)
  summary.total = totalFiles
  const emitFolderProgress = () => sendToRenderer('share:progress', {
    op: 'uploadFolder',
    spaceId,
    done: summary.files,
    total: totalFiles,
    failed: summary.failed,
    dir: 'out',
  })
  emitFolderProgress()
  const ensureFolder = async (curParent, name) => {
    let r
    if (isHostSelf(sp)) r = shareHosts.get(spaceId).createFolder(selfId(), curParent, name)
    else r = await shareRequest(sp.hostUserId, 'folder_create', { spaceId, parentId: curParent, name })
    if (r && r.ok) { summary.folders++; return r.entry.entryId }
    // 已存在 → 复用其 id（重名目录处理）
    let dir
    if (isHostSelf(sp)) dir = shareHosts.get(spaceId).listDir(curParent)
    else dir = await shareRequest(sp.hostUserId, 'dir_list', { spaceId, parentId: curParent })
    const want = (shareMod.checkSegment(name).value) || name
    const found = dir && dir.ok && (dir.entries || []).find((e) => e.type === 'folder' && e.name === want)
    return found ? found.entryId : null
  }
  const walk = async (fsDir, curParent) => {
    let items = []
    try { items = fs.readdirSync(fsDir, { withFileTypes: true }) } catch (_) { return }
    for (const it of items) {
      const full = path.join(fsDir, it.name)
      if (it.isDirectory()) {
        const fid = await ensureFolder(curParent, it.name)
        if (fid) await walk(full, fid); else summary.failed++ // 空文件夹也会被创建并保留
      } else if (it.isFile()) {
        if (shareOversize(full)) { summary.failed++; summary.oversize = (summary.oversize || 0) + 1; emitFolderProgress(); continue } // 跳过超 5GB 文件
        const up = isHostSelf(sp) ? await hostSelfUpload(sp, curParent, full, true) : await shareUploadOne(sp, curParent, full, true)
        if (up && up.ok) summary.files++; else summary.failed++
        emitFolderProgress()
      }
    }
  }
  const topId = await ensureFolder(parentId, path.basename(dirPath))
  if (!topId) return { ok: false, error: '创建根文件夹失败（可能名称非法）' }
  await walk(dirPath, topId)
  if (isHostSelf(sp)) persistHostSpace(sp)
  return { ok: summary.failed === 0, summary }
})
ipcMain.handle('share:download', async (_e, spaceId, entryId, suggestedName, saveDir) => {
  const sp = vault.getShareSpace(spaceId)
  if (!sp) return { ok: false, error: '群文件不存在' }
  if (!shareIsGroupMember(sp, selfId())) return { ok: false, error: '你不是群成员' }
  let saveTo
  let targetDir = saveDir || ''
  if (saveDir) {
    // 批量/指定目录：自动命名落入该目录，不逐个弹另存为；文件夹保留相对路径。
    try { if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true }) } catch (_) {}
  } else {
    // 单个下载：文件走另存为；文件夹走选择目录。无法提前知道远端类型时，仍以文件名作为默认另存为。
    const saveRes = await dialog.showSaveDialog({ title: '保存到', defaultPath: safeFileName(suggestedName || 'download') })
    if (saveRes.canceled || !saveRes.filePath) return { ok: false, canceled: true }
    saveTo = saveRes.filePath
  }
  if (isHostSelf(sp)) {
    const dl = shareHosts.get(spaceId).downloadList(entryId)
    if (!dl.ok) return dl
    try {
      if (dl.type === 'file' && !saveDir) {
        await fs.promises.mkdir(path.dirname(saveTo), { recursive: true })
        await fs.promises.copyFile(dl.files[0].abs, saveTo)
        sendToRenderer('share:downloaded', { spaceId, entryId, path: saveTo, fname: path.basename(saveTo) })
        return { ok: true, path: saveTo, fname: path.basename(saveTo), files: [{ path: saveTo, fname: path.basename(saveTo), entryId }] }
      }
      targetDir = targetDir || path.dirname(saveTo)
      if (dl.type === 'folder') await fs.promises.mkdir(path.join(targetDir, safeFileName(dl.rootName || 'folder')), { recursive: true })
      const files = await copyShareDownloadFiles(dl.files, targetDir)
      sendToRenderer('share:downloaded', { spaceId, entryId, path: targetDir, fname: path.basename(targetDir) })
      return { ok: true, path: targetDir, fname: path.basename(targetDir), files }
    } catch (e) { return { ok: false, error: '保存失败:' + ((e && e.message) || e) } }
  }
  if (!isSpaceOnline(sp)) return { ok: false, offline: true, error: '共享主机离线，暂时不可访问' }
  const ack = await shareRequest(sp.hostUserId, 'download', { spaceId, entryId })
  if (!ack || !ack.ok) return ack || { ok: false, error: '请求失败' }
  const transfers = ack.transfers || []
  if (!transfers.length) {
    if (ack.type === 'folder' && targetDir) {
      try { await fs.promises.mkdir(path.join(targetDir, safeFileName(ack.rootName || suggestedName || 'folder')), { recursive: true }) } catch (_) {}
    }
    return { ok: true, files: [] }
  }
  if (!targetDir) targetDir = path.dirname(saveTo)
  if (ack.type === 'file' && !saveDir && transfers.length === 1) {
    const t = transfers[0]
    return new Promise((resolve) => {
      const timer = setTimeout(() => { shareXferMids.delete(t.mid); shareDownloads.delete(t.mid); resolve({ ok: false, error: '下载超时' }) }, 30 * 60 * 1000)
      shareXferMids.add(t.mid)
      registerShareDownload(t.mid, { resolve, timer, saveTo })
    })
  }
  return makeShareDownloadWaiter(transfers, targetDir)
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
  const guard = requireGroupMember(roomId, selfId(), '群聊不存在', '你不是群成员')
  if (!guard.ok) return guard
  const room = guard.group
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
  purgeTempImages()
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
