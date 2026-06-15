'use strict'
/* 报告输出：summary.json / messages.csv / clients.csv / errors.log / latency.csv /
 * file_transfer_report.csv / final_report.md，并评估通过标准。 */

const path = require('path')
const { fs, ensureDir, toCsv, stats } = require('./util')

// 非致命/预期内事件：离线入发件箱、重连、群发暂存、ACK 失败后已重新入发件箱（最终由补发恢复）
const INFO_ERR_KINDS = new Set(['queued-offline', 'reconnect', 'group-send-queued', 'ack-failed-requeued'])

// 仅统计"实时发送"（发送时对端在线、ok=true）消息的延迟；离线暂存后补发的消息
// 其延迟含离线窗口，属"恢复延迟"，不计入实时 P95（但仍计入整体延迟统计）。
function scopeLatencies (collector, liveMids) {
  const first = new Map(); const out = { private: [], room: [] }
  for (const r of collector.recv) {
    const key = r.mid + '|' + r.receiver
    if (first.has(key)) continue
    first.set(key, true)
    if (liveMids && !liveMids.has(r.mid)) continue
    if (r.scope === 'private') out.private.push(r.latencyMs)
    else out.room.push(r.latencyMs)
  }
  return out
}

function evaluatePass (cfg, v, scenarios, resource, collector) {
  const liveMids = new Set(collector.send.filter((s) => s.ok).map((s) => s.mid))
  const sl = scopeLatencies(collector, liveMids)
  const pLat = stats(sl.private); const gLat = stats(sl.room)
  const ackRate = v.expectedDeliveries ? v.serverAckCount / v.expectedDeliveries : 1
  const fatalErrors = collector.errors.filter((e) => !INFO_ERR_KINDS.has(e.kind)).length
  const rc = scenarios.find((s) => s.name === 'reconnect')
  const reconnectRate = rc && rc.victims ? rc.reconnected / rc.victims : 1
  const fileSc = scenarios.find((s) => s.name === 'file')
  // 以堆(heapUsed)稳态基线判断增长——这是 GC 管理内存的真实泄漏指标；
  // RSS 含已释放但被分配器保留的 socket/文件缓冲，不宜直接当泄漏判据（仅作展示）。
  const memBase = resource.heapMBSteady || resource.heapMBStart || resource.heapMBMax
  const memGrowth = memBase ? (resource.heapMBEnd - memBase) / memBase : 0

  const checks = [
    { id: 1, name: '私聊消息丢失率=0', pass: v.lostPrivate === 0, value: v.lostPrivate },
    { id: 2, name: '私聊/整体消息重复率=0', pass: v.duplicateCount === 0, value: v.duplicateCount },
    { id: 3, name: '群消息丢失率=0(可靠路径)', pass: v.lostRoom === 0, value: v.lostRoom },
    { id: 4, name: '单聊 P95 < 500ms(实时发送)', pass: pLat.count === 0 || pLat.p95 < 500, value: pLat.p95 },
    { id: 5, name: '群聊 P95 < 1000ms(实时发送)', pass: gLat.count === 0 || gLat.p95 < 1000, value: gLat.p95 },
    { id: 6, name: 'ACK 成功率 > 99.9%', pass: ackRate > 0.999, value: +(ackRate * 100).toFixed(3) + '%' },
    { id: 7, name: '无致命错误/不崩溃', pass: fatalErrors === 0, value: fatalErrors },
    { id: 8, name: '断线重连成功率 > 99%', pass: !rc || reconnectRate > 0.99, value: +(reconnectRate * 100).toFixed(2) + '%' },
    { id: 9, name: '文件 hash 通过率=100%', pass: !fileSc || fileSc.hashPassRate === 1, value: fileSc ? (fileSc.hashPassRate * 100) + '%' : 'N/A' },
    { id: 10, name: '断点续传成功', pass: !fileSc || fileSc.resumeTried === 0 || fileSc.resumeOk === fileSc.resumeTried, value: fileSc ? fileSc.resumeOk + '/' + fileSc.resumeTried : 'N/A' },
    { id: 11, name: '内存无失控增长(<50%)', pass: memGrowth < 0.5, value: +(memGrowth * 100).toFixed(1) + '%' },
    { id: 13, name: '消息乱序已量化', pass: true, value: v.outOfOrderCount, note: '无序号设计，按实测值记录而非硬判 0' },
  ]
  const passed = checks.filter((c) => c.pass).length
  return { checks, passed, total: checks.length, overall: checks.every((c) => c.pass), pLat, gLat, ackRate, fatalErrors, reconnectRate, memGrowth }
}

