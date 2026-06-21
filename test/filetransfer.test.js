'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { EventEmitter } = require('node:events')
const cryptoMod = require('../electron/crypto')
const { FileTransfer } = require('../electron/filetransfer')

function waitForEvent (emitter, event, predicate, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('timeout waiting for ' + event))
    }, timeoutMs)
    const onEvent = (value) => {
      if (predicate && !predicate(value)) return
      cleanup()
      resolve(value)
    }
    const cleanup = () => {
      clearTimeout(timer)
      emitter.off(event, onEvent)
    }
    emitter.on(event, onEvent)
  })
}

test('FileTransfer send timeout emits failed and clears outbound entry', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-ft-test-'))
  const filePath = path.join(dir, 'hello.txt')
  fs.writeFileSync(filePath, 'hello')
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  const self = cryptoMod.generateKeyPair()
  const peer = cryptoMod.generateKeyPair()
  const ft = new FileTransfer({
    id: 'self',
    pub: self.pub,
    priv: self.priv,
    resolvePeer: () => ({ address: '127.0.0.1', tport: 9, pub: peer.pub }),
    ownName: () => 'self',
  })
  ft._hashFile = async () => 'hash'

  const realConnect = net.connect
  t.after(() => { net.connect = realConnect })
  net.connect = () => {
    const socket = new EventEmitter()
    socket.destroyed = false
    socket.write = () => false
    socket.end = () => {}
    socket.destroy = () => {
      socket.destroyed = true
      setImmediate(() => socket.emit('close'))
    }
    socket.setTimeout = (_ms, cb) => { setImmediate(cb); return socket }
    return socket
  }

  const failed = waitForEvent(ft, 'failed', (p) => p && p.mid === 'mid-timeout')
  const res = ft.sendFile('peer', filePath, 'private', 'mid-timeout')
  assert.equal(res.error, undefined)
  assert.equal((await failed).mid, 'mid-timeout')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(ft.outbound.has('mid-timeout'), false)
})
