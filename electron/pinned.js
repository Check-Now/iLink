'use strict'

const PREVIEW_IMAGE = '[\u56fe\u7247]'
const PREVIEW_FILE = '[\u6587\u4ef6] '
const PREVIEW_CODE = '[\u4ee3\u7801]'
const PREVIEW_MESSAGE = '[\u6d88\u606f]'
const UNTITLED_FILE = '\u672a\u547d\u540d\u6587\u4ef6'
const ELLIPSIS = '\u2026'
const MAX_PREVIEW_CHARS = 80

function truncatePreview (text) {
  return text.length > MAX_PREVIEW_CHARS ? text.slice(0, MAX_PREVIEW_CHARS) + ELLIPSIS : text
}

function pinnedMessageTypeOf (m) {
  if (!m) return 'text'
  if (m.type === 'file' || m.type === 'file-offer') return (m.mime || '').indexOf('image/') === 0 ? 'image' : 'file'
  const text = (m.text || '').toString()
  if (/```/.test(text)) return 'code'
  return m.type || 'text'
}

function pinnedContentPreview (m) {
  const type = pinnedMessageTypeOf(m)
  if (type === 'image') return PREVIEW_IMAGE
  if (type === 'file') return PREVIEW_FILE + (m.fname || UNTITLED_FILE)
  if (type === 'code') {
    const body = (m.text || '').toString().replace(/```/g, '').trim()
    return truncatePreview(body ? (PREVIEW_CODE + ' ' + body) : PREVIEW_CODE)
  }
  const text = (m.text || '').toString().trim()
  return text ? truncatePreview(text) : PREVIEW_MESSAGE
}

function publicPinnedRecord (pin) {
  if (!pin) return pin
  const out = JSON.parse(JSON.stringify(pin))
  if (out.messageSnapshot) delete out.messageSnapshot.localPath
  return out
}

function publicPinnedGroups (groups) {
  return (groups || []).map((g) => ({ ...g, pins: (g.pins || []).map(publicPinnedRecord) }))
}

module.exports = {
  pinnedMessageTypeOf,
  pinnedContentPreview,
  publicPinnedRecord,
  publicPinnedGroups,
}
