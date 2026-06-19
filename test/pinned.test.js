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
