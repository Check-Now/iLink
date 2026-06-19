'use strict'
// 冒烟测试：验证群置顶消息的本地持久化规则与 P2P 列表同步信令。
// 运行：node test/pinned-messages-smoke.js
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Vault, PINNED_MESSAGE_CAP } = require('../electron/vault')
const { P2P } = require('../electron/p2p')
const { generateKeyPair } = require('../electron/crypto')

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function pinRecord (i, patch) {
  const now = Date.now() + i
  return {
    pinId: 'pin:test:' + i,
    groupId: 'room:test',
    messageId: 'mid:' + i,
    messageSnapshot: {
      messageId: 'mid:' + i,
      senderId: 'A',
      senderName: 'Alice',
      messageType: 'text',
      contentPreview: '消息 ' + i,
      originalContent: '消息 ' + i,
      sentAt: now - 1000,
    },
    senderId: 'A',
    senderName: 'Alice',
    messageType: 'text',
    contentPreview: '消息 ' + i,
    pinnedBy: 'B',
    pinnedByName: 'Bob',
    pinnedAt: now,
    status: 'pinned',
    updatedAt: now,
    ...(patch || {}),
  }
}

;(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ilink-pin-'))
  const vault = new Vault(dir)
  await vault.setup('1234')

  const first = vault.addPinnedMessage(pinRecord(1))
  assert(first.ok, '第一条置顶应成功')
  const duplicate = vault.addPinnedMessage(pinRecord(2, { messageId: 'mid:1', pinId: 'pin:dup' }))
  assert(!duplicate.ok && /已置顶/.test(duplicate.error), '同一 messageId 不应重复置顶')

  for (let i = 2; i <= PINNED_MESSAGE_CAP; i++) {
    const r = vault.addPinnedMessage(pinRecord(i))
    assert(r.ok, '第 ' + i + ' 条置顶应成功')
  }
  const overflow = vault.addPinnedMessage(pinRecord(PINNED_MESSAGE_CAP + 1))
  assert(!overflow.ok && /上限/.test(overflow.error), '超过最大数量应提示先取消旧置顶')

  const unpinned = vault.unpinMessage('room:test', first.pin.pinId, 'C', 'Carol')
  assert(unpinned.ok && unpinned.pin.status === 'unpinned', '取消置顶应保留 unpinned 状态')
  assert(!vault.getPinnedMessages('room:test').some((p) => p.pinId === first.pin.pinId), '取消后不应显示')
  vault.mergePinnedMessages([{ ...first.pin, status: 'pinned', updatedAt: first.pin.pinnedAt }])
  assert(!vault.getPinnedMessages('room:test').some((p) => p.pinId === first.pin.pinId), '旧 pinned 状态不得恢复已取消置顶')
  vault.flush()
  vault.lock()
  fs.rmSync(dir, { recursive: true, force: true })

  const ka = generateKeyPair()
  const kb = generateKeyPair()
  const a = new P2P({ id: 'A', name: 'Alice', pub: ka.pub, priv: ka.priv, disableDiscovery: true })
  const b = new P2P({ id: 'B', name: 'Bob', pub: kb.pub, priv: kb.priv, disableDiscovery: true })
  const gotByB = []
  const gotByA = []
  b.on('pin', (m) => gotByB.push(m))
  a.on('pin', (m) => gotByA.push(m))
  a.start(); b.start()
  await wait(500)
  a._upsertPeer('B', 'Bob', '127.0.0.1', b.uport, kb.pub)
  b._upsertPeer('A', 'Alice', '127.0.0.1', a.uport, ka.pub)
  await wait(100)
  const req = a.sendPinSignal('B', { kind: 'pinned_message_list_request', reqId: 'req:1', groupIds: ['room:test'] })
  assert(req.ok, '置顶列表请求应成功发送')
  await wait(300)
  assert(gotByB.some((m) => m.kind === 'pinned_message_list_request' && m.reqId === 'req:1'), 'B 应收到置顶列表请求')
  const res = b.sendPinSignal('A', { kind: 'pinned_message_list_response', reqId: 'req:1', groups: [{ groupId: 'room:test', pins: [pinRecord(20)] }] })
  assert(res.ok, '置顶列表响应应成功发送')
  await wait(300)
  assert(gotByA.some((m) => m.kind === 'pinned_message_list_response' && m.reqId === 'req:1'), 'A 应收到置顶列表响应')
  a.stop(); b.stop()

  console.log('✅ 群置顶消息存储规则 / 取消墓碑 / P2P 列表同步信令验证通过')
  process.exit(0)
})().catch((e) => { console.error('❌ 测试失败:', e); process.exit(1) })
