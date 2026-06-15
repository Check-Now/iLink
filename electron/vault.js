'use strict'

// 阶段2/3:本地加密存储
// - 主密码 → scrypt 派生 32 字节密钥;应用数据 AES-256-GCM 加密落盘(store.enc 密文)
// - account.json 仅存 KDF 参数 + salt + 校验块(非敏感)
// - 阶段3:X25519 私钥也在 store.enc 内(随主密码加密存储);隐私设置/黑名单/历史保留

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const os = require('os')
const cryptoMod = require('./crypto')

const SCRYPT = { N: 16384, r: 8, p: 1, keyLen: 32 }
const MAGIC = 'FREEDOM_VAULT_OK'
const HISTORY_CAP = 1000
const DAY_MS = 24 * 60 * 60 * 1000 // 一天的毫秒数（历史保留裁剪用）
const SAVE_DEBOUNCE_MS = 300       // 落盘去抖：合并 300ms 内的多次写

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
    if (!Array.isArray(s.blacklist)) s.blacklist = []
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
    if (!['online', 'busy', 'away'].includes(s.presence)) s.presence = 'online'
    if (typeof s.udpPort !== 'number') s.udpPort = 51888
    if (typeof s.broadcastAddrs !== 'string') s.broadcastAddrs = ''
    if (!s.avatar || typeof s.avatar !== 'object') s.avatar = { type: 'text', text: '', color: '' }
    return s
  }

  _writeAccount (obj) {
    this._ensureDir()
    const tmp = this.accountPath + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2))
    fs.renameSync(tmp, this.accountPath)
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
    try { data = JSON.parse(cryptoMod.decryptBuf(key, fs.readFileSync(this.storePath)).toString('utf8')) } catch (_) { data = {} }
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

  transferGroupOwner (groupId, ownerId) {
    const group = this.data && this.data.groups.find((g) => g.id === groupId)
    if (!group || !group.members.includes(ownerId)) return null
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

  getSettings () { return this.data ? { ...this.data.settings } : {} }

  setSettings (patch) {
    if (this.data) { this.data.settings = { ...this.data.settings, ...(patch || {}) }; this._save() }
    return this.getSettings()
  }
}

module.exports = { Vault }
