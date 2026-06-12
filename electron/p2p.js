'use strict'

// 阶段1→3:局域网 P2P
// - UDP 广播发现 + 心跳 + 在线/离线
// - 群聊广播、私聊单播
// - 阶段3:presence 交换 X25519 公钥;消息端到端加密
//     私聊:用对方公钥派生的会话密钥加密
//     群聊:对每个在线成员逐一用其公钥加密(enc:{memberId: blob})
//   抓包只见密文:消息正文在 enc 里(AES-256-GCM),明文不出网。

const dgram = require('dgram')
const os = require('os')
const crypto = require('crypto')
const { EventEmitter } = require('events')
const cryptoMod = require('./crypto')

const DISCOVERY_PORT = 51888
const MAGIC = 'FRDM1'
const HEARTBEAT_MS = 3000
const OFFLINE_MS = 10000
const SWEEP_MS = 2000
const SEEN_MAX = 800
const AVATAR_MAX_CHARS = 32 * 1024

function defaultName () {
  let host = ''
  try { host = os.hostname() } catch (_) {}
  host = (host || '').split('.')[0] || '用户'
  return host + '-' + Math.random().toString(36).slice(2, 5)
}

function localIPv4Interfaces () {
  const out = []
  const ifaces = os.networkInterfaces()
  for (const key of Object.keys(ifaces)) {
    for (const ni of ifaces[key] || []) {
      const fam = typeof ni.family === 'string' ? ni.family : 'IPv' + ni.family
      if (fam === 'IPv4' && !ni.internal) out.push(ni)
    }
  }
  return out
}

function broadcastAddr (ni) {
  const ip = ni.address.split('.').map((n) => parseInt(n, 10))
  const mask = ni.netmask.split('.').map((n) => parseInt(n, 10))
  if (ip.length !== 4 || mask.length !== 4 || mask.some(isNaN)) return null
  return ip.map((o, i) => (o & mask[i]) | (~mask[i] & 0xff)).join('.')
}

function validPort (p) {
  p = parseInt(p, 10)
  return p >= 1024 && p <= 65535 ? p : DISCOVERY_PORT
}

function publicAvatar (avatar) {
  if (!avatar || typeof avatar !== 'object') return null
  const type = avatar.type === 'image' ? 'image' : (avatar.type === 'preset' ? 'preset' : (avatar.type === 'text' ? 'text' : ''))
  if (!type) return null
  const out = { type }
  if (avatar.text) out.text = String(avatar.text).slice(0, 2)
  if (avatar.color) out.color = String(avatar.color).slice(0, 32)
  if (type === 'image' && avatar.imageDataUrl && String(avatar.imageDataUrl).length <= AVATAR_MAX_CHARS) {
    out.imageDataUrl = String(avatar.imageDataUrl)
    out.zoom = 120
    out.x = 50
    out.y = 50
  }
  return out
}

function parseBroadcastAddrs (value) {
  if (!value) return []
  return String(value).split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean)
}

// 瞬时(非致命)UDP 错误:多为同机多实例 / 对端无监听导致的 ICMP 回执,可安全忽略
function isTransientSockError (err) {
  const code = err && err.code
  return code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'ENETUNREACH' ||
    code === 'EHOSTUNREACH' || code === 'EMSGSIZE' || code === 'ENETDOWN'
}

class P2P extends EventEmitter {
  constructor (opts = {}) {
    super()
    this.id = opts.id || crypto.randomUUID()
    this.name = opts.name || defaultName()
    this.pub = opts.pub || null
    this.privObj = opts.priv ? cryptoMod.importPriv(opts.priv) : null
    this.tport = 0 // TCP 文件端口(由文件传输模块设置后,随 presence 公布)
    this.status = ''
    this.presence = 'online' // 个人状态:online 在线 / busy 忙碌 / away 离开
    this.avatar = publicAvatar(opts.avatar)
    this.anonymous = false
    this.blacklist = new Set()
    this.peers = new Map()      // id -> { id, name, address, uport, pub, lastSeen, online }
    this.keyCache = new Map()   // pubB64 -> derived AES key (Buffer)
    this.seen = []
    this.seenSet = new Set()
    this.discSock = null
    this.uniSock = null
    this.uport = 0
    this.timers = []
    this.started = false
    this.discoveryPort = validPort(opts.discoveryPort)
    this.broadcastAddrs = parseBroadcastAddrs(opts.broadcastAddrs)
    const ifs = localIPv4Interfaces()
    this.localIp = ifs.length ? ifs[0].address : '127.0.0.1'
  }

