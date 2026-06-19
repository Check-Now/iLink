'use strict'
// 冒烟测试：共享空间端到端传输。成员(A) 经 FileTransfer 把文件上传到共享主机(B)，
// B 收到 done 后路由进 ShareStore，验证 share 上下文透传、宿主落盘、端到端 SHA-256、
// 宿主→成员下载回程，以及大文件(100MB)流式不卡死。
// 运行：node test/sharespace-transfer-smoke.js
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { FileTransfer } = require('../electron/filetransfer')
const { generateKeyPair } = require('../electron/crypto')
const ss = require('../electron/sharespace')
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  const ka = generateKeyPair(); const kb = generateKeyPair()
  const peers = {}
  const host = new FileTransfer({ id: 'B', pub: kb.pub, priv: kb.priv, resolvePeer: (id) => peers[id], ownName: () => 'B-host' })
  const member = new FileTransfer({ id: 'A', pub: ka.pub, priv: ka.priv, resolvePeer: (id) => peers[id], ownName: () => 'A' })
  let hostPort = 0
  await new Promise((res) => host.start((p) => { hostPort = p; res() }))
  await new Promise((res) => member.start(() => res()))
  peers.B = { id: 'B', address: '127.0.0.1', tport: hostPort, pub: kb.pub }
  peers.A = { id: 'A', address: '127.0.0.1', tport: 0, pub: ka.pub }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-host-'))
  const store = ss.ShareStore.create(root, { spaceId: 'sp', groupId: 'room:g', name: 'Z', hostUserId: 'B', hostDeviceId: 'devB', createdBy: 'B' })
  const results = []
  host.on('done', async (info) => {
    if (info.share && info.share.op === 'upload') {
      const r = await store.placeUpload({ fileName: info.fname, tempPath: info.tempPath, uploadedBy: info.from, parentId: info.share.parentId, rename: info.share.rename, hash: info.sha256 })
      results.push({ r })
    }
  })

  const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-src-'))
  const f1 = path.join(srcDir, '需求文档.docx')
  const c1 = Buffer.from('v0-' + 'x'.repeat(5000))
  fs.writeFileSync(f1, c1)
  const h1 = crypto.createHash('sha256').update(c1).digest('hex')
  member.sendFile('B', f1, 'share', 'm1', 'sp', null, false, 'm1', Date.now(), { op: 'upload', spaceId: 'sp', parentId: ss.ROOT_ID })
  for (let i = 0; i < 60 && results.length < 1; i++) await wait(100)
  assert.strictEqual(results.length, 1, '宿主应收到1次上传')
  assert.ok(results[0].r.ok, '宿主落盘成功')
  const entryId = results[0].r.entry.entryId
  assert.strictEqual(results[0].r.entry.hash, h1, '宿主端 SHA-256 == 源(端到端校验)')
  assert.ok(fs.existsSync(path.join(root, 'files', '需求文档.docx')), '宿主物理文件存在')

  let dl = null
  member.on('done', (info) => { if (info.share && info.share.op === 'download') dl = info })
  const dlList = store.downloadList(entryId)
  const file = dlList.files[0]
  peers.A.tport = member.tport
  host.sendFile('A', file.abs, 'share', 'd1', 'sp', null, false, 'd1', Date.now(), { op: 'download', spaceId: 'sp', entryId })
  for (let i = 0; i < 60 && !dl; i++) await wait(100)
  assert.ok(dl, '成员应收到下载 done')
  const dlBuf = fs.readFileSync(dl.tempPath)
  assert.strictEqual(crypto.createHash('sha256').update(dlBuf).digest('hex'), file.hash, '下载内容 SHA-256 == 宿主记录')
  try { fs.unlinkSync(dl.tempPath) } catch (_) {}

  const big = path.join(srcDir, 'big.bin')
  const bigBuf = crypto.randomBytes(100 * 1024 * 1024)
  fs.writeFileSync(big, bigBuf)
  const bigHash = crypto.createHash('sha256').update(bigBuf).digest('hex')
  const before = results.length
  member.sendFile('B', big, 'share', 'mbig', 'sp', null, false, 'mbig', Date.now(), { op: 'upload', spaceId: 'sp', parentId: ss.ROOT_ID })
  for (let i = 0; i < 300 && results.length < before + 1; i++) await wait(100)
  assert.strictEqual(results.length, before + 1, '大文件应上传成功')
  assert.strictEqual(results[before].r.entry.hash, bigHash, '100MB 文件 SHA-256 一致')

  host.stop(); member.stop()
  try { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(srcDir, { recursive: true, force: true }) } catch (_) {}
  console.log('✅ 共享空间端到端传输（上传/下载/100MB + 端到端 SHA-256）验证通过')
  process.exit(0)
})().catch((e) => { console.error('❌ 测试失败:', e); process.exit(1) })
