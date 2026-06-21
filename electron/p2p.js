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
const { normalizePresence } = require('./constants')
const cryptoMod = require('./crypto')
const { publicAvatar } = require('./avatarutil') // 头像限长/裁剪逻辑与 main 进程共用，避免重复

const DISCOVERY_PORT = 51888
const HEARTBEAT_MS = 2000  // 心跳更频繁，离线判定更快
const OFFLINE_MS = 6000     // 约 3 个心跳未到即判离线（原 10s → 6s）
const SWEEP_MS = 1500       // 更勤地扫描离线
const SEEN_MAX = 800
const ACK_TIMEOUT_MS = 1500 // 私聊消息等待对端 ACK 的超时；超时未确认则重发
const ACK_MAX_RETRY = 3     // 最大重发次数(含首发共 4 次)，全部失败后标记“失败”
const MAX_TEXT_CHARS = 3000        // 单条文本消息字数上限：消息体内嵌头像(≤32KB)+正文加密后须装进一个 UDP 数据报，超长会 EMSGSIZE 静默失败
const { SAFE_DATAGRAM_BYTES, encode: encodePacket, decode: decodePacket } = require('./protocol')
const TEXT_TOO_LONG_ERR = '消息过长，请精简后发送（上限 ' + MAX_TEXT_CHARS + ' 字）'

// 文本是否超过单条消息上限。超长文本加密后会使 UDP 包超限，须在入队/发送前拦截，避免静默失败或发件箱反复重发
function isTextTooLong (text) {
  return (text || '').toString().length > MAX_TEXT_CHARS
}

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