  displayName () { return this.anonymous ? '匿名' : this.name }

  start () {
    if (this.started) return
    this.started = true
    this.uniSock = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    this.uniSock.on('message', (buf, rinfo) => this._onPacket(buf, rinfo))
    // Windows 上向无监听端口发 UDP 会收到 ICMP 端口不可达,触发 ECONNRESET 等
    // 瞬时错误;这些不致命(socket 仍可收发),不应升级为持久"网络异常"。
    this.uniSock.on('error', (err) => { if (isTransientSockError(err)) return; this.emit('neterror', '单播端口错误:' + err) })
    this.uniSock.bind(0, () => {
      try { this.uport = this.uniSock.address().port } catch (_) { this.uport = 0 }
      this._startDiscovery()
    })
  }

  _startDiscovery () {
    this.discSock = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    this.discSock.on('message', (buf, rinfo) => this._onPacket(buf, rinfo))
    this.discSock.on('error', (err) => { if (isTransientSockError(err)) return; this.emit('neterror', '广播端口错误(' + this.discoveryPort + '):' + err) })
    this.discSock.bind(this.discoveryPort, () => {
      try { this.discSock.setBroadcast(true) } catch (_) {}
      this._sendPresence()
      this.timers.push(setInterval(() => this._sendPresence(), HEARTBEAT_MS))
      this.timers.push(setInterval(() => this._sweep(), SWEEP_MS))
      this.emit('ready', this.getSelf())
    })
  }

  _encode (obj) { return Buffer.from(MAGIC + JSON.stringify(obj), 'utf8') }
  _decode (buf) {
    if (!buf || buf.length <= MAGIC.length) return null
    if (buf.toString('utf8', 0, MAGIC.length) !== MAGIC) return null
    try { return JSON.parse(buf.toString('utf8', MAGIC.length)) } catch (_) { return null }
  }

  _broadcastTargets () {
    const set = new Set(['255.255.255.255'])
    for (const ni of localIPv4Interfaces()) { const b = broadcastAddr(ni); if (b) set.add(b) }
    for (const addr of this.broadcastAddrs) set.add(addr)
    return Array.from(set)
  }

  _presencePacket () {
    return this._encode({ t: 'presence', from: this.id, name: this.displayName(), pub: this.pub, uport: this.uport, tport: this.tport, status: this.status, presence: this.presence, avatar: this.avatar, ts: Date.now() })
  }

  _sendPresence () {
    if (!this.discSock) return
    const pkt = this._presencePacket()
    for (const addr of this._broadcastTargets()) this.discSock.send(pkt, this.discoveryPort, addr, () => {})
  }

  _sendPresenceUnicast (address, uport) {
    if (!this.uniSock || !uport || !address) return
    this.uniSock.send(this._presencePacket(), uport, address, () => {})
  }

  _keyForPub (pubB64) {
    if (!this.privObj || !pubB64) return null
    let key = this.keyCache.get(pubB64)
    if (key) return key
    try { key = cryptoMod.deriveKey(this.privObj, cryptoMod.importPub(pubB64)) } catch (_) { return null }
    this.keyCache.set(pubB64, key)
    return key
  }

  _markSeen (mid) {
    if (!mid) return false
    if (this.seenSet.has(mid)) return true
    this.seenSet.add(mid)
    this.seen.push(mid)
    if (this.seen.length > SEEN_MAX) this.seenSet.delete(this.seen.shift())
    return false
  }

  _upsertPeer (id, name, address, uport, pub, tport, status, avatar, presence) {
    const prev = this.peers.get(id)
    const wasOffline = !prev || !prev.online
    const peer = {
      id,
      name: name || (prev && prev.name) || id.slice(0, 6),
      address: address || (prev && prev.address) || null,
      uport: uport || (prev && prev.uport) || 0,
      tport: tport || (prev && prev.tport) || 0,
      pub: pub || (prev && prev.pub) || null,
      status: status != null ? status : ((prev && prev.status) || ''),
      presence: presence != null ? presence : ((prev && prev.presence) || 'online'),
      avatar: publicAvatar(avatar) || (prev && prev.avatar) || null,
      lastSeen: Date.now(),
      online: true,
    }
    const changed = !prev || prev.name !== peer.name || prev.address !== peer.address || prev.uport !== peer.uport || prev.tport !== peer.tport || prev.pub !== peer.pub || prev.status !== peer.status || prev.presence !== peer.presence || JSON.stringify(prev.avatar || null) !== JSON.stringify(peer.avatar || null) || prev.online !== peer.online
    this.peers.set(id, peer)
    if (wasOffline || changed) this._emitPeers()
    return wasOffline
  }

