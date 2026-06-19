'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const cryptoMod = require('../electron/crypto')

test('message encryption round trips with matching X25519 derived keys', () => {
  const alice = cryptoMod.generateKeyPair()
  const bob = cryptoMod.generateKeyPair()
  const aliceKey = cryptoMod.deriveKey(cryptoMod.importPriv(alice.priv), cryptoMod.importPub(bob.pub))
  const bobKey = cryptoMod.deriveKey(cryptoMod.importPriv(bob.priv), cryptoMod.importPub(alice.pub))

  assert.deepEqual(aliceKey, bobKey)
  const encrypted = cryptoMod.encrypt(aliceKey, 'hello')
  assert.equal(cryptoMod.decrypt(bobKey, encrypted), 'hello')

  const ct = Buffer.from(encrypted.ct, 'base64')
  ct[0] ^= 1
  assert.throws(() => cryptoMod.decrypt(bobKey, { ...encrypted, ct: ct.toString('base64') }))
})

test('buffer encryption round trips and rejects tampering', () => {
  const alice = cryptoMod.generateKeyPair()
  const bob = cryptoMod.generateKeyPair()
  const key = cryptoMod.deriveKey(cryptoMod.importPriv(alice.priv), cryptoMod.importPub(bob.pub))
  const encrypted = cryptoMod.encryptBuf(key, Buffer.from('file chunk'))

  assert.equal(cryptoMod.decryptBuf(key, encrypted).toString('utf8'), 'file chunk')

  const tampered = Buffer.from(encrypted)
  tampered[tampered.length - 1] ^= 1
  assert.throws(() => cryptoMod.decryptBuf(key, tampered))
})
