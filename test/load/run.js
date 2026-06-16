'use strict'
/*
 * iLink 压测入口。运行：node test/load/run.js
 * 配置见 ./config.js（全部可用环境变量覆盖）。报告输出到 results/<testRunId>/。
 *
 * 安全：默认仅本机/测试环境；serverUrl 形似生产地址时拒绝运行（除非 ILINK_LT_CONFIRM_PROD=1）。
 */

const cfg = require('./config')
const { Harness } = require('./lib/harness')
const scen = require('./lib/scenarios')
const { fileScenario } = require('./lib/files')
const { verify } = require('./lib/verify')
const { writeReports } = require('./lib/report')
const { sleep } = require('./lib/util')

function assertNotProduction () {
  const u = String(cfg.serverUrl || '').toLowerCase()
  const safe = u === 'local' || u === '' || /(^|\/\/)(127\.0\.0\.1|localhost|::1)/.test(u) ||
    /(^|\/\/)(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(u) || u.startsWith('udp://127.') || u.startsWith('udp://localhost')
  if (!safe && !/^(1|true|yes)$/i.test(process.env.ILINK_LT_CONFIRM_PROD || '')) {
    console.error('\n[安全拦截] serverUrl 看起来不是本机/内网测试地址：' + cfg.serverUrl)
    console.error('为避免压测真实生产环境，已拒绝运行。')
    console.error('若确认是测试环境，请设置 ILINK_LT_CONFIRM_PROD=1 再运行。\n')
    process.exit(2)
  }
}

async function loginBenchmark () {
  const { Vault } = require('../../electron/vault')
  const path = require('path'); const fs = require('fs')
  const n = cfg.loginTest.accounts
  const base = path.join(cfg.testDataDir, 'login-' + cfg.testRunId)
  fs.mkdirSync(base, { recursive: true })
  const setupMs = []; const unlockMs = []
  for (let i = 0; i < n; i++) {
    const v = new Vault(path.join(base, 'acct-' + i))
    let t = Date.now(); await v.setup(cfg.loginTest.password); setupMs.push(Date.now() - t)
    v.lock()
    t = Date.now(); await v.unlock(cfg.loginTest.password); unlockMs.push(Date.now() - t)
  }
  const { stats } = require('./lib/util')
  try { fs.rmSync(base, { recursive: true, force: true }) } catch (_) {}
  return { name: 'login', accounts: n, setupMs: stats(setupMs), unlockMs: stats(unlockMs) }
}

async function main () {
  assertNotProduction()
  console.log('=== iLink 压测开始 testRunId=' + cfg.testRunId + ' ===')
  console.log('用户数=%d 每用户消息=%d 模式=%s QPS=%d', cfg.userCount, cfg.messagePerUser, cfg.sendMode, cfg.qps)

  const collector = { send: [], recv: [], ack: [], errors: [], fileTransfers: [] }
  const h = new Harness(cfg, collector)
  const scenarios = []

  if (cfg.loginTest.enabled) { console.log('· 登录基准...'); scenarios.push(await loginBenchmark()) }

  console.log('· 逐步加压上线 %d 节点（ramp %ds）...', cfg.userCount, cfg.rampUpSeconds)
  const identities = Harness.genIdentities(cfg.userCount)
  await h.bringOnline(identities)
  await sleep(300)

  if (cfg.scenarios.online) { scenarios.push(scen.onlineScenario(h)); console.log('· 在线核验：%d/%d', h.onlineCount(), cfg.userCount) }
  if (cfg.scenarios.privatePairwise) { console.log('· 两两单聊并发...'); scenarios.push(await scen.privatePairwiseScenario(h, cfg)) }
  if (cfg.scenarios.groupBlast) { console.log('· 群聊轰炸...'); scenarios.push(await scen.groupBlastScenario(h, cfg)) }
  if (cfg.scenarios.reconnect) { console.log('· 断线重连...'); scenarios.push(await scen.reconnectScenario(h, cfg)) }
  if (cfg.scenarios.offlineDrain) { console.log('· 离线消息补发...'); scenarios.push(await scen.offlineDrainScenario(h, cfg)) }
  if (cfg.scenarios.file) { console.log('· 文件传输并发...'); scenarios.push(await fileScenario(h, cfg, collector)) }

  // 收尾恢复期：等待在途 ACK 超时判定（最长约 6s），再循环补发离线发件箱直至清空或超时，
  // 镜像真实 app 中"ACK 失败/离线消息留 outbox、presence 时补发"的最终一致性。
  // 等待在途 ACK 判定 + 反复补发，直到"发件箱清空且无在途 ACK"或超时（最长约 7+15*2=37s）
  await sleep(7000)
  for (let i = 0; i < 15; i++) {
    h.refreshPresence(); h.drainAll()
    if (h.outbox.size === 0 && h.pendingAckCount() === 0) break
    await sleep(cfg.engine.heartbeatMs)
  }
  await sleep(cfg.engine.settleMs)

  const resource = h.sampler.summary()
  h.stopAll()

  const verifyRes = verify(collector)
  const { dir, pass } = writeReports({ cfg, collector, scenarios, verifyRes, resource, harness: h })

  console.log('\n=== 结果 ===')
  console.log('计划发送 %d / 实际 %d / 应到达 %d / 收到 %d(唯一 %d)', verifyRes.plannedSendCount, verifyRes.actualSendCount, verifyRes.expectedDeliveries, verifyRes.receiverReceiveCount, verifyRes.uniqueReceivedCount)
  console.log('丢失 %d (私聊 %d/群 %d) | 重复 %d | 乱序 %d | 错误 %d', verifyRes.lostCount, verifyRes.lostPrivate, verifyRes.lostRoom, verifyRes.duplicateCount, verifyRes.outOfOrderCount, verifyRes.errorCount)
  console.log('延迟 avg %dms p95 %dms p99 %dms | ACK %d', verifyRes.avgLatencyMs, verifyRes.p95LatencyMs, verifyRes.p99LatencyMs, verifyRes.serverAckCount)
  console.log('通过标准 %d/%d → %s', pass.passed, pass.total, pass.overall ? '✅ 全部通过' : '❌ 存在未通过')
  console.log('报告目录：' + dir)
  process.exit(pass.overall ? 0 : 1)
}

main().catch((e) => { console.error('压测异常：', e); process.exit(3) })
