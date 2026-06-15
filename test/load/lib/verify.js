'use strict'
/* 一致性校验：从收集器计算丢失/重复/乱序/延迟等全部指标。 */

const { stats } = require('./util')

function verify (collector) {
  // 1) 期望到达集合：每条发送的消息应到达的 (mid, receiver) 对（含离线后应补发的）
  const expected = new Map() // key -> {mid, receiver, scope, sender, sendIndex}
  for (const s of collector.send) {
    if (s.scope === 'private') {
      expected.set(s.mid + '|' + s.to, { mid: s.mid, receiver: s.to, scope: 'private', sender: s.from, sendIndex: s.sendIndex })
    } else if (s.scope === 'room' && Array.isArray(s.members)) {
      for (const m of s.members) expected.set(s.mid + '|' + m, { mid: s.mid, receiver: m, scope: 'room', sender: s.from, sendIndex: s.sendIndex })
    }
  }

  // 2) 实际到达：按 (mid, receiver) 计数；记录首次到达延迟与到达顺序
  const recvCount = new Map()
  const firstArrival = new Map()
  for (const r of collector.recv) {
    const key = r.mid + '|' + r.receiver
    recvCount.set(key, (recvCount.get(key) || 0) + 1)
    if (!firstArrival.has(key)) firstArrival.set(key, r)
  }

  // 3) 丢失 / 重复
  const lost = []
  for (const [key, info] of expected) if (!recvCount.has(key)) lost.push(info)
  let duplicateCount = 0
  for (const [, n] of recvCount) if (n > 1) duplicateCount += (n - 1)

  // 4) 乱序：按 (receiver, sender) 流，按到达时间排序，统计 sendIndex 逆序数
  const streams = new Map()
  for (const r of collector.recv) {
    const k = r.receiver + '<-' + r.sender
    if (!streams.has(k)) streams.set(k, new Map()) // mid -> first recv (去重)
    const seen = streams.get(k)
    if (!seen.has(r.mid)) seen.set(r.mid, r)
  }
  let outOfOrderCount = 0
  for (const [, seen] of streams) {
    const arr = Array.from(seen.values()).sort((a, b) => a.recvTime - b.recvTime)
    let maxSeen = -1
    for (const r of arr) { if (r.sendIndex < maxSeen) outOfOrderCount++; else maxSeen = r.sendIndex }
  }

  // 5) 延迟（首次到达）
  const latencies = Array.from(firstArrival.values()).map((r) => r.latencyMs).filter((x) => Number.isFinite(x) && x >= 0)
  const lat = stats(latencies)

  // 6) 计数
  const plannedSendCount = collector.send.length
  const actualSendCount = collector.send.filter((s) => s.ok).length
  const serverAckCount = collector.ack.filter((a) => a.status === 'delivered').length
  const receiverReceiveCount = collector.recv.length
  const uniqueReceived = recvCount.size

  // 按 scope 分解丢失
  const lostPrivate = lost.filter((x) => x.scope === 'private').length
  const lostRoom = lost.filter((x) => x.scope === 'room').length

  return {
    plannedSendCount,
    actualSendCount,
    serverAckCount,
    receiverReceiveCount,
    uniqueReceivedCount: uniqueReceived,
    dbPersistCount: uniqueReceived, // 无独立 DB：以接收端去重落库代理
    expectedDeliveries: expected.size,
    lostCount: lost.length,
    lostPrivate,
    lostRoom,
    duplicateCount,
    outOfOrderCount,
    errorCount: collector.errors.length,
    avgLatencyMs: lat.avg,
    p50LatencyMs: lat.p50,
    p95LatencyMs: lat.p95,
    p99LatencyMs: lat.p99,
    maxLatencyMs: lat.max,
    _latencies: latencies,
    _lostSample: lost.slice(0, 50),
  }
}

module.exports = { verify }
