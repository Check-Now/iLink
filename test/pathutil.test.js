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
