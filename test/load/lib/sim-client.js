'use strict'
/*
 * SimClient — 模拟客户端。封装一个 P2P 节点（UDP）+ 可选 FileTransfer 节点（TCP）。
 * 直接复用 electron/p2p.js、electron/filetransfer.js，不修改任何业务代码。
 *
 * 协议映射说明（对照通用压测约定）：
 *   - "登录"      → 本地身份(密钥对)装载；可选真实 vault 解锁基准（见 harness.loginBenchmark）。无网络登录。
 *   - "建立连接"  → p2p.start() 绑定 UDP socket（disableDiscovery，节点由 harness 手动注入互联）。
 *   - "心跳"      → 由 harness 周期刷新 peer 活性，镜像真实 presence 2s 心跳（见 harness._heartbeat）。
 *   - "发送单聊"  → p2p.resendPrivate(toId, mid, text)（含 ACK + 超时重发）。
 *   - "发送群聊"  → 逐成员 p2p.sendRoomMember(...)（可靠单播 + did ACK；headless 下广播不可达，故走可靠路径）。
 *   - "ACK/已送达"→ 监听 'msg-status' 事件（sent/delivered/failed）。
 *   - "断开/重连" → simulateDrop()/reconnectUp()（关闭并重建 UDP socket）。
 */

const { P2P } = require('../../../electron/p2p')
const { FileTransfer } = require('../../../electron/filetransfer')

const MAX_CONTENT = 2400 // randomContent 上限，留余量给信封，避免触发业务 MAX_TEXT_CHARS=3000

class SimClient {
  constructor (identity, cfg, collector) {
    this.id = identity.id
    this.name = identity.name
    this.pub = identity.pub
    this.priv = identity.priv
    this.cfg = cfg
    this.col = collector // 全局收集器（跨客户端统计）
    this.harness = null  // 由 harness 注入，用于离线时入发件箱（镜像 main.outboxAdd）
    this.p2p = null
    this.ft = null
    this.tport = 0
    this.online = false
    this._sendIndex = 0
    this.pending = new Map() // mid/did -> {toId,text,kind,room,roomMid} 待 ACK；失败则重新入发件箱（镜像 main 保留 outbox 条目）
    // 每客户端独立日志（用于 clients.csv 与排错）
    this.log = { send: [], recv: [], ack: [], error: [] }
    this.counters = { sent: 0, delivered: 0, failed: 0, recv: 0, errors: 0 }
  }

  // ---- 登录：装载本地身份（无网络）。返回耗时 ms ----
  login () {
    const t0 = Date.now()
    // 身份即密钥对，已在 identity 中。此处仅做"装载"语义占位。
    return Date.now() - t0
  }

  // ---- 建立连接：绑定 UDP socket ----
  connect () {
    return new Promise((resolve) => {
      this.p2p = new P2P({ id: this.id, name: this.name, pub: this.pub, priv: this.priv, disableDiscovery: true })
      this.p2p.on('message', (m) => this._onMessage(m))
      this.p2p.on('msg-status', (s) => this._onStatus(s))
      this.p2p.on('neterror', (e) => this._err('neterror', e))
      this.p2p.on('reconnect', (e) => this._err('reconnect', (e && e.reason) || ''))
      this.p2p.once('ready', () => { this.online = true; resolve(Date.now()) })
      this.p2p.start()
    })
  }

  get uport () { return this.p2p ? this.p2p.uport : 0 }

  // ---- 接收消息 ----
  _onMessage (m) {
    let env = null
    try { env = JSON.parse(m.text) } catch (_) {}
    if (!env || env.r !== this.cfg.testRunId) return // 非本次压测消息忽略
    const recvTime = Date.now()
    const latencyMs = recvTime - (env.t || recvTime)
    const rec = { mid: m.mid, from: m.from, scope: m.scope, sender: env.s, sendIndex: env.i, clientSendTime: env.t, recvTime, latencyMs, receiver: this.id }
    this.log.recv.push(rec)
    this.counters.recv++
    this.col.recv.push(rec)
  }

