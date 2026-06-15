'use strict'
// 冒烟测试：验证 p2p.js 私聊消息的 ACK 送达确认与超时重发失败路径。
// 运行：node test/ack-smoke.js   （无需额外依赖，直接复用主进程的 P2P 类）
// 原理：跳过 UDP 广播发现，手动把对端注入 peers，仅验证单播消息 + ACK + 重发。
// 说明：两个实例会尝试绑定同一发现端口(51888)，在单机上第二个可能 EADDRINUSE，
//      但这只影响广播发现，不影响本测试使用的单播 socket（uniSock）。
const assert = require('assert')
const crypto = require('crypto')
const { P2P } = require('../electron/p2p')
const { generateKeyPair } = require('../electron/crypto')

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  const ka = generateKeyPair()
  const kb = generateKeyPair()
  const a = new P2P({ id: 'A', name: 'Alice', pub: ka.pub, priv: ka.priv, disableDiscovery: true })
  const b = new P2P({ id: 'B', name: 'Bob', pub: kb.pub, priv: kb.priv, disableDiscovery: true })

  const statusA = []
  a.on('msg-status', (s) => statusA.push(s.status + ':' + s.mid))
  const gotByB = []
  b.on('message', (m) => gotByB.push(m.mid))
  const reactionsB = []
  b.on('reaction', (r) => reactionsB.push(r.scope + ':' + r.roomId + ':' + r.mid + ':' + r.emoji))

  a.start(); b.start()
  await wait(600) // 等 uniSock 绑定完成

  // 手动互相注入对端，跳过广播发现
  a._upsertPeer('B', 'Bob', '127.0.0.1', b.uport, kb.pub)
  b._upsertPeer('A', 'Alice', '127.0.0.1', a.uport, ka.pub)
  await wait(100)

  // 1) 正常送达：sending -> sent -> delivered，对端只展示一次
  const mid1 = crypto.randomUUID()
  const echo1 = a.privateEcho(mid1, 'B', '你好')
  const r1 = a.resendPrivate('B', mid1, '你好')
  assert(r1.ok, '发送应成功')
  assert.strictEqual(echo1.status, 'sending', '回显初始状态应为 sending')
  await wait(600)
  assert(statusA.includes('sent:' + mid1), '应出现 sent 状态')
  assert(statusA.includes('delivered:' + mid1), '收到 ACK 后应为 delivered')
  assert.strictEqual(gotByB.filter((x) => x === mid1).length, 1, 'B 应恰好收到一次（去重）')

  // 2) 重发失败：接收端临时拉黑发送端，不回 ACK，重发耗尽后标记 failed
  b.setBlacklist(['A'])
  const mid2 = crypto.randomUUID()
  const r2 = a.resendPrivate('B', mid2, '会失败的消息')
  assert(r2.ok, '进入发送流程应成功')
  await wait(1500 * 4 + 1000) // ACK_TIMEOUT_MS * (MAX_RETRY+1) 余量
  assert(statusA.includes('failed:' + mid2), '重发耗尽后应为 failed')
  assert(!statusA.includes('delivered:' + mid2), 'mid2 不应被送达')

  // 3) 群聊单成员补发：同一 msgMid 重发时，对端回 ACK 但不重复展示
  b.setBlacklist([])
  const room = { id: 'room:test', name: '测试群', ownerId: 'A', members: ['A', 'B'] }
  const roomMid = crypto.randomUUID()
  const did = roomMid + '@B'
  const r3 = a.sendRoomMember('B', room, roomMid, did, '群离线补发')
  assert(r3.ok, '群单成员补发应成功')
  await wait(600)
  assert(statusA.includes('delivered:' + did), '群补发收到 ACK 后应 delivered')
  assert.strictEqual(gotByB.filter((x) => x === roomMid).length, 1, 'B 应收到一次群消息')
  const r4 = a.sendRoomMember('B', room, roomMid, did, '群离线补发')
  assert(r4.ok, '重复补发应仍可发送')
  await wait(600)
  assert.strictEqual(gotByB.filter((x) => x === roomMid).length, 1, '重复补发不应重复展示')

  // 4) 群 reaction：即使广播不可用，也应通过在线节点单播兜底送达
  a.discSock = null
  a.sendReaction('room', room.id, roomMid, '👍')
  await wait(300)
  assert(reactionsB.includes('room:' + room.id + ':' + roomMid + ':👍'), '群 reaction 应能单播送达')

  console.log('msg-status(A):', statusA.join(' | '))
  console.log('\n✅ ACK 送达 / 去重 / 重发失败 / 群补发 / 群 reaction 路径验证通过')
  a.stop(); b.stop()
  process.exit(0)
})().catch((e) => { console.error('❌ 测试失败:', e); process.exit(1) })
