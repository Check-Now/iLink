'use strict'

// 阶段2/3:本地加密存储
// - 主密码 → scrypt 派生 32 字节密钥;应用数据 AES-256-GCM 加密落盘(store.enc 密文)
// - account.json 仅存 KDF 参数 + salt + 校验块(非敏感)
// - 阶段3:X25519 私钥也在 store.enc 内(随主密码加密存储);隐私设置/历史保留

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const os = require('os')
const cryptoMod = require('./crypto')
const { normalizePresence } = require('./constants')

const SCRYPT = { N: 16384, r: 8, p: 1, keyLen: 32 }
const MAGIC = 'FREEDOM_VAULT_OK'
const HISTORY_CAP = 1000
const PINNED_MESSAGE_CAP = 10
const DAY_MS = 24 * 60 * 60 * 1000 // 一天的毫秒数（历史保留裁剪用）
const SAVE_DEBOUNCE_MS = 300       // 落盘去抖：合并 300ms 内的多次写
// settings 持久化键白名单：渲染层只能写入这些已知键，防止任意键被注入持久化 settings（纵深防御）。
// 必须与 _ensureSettings 覆盖的字段保持一致；blacklist/translucency 为已移除功能，刻意不纳入。
const ALLOWED_SETTING_KEYS = new Set([
  'burnDefault', 'burnTtl', 'anonymous', 'autoLockMin', 'retentionDays',
  'theme', 'uiStyle', 'fontPx', 'chatFont', 'nudgeText', 'chatFontPx',
  'notifyEnabled', 'notifyPreview', 'showTyping', 'sendKey', 'minimizeToTray',
  'autoStart', 'closeAction', 'receiveMode', 'downloadDir', 'maxFileMB',
  'markdown', 'pinned', 'muted', 'statusText', 'presence', 'udpPort',
  'broadcastAddrs', 'avatar',
])

function defaultName () {
  let h = ''
  try { h = os.hostname() } catch (_) {}
  h = (h || '').split('.')[0] || '用户'
  return h + '-' + Math.random().toString(36).slice(2, 5)
}

function deriveKey (password, salt, params) {
  const p = params || SCRYPT
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, p.keyLen, { N: p.N, r: p.r, p: p.p, maxmem: 64 * 1024 * 1024 }, (err, dk) => {
      if (err) reject(err)
      else resolve(dk)
    })
  })
}

// 本地存储的 AES-256-GCM 加解密复用 crypto.encryptBuf/decryptBuf：
// 二者载荷格式(iv|tag|ct)字节一致，store.enc 与旧数据完全兼容，避免重复实现同一套原语。

class Vault {
  constructor (dataDir) {
    this.dataDir = dataDir
    this.accountPath = path.join(dataDir, 'account.json')
    this.storePath = path.join(dataDir, 'store.enc')
    this.key = null
    this.data = null
    this.unlocked = false
    this._saveTimer = null
  }

  _ensureDir () { if (!fs.existsSync(this.dataDir)) fs.mkdirSync(this.dataDir, { recursive: true }) }
  exists () { return fs.existsSync(this.accountPath) }

  _ensureFields (data) {
    data = data || {}
    if (!data.identity || !data.identity.id) data.identity = { id: crypto.randomUUID(), name: defaultName() }
    if (!data.keys || !data.keys.pub || !data.keys.priv) data.keys = cryptoMod.generateKeyPair()
    if (!data.history) data.history = {}
    if (!data.contacts) data.contacts = {}
    for (const [id, name] of [['A', 'Alice'], ['B', 'Bob']]) {
      if (data.contacts[id] && data.contacts[id].name === name) delete data.contacts[id]
    }
    if (!Array.isArray(data.groups)) data.groups = []
    if (!data.settings) data.settings = {}
    this._ensureSettings(data.settings)
    if (!data.drafts) data.drafts = {}
    if (!data.reads || typeof data.reads !== 'object') data.reads = {} // 各会话已读位(ts)，用于跨重启恢复未读数
    if (!data.outbox || typeof data.outbox !== 'object') data.outbox = {} // 离线发件箱:peerId -> [item]，持久化待发(文本/文件)
    if (!Array.isArray(data.groupPinnedMessages)) data.groupPinnedMessages = []
    data.groupPinnedMessages = data.groupPinnedMessages.map((p) => this._normalizePinnedMessage(p)).filter(Boolean)
    if (!Array.isArray(data.groupPinnedMessageLogs)) data.groupPinnedMessageLogs = []
    if (!Array.isArray(data.shareSpaces)) data.shareSpaces = [] // 群共享空间·已知空间列表(宿主含 rootPath/isHost)
    if (!data.shareSnapshots || typeof data.shareSnapshots !== 'object') data.shareSnapshots = {} // 共享空间目录缓存快照(离线只读用)
    if (!data.createdAt) data.createdAt = Date.now()
    if (!data.readsInit) {
      // 首次升级：把已有历史标记为已读，避免旧消息一次性全部被计为未读
      for (const conv of Object.keys(data.history || {})) {
        const arr = data.history[conv]
        if (Array.isArray(arr) && arr.length) { const last = arr[arr.length - 1]; if (last && last.ts) data.reads[conv] = Math.max(data.reads[conv] || 0, last.ts) }
      }
      data.readsInit = true
    }
    return data
  }