  _onPacket (buf, rinfo) {
    const m = this._decode(buf)
    if (!m || !m.t || !m.from || m.from === this.id) return
    if (this.blacklist.has(m.from)) return

    if (m.t === 'presence') {
      const firstSeen = this._upsertPeer(m.from, m.name, rinfo.address, m.uport, m.pub, m.tport, m.status, m.avatar, m.presence)
      if (firstSeen) this._sendPresenceUnicast(rinfo.address, m.uport)
      return
    }

    if (m.t === 'bye') {
      const prev = this.peers.get(m.from)
      if (prev && prev.online) { prev.online = false; prev.lastSeen = Date.now(); this.peers.set(m.from, prev); this._emitPeers() }
      return
    }

    if (m.t === 'typing') { this.emit('typing', { from: m.from, to: m.to || null, room: m.room || null }); return }
    if (m.t === 'recall') { this.emit('recall', { from: m.from, scope: m.scope, roomId: m.roomId || null, mid: m.mid }); return }
    if (m.t === 'reaction') { this.emit('reaction', { from: m.from, scope: m.scope, roomId: m.roomId || null, mid: m.mid, emoji: m.emoji }); return }
    if (m.t === 'nudge') { this.emit('nudge', { from: m.from, text: (m.text || '').toString().slice(0, 30) }); return }

    if (m.t === 'room-avatar') {
      const key = this._keyForPub((this.peers.get(m.from) || {}).pub)
      if (!key || !m.enc) return
      let pt; try { pt = JSON.parse(cryptoMod.decrypt(key, m.enc)) } catch (_) { return }
      if (pt && pt.roomId) this.emit('room-avatar', { from: m.from, roomId: pt.roomId, avatar: pt.avatar || null })
      return
    }

    if (m.t === 'msg') {
      if (this._markSeen(m.mid)) return
      this._upsertPeer(m.from, undefined, rinfo.address, m.sport, m.spub) // 名字在密文里,这里只更新地址/公钥
      const key = this._keyForPub(m.spub || (this.peers.get(m.from) || {}).pub)
      if (!key) return
      const blob = m.scope === 'private' ? m.enc : (m.enc && m.enc[this.id])
      if (!blob) return // 群聊里没有发给我的密文
      let pt
      try { pt = JSON.parse(cryptoMod.decrypt(key, blob)) } catch (_) { return }
      this._upsertPeer(m.from, pt.name, rinfo.address, m.sport, m.spub, undefined, undefined, pt.avatar)
      this.emit('message', {
        mid: m.mid,
        scope: m.scope === 'private' ? 'private' : (pt.room ? 'room' : 'group'),
        from: m.from,
        name: pt.name || (this.peers.get(m.from) || {}).name || m.from.slice(0, 6),
        to: m.to || null,
        text: typeof pt.text === 'string' ? pt.text : '',
        room: pt.room || null,
        system: pt.system || null,
        ts: pt.ts || m.ts || Date.now(),
        burn: !!pt.burn,
        ttl: pt.ttl || 10,
        reply: pt.reply || null,
        fwd: pt.fwd || null,
        batch: pt.batch || null,
        avatar: publicAvatar(pt.avatar),
        self: false,
      })
    }
  }

  _sweep () {
    const now = Date.now()
    let changed = false
    for (const [id, p] of this.peers) {
      if (p.online && now - p.lastSeen > OFFLINE_MS) { p.online = false; changed = true }
    }
    if (changed) this._emitPeers()
  }

  _emitPeers () { this.emit('peers', this.getPeers()) }

  // -------- 对外接口 --------
  getSelf () {
    return { id: this.id, name: this.name, localIp: this.localIp, uport: this.uport, port: this.discoveryPort, pub: this.pub, anonymous: this.anonymous, status: this.status, presence: this.presence }
  }

  getPeers () {
    const arr = Array.from(this.peers.values())
      .filter((p) => !this.blacklist.has(p.id))
      .map((p) => ({ id: p.id, name: p.name, address: p.address, online: p.online, hasKey: !!p.pub, pub: p.pub || null, status: p.status || '', presence: p.presence || 'online', avatar: p.avatar || null, lastSeen: p.lastSeen || 0 }))
    arr.sort((a, b) => (a.online === b.online ? a.name.localeCompare(b.name) : a.online ? -1 : 1))
    return arr
  }