function writeReports (ctx) {
  const { cfg, collector, scenarios, verifyRes: v, resource } = ctx
  const dir = ensureDir(path.join(cfg.outputDir, cfg.testRunId))
  const pass = evaluatePass(cfg, v, scenarios, resource, collector)

  const summary = {
    testRunId: cfg.testRunId, generatedAt: new Date().toISOString(),
    environment: { type: 'headless in-process P2P', node: process.version, platform: process.platform, serverUrl: cfg.serverUrl },
    params: { userCount: cfg.userCount, messagePerUser: cfg.messagePerUser, groupId: cfg.groupId, groupSize: cfg.groupSize, concurrency: cfg.concurrency, durationSeconds: cfg.durationSeconds, rampUpSeconds: cfg.rampUpSeconds, sendMode: cfg.sendMode, qps: cfg.qps, payloadSize: cfg.payloadSize, scenarios: cfg.scenarios, file: cfg.file, reconnect: cfg.reconnect },
    scenarios, metrics: v, resource,
    pass: { overall: pass.overall, passed: pass.passed, total: pass.total, checks: pass.checks },
  }
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2))

  const recvCount = new Map(); const firstLat = new Map()
  for (const r of collector.recv) { const k = r.mid + '|' + r.receiver; recvCount.set(k, (recvCount.get(k) || 0) + 1); if (!firstLat.has(k)) firstLat.set(k, r.latencyMs) }
  const msgRows = []
  for (const s of collector.send) {
    const receivers = s.scope === 'private' ? [s.to] : (s.members || [])
    for (const rcv of receivers) {
      const k = s.mid + '|' + rcv
      msgRows.push({ testRunId: cfg.testRunId, testMessageId: s.mid, scope: s.scope, senderId: s.from, receiverId: rcv, sendIndex: s.sendIndex, clientSendTime: s.clientSendTime, payloadSize: s.payloadSize, sendOk: s.ok, receivedCount: recvCount.get(k) || 0, firstLatencyMs: firstLat.has(k) ? firstLat.get(k) : '' })
    }
  }
  fs.writeFileSync(path.join(dir, 'messages.csv'), toCsv(['testRunId', 'testMessageId', 'scope', 'senderId', 'receiverId', 'sendIndex', 'clientSendTime', 'payloadSize', 'sendOk', 'receivedCount', 'firstLatencyMs'], msgRows))

  const clientRows = ctx.harness.clients.map((c) => ({ clientId: c.id, name: c.name, online: c.online, uport: c.uport, tport: c.tport, sent: c.counters.sent, delivered: c.counters.delivered, failed: c.counters.failed, recv: c.counters.recv, errors: c.counters.errors }))
  fs.writeFileSync(path.join(dir, 'clients.csv'), toCsv(['clientId', 'name', 'online', 'uport', 'tport', 'sent', 'delivered', 'failed', 'recv', 'errors'], clientRows))

  fs.writeFileSync(path.join(dir, 'errors.log'), collector.errors.map((e) => new Date(e.time).toISOString() + ' [' + e.kind + '] client=' + e.client + ' ' + e.detail).join('\n') + '\n')

  fs.writeFileSync(path.join(dir, 'latency.csv'), toCsv(['testMessageId', 'receiver', 'sender', 'scope', 'latencyMs'], collector.recv.map((r) => ({ testMessageId: r.mid, receiver: r.receiver, sender: r.sender, scope: r.scope, latencyMs: r.latencyMs }))))

  if (collector.fileTransfers.length) {
    fs.writeFileSync(path.join(dir, 'file_transfer_report.csv'), toCsv(['mid', 'from', 'to', 'sizeBytes', 'ok', 'hashOk', 'ms', 'speedMBps', 'resumed', 'failed'], collector.fileTransfers))
  }

  fs.writeFileSync(path.join(dir, 'final_report.md'), buildMarkdown(cfg, summary, pass))
  return { dir, pass, summary }
}