  // 各设置项的默认值与迁移（从 _ensureFields 抽出：单一职责、便于维护与定位）
  _ensureSettings (s) {
    if (typeof s.burnDefault !== 'boolean') s.burnDefault = false
    if (typeof s.burnTtl !== 'number') s.burnTtl = 10
    if (typeof s.anonymous !== 'boolean') s.anonymous = false
    if (typeof s.autoLockMin !== 'number') s.autoLockMin = 0
    if (typeof s.retentionDays !== 'number') s.retentionDays = 0
    if ('blacklist' in s) delete s.blacklist // 已移除黑名单功能：加载旧数据时清除该字段，正常保存后不再写入
    if (typeof s.theme !== 'string') s.theme = 'system'
    if (!['classic', 'minimal', 'material', 'dark', 'skeuo', 'glass', 'flat', 'neu', 'gradient', 'card', 'hand'].includes(s.uiStyle)) s.uiStyle = 'classic'
    if ('translucency' in s) delete s.translucency
    if (typeof s.fontPx !== 'number') s.fontPx = 15
    if (typeof s.chatFont !== 'string') s.chatFont = ''
    if (typeof s.nudgeText !== 'string') s.nudgeText = ''
    if (typeof s.chatFontPx !== 'number' || s.chatFontPx < 12 || s.chatFontPx > 22) s.chatFontPx = 13.5
    if (typeof s.notifyEnabled !== 'boolean') s.notifyEnabled = true
    if (typeof s.notifyPreview !== 'boolean') s.notifyPreview = true
    if (typeof s.showTyping !== 'boolean') s.showTyping = true
    if (typeof s.sendKey !== 'string') s.sendKey = 'enter'
    if (typeof s.minimizeToTray !== 'boolean') s.minimizeToTray = true
    if (typeof s.autoStart !== 'boolean') s.autoStart = false
    if (typeof s.closeAction !== 'string') s.closeAction = 'ask'
    if (typeof s.receiveMode !== 'string') s.receiveMode = 'auto'
    if (typeof s.downloadDir !== 'string') s.downloadDir = ''
    if (typeof s.maxFileMB !== 'number' || s.maxFileMB < 0) s.maxFileMB = 0
    if (typeof s.markdown !== 'boolean') s.markdown = true
    if (!Array.isArray(s.pinned)) s.pinned = []
    if (!Array.isArray(s.muted)) s.muted = []
    if (typeof s.statusText !== 'string') s.statusText = ''
    s.presence = normalizePresence(s.presence) // dnd(免打扰)必须可持久化；未知值安全回退 online
    if (typeof s.udpPort !== 'number') s.udpPort = 51888
    if (typeof s.broadcastAddrs !== 'string') s.broadcastAddrs = ''
    if (!s.avatar || typeof s.avatar !== 'object') s.avatar = { type: 'text', text: '', color: '' }
    return s
  }