  setName (name) {
    name = (name || '').toString().trim().slice(0, 32)
    if (name) { this.name = name; this._sendPresence() }
    return this.getSelf()
  }

  setAnonymous (on) { this.anonymous = !!on; this._sendPresence() }

  setTport (t) { this.tport = t || 0; this._sendPresence() }

  setStatus (s) { this.status = (s || '').toString().slice(0, 40); this._sendPresence() }
  setPresence (p) { this.presence = ['online', 'busy', 'away'].includes(p) ? p : 'online'; this._sendPresence() }
  setAvatar (avatar) { this.avatar = publicAvatar(avatar); this._sendPresence(); this._emitPeers() }

  sendNudge (toId, text) {
    const peer = this.peers.get(toId)
    if (!peer || !peer.online || !peer.uport || !peer.address) return
    this.uniSock.send(this._encode({ t: 'nudge', from: this.id, to: toId, text: (text || '').toString().slice(0, 30) }), peer.uport, peer.address, () => {})
  }

  setBlacklist (arr) { this.blacklist = new Set(Array.isArray(arr) ? arr : []) }

  _buildPlaintext (text, opts) {
    const o = opts || {}
    return JSON.stringify({
      text, name: this.displayName(), avatar: this.avatar,
      burn: !!o.burn, ttl: Math.min(60, Math.max(3, parseInt(o.ttl, 10) || 10)),
      reply: o.reply || null,
      fwd: o.fwd || null, // 转发来源标记 { name, count? }
      batch: o.batch || null, // 同批次(文字+多附件)归组标记
      room: o.room || null,
      system: o.system || null,
      ts: Date.now(),
    })
  }

  _echo (mid, scope, to, text, opts) {
    const o = opts || {}
    return {
      mid, scope, from: this.id, name: this.name, avatar: this.avatar, to: to || null, text, room: o.room || null, system: o.system || null,
      ts: Date.now(), burn: !!o.burn, ttl: Math.min(60, Math.max(3, parseInt(o.ttl, 10) || 10)), reply: o.reply || null, fwd: o.fwd || null, batch: o.batch || null, self: true,
    }
  }

  sendGroup (text, opts) {
    text = (text || '').toString()
    if (!text.trim()) return { ok: false, error: '空消息' }
    const mid = crypto.randomUUID()
    const ts = Date.now()
    this._markSeen(mid)
    const plaintext = this._buildPlaintext(text, opts)
    const enc = {}
    let count = 0
    for (const p of this.peers.values()) {
      if (!p.online || !p.pub || this.blacklist.has(p.id)) continue
      const key = this._keyForPub(p.pub)
      if (!key) continue
      enc[p.id] = cryptoMod.encrypt(key, plaintext)
      count++
    }
    const pkt = this._encode({ t: 'msg', scope: 'group', from: this.id, spub: this.pub, sport: this.uport, mid, ts, enc })
    if (this.discSock) for (const addr of this._broadcastTargets()) this.discSock.send(pkt, this.discoveryPort, addr, () => {})
    return { ok: true, recipients: count, msg: this._echo(mid, 'group', null, text, opts) }
  }

  sendRoom (room, text, opts) {
    text = (text || '').toString()
    if (!text.trim()) return { ok: false, error: '空消息' }
    if (!room || !room.id || !Array.isArray(room.members)) return { ok: false, error: '群聊不存在' }
    const mid = crypto.randomUUID()
    const ts = Date.now()
    this._markSeen(mid)
    const roomMeta = { id: room.id, name: room.name || '群聊', ownerId: room.ownerId || '', members: room.members || [] }
    const plaintext = this._buildPlaintext(text, { ...(opts || {}), room: roomMeta })
    const enc = {}
    let count = 0
    const targets = new Set(room.members)
    for (const id of ((opts && opts.extraRecipients) || [])) targets.add(id)
    for (const id of targets) {
      if (id === this.id || this.blacklist.has(id)) continue
      const p = this.peers.get(id)
      if (!p || !p.online || !p.pub) continue
      const key = this._keyForPub(p.pub)
      if (!key) continue
      enc[id] = cryptoMod.encrypt(key, plaintext)
      count++
    }
    const pkt = this._encode({ t: 'msg', scope: 'room', roomId: room.id, from: this.id, spub: this.pub, sport: this.uport, mid, ts, enc })
    if (this.discSock) for (const addr of this._broadcastTargets()) this.discSock.send(pkt, this.discoveryPort, addr, () => {})
    return { ok: true, recipients: count, msg: this._echo(mid, 'room', null, text, { ...(opts || {}), room: roomMeta }) }
  }

