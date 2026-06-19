'use strict'

// 阶段6:大文件 TCP 直连传输(端到端加密) + 断点续传
// 协议(每帧 = 4字节大端长度 + 负载;长度 0 表示结束):
//   帧1 明文握手 { v, from, spub, resume }  —— resume:true 表示发送端支持断点续传
//   (接收端回)帧 明文 { resumeFrom: N }     —— 仅当发送端 resume 时回传;N=本地 .part 已收字节
//   帧2 密文元数据 { mid, fname, size, mime, scope, to, name, sha256, share }
//   帧3.. 密文文件分块(每块独立 AES-256-GCM；发送端从 resumeFrom 偏移开始读发)
//   帧EOF 长度 0  —— 仅此帧表示“发送完毕”;未收到 EOF 即断开视为传输不完整
// 断点续传:接收端保留未完成的 .part；同 mid 再次传输时回传已收字节，发送端从该偏移续发。
// 完整性:收尾对整文件重算 SHA-256 并校验字节数(兼容续传)，任一不符则删 .part 报失败，绝不落盘。
//   用户取消 / 校验失败 → 删除 .part；网络中断 → 保留 .part 供续传。
// 兼容:发送端等 resumeFrom 帧 3s，旧接收端不回则从 0 全量发送;旧发送端无 resume 则接收端全新接收。
// 群共享空间:sendFile 第10参 share 透传共享空间上下文(上传/下载)，随密文元数据下发，done 事件原样回传。

const net = require('net')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { EventEmitter } = require('events')
const cryptoMod = require('./crypto')

const CHUNK = 64 * 1024
const DAY_MS = 24 * 60 * 60 * 1000
const PART_TTL_MS = 7 * DAY_MS    // 残留 .part 续传临时文件保留期，超期自动清理
const SOCKET_TIMEOUT_MS = 30000   // TCP 收发空闲超时（收发双向一致）
const OFFSET_WAIT_MS = 3000       // 等待接收端回传续传偏移的超时；旧端不回则从 0 全量发送
const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  bmp: 'image/bmp', svg: 'image/svg+xml', pdf: 'application/pdf', txt: 'text/plain',
  mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', zip: 'application/zip', rar: 'application/x-rar-compressed',
}
function guessMime (name) { return MIME[(name.split('.').pop() || '').toLowerCase()] || 'application/octet-stream' }

class FileTransfer extends EventEmitter {
  constructor (opts) {
    super()
    this.id = opts.id
    this.pub = opts.pub
    this.privObj = cryptoMod.importPriv(opts.priv)
    this.resolvePeer = opts.resolvePeer
    this.ownName = opts.ownName || (() => '')
    this.keyCache = new Map()
    this.server = null
    this.tport = 0
    this.outbound = new Map() // mid -> { socket, rs } 发送中的传输，支持取消
    this.inbound = new Map()  // mid -> socket 接收中的传输，支持取消
  }

  _keyForPub (pub) {
    if (!pub) return null
    let k = this.keyCache.get(pub)
    if (k) return k
    try { k = cryptoMod.deriveKey(this.privObj, cryptoMod.importPub(pub)) } catch (_) { return null }
    this.keyCache.set(pub, k); return k
  }

  start (onPort) {
    this._purgeStaleParts()
    this.server = net.createServer((socket) => this._onConn(socket))
    this.server.on('error', (e) => this.emit('error', String(e)))
    this.server.listen(0, () => { try { this.tport = this.server.address().port } catch (_) { this.tport = 0 } if (onPort) onPort(this.tport) })
  }

  // 清理超过 7 天的残留续传临时文件，避免无限堆积（近期的保留以便续传）
  _purgeStaleParts () {
    try {
      const dir = os.tmpdir(); const now = Date.now()
      for (const f of fs.readdirSync(dir)) {
        if (!/^freedom-.*\.part$/.test(f)) continue
        const fp = path.join(dir, f)
        try { if (now - fs.statSync(fp).mtimeMs > PART_TTL_MS) fs.unlinkSync(fp) } catch (_) {}
      }
    } catch (_) {}
  }

  stop () {
    try { this.server && this.server.close() } catch (_) {} this.server = null
    for (const e of this.outbound.values()) { try { e.rs && e.rs.destroy() } catch (_) {} try { e.socket && e.socket.destroy() } catch (_) {} }
    for (const e of this.inbound.values()) { try { (e.socket || e).destroy() } catch (_) {} }
    this.outbound.clear(); this.inbound.clear()
  }

  // 取消传输:发送端销毁读流+socket 并报失败;接收端销毁 socket(触发清理临时文件)
  cancel (mid) {
    let hit = false
    const out = this.outbound.get(mid)
    if (out) { try { out.rs && out.rs.destroy() } catch (_) {} try { out.socket && out.socket.destroy() } catch (_) {} this.outbound.delete(mid); this.emit('failed', { mid, canceled: true }); hit = true }
    const inb = this.inbound.get(mid)
    if (inb) { try { (inb.abort ? inb.abort() : (inb.socket || inb).destroy()) } catch (_) {} this.inbound.delete(mid); hit = true }
    return hit
  }