  _normalizePinnedMessage (pin) {
    if (!pin || !pin.pinId || !pin.groupId) return null
    const snap = pin.messageSnapshot && typeof pin.messageSnapshot === 'object' ? pin.messageSnapshot : {}
    const messageId = String(pin.messageId || snap.messageId || '')
    const senderId = String(pin.senderId || snap.senderId || '')
    const senderName = String(pin.senderName || snap.senderName || '')
    const messageType = String(pin.messageType || snap.messageType || 'text')
    const contentPreview = String(pin.contentPreview || snap.contentPreview || '').slice(0, 200)
    const pinnedAt = Number(pin.pinnedAt || pin.createdAt || pin.updatedAt || Date.now())
    const updatedAt = Number(pin.updatedAt || pinnedAt || Date.now())
    const status = ['pinned', 'unpinned', 'deleted'].includes(pin.status) ? pin.status : 'pinned'
    const messageSnapshot = {
      messageId,
      senderId,
      senderName,
      messageType,
      contentPreview,
      sentAt: Number(snap.sentAt || pin.sentAt || 0),
    }
    if (snap.originalContent !== undefined) messageSnapshot.originalContent = snap.originalContent
    if (snap.fileName !== undefined) messageSnapshot.fileName = snap.fileName
    if (snap.fileSize !== undefined) messageSnapshot.fileSize = snap.fileSize
    if (snap.mime !== undefined) messageSnapshot.mime = snap.mime
    if (snap.thumbnailDataUrl !== undefined) messageSnapshot.thumbnailDataUrl = snap.thumbnailDataUrl
    if (snap.localPath !== undefined) messageSnapshot.localPath = snap.localPath
    return {
      pinId: String(pin.pinId),
      groupId: String(pin.groupId),
      messageId,
      messageSnapshot,
      senderId,
      senderName,
      messageType,
      contentPreview,
      pinnedBy: String(pin.pinnedBy || ''),
      pinnedByName: String(pin.pinnedByName || ''),
      pinnedAt,
      status,
      updatedAt,
    }
  }

  _clonePinned (pin) {
    return pin ? JSON.parse(JSON.stringify(pin)) : null
  }

  _activePinnedMessages (groupId) {
    return (this.data && this.data.groupPinnedMessages ? this.data.groupPinnedMessages : [])
      .filter((p) => p && p.groupId === groupId && p.status === 'pinned')
  }

  _upsertPinnedMessageRaw (pin) {
    if (!this.data || !pin) return { changed: false, pin: null }
    if (!Array.isArray(this.data.groupPinnedMessages)) this.data.groupPinnedMessages = []
    const incoming = this._normalizePinnedMessage(pin)
    if (!incoming) return { changed: false, pin: null }
    const i = this.data.groupPinnedMessages.findIndex((p) => p.pinId === incoming.pinId)
    if (i >= 0) {
      const prev = this._normalizePinnedMessage(this.data.groupPinnedMessages[i])
      if (prev && (incoming.updatedAt || 0) < (prev.updatedAt || 0)) return { changed: false, pin: this._clonePinned(prev) }
      if (prev && prev.status !== 'pinned' && incoming.status === 'pinned' && (incoming.updatedAt || 0) <= (prev.updatedAt || 0)) return { changed: false, pin: this._clonePinned(prev) }
      this.data.groupPinnedMessages[i] = {
        ...prev,
        ...incoming,
        messageSnapshot: { ...((prev && prev.messageSnapshot) || {}), ...(incoming.messageSnapshot || {}) },
      }
      return { changed: true, pin: this._clonePinned(this.data.groupPinnedMessages[i]) }
    }
    this.data.groupPinnedMessages.push(incoming)
    return { changed: true, pin: this._clonePinned(incoming) }
  }

  _appendPinnedLog (pin, operatorId, action, detail) {
    if (!this.data) return
    if (!Array.isArray(this.data.groupPinnedMessageLogs)) this.data.groupPinnedMessageLogs = []
    this.data.groupPinnedMessageLogs.push({
      logId: crypto.randomUUID(),
      pinId: pin.pinId,
      groupId: pin.groupId,
      messageId: pin.messageId,
      operatorId: operatorId || '',
      action,
      detail: detail || '',
      createdAt: Date.now(),
    })
    if (this.data.groupPinnedMessageLogs.length > 500) this.data.groupPinnedMessageLogs.splice(0, this.data.groupPinnedMessageLogs.length - 500)
  }