  sendPrivate (toId, text, opts) {
    text = (text || '').toString()
    if (!text.trim()) return { ok: false, error: '空消息' }
    const peer = this.peers.get(toId)
    if (!peer || !peer.online || !peer.address || !peer.uport) return { ok: false, error: '对方离线,暂不可发送' }
    if (!peer.pub) return { ok: false, error: '尚未拿到对方公钥(稍候重试)' }
    const key = this._keyForPub(peer.pub)
    if (!key) return { ok: false, error: '无法建立加密会话' }
    const mid = crypto.randomUUID()
    const ts = Date.now()
    this._markSeen(mid)
    const enc = cryptoMod.encrypt(key, this._buildPlaintext(text, opts))
    const pkt = this._encode({ t: 'msg', scope: 'private', from: this.id, to: toId, spub: this.pub, sport: this.uport, mid, ts, enc })
    this.uniSock.send(pkt, peer.uport, peer.address, () => {})
    return { ok: true, msg: this._echo(mid, 'private', toId, text, opts) }
  }

  sendTyping (toId) {
    const peer = this.peers.get(toId)
    if (!peer || !peer.online || !peer.address || !peer.uport) return
    this.uniSock.send(this._encode({ t: 'typing', from: this.id, to: toId }), peer.uport, peer.address, () => {})
  }

  // 群头像更新:逐成员加密单播(不随普通消息携带,避免 UDP 包超限)
  sendRoomAvatar (room, avatar) {
    if (!room || !room.id || !Array.isArray(room.members)) return
    const payload = JSON.stringify({ roomId: room.id, avatar: avatar || null })
    for (const id of room.members) {
      if (id === this.id) continue
      const peer = this.peers.get(id)
      if (!peer || !peer.online || !peer.pub || !peer.uport || !peer.address) continue
      const key = this._keyForPub(peer.pub)
      if (!key) continue
      const pkt = this._encode({ t: 'room-avatar', from: this.id, enc: cryptoMod.encrypt(key, payload) })
      this.uniSock.send(pkt, peer.uport, peer.address, () => {})
    }
  }

  // 群聊“正在输入”:向所有在线群成员单播,携带群 id
  sendTypingRoom (room) {
    if (!room || !room.id || !Array.isArray(room.members)) return
    const pkt = this._encode({ t: 'typing', from: this.id, room: room.id })
    for (const id of room.members) {
      if (id === this.id) continue
      const peer = this.peers.get(id)
      if (!peer || !peer.online || !peer.address || !peer.uport) continue
      this.uniSock.send(pkt, peer.uport, peer.address, () => {})
    }
  }

  _signal (scope, toId, obj) {
    const pkt = this._encode(obj)
    // 群聊(room)与全员广播一样走广播;非成员收到后因 mid 无匹配会自然忽略
    if (scope === 'group' || scope === 'room') { if (this.discSock) for (const addr of this._broadcastTargets()) this.discSock.send(pkt, this.discoveryPort, addr, () => {}) }
    else { const peer = this.peers.get(toId); if (peer && peer.online && peer.uport && peer.address) this.uniSock.send(pkt, peer.uport, peer.address, () => {}) }
  }
  sendRecall (scope, toId, mid) {
    const obj = { t: 'recall', from: this.id, scope, mid }
    if (scope === 'room') obj.roomId = toId
    this._signal(scope, toId, obj)
  }
  sendReaction (scope, toId, mid, emoji) {
    const obj = { t: 'reaction', from: this.id, scope, mid, emoji }
    if (scope === 'room') obj.roomId = toId
    this._signal(scope, toId, obj)
  }

  sayBye () {
    if (!this.discSock) return
    const pkt = this._encode({ t: 'bye', from: this.id })
    for (const addr of this._broadcastTargets()) { try { this.discSock.send(pkt, this.discoveryPort, addr, () => {}) } catch (_) {} }
  }

  stop () {
    this.sayBye()
    for (const t of this.timers) clearInterval(t)
    this.timers = []
    try { this.discSock && this.discSock.close() } catch (_) {}
    try { this.uniSock && this.uniSock.close() } catch (_) {}
    this.discSock = null
    this.uniSock = null
    this.started = false
  }
}

module.exports = { P2P, DISCOVERY_PORT }
