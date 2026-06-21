'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const pinned = require('../electron/pinned')

test('pinned helpers derive message type and preview text', () => {
  assert.equal(pinned.pinnedMessageTypeOf({ type: 'file', mime: 'image/png' }), 'image')
  assert.equal(pinned.pinnedMessageTypeOf({ type: 'file', mime: 'application/pdf' }), 'file')
  assert.equal(pinned.pinnedMessageTypeOf({ text: '```js\nconsole.log(1)\n```' }), 'code')
  assert.equal(pinned.pinnedContentPreview({ type: 'file', fname: 'report.pdf' }), '[\u6587\u4ef6] report.pdf')
  assert.equal(pinned.pinnedContentPreview({ text: '' }), '[\u6d88\u606f]')
})

test('public pinned records remove local paths without mutating source', () => {
  const pin = {
    pinId: 'p1',
    messageSnapshot: {
      contentPreview: 'file',
      localPath: 'C:\\temp\\private.txt',
    },
  }
  const out = pinned.publicPinnedRecord(pin)
  assert.equal(out.messageSnapshot.localPath, undefined)
  assert.equal(pin.messageSnapshot.localPath, 'C:\\temp\\private.txt')

  const groups = pinned.publicPinnedGroups([{ groupId: 'g1', pins: [pin] }])
  assert.equal(groups[0].pins[0].messageSnapshot.localPath, undefined)
})

test('pinned controller throttles list requests and filters peer responses', () => {
  const sent = []
  const rendered = []
  const merged = []
  const groups = [
    { id: 'g1', members: ['self', 'peer'] },
    { id: 'g2', members: ['self'] },
    { id: 'g3', members: ['peer'] },
  ]
  const vault = {
    unlocked: true,
    getGroups: () => groups,
    getPinnedMessagesByGroup: () => ({ g1: merged.slice() }),
    getPinnedSyncState: (groupIds) => groupIds.map((groupId) => ({
      groupId,
      pins: [{ pinId: 'local-' + groupId, groupId, messageSnapshot: { localPath: 'C:\\tmp\\pin.txt' } }],
    })),
    mergePinnedMessages: (pins) => {
      merged.push(...pins)
      return { changed: pins.length > 0 }
    },
  }
  const p2p = {
    reachable: (peerId) => peerId === 'peer',
    sendPinSignal: (peerId, msg) => sent.push({ peerId, msg }),
  }
  const controller = new pinned.PinnedController({
    getVault: () => vault,
    getP2P: () => p2p,
    selfId: () => 'self',
    isGroupMember: (group, userId) => (group.members || []).includes(userId),
    sendToRenderer: (channel, payload) => rendered.push({ channel, payload }),
  })

  controller.requestListFromPeer('peer')
  controller.requestListFromPeer('peer')

  assert.equal(sent.length, 1)
  assert.equal(sent[0].peerId, 'peer')
  assert.equal(sent[0].msg.kind, 'pinned_message_list_request')
  assert.deepEqual(sent[0].msg.groupIds, ['g1'])

  controller.onSignal({ from: 'peer', kind: 'pinned_message_list_request', reqId: 'req-1', groupIds: ['g1', 'g2', 'missing'] })
  assert.equal(sent.length, 2)
  assert.equal(sent[1].msg.reqId, 'req-1')
  assert.deepEqual(sent[1].msg.groups.map((g) => g.groupId), ['g1'])
  assert.equal(sent[1].msg.groups[0].pins[0].messageSnapshot.localPath, undefined)

  const allowedPin = { pinId: 'p1', groupId: 'g1' }
  controller.onSignal({
    from: 'peer',
    kind: 'pinned_message_list_response',
    groups: [
      { groupId: 'g1', pins: [allowedPin] },
      { groupId: 'g2', pins: [{ pinId: 'p2', groupId: 'g2' }] },
      { groupId: 'missing', pins: [{ pinId: 'p3', groupId: 'missing' }] },
    ],
  })

  assert.deepEqual(merged, [allowedPin])
  assert.equal(rendered.length, 1)
  assert.equal(rendered[0].channel, 'msg:pinned-list')
  assert.deepEqual(rendered[0].payload, { g1: [allowedPin] })
})
