'use strict'
/* 压测场景：在线、两两单聊、群聊轰炸、断线重连、离线补发。支持 burst/sustained + 逐步加压。 */

const { sleep } = require('./util')

// 发送节奏控制：burst=全员尽快发；sustained=按全局 QPS 间隔发；duration>0 则按时长持续。
async function pace (ops, cfg) {
  if (cfg.sendMode === 'burst') { for (const op of ops) op(); return }
  const gap = cfg.qps > 0 ? 1000 / cfg.qps : 0
  let next = Date.now()
  for (const op of ops) {
    op()
    if (gap) { next += gap; const d = next - Date.now(); if (d > 0) await sleep(d) }
  }
}

// 轮转展开：让各 sender 的消息交错，避免单用户突发独占
function roundRobin (perSender) {
  const ops = []
  const max = Math.max(0, ...perSender.map((a) => a.length))
  for (let k = 0; k < max; k++) for (const a of perSender) if (a[k]) ops.push(a[k])
  return ops
}

// 多人同时在线（容量观测）—— 实际上线在 harness.bringOnline 完成，这里仅核验在线状态
function onlineScenario (h) {
  const online = h.onlineCount()
  const peerViews = h.clients.map((c) => (c.p2p ? c.p2p.getPeers().filter((p) => p.online).length : 0))
  const expectedPeers = online - 1
  const accurate = peerViews.filter((v) => v === expectedPeers).length
  return {
    name: 'online',
    targetUsers: h.cfg.userCount,
    onlineUsers: online,
    loginSuccessRate: +(online / h.cfg.userCount).toFixed(4),
    presenceAccuracy: h.clients.length ? +(accurate / h.clients.length).toFixed(4) : 0,
    readyMs: h.readyMs.slice(),
  }
}

// 两两单聊并发：相邻配对，双向各发 messagePerUser 条
async function privatePairwiseScenario (h, cfg) {
  const cs = h.clients.filter((c) => c.online)
  const M = cfg.messagePerUser
  const perSender = []
  for (let i = 0; i + 1 < cs.length; i += 2) {
    const a = cs[i]; const b = cs[i + 1]
    const opsA = []; const opsB = []
    for (let k = 0; k < M; k++) { opsA.push(() => a.sendPrivate(b.id)); opsB.push(() => b.sendPrivate(a.id)) }
    perSender.push(opsA, opsB)
  }
  const ops = roundRobin(perSender)
  if (cfg.durationSeconds > 0) await paceDuration(perSender, cfg)
  else await pace(ops, cfg)
  await sleep(cfg.engine.settleMs)
  return { name: 'privatePairwise', pairs: Math.floor(cs.length / 2), planned: ops.length }
}

// 持续模式：按时长循环各 sender 发送，直到 deadline
async function paceDuration (perSender, cfg) {
  const deadline = Date.now() + cfg.durationSeconds * 1000
  const gap = cfg.qps > 0 ? 1000 / cfg.qps : 0
  let next = Date.now(); let idx = 0
  // 各 sender 的发送闭包循环（闭包内部每次调用都会生成新 mid 的消息）
  const senders = perSender.map((a) => a.length ? a[0] : null).filter(Boolean)
  while (Date.now() < deadline && senders.length) {
    senders[idx % senders.length]()
    idx++
    if (gap) { next += gap; const d = next - Date.now(); if (d > 0) await sleep(d) }
  }
}

// 群聊轰炸：建群，所有在线成员向群发送 messagePerUser 条
async function groupBlastScenario (h, cfg) {
  const cs = h.clients.filter((c) => c.online)
  const size = cfg.groupSize > 0 ? Math.min(cfg.groupSize, cs.length) : cs.length
  const members = cs.slice(0, size)
  const memberIds = members.map((c) => c.id)
  const room = { id: cfg.groupId, name: '压测群', ownerId: memberIds[0], members: memberIds }
  const M = cfg.messagePerUser
  const perSender = members.map((sender) => {
    const ops = []
    for (let k = 0; k < M; k++) ops.push(() => sender.sendGroup(room, memberIds))
    return ops
  })
  const ops = roundRobin(perSender)
  if (cfg.durationSeconds > 0) await paceDuration(perSender, cfg)
  else await pace(ops, cfg)
  await sleep(cfg.engine.settleMs)
  return { name: 'groupBlast', groupId: room.id, members: size, planned: ops.length }
}

// 断线重连：按比例/数量选受害者 → 同时/错峰断开 → 期间向其发消息(入发件箱) → 重连重注入 → 补发 → 校验
async function reconnectScenario (h, cfg) {
  const cs = h.clients.filter((c) => c.online)
  const rc = cfg.reconnect
  let victimCount = rc.count > 0 ? rc.count : Math.round(cs.length * rc.ratio)
  victimCount = Math.max(1, Math.min(victimCount, cs.length - 1))
  const victims = cs.slice(0, victimCount)
  const senders = cs.filter((c) => !victims.includes(c))
  const senderPool = senders.length ? senders : cs.filter((c) => !victims.includes(c) || c === cs[cs.length - 1])

  // 断开
  for (const v of victims) { v.simulateDrop(); if (!rc.simultaneous) await sleep(50) }
  h.refreshPresence() // 立即让对端看到离线

  // 期间向受害者发消息（会进入离线发件箱）
  const M = cfg.messagePerUser
  for (const v of victims) {
    const s = senderPool[Math.floor(Math.random() * senderPool.length)] || cs[0]
    for (let k = 0; k < M; k++) s.sendPrivate(v.id)
  }

  await sleep(rc.downMs)

  // 重连并重新注入拓扑
  for (const v of victims) { await v.reconnectUp(); h.rewire(v) }
  h.refreshPresence()

  // 等待补发完成（多个心跳周期）
  const drained = h.drainAll()
  await sleep(Math.max(cfg.engine.settleMs, cfg.engine.heartbeatMs * 2))

  const stillOnline = victims.filter((v) => v.online).length
  return { name: 'reconnect', victims: victimCount, downMs: rc.downMs, reconnected: stillOnline, drained, queuedDuringDown: M * victimCount }
}

// 离线消息补发：把一批接收者离线 → 发消息(入发件箱) → 上线 → 自动补发 → 校验恰好一次
async function offlineDrainScenario (h, cfg) {
  const cs = h.clients.filter((c) => c.online)
  const half = Math.max(1, Math.floor(cs.length / 2))
  const receivers = cs.slice(0, half)
  const senders = cs.slice(half).length ? cs.slice(half) : cs.slice(0, 1)
  const M = Math.max(1, Math.min(cfg.messagePerUser, 50))

  for (const r of receivers) r.simulateDrop()
  h.refreshPresence()

  let planned = 0
  for (const r of receivers) {
    const s = senders[Math.floor(Math.random() * senders.length)]
    if (s === r) continue
    for (let k = 0; k < M; k++) { s.sendPrivate(r.id); planned++ }
  }

  await sleep(500)
  for (const r of receivers) { await r.reconnectUp(); h.rewire(r) }
  h.refreshPresence()
  const drained = h.drainAll()
  await sleep(Math.max(cfg.engine.settleMs, cfg.engine.heartbeatMs * 2))

  return { name: 'offlineDrain', offlineReceivers: receivers.length, plannedWhileOffline: planned, drained }
}

module.exports = { onlineScenario, privatePairwiseScenario, groupBlastScenario, reconnectScenario, offlineDrainScenario }
