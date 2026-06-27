'use strict'

const fs = require('fs')

class OutboxController {
  constructor (deps) {
    this.deps = deps || {}
    this.inFlight = new Set()
    this.recallAttempts = new Map()
  }

  _vault () { return this.deps.getVault ? this.deps.getVault() : null }
  _p2p () { return this.deps.getP2P ? this.deps.getP2P() : null }
  _ft () { return this.deps.getFileTransfer ? this.deps.getFileTransfer() : null }
  _getGroupById (groupId) {
    if (this.deps.getGroupById) return this.deps.getGroupById(groupId)
    const vault = this._vault()
    return vault && vault.unlocked ? (vault.getGroups() || []).find((g) => g.id === groupId) : null
  }
  _isGroupMember (group, userId) {
    if (this.deps.isGroupMember) return this.deps.isGroupMember(group, userId)
    return !!(group && (group.members || []).includes(userId))
  }
  _sendToRenderer (channel, payload) { if (this.deps.sendToRenderer) this.deps.sendToRenderer(channel, payload) }
  _log (scope, event, payload) { if (this.deps.logger && this.deps.logger.log) this.deps.logger.log(scope, event, payload) }

  deleteInFlight (mid) {
    if (mid) this.inFlight.delete(mid)
  }

  clearInFlight () {
    this.inFlight.clear()
  }

  setMsgStatusOut (conv, mid, status) {
    const vault = this._vault()
    if (vault && vault.unlocked) vault.setMessageStatus(conv, mid, status)
    this._sendToRenderer('msg:status', { mid, toId: conv, status })
  }

  findItem (mid) {
    const vault = this._vault()
    if (!vault || !vault.unlocked || !mid) return null
    const ob = vault.getOutbox()
    for (const peerId of Object.keys(ob)) {
      const item = (ob[peerId] || []).find((x) => x.mid === mid)
      if (item) return { peerId, item }
    }
    return null
  }

  removeByMid (mid) {
    const vault = this._vault()
    if (!vault || !vault.unlocked || !mid) return false
    const ob = vault.getOutbox()
    for (const peerId of Object.keys(ob)) {
      if ((ob[peerId] || []).some((x) => x.mid === mid)) {
        vault.outboxRemove(peerId, mid)
        return true
      }
    }
    return false
  }

  onRecallAck (from, targetMid) {
    const vault = this._vault()
    if (!vault || !vault.unlocked) return
    const mid = '__recall__' + targetMid
    vault.outboxRemove(from, mid)
    this.recallAttempts.delete(mid)
  }

  onFileSent (p) {
    this.deleteInFlight(p && p.mid)
    const vault = this._vault()
    if (vault && vault.unlocked && p && p.toId && (vault.getOutbox()[p.toId] || []).some((x) => x.mid === p.mid)) {
      vault.outboxRemove(p.toId, p.mid)
      vault.setMessageStatus(p.toId, p.mid, 'sent')
    }
  }

  drain (peerId) {
    const p2p = this._p2p()
    const ft = this._ft()
    const vault = this._vault()
    if (!p2p || !ft || !vault || !vault.unlocked || !p2p.reachable(peerId)) return
    const items = (vault.getOutbox()[peerId] || []).slice()
    for (const it of items) {
      if (this.inFlight.has(it.mid)) continue
      if (it.kind === 'recall') {
        const a = this.recallAttempts.get(it.mid) || 0
        if (a >= 8) { vault.outboxRemove(peerId, it.mid); this.recallAttempts.delete(it.mid); continue }
        this.recallAttempts.set(it.mid, a + 1)
        p2p.sendRecall('private', peerId, it.targetMid)
        continue
      }
      if (it.kind === 'roomtext') {
        const currentRoom = this._getGroupById(it.roomId)
        const room = currentRoom || it.room
        if (!room || (!currentRoom && !it.allowMissingRoom)) { vault.outboxRemove(peerId, it.mid); continue }
        if (currentRoom && !this._isGroupMember(currentRoom, peerId) && !it.allowNonMember) { vault.outboxRemove(peerId, it.mid); continue }
        this.inFlight.add(it.mid)
        const r = p2p.sendRoomMember(peerId, room, it.msgMid, it.mid, it.text, it.opts)
        if (!r || !r.ok) this.inFlight.delete(it.mid)
      } else if (it.kind === 'roomfile') {
        const currentRoom = this._getGroupById(it.roomId)
        const room = currentRoom || it.room
        if (!room || (!currentRoom && !it.allowMissingRoom)) { vault.outboxRemove(peerId, it.mid); continue }
        if (currentRoom && !this._isGroupMember(currentRoom, peerId) && !it.allowNonMember) { vault.outboxRemove(peerId, it.mid); continue }
        // 路径不存在或是文件夹:永久失败,移除,避免无限重发(文件夹无法作为文件发送)
        if (!fs.existsSync(it.path) || fs.statSync(it.path).isDirectory()) { vault.outboxRemove(peerId, it.mid); continue }
        this.inFlight.add(it.mid)
        const r = ft.sendFile(peerId, it.path, 'room', it.mid, it.roomId, it.batch || null, !!it.sticker, it.msgMid, it.ts)
        if (r && r.error) this.inFlight.delete(it.mid)
      } else if (it.kind === 'file') {
        if (!fs.existsSync(it.path) || fs.statSync(it.path).isDirectory()) { vault.outboxRemove(peerId, it.mid); this.setMsgStatusOut(peerId, it.mid, 'failed'); continue }
        this.inFlight.add(it.mid)
        const r = ft.sendFile(peerId, it.path, 'private', it.mid, peerId, it.batch || null, !!it.sticker, it.mid, it.ts)
        if (r && r.error) this.inFlight.delete(it.mid)
      } else {
        this.inFlight.add(it.mid)
        const r = p2p.resendPrivate(peerId, it.mid, it.text, it.opts)
        if (!r || !r.ok) this.inFlight.delete(it.mid)
      }
    }
  }

  drainAll () {
    const vault = this._vault()
    if (!vault || !vault.unlocked) return
    for (const pid of Object.keys(vault.getOutbox())) this.drain(pid)
  }
}

module.exports = { OutboxController }
