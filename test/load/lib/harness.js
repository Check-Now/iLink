'use strict'
/*
 * Harness — 压测引擎。负责：
 *   - 批量创建 SimClient（模拟用户）
 *   - 逐步加压（ramp-up）让节点分批上线
 *   - 全互联注入 peer（headless 下替代 UDP 广播发现）
 *   - 模拟 presence 心跳：按真实在线状态刷新 peer 活性（镜像真实 2s 心跳）
 *   - 重连后重新注入（节点重连后 uport 变化）
 *   - 离线发件箱模拟（镜像 electron/main.js 的 outboxDrain；main.js 依赖 Electron 无法 headless 加载）
 *   - 进程资源采样
 *
 * 说明（缺失能力的替代方案，对照要求"无法实现请说明并替代"）：
 *   electron/main.js 是 Electron 主进程，require('electron') 无法在纯 node 下加载，
 *   因此其中的发件箱编排(outboxDrain/outboxDrainAll)在此用等价的最小实现复刻，
 *   底层仍调用真实的 p2p.resendPrivate / sendRoomMember，行为一致、零侵入。
 */

const crypto = require('crypto')
const { generateKeyPair } = require('../../../electron/crypto')
const { SimClient } = require('./sim-client')
const { sleep, ResourceSampler } = require('./util')

const LO = '127.0.0.1'

class Harness {
  constructor (cfg, collector) {
    this.cfg = cfg
    this.col = collector
    this.clients = []
    this.byId = new Map()
    this._hbTimer = null
    this.outbox = new Map() // recipientId -> [{ senderClient, kind, mid, text, room, members }]
    this.sampler = new ResourceSampler(1000)
    this.readyMs = [] // 各节点 connect→ready 耗时
  }

  static genIdentities (n) {
    const out = []
    for (let i = 0; i < n; i++) { const kp = generateKeyPair(); out.push({ id: crypto.randomUUID(), name: 'node-' + i, pub: kp.pub, priv: kp.priv }) }
    return out
  }

  // 逐步加压上线：把 userCount 个节点在 rampUpSeconds 内分批 connect
  async bringOnline (identities) {
    this.sampler.start()
    const n = identities.length
    const ramp = Math.max(0, this.cfg.rampUpSeconds) * 1000
    const batchSize = Math.max(1, Math.ceil(n / Math.max(1, Math.round(ramp / 200) || 1)))
    let i = 0
    while (i < n) {
      const batch = identities.slice(i, i + batchSize)
      await Promise.all(batch.map(async (idn) => {
        const c = new SimClient(idn, this.cfg, this.col)
        c.harness = this
        c.login()
        const t0 = Date.now()
        await c.connect()
        this.readyMs.push(Date.now() - t0)
        c.online = true
        this.clients.push(c); this.byId.set(c.id, c)
      }))
      i += batchSize
      if (ramp && i < n) await sleep(Math.max(0, ramp / Math.ceil(n / batchSize)))
    }
    this.wireMesh()
    this._startHeartbeat()
    return this.clients
  }

  // 全互联：把每个在线节点互相注入对方 peer（带真实 uport/pub/tport）
  wireMesh () {
    const online = this.clients.filter((c) => c.online)
    for (const a of online) {
      for (const b of online) {
        if (a.id === b.id) continue
        a.p2p._upsertPeer(b.id, b.name, LO, b.uport, b.pub, b.tport || 0)
      }
    }
  }

  // 重连后：把某节点的新 uport/tport 重新注入所有其它节点，并把所有节点重新注入它
  rewire (c) {
    for (const o of this.clients) {
      if (o.id === c.id || !o.online || !o.p2p) continue
      o.p2p._upsertPeer(c.id, c.name, LO, c.uport, c.pub, c.tport || 0)
      c.p2p._upsertPeer(o.id, o.name, LO, o.uport, o.pub, o.tport || 0)
    }
  }

  // 模拟 presence 心跳：按"客户端真实 online"刷新各节点 peer 活性，避免 _sweep 误判离线，
  // 同时让掉线节点在对端正确转为 offline（offlineDrain/reconnect 场景依赖此真实状态）。
  _startHeartbeat () {
    if (this._hbTimer) return
    this._hbTimer = setInterval(() => this.refreshPresence(), this.cfg.engine.heartbeatMs)
    if (this._hbTimer.unref) this._hbTimer.unref()
  }
  refreshPresence () {
    const now = Date.now()
    for (const c of this.clients) {
      if (!c.online || !c.p2p) continue
      for (const [pid, entry] of c.p2p.peers) {
        const real = this.byId.get(pid)
        if (real && real.online) { entry.lastSeen = now; entry.online = true }
        else { entry.online = false }
      }
    }
    // 对端上线即补发离线发件箱（镜像 main 在 presence 时 outboxDrainAll）
    if (this.outbox.size) this.drainAll()
  }

  // ---- 离线发件箱（复刻 main.outboxDrain）----
  queueOutbox (recipientId, item) {
    if (!this.outbox.has(recipientId)) this.outbox.set(recipientId, [])
    this.outbox.get(recipientId).push(item)
  }
  drainOutbox (recipientId) {
    const items = this.outbox.get(recipientId)
    if (!items || !items.length) return 0
    const recipient = this.byId.get(recipientId)
    if (!recipient || !recipient.online) return 0
    let drained = 0
    const remain = []
    for (const it of items) {
      const sender = it.senderClient
      if (!sender || !sender.online) { remain.push(it); continue }
      let r
      if (it.kind === 'room') r = sender.p2p.sendRoomMember(recipientId, it.room, it.mid, it.mid + '@' + recipientId, it.text, {})
      else r = sender.p2p.resendPrivate(recipientId, it.mid, it.text, {})
      if (r && r.ok) drained++
      else remain.push(it)
    }
    if (remain.length) this.outbox.set(recipientId, remain); else this.outbox.delete(recipientId)
    return drained
  }
  drainAll () { let t = 0; for (const id of Array.from(this.outbox.keys())) t += this.drainOutbox(id); return t }

  onlineCount () { return this.clients.filter((c) => c.online).length }

  // 全网仍在等待 ACK 的消息数（用于收尾恢复期判断是否已静默）
  pendingAckCount () { let n = 0; for (const c of this.clients) n += (c.pending ? c.pending.size : 0); return n }

  stopAll () {
    if (this._hbTimer) clearInterval(this._hbTimer)
    this._hbTimer = null
    this.sampler.stop()
    for (const c of this.clients) c.stop()
  }
}

module.exports = { Harness }
