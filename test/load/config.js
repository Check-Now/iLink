'use strict'
/*
 * iLink 压测配置（独立于业务代码，零侵入）
 * ------------------------------------------------------------------
 * 重要：本项目是纯 P2P / 去中心化架构，没有 WebSocket / HTTP / 登录服务端。
 *   - serverUrl / loginApi / wsUrl 这三项在本项目【不适用】，仅为兼容通用压测约定而保留，
 *     默认指向本机占位地址，并受生产环境保护（见 run.js 的 assertNotProduction）。
 *   - 真实的"连接"= 在同一进程内实例化 electron/p2p.js 的 P2P 类（UDP）与
 *     electron/filetransfer.js 的 FileTransfer 类（TCP），节点间手动注入 peer。
 *   - 真实的"登录"= 本地 vault 解锁（scrypt + AES-GCM），无网络。可选开启 loginTest 做基准。
 *
 * 所有参数均可通过环境变量覆盖：ILINK_LT_<UPPER_SNAKE>，例如 ILINK_LT_USER_COUNT=200。
 */

const path = require('path')

function envNum (k, d) { const v = process.env['ILINK_LT_' + k]; return v == null ? d : Number(v) }
function envStr (k, d) { const v = process.env['ILINK_LT_' + k]; return v == null ? d : v }
function envBool (k, d) { const v = process.env['ILINK_LT_' + k]; return v == null ? d : /^(1|true|yes|on)$/i.test(v) }

const config = {
  // ---- 通用约定字段（本项目不适用，仅占位 + 受生产保护）----
  serverUrl: envStr('SERVER_URL', 'local'),          // 占位：本项目无服务端。非 local/127/内网将被生产保护拦截
  loginApi: envStr('LOGIN_API', 'N/A (local vault unlock)'),
  wsUrl: envStr('WS_URL', 'udp://127.0.0.1:51888 (P2P discovery, 内嵌)'),

  // ---- 规模 / 负载 ----
  userCount: envNum('USER_COUNT', 20),               // 模拟用户(节点)数
  messagePerUser: envNum('MSG_PER_USER', 50),        // 每用户发送消息数
  groupId: envStr('GROUP_ID', 'room:loadtest'),      // 测试群聊 ID
  groupSize: envNum('GROUP_SIZE', 0),                // 群成员数；0=全部用户都在群里
  concurrency: envNum('CONCURRENCY', 20),            // 同时活跃发送的用户并发数
  durationSeconds: envNum('DURATION_SEC', 0),        // 持续模式时长；0=按 messagePerUser 发完即止
  rampUpSeconds: envNum('RAMPUP_SEC', 5),            // 逐步加压时间（用户分批上线/起压）
  sendMode: envStr('SEND_MODE', 'sustained'),        // 'burst' 全员同时发 | 'sustained' 固定 QPS 持续发
  qps: envNum('QPS', 200),                           // sustained 模式全局目标 QPS
  sendIntervalMs: envNum('SEND_INTERVAL_MS', 0),     // 单用户两条消息最小间隔(ms)，0=不限
  payloadSize: envNum('PAYLOAD_SIZE', 200),          // randomContent 字节数（受 2500 上限钳制，避免触发 3000 字限）

  // ---- 场景开关 ----
  scenarios: {
    online: envBool('SC_ONLINE', true),              // 多人同时在线
    privatePairwise: envBool('SC_PRIVATE', true),    // 两两单聊并发
    groupBlast: envBool('SC_GROUP', true),           // 多人轰同一群
    reconnect: envBool('SC_RECONNECT', true),        // 断线重连
    offlineDrain: envBool('SC_OFFLINE', true),       // 离线消息补发
    file: envBool('SC_FILE', true),                  // 文件传输并发
  },

  // ---- 登录基准（可选，真实 vault scrypt 解锁，较慢）----
  loginTest: {
    enabled: envBool('LOGIN_TEST', false),
    accounts: envNum('LOGIN_ACCOUNTS', 10),
    password: envStr('LOGIN_PW', 'loadtest-pw-123'),
  },

  // ---- 断线重连 ----
  reconnect: {
    ratio: envNum('RC_RATIO', 0.3),                  // 随机断开比例
    count: envNum('RC_COUNT', 0),                    // 指定数量断开；>0 时覆盖 ratio
    downMs: envNum('RC_DOWN_MS', 4000),              // 断开后保持离线时长
    simultaneous: envBool('RC_SIMULTANEOUS', true),  // 同时断开 vs 错峰断开
  },

  // ---- 文件传输 ----
  file: {
    senders: envNum('FILE_SENDERS', 10),             // 并发发送方数量
    testFileSizeMB: envNum('FILE_SIZE_MB', 10),      // 单文件大小
    interruptResume: envBool('FILE_RESUME', true),   // 测试中断+断点续传
    scope: envStr('FILE_SCOPE', 'private'),          // private | room
  },

  // ---- 输出 ----
  outputDir: envStr('OUTPUT_DIR', path.join(__dirname, 'results')),
  testDataDir: envStr('TEST_DATA_DIR', path.join(__dirname, '.testdata')), // vault/临时文件隔离目录
  verbose: envBool('VERBOSE', false),

  // ---- 引擎内部 ----
  engine: {
    heartbeatMs: envNum('HEARTBEAT_MS', 2000),       // 模拟 presence 心跳：刷新 peer 活性（镜像真实 2s 心跳）
    settleMs: envNum('SETTLE_MS', 3000),             // 发送完成后等待 ACK/到达收尾的静默期
    loopback: '127.0.0.1',
  },
}

// testRunId：本次运行唯一标识。所有测试数据/消息都带它，便于校验与清理。
config.testRunId = envStr('RUN_ID', 'LT-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + Math.random().toString(36).slice(2, 7))

module.exports = config
