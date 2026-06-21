'use strict'

const crypto = require('crypto')

const PREVIEW_IMAGE = '[\u56fe\u7247]'
const PREVIEW_FILE = '[\u6587\u4ef6] '
const PREVIEW_CODE = '[\u4ee3\u7801]'
const PREVIEW_MESSAGE = '[\u6d88\u606f]'
const UNTITLED_FILE = '\u672a\u547d\u540d\u6587\u4ef6'
const ELLIPSIS = '\u2026'
const MAX_PREVIEW_CHARS = 80
const PINNED_SYNC_THROTTLE_MS = 10000

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

class PinnedController {
  constructor (deps) {
    this.deps = deps || {}
    this.lastRequest = new Map()
  }

  _vault () { return this.deps.getVault ? this.deps.getVault() : null }
  _p2p () { return this.deps.getP2P ? this.deps.getP2P() : null }
  _selfId () { return this.deps.selfId ? this.deps.selfId() : '' }
  _isGroupMember (group, userId) { return this.deps.isGroupMember ? this.deps.isGroupMember(group, userId) : !!(group && (group.members || []).includes(userId)) }
  _sendToRenderer (channel, payload) { if (this.deps.sendToRenderer) this.deps.sendToRenderer(channel, payload) }

  canUseGroup (group, userId) {
    return this._isGroupMember(group, userId)
  }

  emitMessages () {
    const vault = this._vault()
    if (!vault || !vault.unlocked) return
    this._sendToRenderer('msg:pinned-list', vault.getPinnedMessagesByGroup())
  }

  applyRoomEvent (m) {
    const vault = this._vault()
    const p2p = this._p2p()
    if (!m || !m.room || !m.pin || !vault || !vault.unlocked || !p2p) return
    if (!this.canUseGroup(m.room, this._selfId()) || !this.canUseGroup(m.room, m.from)) return
    const event = m.pin.event || m.system
    const record = m.pin.record || m.pin.pin || null
    if (!record || !record.pinId || !record.groupId) return
    if (event !== 'message_pinned' && event !== 'message_unpinned') return
    const res = vault.mergePinnedMessages([record])
    if (res.changed) {
      this.emitMessages()
      this._sendToRenderer(event === 'message_pinned' ? 'msg:pinned' : 'msg:unpinned', record)
    }
  }

  groupIdsForPeer (peerId) {
    const vault = this._vault()
    const p2p = this._p2p()
    if (!vault || !vault.unlocked || !p2p || !peerId) return []
    return (vault.getGroups() || [])
      .filter((g) => this.canUseGroup(g, this._selfId()) && this.canUseGroup(g, peerId))
      .map((g) => g.id)
  }

  requestListFromPeer (peerId) {
    const vault = this._vault()
    const p2p = this._p2p()
    if (!p2p || !vault || !vault.unlocked || !peerId || !p2p.reachable(peerId)) return
    const groupIds = this.groupIdsForPeer(peerId)
    if (!groupIds.length) return
    const key = peerId + ':' + groupIds.sort().join(',')
    const now = Date.now()
    if (now - (this.lastRequest.get(key) || 0) < PINNED_SYNC_THROTTLE_MS) return
    this.lastRequest.set(key, now)
    p2p.sendPinSignal(peerId, { kind: 'pinned_message_list_request', reqId: 'pinreq:' + crypto.randomUUID(), groupIds, ts: now })
  }

  requestListsFromPeers (peers) {
    for (const peer of peers || []) {
      if (peer && peer.id && peer.online) this.requestListFromPeer(peer.id)
    }
  }

  onSignal (msg) {
    const vault = this._vault()
    const p2p = this._p2p()
    if (!msg || !msg.from || !vault || !vault.unlocked || !p2p) return
    if (msg.kind === 'pinned_message_list_request') {
      const allowed = new Set(this.groupIdsForPeer(msg.from))
      const requested = Array.isArray(msg.groupIds) && msg.groupIds.length ? msg.groupIds.filter((id) => allowed.has(id)) : Array.from(allowed)
      const groups = publicPinnedGroups(vault.getPinnedSyncState(requested))
      p2p.sendPinSignal(msg.from, { kind: 'pinned_message_list_response', reqId: msg.reqId || ('pinres:' + crypto.randomUUID()), groups, ts: Date.now() })
      return
    }
    if (msg.kind !== 'pinned_message_list_response') return
    const allowed = new Set(this.groupIdsForPeer(msg.from))
    const pins = []
    for (const g of msg.groups || []) {
      if (!g || !allowed.has(g.groupId)) continue
      for (const p of g.pins || []) pins.push(p)
    }
    const res = vault.mergePinnedMessages(pins)
    if (res.changed) this.emitMessages()
  }
}

module.exports = {
  PinnedController,
  pinnedMessageTypeOf,
  pinnedContentPreview,
  publicPinnedRecord,
  publicPinnedGroups,
}
