'use strict'
// 冒烟测试：验证 T19（群聊/长消息 UDP 包超限处理）与 T17（在线成员可靠单播投递）。
// 运行：node test/room-smoke.js   （无需额外依赖，直接复用主进程的 P2P 类）
// 覆盖：
//   1) 超长文本在发送入口被拦截（避免加密后单个 UDP 包超限 EMSGSIZE 静默失败）
//   2) 正常大小群消息会真正广播
//   3) 超限群消息跳过广播但仍返回 ok（交由 main 的可靠单播 sendRoomMember 补达）
//   4) T17：广播缺失时，在线成员仍经单播 + ACK 可靠送达且去重
const assert = require('assert')
const crypto = require('crypto')
const { P2P, MAX_TEXT_CHARS, isTextTooLong } = require('../electron/p2p')
const { generateKeyPair } = require('../electron/crypto')

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  // ---- 1) 文本长度判定：等于上限放行，超过上限拦截 ----
  assert.strictEqual(isTextTooLong('x'.repeat(MAX_TEXT_CHARS)), false, '等于上限不算超长')
  assert.strictEqual(isTextTooLong('x'.repeat(MAX_TEXT_CHARS + 1)), true, '超过上限算超长')

  const ka = generateKeyPair(); const kb = generateKeyPair(); const kc = generateKeyPair()
  const a = new P2P({ id: 'A', name: 'Alice', pub: ka.pub, priv: ka.priv, disableDiscovery: true })
  a.start()
  await wait(300)
  a._upsertPeer('B', 'Bob', '127.0.0.1', 40001, kb.pub)
  a._upsertPeer('C', 'Carol', '127.0.0.1', 40002, kc.pub)
  const room = { id: 'room:t', name: '群', ownerId: 'A', members: ['A', 'B', 'C'] }

  const longText = '一'.repeat(MAX_TEXT_CHARS + 1)
  const rLong = a.sendRoom(room, longText)
  assert(!rLong.ok && /过长/.test(rLong.error || ''), '超长群消息应被拒绝: ' + JSON.stringify(rLong))

  // ---- 2) 正常大小：广播被真正发出 ----
  let bcast = 0
  a.discSock = { send: (...args) => { bcast++; const cb = args[args.length - 1]; if (typeof cb === 'function') cb() } }
  a.setAvatar({ type: 'text', text: 'A' }) // 小头像
  bcast = 0 // 忽略 setAvatar 触发的 presence
  const rOk = a.sendRoom(room, '正常消息')
  assert(rOk.ok && rOk.recipients === 2, '正常群消息应成功且有 2 个在线收件人: ' + JSON.stringify(rOk))
  assert(bcast > 0, '正常大小群消息应触发广播')

  // ---- 3) 超限：广播跳过（避免 EMSGSIZE 静默失败），但仍 ok（交由单播补达） ----
  const bigImg = 'data:image/png;base64,' + 'A'.repeat(32000) // 撑大每成员密文，使整包超 SAFE_DATAGRAM_BYTES
  a.setAvatar({ type: 'image', imageDataUrl: bigImg })
  bcast = 0 // 忽略 setAvatar 触发的 presence
  const rBig = a.sendRoom(room, '附带大头像的消息')
  assert(rBig.ok && rBig.recipients === 2, '超限群消息仍应返回 ok + 收件人（交由单播补达）: ' + JSON.stringify(rBig))
  assert.strictEqual(bcast, 0, '超限群消息广播应被跳过')
  a.stop()

  // ---- 4) T17：广播不可用时，在线成员仍经单播 + ACK 可靠送达且去重 ----
  const a2 = new P2P({ id: 'A2', name: 'A2', pub: ka.pub, priv: ka.priv, disableDiscovery: true })
  const b2 = new P2P({ id: 'B2', name: 'B2', pub: kb.pub, priv: kb.priv, disableDiscovery: true })
  const gotB = []; const statusA = []
  b2.on('message', (m) => gotB.push(m.mid))
  a2.on('msg-status', (s) => statusA.push(s.status + ':' + s.mid))
  a2.start(); b2.start()
  await wait(500)
  a2._upsertPeer('B2', 'B2', '127.0.0.1', b2.uport, kb.pub)
  b2._upsertPeer('A2', 'A2', '127.0.0.1', a2.uport, ka.pub)
  a2.discSock = null // 模拟广播被跳过/不可用：在线成员只能靠单播
  const room2 = { id: 'room:x', name: '群', ownerId: 'A2', members: ['A2', 'B2'] }
  const mid = crypto.randomUUID(); const did = mid + '@B2'
  const r = a2.sendRoomMember('B2', room2, mid, did, '在线成员可靠投递')
  assert(r.ok, '单成员可靠投递应成功')
  await wait(600)
  assert(statusA.includes('delivered:' + did), 'T17：在线成员应收到 ACK→delivered')
  assert.strictEqual(gotB.filter((x) => x === mid).length, 1, 'T17：在线成员应恰好收到一次（去重）')
  a2.stop(); b2.stop()

  console.log('✅ T19 超长拦截 / 超限广播跳过 + T17 在线成员可靠单播 验证通过')
  process.exit(0)
})().catch((e) => { console.error('❌ 测试失败:', e); process.exit(1) })
