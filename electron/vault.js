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

function aesEncrypt (key, plaintext) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, ct])
}

function aesDecrypt (key, buf) {
  const iv = buf.subarray(0, 12)
  const tag = buf.subarray(12, 28)
  const ct = buf.subarray(28)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()])
}

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
    if (!Array.isArray(data.groups)) data.groups = []
    if (!data.settings) data.settings = {}
    const s = data.settings
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
    if (typeof s.markdown !== 'boolean') s.markdown = true
    if (!Array.isArray(s.pinned)) s.pinned = []
    if (!Array.isArray(s.muted)) s.muted = []
    if (typeof s.statusText !== 'string') s.statusText = ''
    if (!['online', 'busy', 'away'].includes(s.presence)) s.presence = 'online'
    if (typeof s.udpPort !== 'number') s.udpPort = 51888
    if (typeof s.broadcastAddrs !== 'string') s.broadcastAddrs = ''
    if (!s.avatar || typeof s.avatar !== 'object') s.avatar = { type: 'text', text: '', color: '' }
    if (!data.drafts) data.drafts = {}
    if (!data.createdAt) data.createdAt = Date.now()
    return data
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
    const buf = aesEncrypt(this.key, Buffer.from(JSON.stringify(this.data), 'utf8'))
    const tmp = this.storePath + '.tmp'
    fs.writeFileSync(tmp, buf)
    fs.renameSync(tmp, this.storePath)
  }

  _save () {
    if (this._saveTimer) return
    this._saveTimer = setTimeout(() => { this._saveTimer = null; try { this._saveNow() } catch (_) {} }, 300)
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
    const verifier = aesEncrypt(key, Buffer.from(MAGIC, 'utf8'))
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
    try { ok = aesDecrypt(key, Buffer.from(account.verifier, 'base64')).toString('utf8') === MAGIC } catch (_) { ok = false }
    if (!ok) throw new Error('密码错误')
    let data
    try { data = JSON.parse(aesDecrypt(key, fs.readFileSync(this.storePath)).toString('utf8')) } catch (_) { data = {} }
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
    try { ok = aesDecrypt(oldKey, Buffer.from(account.verifier, 'base64')).toString('utf8') === MAGIC } catch (_) { ok = false }
    if (!ok) throw new Error('原密码错误')
    if (!newPw || String(newPw).length < 4) throw new Error('新密码至少 4 位')
    const newSalt = crypto.randomBytes(16)
    const newKey = await deriveKey(newPw, newSalt)
    const verifier = aesEncrypt(newKey, Buffer.from(MAGIC, 'utf8'))
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
        lastSeen: p.lastSeen || Date.now(),
      }
      if (JSON.stringify(prev) !== JSON.stringify(next)) { this.data.contacts[p.id] = next; changed = true }
    }
    if (changed) this._save()
    return this.getContacts()
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
    if (!this.data || !convId || !msg) return
    if (!this.data.history[convId]) this.data.history[convId] = []
    const arr = this.data.history[convId]
    arr.push(msg)
    if (arr.length > HISTORY_CAP) arr.splice(0, arr.length - HISTORY_CAP)
    this._save()
  }

  pruneHistory (days) {
    if (!this.data || !days || days <= 0) return
    const cutoff = Date.now() - days * 86400000
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

  clearHistory () { if (this.data) { this.data.history = {}; this._save() } }
  clearConversation (convId) { if (this.data && this.data.history[convId]) { delete this.data.history[convId]; this._save() } }
  getDrafts () { return this.data ? (this.data.drafts || {}) : {} }
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
