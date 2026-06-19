'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { Vault } = require('../electron/vault')

function tempDir () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-vault-test-'))
}

test('vault setup, unlock, and password change round trip', async (t) => {
  const dir = tempDir()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  const vault = new Vault(dir)
  const identity = await vault.setup('old-password')
  assert.ok(identity.id)

  vault.lock()
  assert.equal(vault.unlocked, false)
  const unlocked = await vault.unlock('old-password')
  assert.equal(unlocked.id, identity.id)

  await vault.changePassword('old-password', 'new-password')
  vault.lock()
  await assert.rejects(() => vault.unlock('old-password'))
  const afterChange = await vault.unlock('new-password')
  assert.equal(afterChange.id, identity.id)
})

test('unlocking a corrupt store creates a backup and does not overwrite data', async (t) => {
  const dir = tempDir()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  const vault = new Vault(dir)
  await vault.setup('password')
  vault.lock()

  const storePath = path.join(dir, 'store.enc')
  const corruptBytes = Buffer.from('not a valid encrypted vault')
  fs.writeFileSync(storePath, corruptBytes)

  const reloaded = new Vault(dir)
  let thrown = null
  try {
    await reloaded.unlock('password')
  } catch (e) {
    thrown = e
  }

  assert.equal(thrown && thrown.code, 'ERR_VAULT_STORE_CORRUPT')
  assert.ok(thrown.backupPath)
  assert.deepEqual(fs.readFileSync(thrown.backupPath), corruptBytes)
  assert.equal(fs.existsSync(storePath), false)
  assert.equal(reloaded.unlocked, false)
})

test('appendMessage keeps history ordered, capped, and skips burn messages', async (t) => {
  const dir = tempDir()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  const vault = new Vault(dir)
  await vault.setup('password')

  vault.appendMessage('peer-1', { mid: 'late', ts: 30, text: 'late' })
  vault.appendMessage('peer-1', { mid: 'early', ts: 10, text: 'early' })
  vault.appendMessage('peer-1', { mid: 'middle', ts: 20, text: 'middle' })
  vault.appendMessage('peer-1', { mid: 'burn', ts: 40, text: 'burn', burn: true })

  assert.deepEqual(vault.getHistory()['peer-1'].map((m) => m.mid), ['early', 'middle', 'late'])

  for (let i = 1; i <= 1005; i++) vault.appendMessage('peer-2', { mid: 'm-' + i, ts: i, text: String(i) })
  const capped = vault.getHistory()['peer-2']
  assert.equal(capped.length, 1000)
  assert.equal(capped[0].mid, 'm-6')
  assert.equal(capped[capped.length - 1].mid, 'm-1005')
})

test('outboxAdd deduplicates, skips burn items, and removes empty peer queues', async (t) => {
  const dir = tempDir()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  const vault = new Vault(dir)
  await vault.setup('password')

  vault.outboxAdd('peer-1', { mid: 'm1', kind: 'text', text: 'one' })
  vault.outboxAdd('peer-1', { mid: 'm1', kind: 'text', text: 'duplicate' })
  vault.outboxAdd('peer-1', { mid: 'm2', kind: 'text', text: 'burn', burn: true })

  assert.deepEqual(vault.getOutbox()['peer-1'].map((m) => m.mid), ['m1'])

  vault.outboxRemove('peer-1', 'm1')
  assert.equal(vault.getOutbox()['peer-1'], undefined)
})
