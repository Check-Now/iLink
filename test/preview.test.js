'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const preview = require('../electron/preview')

test('image previews inline only small images and thumbnail larger ones', () => {
  const reads = []
  const fsSmall = {
    statSync: () => ({ size: 3 }),
    readFileSync: (fp) => { reads.push(fp); return Buffer.from('abc') },
  }

  assert.equal(preview.imagePreviewDataUrl('note.txt', 'text/plain', { fs: fsSmall }), null)
  assert.equal(preview.imagePreviewDataUrl('small.png', 'image/png', { fs: fsSmall, inlineMax: 4 }), 'data:image/png;base64,YWJj')
  assert.deepEqual(reads, ['small.png'])

  let resized = false
  const fsLarge = {
    statSync: () => ({ size: 5 }),
    readFileSync: () => { throw new Error('large images should not be inlined') },
  }
  const nativeImage = {
    createFromPath: () => ({
      isEmpty: () => false,
      getSize: () => ({ width: 960, height: 540 }),
      resize: (opts) => {
        resized = true
        assert.deepEqual(opts, { width: preview.PREVIEW_THUMB_WIDTH, quality: 'good' })
        return { toJPEG: (quality) => Buffer.from('jpg-' + quality) }
      },
    }),
  }

  assert.equal(
    preview.imagePreviewDataUrl('large.png', 'image/png', { fs: fsLarge, nativeImage, inlineMax: 4 }),
    'data:image/jpeg;base64,anBnLTcy'
  )
  assert.equal(resized, true)

  assert.equal(preview.imagePreviewDataUrl('bad.png', 'image/png', {
    fs: fsLarge,
    nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
    inlineMax: 4,
  }), null)
})