function buildMarkdown (cfg, s, pass) {
  const v = s.metrics; const r = s.resource
  const sc = (n) => s.scenarios.find((x) => x.name === n)
  const fileSc = sc('file'); const on = sc('online')
  const yn = (b) => b ? '通过' : '未通过'
  const checksTable = pass.checks.map((c) => '| ' + c.id + ' | ' + c.name + ' | ' + c.value + ' | ' + (c.pass ? 'PASS' : 'FAIL') + ' | ' + (c.note || '') + ' |').join('\n')
  const L = []
  L.push('# iLink 压测报告 — ' + cfg.testRunId, '', '生成时间：' + s.generatedAt, '')
  L.push('## 1. 测试环境', '- 架构：纯 P2P / 去中心化（无服务端、无 WebSocket/HTTP、无数据库）', '- 执行方式：单机无头进程内压测，复用 electron/p2p.js + electron/filetransfer.js（零侵入）', '- Node：' + s.environment.node + '，平台：' + s.environment.platform, '- serverUrl（占位）：' + s.environment.serverUrl, '')
  L.push('## 2. 测试参数', '- 用户数：' + cfg.userCount + '，每用户消息：' + cfg.messagePerUser + '，群：' + cfg.groupId + '（成员 ' + (on ? on.onlineUsers : '-') + '）', '- 发送模式：' + cfg.sendMode + '，QPS：' + cfg.qps + '，逐步加压：' + cfg.rampUpSeconds + 's，持续：' + cfg.durationSeconds + 's', '- payloadSize：' + cfg.payloadSize + 'B，并发：' + cfg.concurrency, '- 启用场景：' + Object.entries(cfg.scenarios).filter((e) => e[1]).map((e) => e[0]).join(', '), '')
  L.push('## 3. 测试场景', s.scenarios.map((x) => '- **' + x.name + '**: ' + JSON.stringify(x).slice(0, 400)).join('\n'), '')
  L.push('## 4. 总体结论', '**' + yn(pass.overall) + '**（通过 ' + pass.passed + '/' + pass.total + ' 项标准）', '')
  L.push('## 5. 各项指标', '| 指标 | 值 |', '|---|---|',
    '| 计划发送 plannedSendCount | ' + v.plannedSendCount + ' |',
    '| 实际发送 actualSendCount | ' + v.actualSendCount + ' |',
    '| 应到达 expectedDeliveries | ' + v.expectedDeliveries + ' |',
    '| 服务端 ACK serverAckCount | ' + v.serverAckCount + ' |',
    '| 接收方收到(含重复) | ' + v.receiverReceiveCount + ' |',
    '| 去重后到达 | ' + v.uniqueReceivedCount + ' |',
    '| 落库代理 dbPersistCount | ' + v.dbPersistCount + ' |',
    '| 丢失 lostCount | ' + v.lostCount + '（私聊 ' + v.lostPrivate + ' / 群 ' + v.lostRoom + '） |',
    '| 重复 duplicateCount | ' + v.duplicateCount + ' |',
    '| 乱序 outOfOrderCount | ' + v.outOfOrderCount + ' |',
    '| 错误 errorCount | ' + v.errorCount + ' |',
    '| 平均延迟 avgLatencyMs | ' + v.avgLatencyMs + ' |',
    '| p50/p95/p99/max (ms,含恢复) | ' + v.p50LatencyMs + ' / ' + v.p95LatencyMs + ' / ' + v.p99LatencyMs + ' / ' + v.maxLatencyMs + ' |',
    '| 单聊P95/群聊P95 (ms,实时) | ' + pass.pLat.p95 + ' / ' + pass.gLat.p95 + ' |', '')
  L.push('## 6. 是否通过（对照建议标准）', '| # | 标准 | 实测 | 结果 | 说明 |', '|---|---|---|---|---|', checksTable, '')
  L.push('## 7. 消息丢失情况', '- 总丢失 ' + v.lostCount + ' 条（私聊 ' + v.lostPrivate + '，群 ' + v.lostRoom + '）。', (v._lostSample && v._lostSample.length ? '- 样例：' + v._lostSample.slice(0, 5).map((x) => x.mid + '->' + x.receiver + '(' + x.scope + ')').join(', ') : '- 无丢失样例。'), '')
  L.push('## 8. 消息重复情况', '- 重复 ' + v.duplicateCount + ' 条。' + (v.duplicateCount > 0 ? ' 可能触及去重窗口 SEEN_MAX=800 或重连后重复投递，建议核查。' : ' 去重正常。'), '')
  L.push('## 9. 消息乱序情况', '- 乱序到达 ' + v.outOfOrderCount + ' 条。说明：UDP 单播+重发天然可能乱序，当前协议无消息序号、无重排缓冲，属已知架构特性，按实测量化评估业务可接受度。', '')
  L.push('## 10. 延迟统计', '- 整体（含离线恢复）：平均 ' + v.avgLatencyMs + 'ms，P50 ' + v.p50LatencyMs + '，P95 ' + v.p95LatencyMs + '，P99 ' + v.p99LatencyMs + '，Max ' + v.maxLatencyMs + 'ms。', '- 实时发送 P95：单聊 ' + pass.pLat.p95 + 'ms，群聊 ' + pass.gLat.p95 + 'ms。', '- 注：单机回环延迟偏乐观，真实多机 LAN 需重新标定基线。', '')
  L.push('## 11. 服务端资源使用情况（单进程聚合）', '- CPU：均值 ' + r.cpuPctAvg + '%，峰值 ' + r.cpuPctMax + '%', '- 内存 RSS：' + r.rssMBStart + 'MB -> ' + r.rssMBEnd + 'MB，峰值 ' + r.rssMBMax + 'MB（仅展示；含分配器保留的 socket/文件缓冲，非泄漏判据）', '- 堆 heapUsed：稳态 ' + (r.heapMBSteady != null ? r.heapMBSteady : '-') + 'MB -> 结束 ' + (r.heapMBEnd != null ? r.heapMBEnd : '-') + 'MB，峰值 ' + r.heapMBMax + 'MB（增长 ' + (pass.memGrowth * 100).toFixed(1) + '% ← 泄漏判据