  _writeAccount (obj) {
    this._ensureDir()
    const tmp = this.accountPath + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2))
    fs.renameSync(tmp, this.accountPath)
  }

  _backupCorruptStore (cause) {
    let backupPath = null
    if (fs.existsSync(this.storePath)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      let candidate = this.storePath + '.corrupt-' + stamp
      let i = 1
      while (fs.existsSync(candidate)) candidate = this.storePath + '.corrupt-' + stamp + '-' + (i++)
      try {
        fs.renameSync(this.storePath, candidate)
        backupPath = candidate
      } catch (_) {
        try {
          fs.copyFileSync(this.storePath, candidate)
          backupPath = candidate
        } catch (_) {}
      }
    }
    const err = new Error('Vault store is corrupted; original data was not overwritten' + (backupPath ? (': ' + backupPath) : ''))
    err.code = 'ERR_VAULT_STORE_CORRUPT'
    err.backupPath = backupPath
    err.cause = cause
    return err
  }

  _saveNow () {
    if (!this.key || !this.data) return
    this._ensureDir()
    const buf = cryptoMod.encryptBuf(this.key, Buffer.from(JSON.stringify(this.data), 'utf8'))
    const tmp = this.storePath + '.tmp'
    fs.writeFileSync(tmp, buf)
    fs.renameSync(tmp, this.storePath)
  }

  _save () {
    if (this._saveTimer) return
    this._saveTimer = setTimeout(() => { this._saveTimer = null; try { this._saveNow() } catch (_) {} }, SAVE_DEBOUNCE_MS)
  }

  flush () {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null }
    try { this._saveNow() } catch (_) {}
  }

  async setup (password) {
    if (!password || String(password).length < 4) throw new Error('密码至少 4 位')
    this._ensureDir()
    const salt = crypto.randomBytes(16)
    const key = await deriveKey(password, salt)
    const verifier = cryptoMod.encryptBuf(key, Buffer.from(MAGIC, 'utf8'))
    this.data = this._ensureFields({})
    this.key = key
    this._writeAccount({
      v: 1, kdf: 'scrypt', N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, keyLen: SCRYPT.keyLen,
      salt: salt.toString('hex'), verifier: verifier.toString('base64'), createdAt: Date.now(),
    })
    this._saveNow()
    this.unlocked = true
    return this.getIdentity()
  }

  async unlock (password) {
    if (!this.exists()) throw new Error('账户不存在')
    const account = JSON.parse(fs.readFileSync(this.accountPath, 'utf8'))
    const salt = Buffer.from(account.salt, 'hex')
    const key = await deriveKey(password, salt, { N: account.N, r: account.r, p: account.p, keyLen: account.keyLen })
    let ok = false
    try { ok = cryptoMod.decryptBuf(key, Buffer.from(account.verifier, 'base64')).toString('utf8') === MAGIC } catch (_) { ok = false }
    if (!ok) throw new Error('密码错误')
    let data
    try { data = JSON.parse(cryptoMod.decryptBuf(key, fs.readFileSync(this.storePath)).toString('utf8')) } catch (e) { throw this._backupCorruptStore(e) }
    this.key = key
    this.data = this._ensureFields(data)
    this.unlocked = true
    if (this.data.settings.retentionDays > 0) this.pruneHistory(this.data.settings.retentionDays)
    this._saveNow() // 补齐的 keys/settings 落盘
    return this.getIdentity()
  }

  async changePassword (oldPw, newPw) {
    if (!this.unlocked || !this.data) throw new Error('未解锁')
    const account = JSON.parse(fs.readFileSync(this.accountPath, 'utf8'))
    const salt = Buffer.from(account.salt, 'hex')
    const oldKey = await deriveKey(oldPw, salt, { N: account.N, r: account.r, p: account.p, keyLen: account.keyLen })
    let ok = false
    try { ok = cryptoMod.decryptBuf(oldKey, Buffer.from(account.verifier, 'base64')).toString('utf8') === MAGIC } catch (_) { ok = false }
    if (!ok) throw new Error('原密码错误')
    if (!newPw || String(newPw).length < 4) throw new Error('新密码至少 4 位')
    const newSalt = crypto.randomBytes(16)
    const newKey = await deriveKey(newPw, newSalt)
    const verifier = cryptoMod.encryptBuf(newKey, Buffer.from(MAGIC, 'utf8'))
    this.key = newKey
    this._writeAccount({
      v: 1, kdf: 'scrypt', N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, keyLen: SCRYPT.keyLen,
      salt: newSalt.toString('hex'), verifier: verifier.toString('base64'),
      createdAt: account.createdAt, updatedAt: Date.now(),
    })
    this._saveNow()
    return true
  }

  reset () {
    this.lock()
    try { if (fs.existsSync(this.accountPath)) fs.unlinkSync(this.accountPath) } catch (_) {}
    try { if (fs.existsSync(this.storePath)) fs.unlinkSync(this.storePath) } catch (_) {}
    return true
  }

  lock () {
    this.flush()
    this.key = null
    this.data = null
    this.unlocked = false
  }

  // -------- 数据访问 --------
  getIdentity () { return this.data ? { ...this.data.identity } : null }
  getKeys () { return this.data && this.data.keys ? { pub: this.data.keys.pub, priv: this.data.keys.priv } : null }
  getPublicKey () { return this.data && this.data.keys ? this.data.keys.pub : null }

  setNickname (name) {
    if (!this.data) return null
    name = (name || '').toString().trim().slice(0, 32)
    if (name) { this.data.identity.name = name; this._save() }
    return this.getIdentity()
  }

  getHistory () { return this.data ? this.data.history : {} }

  getContacts () {
    return this.data ? Object.values(this.data.contacts || {}) : []
  }

  upsertContacts (list) {
    if (!this.data || !Array.isArray(list)) return this.getContacts()
    if (!this.data.contacts) this.data.contacts = {}
    let changed = false
    for (const p of list) {
      if (!p || !p.id) continue
      const prev = this.data.contacts[p.id] || {}
      const next = {
        id: p.id,
        name: p.name || prev.name || p.id.slice(0, 6),
        pub: p.pub || prev.pub || null,
        address: p.address || prev.address || null,
        status: p.status != null ? p.status : (prev.status || ''),
        avatar: p.avatar || prev.avatar || null,
        remark: prev.remark || '', // 本机备注：仅存本地，不随对方资料更新被覆盖
        lastSeen: p.lastSeen || Date.now(),
      }
      if (JSON.stringify(prev) !== JSON.stringify(next)) { this.data.contacts[p.id] = next; changed = true }
    }
    if (changed) this._save()
    return this.getContacts()
  }

  // 设置联系人备注（仅本机可见，不参与任何广播）
  setContactRemark (id, remark) {
    if (!this.data || !id) return null
    if (!this.data.contacts) this.data.contacts = {}
    const prev = this.data.contacts[id] || { id, name: id.slice(0, 6) }
    this.data.contacts[id] = { ...prev, remark: (remark || '').toString().trim().slice(0, 32) }
    this._save()
    return this.data.contacts[id]
  }

  getGroups () {
    return this.data ? (this.data.groups || []) : []
  }

  upsertGroup (group) {
    if (!this.data || !group || !group.id) return null
    if (!Array.isArray(this.data.groups)) this.data.groups = []
    const prev = this.data.groups.find((g) => g.id === group.id) || null
    const members = Array.from(new Set(group.members || [])).filter(Boolean)
    const next = {
      id: group.id,
      name: (group.name || '群聊').toString().slice(0, 40),
      ownerId: group.ownerId || (members[0] || ''),
      members,
      avatar: group.avatar !== undefined ? group.avatar : ((prev && prev.avatar) || null),
      createdAt: group.createdAt || Date.now(),
      updatedAt: Date.now(),
    }
    const i = this.data.groups.findIndex((g) => g.id === next.id)
    if (i >= 0) this.data.groups[i] = { ...this.data.groups[i], ...next }
    else this.data.groups.push(next)
    this._save()
    return next
  }

  createGroup (name, members, ownerId) {
    return this.upsertGroup({ id: 'room:' + crypto.randomUUID(), name, ownerId, members, createdAt: Date.now() })
  }

  removeGroup (groupId) {
    if (!this.data || !Array.isArray(this.data.groups)) return
    const i = this.data.groups.findIndex((g) => g.id === groupId)
    if (i >= 0) { this.data.groups.splice(i, 1); this._save() }
  }

  // 转让群主。领域层强校验（不依赖前端）：传入 operatorId 时必须为现任群主；新群主须为群成员且不能是现任群主本人。
  transferGroupOwner (groupId, ownerId, operatorId) {
    const group = this.data && this.data.groups.find((g) => g.id === groupId)
    if (!group) return null
    if (operatorId && group.ownerId !== operatorId) return null // 仅现群主可转让
    if (!ownerId || !group.members.includes(ownerId)) return null // 新群主必须是群成员
    if (ownerId === group.ownerId) return null // 不能转让给当前群主本人
    group.ownerId = ownerId
    group.updatedAt = Date.now()
    this._save()
    return group
  }

  appendMessage (convId, msg) {
    if (!this.data || !convId || !msg || msg.burn) return // 阅后即焚消息绝不落库（仅内存）
    if (!this.data.history[convId]) this.data.history[convId] = []
    const arr = this.data.history[convId]
    const ts = msg.ts || Date.now()
    // 常规追加到末尾(新消息 ts 最大)；迟到/乱序消息按 ts 插入正确位置，保持时间序
    if (arr.length === 0 || ts >= (arr[arr.length - 1].ts || 0)) {
      arr.push(msg)
    } else {
      let i = arr.length - 1
      while (i >= 0 && (arr[i].ts || 0) > ts) i--
      arr.splice(i + 1, 0, msg)
    }
    if (arr.length > HISTORY_CAP) arr.splice(0, arr.length - HISTORY_CAP)
    this._save()
  }

  pruneHistory (days) {
    if (!this.data || !days || days <= 0) return
    const cutoff = Date.now() - days * DAY_MS
    let changed = false
    for (const k of Object.keys(this.data.history)) {
      const arr = this.data.history[k]
      const filtered = arr.filter((m) => (m.ts || 0) >= cutoff)
      if (filtered.length !== arr.length) { this.data.history[k] = filtered; changed = true }
    }
    if (changed) this._save()
  }

  markRecalled (convId, mid) {
    const arr = this.data && this.data.history[convId]
    if (!arr) return
    const m = arr.find((x) => x.mid === mid)
    // 自己撤回的消息保留原文(recalledText),用于“重新编辑”;别人撤回的不保留
    if (m) { m.recalled = true; if (m.self) m.recalledText = m.text || m.recalledText || ''; m.text = ''; this._save() }
  }

  addReaction (convId, mid, emoji, fromId) {
    const arr = this.data && this.data.history[convId]
    if (!arr) return
    const m = arr.find((x) => x.mid === mid)
    if (!m) return
    if (!m.reactions) m.reactions = {}
    if (!m.reactions[emoji]) m.reactions[emoji] = []
    if (!m.reactions[emoji].includes(fromId)) m.reactions[emoji].push(fromId)
    this._save()
  }

  // 更新自己发出消息的发送状态(sending/sent/delivered/failed)，供重启后恢复
  setMessageStatus (convId, mid, status) {
    const arr = this.data && this.data.history[convId]
    if (!arr) return
    const m = arr.find((x) => x.mid === mid)
    if (m && m.self) { m.status = status; this._save() }
  }

  clearHistory () { if (this.data) { this.data.history = {}; this.data.reads = {}; this._save() } }
  clearConversation (convId) { if (this.data && this.data.history[convId]) { delete this.data.history[convId]; this._save() } }
  getDrafts () { return this.data ? (this.data.drafts || {}) : {} }
  getReads () { return this.data ? (this.data.reads || {}) : {} }
  // 已读位单调前进：记录某会话“已读到的最新消息时间”，未读数据此重算（跨重启恢复）
  setRead (convId, ts) {
    if (!this.data || !convId) return
    if (!this.data.reads) this.data.reads = {}
    const v = ts || Date.now()
    if (v > (this.data.reads[convId] || 0)) { this.data.reads[convId] = v; this._save() }
  }
  // “最近”分页的会话元数据：lastActiveTime（最后关联时间）/ hiddenInRecent / hiddenAt
  // 仅记录会话状态，绝不触碰 history 中的聊天记录
  getRecent () { return this.data ? (this.data.recent || {}) : {} }
  setRecent (convId, meta) {
    if (!this.data || !convId) return
    if (!this.data.recent) this.data.recent = {}
    this.data.recent[convId] = { ...(this.data.recent[convId] || {}), ...(meta || {}) }
    this._save()
  }

  // -------- 离线发件箱（持久化，确认送达后才移除）--------
  getOutbox () { return this.data ? (this.data.outbox || {}) : {} }
  outboxAdd (peerId, item) {
    if (!this.data || !peerId || !item || !item.mid || item.burn) return // 阅后即焚绝不入发件箱
    if (!this.data.outbox) this.data.outbox = {}
    const arr = this.data.outbox[peerId] || (this.data.outbox[peerId] = [])
    if (arr.some((x) => x.mid === item.mid)) return // 去重，避免重复入队
    arr.push(item); this._save()
  }
  outboxRemove (peerId, mid) {
    if (!this.data || !this.data.outbox || !this.data.outbox[peerId]) return
    const arr = this.data.outbox[peerId]
    const i = arr.findIndex((x) => x.mid === mid)
    if (i >= 0) { arr.splice(i, 1); if (!arr.length) delete this.data.outbox[peerId]; this._save() }
  }
  clearDrafts () { if (this.data) { this.data.drafts = {}; this._save() } }
  setDraft (convId, text) {
    if (!this.data) return
    if (!this.data.drafts) this.data.drafts = {}
    if (text && text.trim()) this.data.drafts[convId] = text
    else delete this.data.drafts[convId]
    this._save()
  }

  getPinnedMessages (groupId, opts) {
    if (!this.data) return []
    const includeInactive = !!(opts && opts.includeInactive)
    let arr = (this.data.groupPinnedMessages || []).filter((p) => p && (!groupId || p.groupId === groupId))
    arr = arr.map((p) => this._normalizePinnedMessage(p)).filter(Boolean)
    arr.sort((a, b) => (b.pinnedAt || 0) - (a.pinnedAt || 0) || String(b.pinId).localeCompare(String(a.pinId)))
    if (includeInactive) return arr.map((p) => this._clonePinned(p))
    const seenMessages = new Set()
    const out = []
    for (const p of arr) {
      if (p.status !== 'pinned') continue
      const key = p.groupId + ':' + p.messageId
      if (seenMessages.has(key)) continue
      seenMessages.add(key)
      out.push(this._clonePinned(p))
    }
    return out
  }

  getPinnedMessagesByGroup () {
    const out = {}
    for (const p of this.getPinnedMessages()) {
      if (!out[p.groupId]) out[p.groupId] = []
      out[p.groupId].push(p)
    }
    return out
  }

  getPinnedSyncState (groupIds) {
    const allow = Array.isArray(groupIds) && groupIds.length ? new Set(groupIds) : null
    const groups = {}
    for (const p of this.getPinnedMessages(null, { includeInactive: true })) {
      if (allow && !allow.has(p.groupId)) continue
      if (!groups[p.groupId]) groups[p.groupId] = []
      groups[p.groupId].push(p)
    }
    return Object.keys(groups).map((groupId) => ({ groupId, pins: groups[groupId] }))
  }

  addPinnedMessage (pin) {
    if (!this.data) return { ok: false, error: '未解锁' }
    const next = this._normalizePinnedMessage({ ...pin, status: 'pinned' })
    if (!next || !next.groupId || !next.messageId) return { ok: false, error: '置顶消息数据不完整' }
    const active = this._activePinnedMessages(next.groupId)
    if (active.some((p) => p.messageId === next.messageId)) return { ok: false, error: '该消息已置顶' }
    if (active.length >= PINNED_MESSAGE_CAP) return { ok: false, error: '置顶消息已达上限，请先取消旧置顶' }
    const res = this._upsertPinnedMessageRaw(next)
    if (res.changed) {
      this._appendPinnedLog(next, next.pinnedBy, 'pin')
      this._save()
    }
    return { ok: true, pin: res.pin || this._clonePinned(next) }
  }

  unpinMessage (groupId, pinId, operatorId, operatorName) {
    if (!this.data) return { ok: false, error: '未解锁' }
    const list = this.data.groupPinnedMessages || []
    const i = list.findIndex((p) => p && p.pinId === pinId && p.groupId === groupId)
    if (i < 0) return { ok: false, error: '置顶消息不存在' }
    const prev = this._normalizePinnedMessage(list[i])
    const next = {
      ...prev,
      status: 'unpinned',
      updatedAt: Date.now(),
      unpinnedBy: operatorId || '',
      unpinnedByName: operatorName || '',
    }
    list[i] = next
    this._appendPinnedLog(next, operatorId, 'unpin')
    this._save()
    return { ok: true, pin: this._clonePinned(next) }
  }

  mergePinnedMessages (pins) {
    if (!this.data || !Array.isArray(pins)) return { changed: false, pins: [] }
    let changed = false
    const merged = []
    for (const raw of pins) {
      const res = this._upsertPinnedMessageRaw(raw)
      if (res.pin) merged.push(res.pin)
      if (res.changed) changed = true
    }
    if (changed) this._save()
    return { changed, pins: merged }
  }

  // -------- 群共享空间（已知空间列表 + 目录缓存快照）--------
  getShareSpaces () { return this.data ? (this.data.shareSpaces || []) : [] }
  getShareSpacesByGroup (groupId) { return this.getShareSpaces().filter((s) => s.groupId === groupId && s.status !== 'deleted') }
  getShareSpace (spaceId) { return this.getShareSpaces().find((s) => s.spaceId === spaceId) || null }
  upsertShareSpace (space) {
    if (!this.data || !space || !space.spaceId) return null
    if (!Array.isArray(this.data.shareSpaces)) this.data.shareSpaces = []
    const i = this.data.shareSpaces.findIndex((s) => s.spaceId === space.spaceId)
    if (i >= 0) this.data.shareSpaces[i] = { ...this.data.shareSpaces[i], ...space }
    else this.data.shareSpaces.push(space)
    this._save()
    return this.getShareSpace(space.spaceId)
  }
  removeShareSpace (spaceId) {
    if (!this.data || !Array.isArray(this.data.shareSpaces)) return
    const i = this.data.shareSpaces.findIndex((s) => s.spaceId === spaceId)
    if (i >= 0) { this.data.shareSpaces.splice(i, 1); if (this.data.shareSnapshots) delete this.data.shareSnapshots[spaceId]; this._save() }
  }
  getShareSnapshot (spaceId, parentId) {
    const sp = this.data && this.data.shareSnapshots && this.data.shareSnapshots[spaceId]
    return sp ? (sp[parentId || 'root'] || null) : null
  }
  setShareSnapshot (spaceId, parentId, data) {
    if (!this.data) return
    if (!this.data.shareSnapshots) this.data.shareSnapshots = {}
    if (!this.data.shareSnapshots[spaceId]) this.data.shareSnapshots[spaceId] = {}
    this.data.shareSnapshots[spaceId][parentId || 'root'] = { ...data, ts: Date.now() }
    this._save()
  }
  clearShareSnapshot (spaceId) {
    if (this.data && this.data.shareSnapshots) { delete this.data.shareSnapshots[spaceId]; this._save() }
  }

  searchShareSnapshots (groupId, query, spaceId) {
    if (!this.data) return []
    const q = String(query || '').trim().toLowerCase()
    if (!q) return []
    const spaces = this.getShareSpacesByGroup(groupId).filter((s) => !spaceId || s.spaceId === spaceId)
    const snapsRoot = this.data.shareSnapshots || {}
    const out = []
    const seen = new Set()
    for (const sp of spaces) {
      const snaps = snapsRoot[sp.spaceId] || {}
      for (const [pid, snap] of Object.entries(snaps)) {
        for (const e of ((snap && snap.entries) || [])) {
          if (!e || !e.entryId || !String(e.name || '').toLowerCase().includes(q)) continue
          const key = sp.spaceId + ':' + e.entryId
          if (seen.has(key)) continue
          seen.add(key)
          const baseCrumbs = Array.isArray(snap.breadcrumb) && snap.breadcrumb.length ? snap.breadcrumb : [{ entryId: 'root', name: '根目录' }]
          const breadcrumb = e.type === 'folder' ? baseCrumbs.concat([{ entryId: e.entryId, name: e.name }]) : baseCrumbs
          out.push({
            ...e,
            parentId: e.parentId || pid || 'root',
            spaceId: sp.spaceId,
            spaceName: sp.name,
            breadcrumb,
            pathText: breadcrumb.map((c) => c.name).join(' / ') + (e.type === 'file' ? ' / ' + e.name : ''),
            cached: true,
            offline: true,
          })
        }
      }
    }
    return out
  }

  // 深拷贝返回：调用方拿到的是隔离副本，对 avatar/pinned/muted 等嵌套对象的修改不会污染内存中的真实 settings。
  getSettings () { return this.data ? JSON.parse(JSON.stringify(this.data.settings)) : {} }

  setSettings (patch) {
    if (this.data) {
      const filtered = {}
      for (const k of Object.keys(patch || {})) if (ALLOWED_SETTING_KEYS.has(k)) filtered[k] = patch[k]
      this.data.settings = { ...this.data.settings, ...filtered }
      this._save()
    }
    return this.getSettings()
  }
}

module.exports = { Vault, PINNED_MESSAGE_CAP }
