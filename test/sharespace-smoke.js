'use strict'
// 冒烟测试：共享空间宿主存储核心逻辑（版本命名 / 安全校验 / 上传新文件与新版本 / 历史 / 重命名 / 删除）。
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

;(() => {
  // ---- 1) 版本命名 / 解析 ----
  assert.strictEqual(ss.padVersion(1), '01')
  assert.strictEqual(ss.padVersion(10), '10')
  assert.strictEqual(ss.padVersion(100), '100')
  assert.strictEqual(ss.versionFileName('需求文档', '.docx', 0), '需求文档.docx')
  assert.strictEqual(ss.versionFileName('需求文档', '.docx', 1), '需求文档_V01.docx')
  assert.strictEqual(ss.versionFileName('需求文档', '.docx', 3), '需求文档_V03.docx')
  let p = ss.parseLogicalName('需求文档_V02.docx')
  assert.deepStrictEqual([p.base, p.versionNo, p.ext], ['需求文档', 2, '.docx'], '应识别 _V02 为版本2 基名需求文档')
  p = ss.parseLogicalName('report.pdf')
  assert.deepStrictEqual([p.base, p.versionNo, p.ext], ['report', 0, '.pdf'])

  // ---- 2) 安全校验：非法字符 / 保留名 / 穿越 ----
  assert.strictEqual(ss.checkSegment('正常名').ok, true)
  assert.strictEqual(ss.checkSegment('a/b').ok, false, '含分隔符应拒绝')
  assert.strictEqual(ss.checkSegment('..').ok, false, '.. 应拒绝')
  assert.strictEqual(ss.checkSegment('CON').ok, false, '保留名应拒绝')
  assert.strictEqual(ss.checkSegment('a:b*c?').ok, false, '通配符/盘符应拒绝')
  assert.strictEqual(ss.safeFileName('../../etc/passwd'), 'passwd', '净化应去掉路径穿越')

  // ---- 3) 建空间 + 上传新文件 ----
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-root-'))
  const store = ss.ShareStore.create(root, { spaceId: 'sp1', groupId: 'room:g', name: '资料区', hostUserId: 'A', hostDeviceId: 'devA', createdBy: 'A' })
  const f1 = tmpFile('hello-v0')
  let r = store.placeUpload({ fileName: '需求文档.docx', tempPath: f1, uploadedBy: 'B', intent: 'new', parentId: ss.ROOT_ID })
  assert.ok(r.ok, '上传新文件应成功')
  const entryId = r.entry.entryId
  assert.strictEqual(r.entry.name, '需求文档.docx')
  assert.ok(fs.existsSync(path.join(root, 'files', '需求文档.docx')), '物理文件应存在')
  const v0hash = r.version.fileHash
  assert.strictEqual(v0hash, crypto.createHash('sha256').update('hello-v0').digest('hex'), '宿主端 hash 正确')

  // ---- 4) 重名：不静默覆盖，返回 conflict ----
  const fdup = tmpFile('dup')
  r = store.placeUpload({ fileName: '需求文档.docx', tempPath: fdup, uploadedBy: 'C', intent: 'new', parentId: ss.ROOT_ID })
  assert.ok(!r.ok && r.conflict && r.entryId === entryId, '重名应返回 conflict 指向已有条目')
  try { fs.unlinkSync(fdup) } catch (_) {}

  // ---- 5) 上传新版本：生成 _V01 / _V02，不叠加 ----
  const f2 = tmpFile('hello-v1')
  r = store.placeUpload({ tempPath: f2, uploadedBy: 'C', intent: 'version', entryId })
  assert.ok(r.ok && r.version.versionFileName === '需求文档_V01.docx', 'V01 命名正确: ' + JSON.stringify(r))
  const f3 = tmpFile('hello-v2')
  r = store.placeUpload({ tempPath: f3, uploadedBy: 'B', intent: 'version', entryId })
  assert.ok(r.ok && r.version.versionFileName === '需求文档_V02.docx', 'V02 命名正确')
  assert.strictEqual(r.entry.currentVersion, 2, '当前版本应为2')
  assert.ok(fs.existsSync(path.join(root, 'files', '需求文档_V01.docx')))
  assert.ok(fs.existsSync(path.join(root, 'files', '需求文档_V02.docx')))
  assert.ok(!/V01_V02/.test(r.version.versionFileName), '不应出现 _V01_V02 叠加')

  // ---- 6) 主列表只显示当前版本（1 个文件条目），历史版本含 3 个版本 ----
  const list = store.listDir(ss.ROOT_ID)
  assert.strictEqual(list.entries.filter((e) => e.type === 'file').length, 1, '主列表只显示1个逻辑文件')
  assert.strictEqual(list.entries[0].name, '需求文档.docx', '主列表显示逻辑名')
  const hist = store.listHistory(entryId)
  assert.strictEqual(hist.versions.length, 3, '历史应有 V0/V01/V02 共3版')
  assert.deepStrictEqual(hist.versions.map((v) => v.versionNo), [2, 1, 0], '历史按版本号倒序')

  // ---- 7) 下载任意历史版本：路径与 hash 对应正确 ----
  const v0 = hist.versions.find((v) => v.versionNo === 0)
  const vp = store.versionAbsPath(entryId, v0.versionId)
  assert.ok(vp && fs.readFileSync(vp.abs, 'utf8') === 'hello-v0', '历史版本内容正确')
  assert.strictEqual(vp.hash, v0hash, '历史版本 hash 正确')

  // ---- 8) 新建文件夹 + 子目录上传 + 嵌套 ----
  r = store.createFolder('B', ss.ROOT_ID, '设计稿')
  assert.ok(r.ok, '新建文件夹成功')
  const folderId = r.entry.entryId
  assert.ok(fs.existsSync(path.join(root, 'files', '设计稿')), '物理目录创建')
  r = store.createFolder('B', ss.ROOT_ID, '设计稿')
  assert.ok(!r.ok, '同名文件夹应拒绝')
  const f4 = tmpFile('nested')
  r = store.placeUpload({ fileName: '原型.fig', tempPath: f4, uploadedBy: 'B', intent: 'new', parentId: folderId })
  assert.ok(r.ok && fs.existsSync(path.join(root, 'files', '设计稿', '原型.fig')), '子目录上传保留结构')

  // ---- 9) 重命名文件：版本关系保持，物理文件随之改名 ----
  r = store.rename('A', entryId, '需求说明.docx')
  assert.ok(r.ok, '重命名成功')
  assert.ok(fs.existsSync(path.join(root, 'files', '需求说明.docx')))
  assert.ok(fs.existsSync(path.join(root, 'files', '需求说明_V02.docx')), '版本文件随之改名')
  assert.ok(!fs.existsSync(path.join(root, 'files', '需求文档.docx')), '旧名应消失')
  const hist2 = store.listHistory(entryId)
  assert.strictEqual(hist2.versions.length, 3, '重命名后历史版本不丢失')
  // 重命名后继续上传新版本应为 _V03（基于新逻辑名，不叠加）
  const f5 = tmpFile('hello-v3')
  r = store.placeUpload({ tempPath: f5, uploadedBy: 'C', intent: 'version', entryId })
  assert.ok(r.ok && r.version.versionFileName === '需求说明_V03.docx', '重命名后继续 _V03: ' + JSON.stringify(r.version))

  // ---- 10) 删除：移入 .trash，主列表隐藏，物理移走 ----
  r = store.remove('A', folderId)
  assert.ok(r.ok, '删除文件夹成功')
  assert.ok(!fs.existsSync(path.join(root, 'files', '设计稿')), '物理目录应移出')
  const trash = fs.readdirSync(path.join(root, '.trash'))
  assert.ok(trash.some((n) => n.includes('设计稿')), '回收站应有该目录')
  const list2 = store.listDir(ss.ROOT_ID)
  assert.ok(!list2.entries.some((e) => e.entryId === folderId), '删除后主列表隐藏')

  // ---- 11) 重新 open 持久化 meta，状态保持 ----
  const store2 = ss.ShareStore.open(root)
  assert.strictEqual(store2.listHistory(entryId).versions.length, 4, '重开后版本数应为4(含V03)')

  try { fs.rmSync(root, { recursive: true, force: true }) } catch (_) {}
  ;[f1, f2, f3, f4, f5].forEach((f) => { try { fs.unlinkSync(f) } catch (_) {} })
  console.log('✅ sharespace 核心逻辑（版本命名/安全/上传/版本/历史/重命名/删除/持久化）验证通过')
  process.exit(0)
})()