  _writeFrame (socket, buf) {
    const len = Buffer.alloc(4); len.writeUInt32BE(buf.length, 0)
    return socket.write(Buffer.concat([len, buf]))
  }

  // 计算文件 SHA-256(发送前一次性读取),写入元数据供接收端完整性校验
  _hashFile (filePath) {
    return new Promise((resolve, reject) => {
      try {
        const h = crypto.createHash('sha256')
        const rs = fs.createReadStream(filePath)
        rs.on('error', reject)
        rs.on('data', (d) => h.update(d))
        rs.on('end', () => resolve(h.digest('hex')))
      } catch (e) { reject(e) }
    })
  }

  sendFile (toId, filePath, scope, mid, metaTo, batch, sticker, msgMid, msgTs, share) {
    mid = mid || crypto.randomUUID()
    // metaTo:写入元数据的会话归属。私聊=对方 id;群聊(room)=群 id(否则接收端会归错会话)
    if (metaTo == null) metaTo = toId
    let size = 0
    try { size = fs.statSync(filePath).size } catch (_) { this.emit('failed', { mid }); return { mid, error: '文件不存在' } }
    const fname = path.basename(filePath)
    const mime = guessMime(fname)
    const peer = this.resolvePeer(toId)
    if (!peer || !peer.address || !peer.tport || !peer.pub) { this.emit('failed', { mid }); return { mid, fname, size, mime, error: '对方不可达(可能离线或版本不符)' } }
    const key = this._keyForPub(peer.pub)
    if (!key) { this.emit('failed', { mid }); return { mid, fname, size, mime, error: '无加密会话' } }

    // 先启动文件哈希计算(与建连并行);元数据帧需携带 sha256,故在其就绪后再发送
    let sha256 = null
    const hashReady = this._hashFile(filePath).then((h) => { sha256 = h }).catch(() => { sha256 = null })
    const socket = net.connect(peer.tport, peer.address)
    const entry = { socket, rs: null }
    this.outbound.set(mid, entry) // 登记发送中传输，供取消
    socket.on('close', () => { if (this.outbound.get(mid) === entry) this.outbound.delete(mid) })
    socket.on('error', () => this.emit('failed', { mid }))
    socket.setTimeout(SOCKET_TIMEOUT_MS, () => { socket.destroy(); this.emit('failed', { mid }) })
    socket.on('connect', () => {
      socket.setTimeout(0)
      this._writeFrame(socket, Buffer.from(JSON.stringify({ v: 1, from: this.id, spub: this.pub, resume: true }), 'utf8'))
      hashReady.then(() => {
        if (socket.destroyed) return
        this._writeFrame(socket, cryptoMod.encryptBuf(key, Buffer.from(JSON.stringify({ mid, msgMid: msgMid || mid, fname, size, mime, scope: scope || 'private', to: metaTo, name: this.ownName(), batch: batch || null, sticker: !!sticker, ts: msgTs || null, sha256, share: share || null }), 'utf8')))
        // 等接收端回传续传偏移；旧接收端不回，3s 超时后从 0 全量发送（兼容）
        let started = false; let rbuf = Buffer.alloc(0); let offsetTimer = null
        const startStream = (offset) => {
          if (started || socket.destroyed) return
          started = true
          socket.removeListener('data', onOffset)
          if (offsetTimer) { clearTimeout(offsetTimer); offsetTimer = null }
          offset = Math.max(0, Math.min(parseInt(offset, 10) || 0, size))
          const rs = fs.createReadStream(filePath, { highWaterMark: CHUNK, start: offset })
          entry.rs = rs
          let sent = offset
          rs.on('data', (chunk) => {
            const ok = this._writeFrame(socket, cryptoMod.encryptBuf(key, chunk))
            sent += chunk.length
            this.emit('send-progress', { mid, toId, sent, size })
            if (!ok) { rs.pause(); socket.once('drain', () => rs.resume()) }
          })
          rs.on('end', () => { const eof = Buffer.alloc(4); eof.writeUInt32BE(0, 0); socket.write(eof); socket.end(); this.emit('sent', { mid, toId }) })
          rs.on('error', () => { socket.destroy(); this.emit('failed', { mid }) })
        }
        const onOffset = (chunk) => {
          rbuf = Buffer.concat([rbuf, chunk])
          if (rbuf.length < 4) return
          const len = rbuf.readUInt32BE(0)
          if (rbuf.length < 4 + len) return
          let off = 0
          try { off = (JSON.parse(rbuf.subarray(4, 4 + len).toString('utf8')) || {}).resumeFrom || 0 } catch (_) { off = 0 }
          startStream(off)
        }
        socket.on('data', onOffset)
        offsetTimer = setTimeout(() => startStream(0), OFFSET_WAIT_MS)
      })
    })
    return { mid, fname, size, mime }
  }

