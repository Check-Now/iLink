'use strict'

const fs = require('fs')

const PREVIEW_INLINE_MAX = 256 * 1024
const PREVIEW_THUMB_WIDTH = 480
const PREVIEW_THUMB_QUALITY = 72

function imagePreviewDataUrl (fp, mime, opts) {
  if (!mime || mime.indexOf('image/') !== 0) return null
  const o = opts || {}
  const fsMod = o.fs || fs
  const inlineMax = Number.isFinite(o.inlineMax) ? o.inlineMax : PREVIEW_INLINE_MAX
  try {
    const size = fsMod.statSync(fp).size
    if (size <= inlineMax) return 'data:' + mime + ';base64,' + fsMod.readFileSync(fp).toString('base64')
    const nativeImage = o.nativeImage || require('electron').nativeImage
    const img = nativeImage.createFromPath(fp)
    if (!img || img.isEmpty()) return null
    const dim = img.getSize()
    const thumb = dim.width > PREVIEW_THUMB_WIDTH ? img.resize({ width: PREVIEW_THUMB_WIDTH, quality: 'good' }) : img
    return 'data:image/jpeg;base64,' + thumb.toJPEG(PREVIEW_THUMB_QUALITY).toString('base64')
  } catch (_) {
    return null
  }
}

module.exports = {
  PREVIEW_INLINE_MAX,
  PREVIEW_THUMB_WIDTH,
  PREVIEW_THUMB_QUALITY,
  imagePreviewDataUrl,
}
