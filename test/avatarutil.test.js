'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const avatar = require('../electron/avatarutil')

test('publicAvatar shares image selection logic with optional thumbnail fallback', () => {
  const small = avatar.publicAvatar({
    type: 'image',
    imageDataUrl: 'data:image/png;base64,small',
    zoom: 300,
    x: -1,
    y: 120,
  })
  assert.equal(small.imageDataUrl, 'data:image/png;base64,small')
  assert.deepEqual({ zoom: small.zoom, x: small.x, y: small.y }, { zoom: 240, x: 0, y: 100 })

  const large = 'data:image/png;base64,' + 'x'.repeat(avatar.AVATAR_MAX_CHARS)
  const stat = 'data:image/jpeg;base64,static'
  assert.equal(avatar.publicAvatar({ type: 'image', imageDataUrl: large, staticDataUrl: stat }).imageDataUrl, stat)

  const thumbed = avatar.publicAvatar({
    type: 'image',
    imageDataUrl: large,
    staticDataUrl: large,
  }, {
    makeThumbnail: (dataUrl) => {
      assert.equal(dataUrl, large)
      return 'data:image/jpeg;base64,thumb'
    },
  })
  assert.equal(thumbed.imageDataUrl, 'data:image/jpeg;base64,thumb')

  const noThumb = avatar.publicAvatar({ type: 'image', imageDataUrl: large, staticDataUrl: large })
  assert.equal(noThumb.imageDataUrl, undefined)

  const color = '#1234567890abcdef1234567890abcdef!'
  assert.deepEqual(avatar.publicAvatar({ type: 'text', text: 'ABC', color }), {
    type: 'text',
    text: 'AB',
    color: color.slice(0, 32),
  })
})