  _onConn (socket) {
    let buf = Buffer.alloc(0)
    let stage = 'hs'
    let key = null; let from = null; let meta = null; let ws = null; let tempPath = null; let received = 0; let done = false; let finishing = false; let resumeCap = false
    // deletePart=true 删除 .part(取消/校验失败/不可信)；false 保留 .part 以便续传(网络中断)
    const fail = (deletePart) => {
      if (done) return; done = true
      try { ws && ws.destroy() } catch (_) {}
      if (deletePart && tempPath) { try { fs.unlinkSync(tempPath) } catch (_) {} }
      try { socket.destroy() } catch (_) {}
      if (meta) this.emit('failed', { mid: meta.mid })
    }
    const finish = () => {
      if (done || finishing) return
      finishing = true
      try { socket.setTimeout(0) } catch (_) {}
      const verify = () => {
        if (done) return
        let actualSize = -1
        try { actualSize = fs.statSync(tempPath).size } catch (_) {}
        if (!meta || actualSize !== meta.size) {
          console.warn('[filetransfer] 大小不符 mid=%s 期望=%s 实际=%s', meta && meta.mid, meta && meta.size, actualSize)
          finishing = false; return fail(true)
        }
        const commit = () => {
          if (done) return; done = true
          this.emit('done', { mid: meta.msgMid || meta.mid, transferMid: meta.mid, from, name: meta.name, fname: meta.fname, size: meta.size, mime: meta.mime, scope: meta.scope, to: meta.to, batch: meta.batch || null, sticker: !!meta.sticker, ts: meta.ts || null, share: meta.share || null, sha256: meta.sha256 || null, tempPath })
        }
        if (!meta.sha256) return commit() // 旧发送端无 sha256：仅校验大小
        // 对完整 .part 重算 SHA-256（复用 _hashFile；兼容续传：增量哈希无法覆盖续传前已落盘部分）
        this._hashFile(tempPath).then((hex) => {
          if (hex === meta.sha256) commit()
          else { console.warn('[filetransfer] 哈希不符 mid=%s', meta && meta.mid); finishing = false; fail(true) }
        }).catch(() => { finishing = false; fail(true) })
      }
      if (ws) { ws.once('close', verify); try { ws.end() } catch (_) { verify() } }
      else verify()
    }
    const handle = (payload) => {
      if (stage === 'hs') {
        let hs; try { hs = JSON.parse(payload.toString('utf8')) } catch (_) { return fail(true) }
        from = hs.from
        resumeCap = !!hs.resume
        key = this._keyForPub(hs.spub)
        if (!key) return fail(true)
        stage = 'meta'
      } else if (stage === 'meta') {
        try { meta = JSON.parse(cryptoMod.decryptBuf(key, payload).toString('utf8')) } catch (_) { return fail(true) }
        tempPath = path.join(os.tmpdir(), 'freedom-' + (meta.mid || crypto.randomUUID()) + '.part')
        // 断点续传：发送端支持(resume)且本地已有 .part → 从已收字节续传
        let existing = 0
        if (resumeCap) { try { existing = fs.existsSync(tempPath) ? fs.statSync(tempPath).size : 0 } catch (_) { existing = 0 } }
        if (existing > (meta.size || 0)) existing = 0 // 脏数据(超过声明大小) → 重来
        if (existing > 0) { ws = fs.createWriteStream(tempPath, { flags: 'a' }); received = existing }
        else { ws = fs.createWriteStream(tempPath); received = 0 }
        ws.on('error', () => fail(false))
        if (meta.mid) { this.inbound.set(meta.mid, { socket, abort: () => fail(true) }); socket.on('close', () => { const e = this.inbound.get(meta.mid); if (e && e.socket === socket) this.inbound.delete(meta.mid) }) }
        if (resumeCap) this._writeFrame(socket, Buffer.from(JSON.stringify({ resumeFrom: received }), 'utf8')) // 明文控制帧：告知发送端续传偏移
        this.emit('incoming', { mid: meta.mid, from, name: meta.name, fname: meta.fname, size: meta.size, mime: meta.mime, scope: meta.scope })
        stage = 'data'
      } else {
        let plain; try { plain = cryptoMod.decryptBuf(key, payload) } catch (_) { return fail(false) }
        ws.write(plain); received += plain.length
        this.emit('progress', { mid: meta.mid, received, size: meta.size })
      }
    }
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      for (;;) {
        if (buf.length < 4) break
        const len = buf.readUInt32BE(0)
        if (len === 0) { buf = buf.subarray(4); finish(); continue }
        if (buf.length < 4 + len) break
        const payload = buf.subarray(4, 4 + len)
        buf = buf.subarray(4 + len)
        handle(payload)
        if (done) break
      }
    })
    // 未收到 EOF 就断开 = 传输不完整：保留 .part 以便续传（finishing 期间是收尾校验，忽略）
    socket.on('end', () => { if (!done && !finishing && meta) fail(false) })
    socket.on('error', () => { if (!done && !finishing) fail(false) })
    socket.setTimeout(SOCKET_TIMEOUT_MS, () => { if (!done && !finishing) fail(false) })
  }
}

module.exports = { FileTransfer, guessMime }
