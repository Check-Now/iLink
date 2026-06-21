'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const pathutil = require('../electron/pathutil')
const sharespace = require('../electron/sharespace')
const shareHost = require('../electron/sharespace-host')

test('safeFileName strips traversal, reserved names, unsafe suffixes, and invalid characters', () => {
  assert.equal(pathutil.safeFileName('..\\nested\\report.txt'), 'report.txt')
  assert.equal(pathutil.safeFileName('../nested/report.txt'), 'report.txt')
  assert.equal(pathutil.safeFileName('CON', 'file'), 'file')
  assert.equal(pathutil.safeFileName('LPT1.txt', 'file'), 'file')
  assert.equal(pathutil.safeFileName('report. ', 'file'), 'report')
  assert.equal(pathutil.safeFileName('   ', 'fallback.txt'), 'fallback.txt')
  assert.equal(/[\\/:*?"<>|\x00-\x1f]/.test(pathutil.safeFileName('a:b*c?"<>|.txt', 'file')), false)
})

test('safeFileName keeps length bounded while preserving a short extension', () => {
  const out = pathutil.safeFileName('a'.repeat(260) + '.txt', 'file')
  assert.ok(out.length <= pathutil.MAX_FILENAME_LEN)
  assert.ok(out.endsWith('.txt'))
})

test('sharespace uses the same safe file name normalization', () => {
  for (const name of ['CON', 'report. ', '..\\x.png', 'a:b.txt']) {
    assert.equal(sharespace.safeFileName(name, 'file'), pathutil.safeFileName(name, 'file'))
  }
})

test('sharespace-host sanitizes relative paths and reports online state', () => {
  const rel = shareHost.safeShareRelativePath('../CON/nested/a:b.txt', 'fallback.txt')
  const parts = rel.split(/[\\/]+/)
  assert.deepEqual(parts, ['item', 'item', 'nested', 'b.txt'])
  assert.equal(shareHost.safeShareRelativePath('', 'fallback.txt'), 'fallback.txt')

  const space = { spaceId: 's1', hostUserId: 'host' }
  assert.equal(shareHost.isSpaceOnline(space, 'host', []), true)
  assert.equal(shareHost.isSpaceOnline(space, 'self', [{ id: 'host', online: true }]), true)
  assert.equal(shareHost.isSpaceOnline(space, 'self', [{ id: 'host', online: false }]), false)
  assert.equal(shareHost.shareSpaceView(space, 'host', []).online, true)
})

test('share signal controller resolves responses and applies sync events', async () => {
  const sent = []
  const rendered = []
  const spaces = new Map([['space-1', { spaceId: 'space-1', fileCount: 0, updatedAt: 1 }]])
  const cleared = []
  const vault = {
    unlocked: true,
    getShareSpace: (spaceId) => spaces.get(spaceId),
    upsertShareSpace: (sp) => spaces.set(sp.spaceId, sp),
    removeShareSpace: (spaceId) => spaces.delete(spaceId),
    clearShareSnapshot: (spaceId) => cleared.push(spaceId),
  }
  const p2p = {
    sendShare: (peerId, msg) => {
      sent.push({ peerId, msg })
      return { ok: true }
    },
  }
  const controller = new shareHost.ShareSignalController({
    getVault: () => vault,
    getP2P: () => p2p,
    sendToRenderer: (channel, payload) => rendered.push({ channel, payload }),
  })

  const pending = controller.request('host', 'dir_list', { spaceId: 'space-1' })
  assert.equal(sent[0].peerId, 'host')
  assert.equal(sent[0].msg.kind, 'req')
  assert.equal(sent[0].msg.action, 'dir_list')

  assert.equal(controller.handleCommonSignal({ kind: 'res', reqId: sent[0].msg.reqId, data: { ok: true, entries: [] } }), true)
  assert.deepEqual(await pending, { ok: true, entries: [] })

  assert.equal(controller.handleCommonSignal({ kind: 'sync', spaceId: 'space-1', fileCount: 2, updatedAt: 9 }), true)
  assert.deepEqual(cleared, ['space-1'])
  assert.equal(spaces.get('space-1').fileCount, 2)
  assert.equal(spaces.get('space-1').updatedAt, 9)
  assert.deepEqual(rendered[0], { channel: 'share:changed', payload: { spaceId: 'space-1' } })

  controller.notifySync({ spaceId: 'space-1' }, ['u1', 'u2'], { fileCount: 2, updatedAt: 9 }, 'deleted')
  assert.equal(sent.length, 3)
  assert.equal(sent[1].msg.kind, 'sync')
  assert.equal(sent[1].msg.op, 'deleted')
  assert.equal(sent[2].peerId, 'u2')

  assert.equal(controller.handleCommonSignal({ kind: 'sync', spaceId: 'space-1', op: 'deleted' }), true)
  assert.equal(spaces.has('space-1'), false)
})
