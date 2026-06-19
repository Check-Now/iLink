'use strict'
// 冒烟测试：共享空间宿主存储核心逻辑（安全校验 / 上传新文件 / 文件夹重命名 / 文件夹下载清单 / 递归删除）。
// 不涉及网络，纯本机 fs。运行：node test/sharespace-smoke.js
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const ss = require('../electron/sharespace')

function tmpFile (content) {
  const p = path.join(os.tmpdir(), 'ss-up-' + crypto.randomUUID())
  fs.writeFileSync(p, content)
  return p
}

;(async () => {
  // ---- 1) 安全校验：非法字符 / 保留名 / 穿越 ----
  assert.strictEqual(ss.checkSegment('正常名').ok, true)
  assert.strictEqual(ss.checkSegment('a/b').ok, false, '含分隔符应拒绝')
  assert.strictEqual(ss.checkSegment('..').ok, false, '.. 应拒绝')
  assert.strictEqual(ss.checkSegment('CON').ok, false, '保留名应拒绝')
  assert.strictEqual(ss.checkSegment('a:b*c?').ok, false, '通配符/盘符应拒绝')
  assert.strictEqual(ss.safeFileName('../../etc/passwd'), 'passwd', '净化应去掉路径穿越')

  // ---- 2) 建空间 + 上传新文件 ----
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-root-'))
  const store = ss.ShareStore.create(root, { spaceId: 'sp1', groupId: 'room:g', name: '资料区', hostUserId: 'A', hostDeviceId: 'devA', createdBy: 'A' })
  const f1 = tmpFile('hello')
  let r = await store.placeUpload({ fileName: '需求文档.docx', tempPath: f1, uploadedBy: 'B', parentId: ss.ROOT_ID })
  assert.ok(r.ok, '上传新文件应成功')
  const entryId = r.entry.entryId
  const fileHash = crypto.createHash('sha256').update('hello').digest('hex')
  assert.strictEqual(r.entry.name, '需求文档.docx')
  assert.strictEqual(r.entry.hash, fileHash, '宿主端 hash 正确')
  assert.ok(fs.existsSync(path.join(root, 'files', '需求文档.docx')), '物理文件应存在')
  assert.ok(!store.meta.versions, '不应再创建 versions 元数据')

  // ---- 3) 重名：不静默覆盖，返回 conflict；改名上传生成新文件 ----
  const fdup = tmpFile('dup')
  r = await store.placeUpload({ fileName: '需求文档.docx', tempPath: fdup, uploadedBy: 'C', parentId: ss.ROOT_ID })
  assert.ok(!r.ok && r.conflict && r.entryId === entryId, '重名应返回 conflict 指向已有条目')
  r = await store.placeUpload({ fileName: '需求文档.docx', tempPath: fdup, uploadedBy: 'C', parentId: ss.ROOT_ID, rename: true })
  assert.ok(r.ok && r.entry.name === '需求文档(1).docx', '改名上传应生成新文件')

  // ---- 4) 新建文件夹 + 子目录上传 ----
  r = store.createFolder('B', ss.ROOT_ID, '设计稿')
  assert.ok(r.ok, '新建文件夹成功')
  const folderId = r.entry.entryId
  assert.ok(fs.existsSync(path.join(root, 'files', '设计稿')), '物理目录创建')
  r = store.createFolder('B', ss.ROOT_ID, '设计稿')
  assert.ok(!r.ok, '同名文件夹应拒绝')
  const f2 = tmpFile('nested')
  r = await store.placeUpload({ fileName: '原型.fig', tempPath: f2, uploadedBy: 'B', parentId: folderId })
  assert.ok(r.ok && fs.existsSync(path.join(root, 'files', '设计稿', '原型.fig')), '子目录上传保留结构')

  // ---- 5) 文件不支持重命名；文件夹重命名会同步子文件路径 ----
  r = store.rename('A', entryId, '需求说明.docx')
  assert.ok(!r.ok, '文件不支持重命名')
  r = store.rename('A', folderId, '设计归档')
  assert.ok(r.ok, '文件夹重命名成功')
  assert.ok(fs.existsSync(path.join(root, 'files', '设计归档', '原型.fig')), '子文件物理路径随文件夹更新')
  r = store.search('原型')
  assert.ok(r.ok && r.entries.length === 1 && r.entries[0].pathText.includes('设计归档'), '全量搜索应命中文件并返回路径')
  r = store.search('归档')
  assert.ok(r.ok && r.entries.some((e) => e.type === 'folder' && e.name === '设计归档'), '全量搜索应命中文件夹')

  // ---- 6) 下载清单：文件夹下载包含自身目录和所有子文件 ----
  const dlFile = store.downloadList(entryId)
  assert.ok(dlFile.ok && dlFile.type === 'file' && dlFile.files.length === 1, '文件下载清单正确')
  const dlFolder = store.downloadList(folderId)
  assert.ok(dlFolder.ok && dlFolder.type === 'folder' && dlFolder.files.length === 1, '文件夹下载清单正确')
  assert.strictEqual(dlFolder.files[0].relativePath, '设计归档/原型.fig', '文件夹下载应保留相对目录')

  // ---- 7) 真删除：文件夹递归物理删除并移除元数据 ----
  const f3 = tmpFile('inner-data')
  await store.placeUpload({ fileName: '稿件.txt', tempPath: f3, uploadedBy: 'B', parentId: folderId })
  r = store.remove('A', folderId)
  assert.ok(r.ok && r.affected >= 2, '删除文件夹应影响自身和子文件')
  assert.ok(!fs.existsSync(path.join(root, 'files', '设计归档')), '物理目录应被真删除')
  assert.ok(!store.listDir(ss.ROOT_ID).entries.some((e) => e.entryId === folderId), '删除后主列表无此项')
  const reopened = ss.ShareStore.open(root)
  assert.ok(!reopened.meta.entries[folderId], '重开后文件夹元数据应移除')

  // 删除单个文件：物理文件和元数据均移除
  r = store.remove('A', entryId)
  assert.ok(r.ok, '删除文件成功')
  assert.ok(!fs.existsSync(path.join(root, 'files', '需求文档.docx')), '物理文件应删除')
  assert.ok(!store.downloadList(entryId).ok, '删除后不可下载')

  try { fs.rmSync(root, { recursive: true, force: true }) } catch (_) {}
  console.log('✅ sharespace 核心逻辑（安全/上传/文件夹重命名/下载清单/递归删除）验证通过')
  process.exit(0)
})().catch((e) => { console.error('❌ 测试失败:', e); process.exit(1) })
