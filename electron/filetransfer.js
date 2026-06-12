'use strict'

// 阶段6:大文件 TCP 直连传输(端到端加密)
// 协议(每帧 = 4字节大端长度 + 负载;长度 0 表示结束):
//   帧1 明文握手 { v, from, spub }   —— 公钥非敏感,用于派生会话密钥
//   帧2 密文元数据 { mid, fname, size, mime, scope, to, name }
//   帧3.. 密文文件分块(每块独立 AES-256-GCM)
//   帧EOF 长度 0
// 落盘先写系统临时目录;主进程按"接收方式"决定移动到下载目录或先征询用户。

const net = require('net')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { EventEmitter } = require('events')
const cryptoMod = require('./crypto')

const CHUNK = 64 * 1024
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
    this.isBlocked = opts.isBlocked || (() => false)
    this.ownName = opts.ownName || (() => '')
    this.keyCache = new Map()
    this.server = null
    this.tport = 0
  }

  _keyForPub (pub) {
    if (!pub) return null
    let k = this.keyCache.get(pub)
    if (k) return k
    try { k = cryptoMod.deriveKey(this.privObj, cryptoMod.importPub(pub)) } catch (_) { return null }
    this.keyCache.set(pub, k); return k
  }

  start (onPort) {
    this.server = net.createServer((socket) => this._onConn(socket))
    this.server.on('error', (e) => this.emit('error', String(e)))
    this.server.listen(0, () => { try { this.tport = this.server.address().port } catch (_) { this.tport = 0 } if (onPort) onPort(this.tport) })
  }

  stop () { try { this.server && this.server.close() } catch (_) {} this.server = null }

  _writeFrame (socket, buf) {
    const len = Buffer.alloc(4); len.writeUInt32BE(buf.length, 0)
    return socket.write(Buffer.concat([len, buf]))
  }

  sendFile (toId, filePath, scope, mid, metaTo, batch) {
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

    const socket = net.connect(peer.tport, peer.address)
    socket.on('error', () => this.emit('failed', { mid }))
    socket.setTimeout(30000, () => { socket.destroy(); this.emit('failed', { mid }) })
    socket.on('connect', () => {
      socket.setTimeout(0)
      this._writeFrame(socket, Buffer.from(JSON.stringify({ v: 1, from: this.id, spub: this.pub }), 'utf8'))
      this._writeFrame(socket, cryptoMod.encryptBuf(key, Buffer.from(JSON.stringify({ mid, fname, size, mime, scope: scope || 'private', to: metaTo, name: this.ownName(), batch: batch || null }), 'utf8')))
      const rs = fs.createReadStream(filePath, { highWaterMark: CHUNK })
      let sent = 0
      rs.on('data', (chunk) => {
        const ok = this._writeFrame(socket, cryptoMod.encryptBuf(key, chunk))
        sent += chunk.length
        this.emit('send-progress', { mid, toId, sent, size })
        if (!ok) { rs.pause(); socket.once('drain', () => rs.resume()) }
      })
      rs.on('end', () => { const eof = Buffer.alloc(4); eof.writeUInt32BE(0, 0); socket.write(eof); socket.end(); this.emit('sent', { mid, toId }) })
      rs.on('error', () => { socket.destroy(); this.emit('failed', { mid }) })
    })
    return { mid, fname, size, mime }
  }

  _onConn (socket) {
    let buf = Buffer.alloc(0)
    let stage = 'hs'
    let key = null; let from = null; let meta = null; let ws = null; let tempPath = null; let received = 0; let done = false
    const fail = () => {
      if (done) return; done = true
      try { ws && ws.destroy() } catch (_) {}
      if (tempPath) { try { fs.unlinkSync(tempPath) } catch (_) {} }
      try { socket.destroy() } catch (_) {}
      if (meta) this.emit('failed', { mid: meta.mid })
    }
    const finish = () => {
      if (done) return; done = true
      try { ws && ws.end() } catch (_) {}
      this.emit('done', { mid: meta.mid, from, name: meta.name, fname: meta.fname, size: meta.size, mime: meta.mime, scope: meta.scope, to: meta.to, batch: meta.batch || null, tempPath })
    }
    const handle = (payload) => {
      if (stage === 'hs') {
        let hs; try { hs = JSON.parse(payload.toString('utf8')) } catch (_) { return fail() }
        from = hs.from
        if (this.isBlocked(from)) return fail()
        key = this._keyForPub(hs.spub)
        if (!key) return fail()
        stage = 'meta'
      } else if (stage === 'meta') {
        try { meta = JSON.parse(cryptoMod.decryptBuf(key, payload).toString('utf8')) } catch (_) { return fail() }
        tempPath = path.join(os.tmpdir(), 'freedom-' + (meta.mid || crypto.randomUUID()) + '.part')
        ws = fs.createWriteStream(tempPath)
        ws.on('error', () => fail())
        this.emit('incoming', { mid: meta.mid, from, name: meta.name, fname: meta.fname, size: meta.size, mime: meta.mime, scope: meta.scope })
        stage = 'data'
      } else {
        let plain; try { plain = cryptoMod.decryptBuf(key, payload) } catch (_) { return fail() }
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
    socket.on('end', () => { if (!done && stage === 'data' && meta) finish() })
    socket.on('error', () => fail())
    socket.setTimeout(30000, () => fail())
  }
}

module.exports = { FileTransfer, guessMime }
