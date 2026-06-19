'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const cryptoMod = require('../electron/crypto')
const { P2P } = require('../electron/p2p')

function waitForEvent (emitter, event, predicate, timeoutMs = 2000) {
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

function waitForReady (p2p) {
  return waitForEvent(p2p, 'ready', null, 2000)
}

function createPeer (id, name) {
  const keys = cryptoMod.generateKeyPair()
  return {
    keys,
    p2p: new P2P({
      id,
      name,
      pub: keys.pub,
      priv: keys.priv,
      disableDiscovery: true,
    }),
  }
}

async function connectPeers (a, b) {
  await Promise.all([waitForReady(a.p2p), waitForReady(b.p2p)])
  const gotA = waitForEvent(a.p2p, 'presence', (p) => p && p.id === b.p2p.id)
  const gotB = waitForEvent(b.p2p, 'presence', (p) => p && p.id === a.p2p.id)
  a.p2p._sendPresenceUnicast('127.0.0.1', b.p2p.uport)
  b.p2p._sendPresenceUnicast('127.0.0.1', a.p2p.uport)
  await Promise.all([gotA, gotB])
}

test('P2P private resend receives ACK and emits delivered status', async (t) => {
  const a = createPeer('peer-a', 'Alice')
  const b = createPeer('peer-b', 'Bob')
  t.after(() => { a.p2p.stop(); b.p2p.stop() })

  a.p2p.start()
  b.p2p.start()
  await connectPeers(a, b)

  const mid = 'mid-ack'
  const received = waitForEvent(b.p2p, 'message', (m) => m && m.mid === mid)
  const delivered = waitForEvent(a.p2p, 'msg-status', (s) => s && s.mid === mid && s.status === 'delivered')

  const sent = a.p2p.resendPrivate('peer-b', mid, 'hello', {})
  assert.equal(sent.ok, true)
  assert.equal((await received).text, 'hello')
  assert.equal((await delivered).status, 'delivered')
})

test('P2P ACK retry state emits failed when no ACK arrives', async (t) => {
  const a = createPeer('peer-a', 'Alice')
  const ghost = cryptoMod.generateKeyPair()
  t.after(() => a.p2p.stop())

  a.p2p.start()
  await waitForReady(a.p2p)
  a.p2p.peers.set('ghost', {
    id: 'ghost',
    name: 'Ghost',
    address: '127.0.0.1',
    uport: 9,
    pub: ghost.pub,
    online: true,
  })

  const failed = waitForEvent(a.p2p, 'msg-status', (s) => s && s.mid === 'mid-fail' && s.status === 'failed')
  const sent = a.p2p.resendPrivate('ghost', 'mid-fail', 'lost', {})
  assert.equal(sent.ok, true)

  for (let i = 0; i < 4; i++) {
    const pending = a.p2p.pending.get('mid-fail')
    if (pending && pending.timer) clearTimeout(pending.timer)
    a.p2p._retryAck('mid-fail')
  }

  assert.equal((await failed).status, 'failed')
})