// publicAvatar 已抽到 ./avatarutil（p2p 与 main 进程共用，见顶部 require）

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
    this.peers = new Map()      // id -> { id, name, address, uport, pub, lastSeen, online }
    this.keyCache = new Map()   // pubB64 -> derived AES key (Buffer)
    this.seen = []
    this.seenSet = new Set()
    this.pending = new Map()    // mid -> { toId, pkt, attempts, timer } 等待对端 ACK 的私聊消息
    this._reconnectTimer = null // 断线自愈：退避重连定时器
    this._reconnectAttempts = 0 // 连续重连次数（成功绑定后清零），用于指数退避
    this._closing = false       // stop() 后置真，阻止自愈/重连继续触发
    this._ifSig = null          // 网卡 IPv4 地址签名，变化即触发重连
    this.discSock = null
    this.uniSock = null
    this.uport = 0
    this.timers = []
    this.started = false
    this.discoveryPort = validPort(opts.discoveryPort)
    this.broadcastAddrs = parseBroadcastAddrs(opts.broadcastAddrs)
    this.disableDiscovery = !!opts.disableDiscovery
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
    this.uniSock.on('error', (err) => { if (isTransientSockError(err)) return; this.emit('neterror', '单播端口错误:' + err); this._scheduleReconnect('uniSock ' + ((err && err.code) || err)) })
    this.uniSock.bind(0, () => {
      try { this.uport = this.uniSock.address().port } catch (_) { this.uport = 0 }
      if (this.disableDiscovery) { this.emit('ready', this.getSelf()); return }
      this._startDiscovery()
    })
  }

  _startDiscovery () {
    this.discSock = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    this.discSock.on('message', (buf, rinfo) => this._onPacket(buf, rinfo))
    this.discSock.on('error', (err) => { if (isTransientSockError(err)) return; this.emit('neterror', '广播端口错误(' + this.discoveryPort + '):' + err); this._scheduleReconnect('discSock ' + ((err && err.code) || err)) })
    this.discSock.bind(this.discoveryPort, () => {
      try { this.discSock.setBroadcast(true) } catch (_) {}
      this._reconnectAttempts = 0 // 绑定成功：重置退避计数
      this._ifSig = this._interfaceSignature()
      this._sendPresence()
      this.timers.push(setInterval(() => this._sendPresence(), HEARTBEAT_MS))
      this.timers.push(setInterval(() => this._sweep(), SWEEP_MS))
      this.timers.push(setInterval(() => this._checkInterfaces(), 4000)) // 网卡/IP 变化检测
      this.emit('ready', this.getSelf())
    })
  }

  // -------- 断线自愈：socket 致命错误 / 绑定失败 / 网卡切换后自动重连 --------
  _interfaceSignature () {
    return localIPv4Interfaces().map((n) => n.address).sort().join(',')
  }
  _checkInterfaces () {
    if (this._closing) return
    const sig = this._interfaceSignature()
    if (this._ifSig != null && sig !== this._ifSig) {
      this._ifSig = sig
      console.warn('[p2p] 网卡/IP 变化，自动重连')
      this.reconnect('network change')
    }
  }
  _scheduleReconnect (reason) {
    if (this._closing || this._reconnectTimer) return
    const delay = Math.min(15000, 1000 * Math.pow(2, this._reconnectAttempts)) // 指数退避，封顶 15s
    this._reconnectAttempts++
    console.warn('[p2p] %dms 后重连，原因：%s', delay, reason)
    this._reconnectTimer = setTimeout(() => { this._reconnectTimer = null; this.reconnect(reason) }, delay)
  }
  // 重建 socket（保留身份/peers/待确认消息）；心跳与发现重新开始，对端数秒内重新上线
  reconnect (reason) {
    if (this._closing) return
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null }
    console.warn('[p2p] 重连 socket，原因：%s', reason || '手动')
    this.emit('reconnect', { reason: reason || 'manual' })
    for (const t of this.timers) clearInterval(t)
    this.timers = []
    try { if (this.discSock) { this.discSock.removeAllListeners(); this.discSock.close() } } catch (_) {}
    try { if (this.uniSock) { this.uniSock.removeAllListeners(); this.uniSock.close() } } catch (_) {}
    this.discSock = null
    this.uniSock = null
    this.started = false
    this.start()
  }

  _encode (obj) { return encodePacket(obj) }
  _decode (buf) { return decodePacket(buf) }

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
    this._unicast({ address, uport }, this._presencePacket())
  }

  _unicast (peer, pkt, cb) {
    if (!this.uniSock || !peer || !peer.address || !peer.uport) {
      return false
    }
    try {
      this.uniSock.send(pkt, peer.uport, peer.address, cb || (() => {}))
      return true
    } catch (e) {
      return false
    }
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

    if (m.t === 'presence') {
      const firstSeen = this._upsertPeer(m.from, m.name, rinfo.address, m.uport, m.pub, m.tport, m.status, m.avatar, m.presence)
      this.emit('presence', this.peers.get(m.from))
      if (firstSeen) this._sendPresenceUnicast(rinfo.address, m.uport)
      return
    }

    if (m.t === 'bye') {
      const prev = this.peers.get(m.from)
      if (prev && prev.online) { prev.online = false; prev.lastSeen = Date.now(); this.peers.set(m.from, prev); this._emitPeers() }
      return
    }

    if (m.t === 'typing') { this.emit('typing', { from: m.from, to: m.to || null, room: m.room || null }); return }
    if (m.t === 'recall') {
      this.emit('recall', { from: m.from, scope: m.scope, roomId: m.roomId || null, mid: m.mid })
      // 私聊撤回回 ACK，发送端据此确认送达后停止补发（覆盖对端"假在线"/离线后上线）
      if (m.scope !== 'room') { const peer = this.peers.get(m.from); this._unicast(peer, this._encode({ t: 'recallack', from: this.id, mid: m.mid })) }
      return
    }
    if (m.t === 'recallack') { this.emit('recall-ack', { from: m.from, mid: m.mid }); return }
    if (m.t === 'reaction') { this.emit('reaction', { from: m.from, scope: m.scope, roomId: m.roomId || null, mid: m.mid, emoji: m.emoji }); return }
    if (m.t === 'nudge') { this.emit('nudge', { from: m.from, text: (m.text || '').toString().slice(0, 30) }); return }

    // 群共享空间·加密单播控制信令(请求/响应)：obj 含 { kind:'req'|'res', reqId, action, data }
    if (m.t === 'share') {
      this._upsertPeer(m.from, undefined, rinfo.address, m.sport, m.spub)
      const key = this._keyForPub(m.spub || (this.peers.get(m.from) || {}).pub)
      if (!key || !m.enc) return
      let obj; try { obj = JSON.parse(cryptoMod.decrypt(key, m.enc)) } catch (_) { return }
      if (obj.reqId && this._markSeen('share:' + obj.reqId + ':' + (obj.kind || ''))) return // 同 reqId+kind 去重，避免 UDP 重复包重复处理/重复落地
      this.emit('share', { from: m.from, ...obj })
      return
    }

    // 置顶消息·加密单播控制信令(请求/响应)：obj 含 { kind, reqId, groupIds?, groups? }
    if (m.t === 'pin') {
      this._upsertPeer(m.from, undefined, rinfo.address, m.sport, m.spub)
      const key = this._keyForPub(m.spub || (this.peers.get(m.from) || {}).pub)
      if (!key || !m.enc) return
      let obj; try { obj = JSON.parse(cryptoMod.decrypt(key, m.enc)) } catch (_) { return }
      if (obj.reqId && this._markSeen('pin:' + obj.reqId + ':' + (obj.kind || ''))) return
      this.emit('pin', { from: m.from, ...obj })
      return
    }

    if (m.t === 'room-avatar') {
      const key = this._keyForPub((this.peers.get(m.from) || {}).pub)
      if (!key || !m.enc) return
      let pt; try { pt = JSON.parse(cryptoMod.decrypt(key, m.enc)) } catch (_) { return }
      if (pt && pt.roomId) this.emit('room-avatar', { from: m.from, roomId: pt.roomId, avatar: pt.avatar || null })
      return
    }

    if (m.t === 'ack') { this._onAck(m); return }

    if (m.t === 'msg') {
      this._upsertPeer(m.from, undefined, rinfo.address, m.sport, m.spub) // 名字在密文里,这里只更新地址/公钥
      const key = this._keyForPub(m.spub || (this.peers.get(m.from) || {}).pub)
      if (!key) return
      const blob = m.scope === 'private' ? m.enc : (m.enc && m.enc[this.id])
      if (!blob) return // 群聊里没有发给我的密文
      let pt
      try { pt = JSON.parse(cryptoMod.decrypt(key, blob)) } catch (_) { return }
      // 私聊/群聊单发且发给我:先回 ACK(重复包也回,以覆盖此前丢失的 ACK),再按 mid 去重展示
      // 群聊广播包无 m.to(不回 ACK,best-effort);群聊单发补达包带 m.to+m.did,按 did 回执以区分各成员
      if (m.to === this.id && (m.scope === 'private' || m.scope === 'room')) this._sendAck(m.from, rinfo.address, m.sport, m.did || m.mid)
      if (this._markSeen(m.mid)) return
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
        share: pt.share || null,
        pin: pt.pin || null,
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
  setPresence (p) { this.presence = normalizePresence(p); this._sendPresence() }
  setAvatar (avatar) { this.avatar = publicAvatar(avatar); this._sendPresence(); this._emitPeers() }

  sendNudge (toId, text) {
    const peer = this.peers.get(toId)
    if (!peer || !peer.online || !peer.uport || !peer.address) return
    this._unicast(peer, this._encode({ t: 'nudge', from: this.id, to: toId, text: (text || '').toString().slice(0, 30) }))
  }

  // 群共享空间·加密单播控制信令。obj: { kind, reqId, action, data }。返回 { ok } 或 { ok:false, error }
  // 加密单播控制信令公共实现（share/pin 等共用）：在线/公钥校验 → 会话密钥 → 加密 → 编码 → 超限判断 → 单播。
  // 包结构 { t, from, to, spub, sport, enc } 对各信令保持一致，确保线上字节布局与历史实现等价。
  _sendEncryptedSignal (toId, t, obj, oversizeError) {
    const peer = this.peers.get(toId)
    if (!peer || !peer.online || !peer.uport || !peer.address) return { ok: false, error: '对方离线' }
    if (!peer.pub) return { ok: false, error: '尚未拿到对方公钥' }
    const key = this._keyForPub(peer.pub)
    if (!key) return { ok: false, error: '无法建立加密会话' }
    const enc = cryptoMod.encrypt(key, JSON.stringify(obj || {}))
    const pkt = this._encode({ t, from: this.id, to: toId, spub: this.pub, sport: this.uport, enc })
    if (pkt.length > SAFE_DATAGRAM_BYTES) return { ok: false, error: oversizeError }
    if (!this._unicast(peer, pkt)) return { ok: false, error: 'unicast unavailable' }
    return { ok: true }
  }

  sendShare (toId, obj) { return this._sendEncryptedSignal(toId, 'share', obj, '载荷过大(目录项过多)，请分目录查看') }

  // 置顶消息·加密单播控制信令。obj: { kind, reqId, groupIds?, groups? }。
  sendPinSignal (toId, obj) { return this._sendEncryptedSignal(toId, 'pin', obj, '置顶消息列表过大') }

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
      share: o.share || null, // 共享空间广播载荷(随群系统消息同步，仅聊天框展示)
      pin: o.pin || null, // 置顶消息广播载荷(随群系统消息同步)
      ts: Date.now(),
    })
  }

  _echo (mid, scope, to, text, opts) {
    const o = opts || {}
    return {
      mid, scope, from: this.id, name: this.name, avatar: this.avatar, to: to || null, text, room: o.room || null, system: o.system || null, share: o.share || null, pin: o.pin || null,
      ts: Date.now(), burn: !!o.burn, ttl: Math.min(60, Math.max(3, parseInt(o.ttl, 10) || 10)), reply: o.reply || null, fwd: o.fwd || null, batch: o.batch || null, self: true,
      // 发送状态:私聊 sending->sent->delivered/failed;群聊只标 sent;阅后即焚不跟踪
      status: o.burn ? null : (scope === 'private' ? 'sending' : 'sent'),
    }
  }

  // -------- 私聊消息可靠投递:ACK 确认 + 超时重发 --------
  _sendAck (toId, address, uport, mid) {
    if (!mid) return
    this._unicast({ address, uport }, this._encode({ t: 'ack', from: this.id, to: toId, mid }))
  }
  _onAck (m) {
    const e = this.pending.get(m.mid)
    if (!e) return
    clearTimeout(e.timer)
    this.pending.delete(m.mid)
    this.emit('msg-status', { mid: m.mid, toId: e.toId, status: 'delivered' })
  }
  _trackAck (mid, toId, pkt) {
    const entry = { toId, pkt, attempts: 0, timer: null }
    entry.timer = setTimeout(() => this._retryAck(mid), ACK_TIMEOUT_MS)
    this.pending.set(mid, entry)
  }
  _retryAck (mid) {
    const e = this.pending.get(mid)
    if (!e) return
    const peer = this.peers.get(e.toId)
    if (e.attempts >= ACK_MAX_RETRY || !peer || !peer.online || !peer.address || !peer.uport) {
      this.pending.delete(mid)
      console.warn('[p2p] 私聊消息多次未确认 mid=%s to=%s（交由 main 发件箱择机重发）', mid, e.toId)
      this.emit('msg-status', { mid, toId: e.toId, status: 'failed' }) // main 据此保留发件箱条目，下次 presence 重发
      return
    }
    e.attempts++
    this._unicast(peer, e.pkt)
    e.timer = setTimeout(() => this._retryAck(mid), ACK_TIMEOUT_MS)
  }
  _clearPending (mid) {
    const e = this.pending.get(mid)
    if (e) { clearTimeout(e.timer); this.pending.delete(mid) }
  }
  // 是否可向某对端直发（在线 + 有地址/端口/公钥）
  reachable (toId) {
    const p = this.peers.get(toId)
    return !!(p && p.online && p.address && p.uport && p.pub)
  }
  // 构造一条私聊本端回显（供 main 落库/展示）
  privateEcho (mid, toId, text, opts) {
    const m = this._echo(mid, 'private', toId, text, opts)
    m.mid = mid
    return m
  }
  // 按指定 mid 直发私聊（main 发件箱驱动）：不可达返回 ok:false；对端按 mid 去重；非阅后即焚跟踪 ACK
  resendPrivate (toId, mid, text, opts) {
    text = (text || '').toString()
    const peer = this.peers.get(toId)
    if (!peer || !peer.online || !peer.address || !peer.uport) return { ok: false, error: '对方离线,暂不可发送' }
    if (!peer.pub) return { ok: false, error: '尚未拿到对方公钥(稍候重试)' }
    const key = this._keyForPub(peer.pub)
    if (!key) return { ok: false, error: '无法建立加密会话' }
    const burn = !!(opts && opts.burn)
    this._markSeen(mid)
    this._clearPending(mid)
    const enc = cryptoMod.encrypt(key, this._buildPlaintext(text, opts))
    const pkt = this._encode({ t: 'msg', scope: 'private', from: this.id, to: toId, spub: this.pub, sport: this.uport, mid, ts: Date.now(), enc })
    const sent = this._unicast(peer, pkt, (err) => {
      if (burn) return
      if (err) { this._clearPending(mid); this.emit('msg-status', { mid, toId, status: 'failed' }) }
      else this.emit('msg-status', { mid, toId, status: 'sent' })
    })
    if (!sent) {
      if (!burn) { this._clearPending(mid); this.emit('msg-status', { mid, toId, status: 'failed' }) }
      return { ok: false, error: 'unicast unavailable' }
    }
    if (!burn) this._trackAck(mid, toId, pkt)
    return { ok: true }
  }

  // 广播一条群消息数据报；超过安全上限则跳过广播(交由 main 的可靠单播 sendRoomMember 补达)，避免 EMSGSIZE 被当瞬时错误静默丢弃
  _broadcastMsg (pkt, label) {
    if (!this.discSock) return false
    if (pkt.length > SAFE_DATAGRAM_BYTES) {
      console.warn('[p2p] %s 广播包过大(%d 字节 > %d)，跳过广播，改由单播补达', label || 'room', pkt.length, SAFE_DATAGRAM_BYTES)
      return false
    }
    for (const addr of this._broadcastTargets()) this.discSock.send(pkt, this.discoveryPort, addr, () => {})
    return true
  }

  sendRoom (room, text, opts) {
    text = (text || '').toString()
    if (!text.trim()) return { ok: false, error: '空消息' }
    if (isTextTooLong(text)) return { ok: false, error: TEXT_TOO_LONG_ERR }
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
      if (id === this.id) continue
      const p = this.peers.get(id)
      if (!p || !p.online || !p.pub) continue
      const key = this._keyForPub(p.pub)
      if (!key) continue
      enc[id] = cryptoMod.encrypt(key, plaintext)
      count++
    }
    const pkt = this._encode({ t: 'msg', scope: 'room', roomId: room.id, from: this.id, spub: this.pub, sport: this.uport, mid, ts, enc })
    this._broadcastMsg(pkt, 'room')
    return { ok: true, recipients: count, msg: this._echo(mid, 'room', null, text, { ...(opts || {}), room: roomMeta }) }
  }

  // 群聊离线补达：把一条群消息单发给某个(此前离线、现已上线)成员，并按 did=mid@member 跟踪 ACK。
  // 由 main 的发件箱在该成员 presence 时调用，逻辑与私聊 resendPrivate 一致（单发 + ACK + 超时重发）。
  // did 写入包内，接收端据此回执，使同一 mid 发往多个成员时各自的确认互不串号。
  sendRoomMember (toId, room, mid, did, text, opts) {
    text = (text || '').toString()
    if (!room || !room.id) return { ok: false, error: '群聊不存在' }
    const peer = this.peers.get(toId)
    if (!peer || !peer.online || !peer.address || !peer.uport) return { ok: false, error: '对方离线,暂不可发送' }
    if (!peer.pub) return { ok: false, error: '尚未拿到对方公钥(稍候重试)' }
    const key = this._keyForPub(peer.pub)
    if (!key) return { ok: false, error: '无法建立加密会话' }
    this._markSeen(mid)
    this._clearPending(did)
    const roomMeta = { id: room.id, name: room.name || '群聊', ownerId: room.ownerId || '', members: room.members || [] }
    const enc = { [toId]: cryptoMod.encrypt(key, this._buildPlaintext(text, { ...(opts || {}), room: roomMeta })) }
    const pkt = this._encode({ t: 'msg', scope: 'room', roomId: room.id, from: this.id, to: toId, did, spub: this.pub, sport: this.uport, mid, ts: Date.now(), enc })
    const sent = this._unicast(peer, pkt, (err) => {
      if (err) { this._clearPending(did); this.emit('msg-status', { mid: did, toId, status: 'failed' }) }
      else this.emit('msg-status', { mid: did, toId, status: 'sent' })
    })
    if (!sent) {
      this._clearPending(did)
      this.emit('msg-status', { mid: did, toId, status: 'failed' })
      return { ok: false, error: 'unicast unavailable' }
    }
    this._trackAck(did, toId, pkt) // 接收端回执 mid=did → _onAck(pending.get(did)) → emit delivered{mid:did}
    return { ok: true }
  }

  // 私聊发送已改由 main 的持久化发件箱编排（见 resendPrivate / privateEcho / reachable）

  sendTyping (toId) {
    const peer = this.peers.get(toId)
    if (!peer || !peer.online || !peer.address || !peer.uport) return
    this._unicast(peer, this._encode({ t: 'typing', from: this.id, to: toId }))
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
      this._unicast(peer, pkt)
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
      this._unicast(peer, pkt)
    }
  }

  _signal (scope, toId, obj) {
    const pkt = this._encode(obj)
    // 群聊控制信号先广播，再对已知在线节点单播兜底；重复到达由上层按 from 去重。
    if (scope === 'group' || scope === 'room') {
      if (this.discSock) for (const addr of this._broadcastTargets()) this.discSock.send(pkt, this.discoveryPort, addr, () => {})
      if (this.uniSock) {
        for (const peer of this.peers.values()) {
          if (!peer || !peer.online || !peer.uport || !peer.address) continue
          this._unicast(peer, pkt)
        }
      }
    } else {
      const peer = this.peers.get(toId)
      if (peer && peer.online && peer.uport && peer.address) this._unicast(peer, pkt)
    }
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
    this._closing = true
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null }
    this.sayBye()
    for (const e of this.pending.values()) { try { clearTimeout(e.timer) } catch (_) {} }
    this.pending.clear()
    for (const t of this.timers) clearInterval(t)
    this.timers = []
    try { this.discSock && this.discSock.close() } catch (_) {}
    try { this.uniSock && this.uniSock.close() } catch (_) {}
    this.discSock = null
    this.uniSock = null
    this.started = false
  }
}

module.exports = { P2P, DISCOVERY_PORT, MAX_TEXT_CHARS, isTextTooLong }
