'use strict'

const path = require('path')
const { safeFileName } = require('./pathutil')

function isSpaceOnline (sp, selfId, peers) {
  if (!sp) return false
  if (sp.hostUserId === selfId) return true
  const peer = (peers || []).find((p) => p.id === sp.hostUserId)
  return !!(peer && peer.online)
}

function shareSpaceView (sp, selfId, peers) {
  return { ...sp, online: isSpaceOnline(sp, selfId, peers) }
}

function safeShareRelativePath (rel, fallback) {
  const parts = String(rel || '').split(/[\\/]+/).filter(Boolean).map((part) => safeFileName(part, 'item')).filter(Boolean)
  return parts.length ? parts.join(path.sep) : safeFileName(fallback || 'download')
}

module.exports = {
  isSpaceOnline,
  shareSpaceView,
  safeShareRelativePath,
}
