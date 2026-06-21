'use strict'

const crypto = require('crypto')
const path = require('path')
const { safeFileName } = require('./pathutil')

const DEFAULT_REQUEST_TIMEOUT_MS = 8000
const REQUEST_OFFLINE_ERROR = '共享主机离线，暂时不可访问'
const REQUEST_TIMEOUT_ERROR = '请求超时（共享主机无响应）'

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

class ShareSignalController {
  constructor (deps) {
    this.deps = deps || {}
    this.pending = new Map()
  }

  _vault () { return this.deps.getVault ? this.deps.getVault() : null }
  _p2p () { return this.deps.getP2P ? this.deps.getP2P() : null }
  _sendToRenderer (channel, payload) { if (this.deps.sendToRenderer) this.deps.sendToRenderer(channel, payload) }

  ready () {
    const vault = this._vault()
    return !!(vault && vault.unlocked)
  }

  request (hostId, action, data, timeoutMs) {
    return new Promise((resolve) => {
      const p2p = this._p2p()
      if (!p2p) return resolve({ ok: false, error: '网络未就绪' })
      const reqId = crypto.randomUUID()
      const r = p2p.sendShare(hostId, { kind: 'req', reqId, action, data: data || {} })
      if (!r || !r.ok) return resolve({ ok: false, error: (r && r.error) || REQUEST_OFFLINE_ERROR })
      this.waitForResponse(reqId, resolve, timeoutMs || DEFAULT_REQUEST_TIMEOUT_MS, { ok: false, error: REQUEST_TIMEOUT_ERROR })
    })
  }

  waitForResponse (reqId, resolve, timeoutMs, timeoutData) {
    if (!reqId || typeof resolve !== 'function') return
    const timer = setTimeout(() => {
      this.pending.delete(reqId)
      resolve(timeoutData || { ok: false, error: REQUEST_TIMEOUT_ERROR })
    }, timeoutMs || DEFAULT_REQUEST_TIMEOUT_MS)
    this.pending.set(reqId, { resolve, timer })
  }

  cancel (reqId) {
    const pending = this.pending.get(reqId)
    if (!pending) return false
    clearTimeout(pending.timer)
    this.pending.delete(reqId)
    return true
  }

  resolveResponse (reqId, data) {
    const pending = this.pending.get(reqId)
    if (!pending) return false
    clearTimeout(pending.timer)
    this.pending.delete(reqId)
    pending.resolve(data || { ok: false, error: '空响应' })
    return true
  }

  sendResponse (toId, req, data) {
    const p2p = this._p2p()
    if (!p2p || !toId || !req) return
    p2p.sendShare(toId, { kind: 'res', reqId: req.reqId, action: req.action, data })
  }

  handleCommonSignal (msg) {
    if (!msg || !this.ready()) return true
    if (msg.kind === 'res') {
      this.resolveResponse(msg.reqId, msg.data)
      return true
    }
    if (msg.kind !== 'sync') return false
    const vault = this._vault()
    if (msg.spaceId) {
      if (msg.op === 'deleted') vault.removeShareSpace(msg.spaceId)
      else {
        vault.clearShareSnapshot(msg.spaceId)
        const sp = vault.getShareSpace(msg.spaceId)
        if (sp && typeof msg.fileCount === 'number') vault.upsertShareSpace({ ...sp, fileCount: msg.fileCount, updatedAt: msg.updatedAt || sp.updatedAt })
      }
      this._sendToRenderer('share:changed', { spaceId: msg.spaceId })
    }
    return true
  }

  notifySync (sp, memberIds, info, op) {
    const p2p = this._p2p()
    if (!p2p || !sp) return
    const reqId = crypto.randomUUID()
    for (const id of memberIds || []) {
      p2p.sendShare(id, { kind: 'sync', reqId, spaceId: sp.spaceId, op: op || '', fileCount: info ? info.fileCount : undefined, updatedAt: info ? info.updatedAt : undefined })
    }
  }
}

module.exports = {
  ShareSignalController,
  isSpaceOnline,
  shareSpaceView,
  safeShareRelativePath,
}
