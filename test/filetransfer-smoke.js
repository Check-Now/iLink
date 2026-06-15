'use strict'
// 冒烟测试：两个 FileTransfer 实例本机 TCP 收发一个 200KB 文件（跨多个 64KB 分块），
// 验证落地内容字节一致 + 收尾 SHA-256 校验通过（覆盖 _onConn 复用 _hashFile 的校验路径）。
// 运行：node test/filetransfer-smoke.js
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { FileTransfer } = require('../electron/filetransfer')
const { generateKeyPair } = require('../electron/crypto')

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  const ka = generateKeyPair(); const kb = generateKeyPair()
  const peers = {}
  const b = new FileTransfer({ id: 'B', pub: kb.pub, priv: kb.priv, resolvePeer: (id) => peers[id], ownName: () => 'B' })
  const a = new FileTransfer({ id: 'A', pub: ka.pub, priv: ka.priv, resolvePeer: (id) => peers[id], ownName: () => 'A' })
  let bPort = 0
  await new Promise((res) => b.start((p) => { bPort = p; res() }))
  await new Promise((res) => a.start(() => res()))
  peers.B = { id: 'B', address: '127.0.0.1', tport: bPort, pub: kb.pub }

  const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-src-'))
  const srcFile = path.join(srcDir, 'hello.bin')
  const content = crypto.randomBytes(200 * 1024) // 200KB，跨多个 64KB 分块
  fs.writeFileSync(srcFile, content)
  const expectHash = crypto.createHash('sha256').update(content).digest('hex')

  let doneInfo = null; let failed = false
  b.on('done', (info) => { doneInfo = info })
  b.on('failed', () => { failed = true })

  const r = a.sendFile('B', srcFile, 'private', 'mid-1', 'B')
  assert.ok(r && r.mid, 'sendFile 启动')

  for (let i = 0; i < 60 && !doneInfo && !failed; i++) await wait(100)
  assert.ok(!failed, '传输不应失败')
  assert.ok(doneInfo, '应收到 done 事件（说明大小+SHA-256 校验通过）')
  assert.strictEqual(doneInfo.size, content.length, 'meta 大小一致')
  const got = fs.readFileSync(doneInfo.tempPath)
  assert.strictEqual(got.length, content.length, '落地字节数一致')
  assert.strictEqual(crypto.createHash('sha256').update(got).digest('hex'), expectHash, '落地内容 SHA-256 一致')

  a.stop(); b.stop()
  try { fs.rmSync(srcDir, { recursive: true, force: true }); fs.unlinkSync(doneInfo.tempPath) } catch (_) {}
  console.log('✅ FileTransfer TCP 往返 + SHA-256 校验 验证通过')
  process.exit(0)
})().catch((e) => { console.error('❌ 测试失败:', e); process.exit(1) })
