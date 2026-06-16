'use strict'
// 冒烟测试：共享空间控制信令(share) 加密单播请求→响应往返 + reqId 去重 + 大载荷拒绝。
// 直接复用主进程的 P2P 类。运行：node test/sharespace-signal-smoke.js
const assert = require('assert')
const { P2P } = require('../electron/p2p')
const { generateKeyPair } = require('../electron/crypto')
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  const ka = generateKeyPair(); const kb = generateKeyPair()
  const a = new P2P({ id: 'A', name: 'A', pub: ka.pub, priv: ka.priv, disableDiscovery: true })
  const b = new P2P({ id: 'B', name: 'B', pub: kb.pub, priv: kb.priv, disableDiscovery: true })
  a.start(); b.start()
  await wait(300)
  a._upsertPeer('B', 'B', '127.0.0.1', b.uport, kb.pub)
  b._upsertPeer('A', 'A', '127.0.0.1', a.uport, ka.pub)

  const bReqs = []; const aResps = []
  b.on('share', (msg) => {
    if (msg.kind === 'req') { bReqs.push(msg); b.sendShare(msg.from, { kind: 'res', reqId: msg.reqId, action: msg.action, data: { entries: ['a.txt', 'b.txt'], parentId: msg.data.parentId } }) }
  })
  a.on('share', (msg) => { if (msg.kind === 'res') aResps.push(msg) })

  const r = a.sendShare('B', { kind: 'req', reqId: 'req-1', action: 'dir_list', data: { spaceId: 'sp', parentId: 'root' } })
  assert.ok(r.ok, 'sendShare 应成功')
  await wait(400)
  assert.strictEqual(bReqs.length, 1, '宿主应收到1次请求')
  assert.strictEqual(bReqs[0].data.spaceId, 'sp', '请求载荷正确解密')
  assert.strictEqual(aResps.length, 1, '成员应收到1次响应')
  assert.deepStrictEqual(aResps[0].data.entries, ['a.txt', 'b.txt'], '响应载荷正确解密')

  // reqId+kind 去重：重复响应被丢弃
  b.sendShare('A', { kind: 'res', reqId: 'req-1', action: 'dir_list', data: { entries: ['dup'] } })
  b.sendShare('A', { kind: 'res', reqId: 'req-1', action: 'dir_list', data: { entries: ['dup'] } })
  await wait(300)
  assert.strictEqual(aResps.filter((x) => x.reqId === 'req-1').length, 1, '同一响应仅投递一次(去重)')

  // 大载荷拒绝（避免 UDP 超限）
  const big = a.sendShare('B', { kind: 'req', reqId: 'big', action: 'x', data: { blob: 'z'.repeat(70000) } })
  assert.ok(!big.ok && /过大/.test(big.error || ''), '超大载荷应被拒绝')

  a.stop(); b.stop()
  console.log('✅ 共享空间信令（加密往返 + reqId 去重 + 大载荷拒绝）验证通过')
  process.exit(0)
})().catch((e) => { console.error('❌ 测试失败:', e); process.exit(1) })