  // ---- ACK / delivered ----
  _onStatus (s) {
    const rec = { mid: s.mid, toId: s.toId, status: s.status, time: Date.now(), sender: this.id }
    this.log.ack.push(rec)
    this.col.ack.push(rec)
    if (s.status === 'delivered') { this.counters.delivered++; this.pending.delete(s.mid) }
    if (s.status === 'failed') {
      this.counters.failed++
      // ACK 重发耗尽：保留待发并重新入发件箱，等对端 presence 时补发（镜像 main 保留 outbox 条目）
      const p = this.pending.get(s.mid)
      if (p && this.harness) {
        if (p.kind === 'room') this.harness.queueOutbox(p.toId, { senderClient: this, kind: 'room', mid: p.roomMid, room: p.room, text: p.text })
        else this.harness.queueOutbox(p.toId, { senderClient: this, kind: 'private', mid: s.mid, text: p.text })
        this.pending.delete(s.mid)
      }
      this._err('ack-failed-requeued', s.mid)
    }
  }

  _err (kind, detail) {
    const rec = { time: Date.now(), client: this.id, kind, detail: String(detail || '') }
    this.log.error.push(rec); this.counters.errors++; this.col.errors.push(rec)
  }

  _buildEnvelope (scope, dest) {
    const sendIndex = this._sendIndex++
    const mid = this.cfg.testRunId + '.' + this.id + '.' + sendIndex // 唯一 testMessageId（= 业务 mid）
    const size = Math.max(0, Math.min(MAX_CONTENT, this.cfg.payloadSize | 0))
    const randomContent = size ? require('crypto').randomBytes(Math.ceil(size / 2)).toString('hex').slice(0, size) : ''
    const env = { r: this.cfg.testRunId, m: mid, s: this.id, d: dest, i: sendIndex, t: Date.now(), p: size, c: randomContent }
    return { mid, sendIndex, text: JSON.stringify(env) }
  }

  // ---- 发送单聊 ----
  sendPrivate (toId) {
    const { mid, sendIndex, text } = this._buildEnvelope('private', toId)
    const clientSendTime = Date.now()
    const r = this.p2p.resendPrivate(toId, mid, text, {})
    const rec = { mid, scope: 'private', from: this.id, to: toId, members: null, sendIndex, clientSendTime, payloadSize: this.cfg.payloadSize, ok: !!(r && r.ok), error: r && r.error }
    this.log.send.push(rec); this.col.send.push(rec)
    if (r && r.ok) { this.counters.sent++; this.pending.set(mid, { toId, text, kind: 'private' }) }
    else {
      // 对端离线/不可达：入离线发件箱，等对端上线由 harness 补发（镜像 main.outboxAdd + outboxDrain）
      if (this.harness) this.harness.queueOutbox(toId, { senderClient: this, kind: 'private', mid, text })
      this._err('queued-offline', (r && r.error) || 'unreachable')
    }
    return r
  }

  // ---- 发送群聊：逐在线成员可靠单播 ----
  sendGroup (room, onlineMembers) {
    const { mid, sendIndex, text } = this._buildEnvelope('room', room.id)
    const clientSendTime = Date.now()
    const targets = onlineMembers.filter((x) => x !== this.id)
    const rec = { mid, scope: 'room', from: this.id, to: null, members: targets.slice(), sendIndex, clientSendTime, payloadSize: this.cfg.payloadSize, ok: true }
    let okCount = 0
    for (const m of targets) {
      const did = mid + '@' + m
      const r = this.p2p.sendRoomMember(m, room, mid, did, text, {})
      if (r && r.ok) { okCount++; this.pending.set(did, { toId: m, text, kind: 'room', room, roomMid: mid }) }
      else {
        if (this.harness) this.harness.queueOutbox(m, { senderClient: this, kind: 'room', room, mid, text })
        this._err('group-send-queued', (r && r.error) || m)
      }
    }
    rec.ok = okCount > 0
    rec.recipients = okCount
    this.log.send.push(rec); this.col.send.push(rec)
    if (okCount) this.counters.sent++
    return rec
  }

  // ---- 主动断开（保留 peers，关闭 socket，模拟掉线窗口）----
  simulateDrop () {
    const p = this.p2p
    if (!p) return
    this.online = false
    for (const t of p.timers) clearInterval(t)
    p.timers = []
    try { p.discSock && p.discSock.close() } c