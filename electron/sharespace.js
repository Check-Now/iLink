'use strict'

// 群共享空间·宿主端权威存储（纯 P2P，无中心服务器）
// 设计：
//  - 共享空间数据存储在“共享主机”(创建者)本机；本模块只在主机进程运行，负责落盘与元数据管理。
//  - 物理布局：
//      <rootPath>/files/<目录树>/<文件...>           真实文件（含全部历史版本物理文件）
//      <rootPath>/.ilink-share/meta.json             元数据（空间/目录项/版本/日志）
//      <rootPath>/.trash/                            删除项（移入而非物理删除，可恢复）
//  - 版本：版本0=原始名(需求文档.docx)，版本k=需求文档_VKK.docx，全部物理共存；
//          主列表显示“逻辑名”(logicalBase+ext)，默认指向最新版本。
//  - 安全：对端可控的名称一律净化；禁止路径穿越/盘符/通配符/Windows 保留名；落盘前 .part 暂存校验后改名。
// 注意：本文件不依赖 electron，便于在 Node 下直接做单元测试。

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { win32 } = require('path')

const META_DIR = '.ilink-share'
const META_FILE = 'meta.json'
const FILES_DIR = 'files'
const TRASH_DIR = '.trash'
const MAX_SEGMENT_LEN = 200
const ROOT_ID = 'root'
// Windows 保留设备名（基名，忽略大小写与扩展名）
const RESERVED = new Set(['con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9'])

// -------- 纯函数：版本命名 / 名称解析（无 fs，便于测试） --------

// 版本号补零：至少两位（V01..V99），超过 99 原样（V100...）
function padVersion (n) {
  n = parseInt(n, 10) || 0
  return n < 100 ? String(n).padStart(2, '0') : String(n)
}

// 解析文件名 → { base, ext, versionNo }。
//  - ext 含点(可能为'')；base 为去扩展名后的主体。
//  - 仅当主体以 _V\d{2,} 结尾才识别为版本号，避免把普通名字误判（如“配置_V”不算）。
function parseLogicalName (fileName) {
  const name = String(fileName == null ? '' : fileName)
  const ext = win32.extname(name)
  let base = ext ? name.slice(0, name.length - ext.length) : name
  let versionNo = 0
  const m = base.match(/^(.+)_V(\d{2,})$/)
  if (m) { base = m[1]; versionNo = parseInt(m[2], 10) }
  return { base, ext, versionNo }
}

// 生成版本物理文件名：版本0=base+ext；版本k=base_VKK+ext
function versionFileName (logicalBase, ext, versionNo) {
  versionNo = parseInt(versionNo, 10) || 0
  if (versionNo <= 0) return logicalBase + (ext || '')
  return logicalBase + '_V' + padVersion(versionNo) + (ext || '')
}

function isReservedName (segment) {
  const base = win32.basename(String(segment || '')).split('.')[0].trim().toLowerCase()
  return RESERVED.has(base)
}

// 校验单层目录/文件名段是否安全。返回 { ok, value } 或 { ok:false, error }
function checkSegment (name) {
  let n = String(name == null ? '' : name).trim()
  if (!n) return { ok: false, error: '名称不能为空' }
  if (n === '.' || n === '..') return { ok: false, error: '名称非法' }
  // 含路径分隔符/盘符冒号/通配符/引号/尖括号/竖线/控制字符 → 拒绝（不是默默替换，明确报错）
  if (/[\\/:*?"<>|\x00-\x1f]/.test(n)) return { ok: false, error: '名称含非法字符 \\ / : * ? " < > |' }
  if (isReservedName(n)) return { ok: false, error: '名称为系统保留名(' + n + ')' }
  if (n.length > MAX_SEGMENT_LEN) return { ok: false, error: '名称过长(上限 ' + MAX_SEGMENT_LEN + ')' }
  if (/[. ]$/.test(n)) n = n.replace(/[. ]+$/, '') // Windows 不允许以点/空格结尾
  if (!n) return { ok: false, error: '名称非法' }
  return { ok: true, value: n }
}

// 把任意（可能来自对端的）文件名净化为安全的纯文件名（用于上传落盘兜底，绝不抛错）
function safeFileName (name, fallback) {
  const fb = (fallback && String(fallback)) || 'file'
  let n = win32.basename(String(name == null ? '' : name))
  n = n.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+$/, '').replace(/[. ]+$/, '').trim()
  if (!n || isReservedName(n)) n = win32.basename(fb) || 'file'
  if (n.length > MAX_SEGMENT_LEN) {
    const ext = win32.extname(n).slice(0, 16)
    n = n.slice(0, MAX_SEGMENT_LEN - ext.length) + ext
  }
  return n
}

// 确保 child 解析后仍位于 root 之内（最后一道路径穿越防线）
function isInside (root, child) {
  const r = path.resolve(root)
  const c = path.resolve(child)
  return c === r || c.startsWith(r + path.sep)
}

function sha256File (filePath) {
  const h = crypto.createHash('sha256')
  const fd = fs.openSync(filePath, 'r')
  try {
    const buf = Buffer.alloc(1024 * 1024)
    let n
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n))
  } finally { fs.closeSync(fd) }
  return h.digest('hex')
}

function moveInto (src, dest) {
  // 先写到 .part 再改名，避免外部看到半成品；跨卷退回 copy+unlink
  const part = dest + '.part'
  try { fs.copyFileSync(src, part) } catch (e) { throw e }
  fs.renameSync(part, dest)
  try { fs.unlinkSync(src) } catch (_) {}
}

// ============ 单个共享空间的宿主存储 ============
class ShareStore {
  constructor (rootPath) {
    this.rootPath = rootPath
    this.metaDir = path.join(rootPath, META_DIR)
    this.metaPath = path.join(this.metaDir, META_FILE)
    this.filesDir = path.join(rootPath, FILES_DIR)
    this.trashDir = path.join(rootPath, TRASH_DIR)
    this.meta = null
  }

  // 创建新空间（写 meta + 目录骨架）。space: { spaceId, groupId, name, hostUserId, hostDeviceId, createdBy }
  static create (rootPath, space) {
    fs.mkdirSync(path.join(rootPath, META_DIR), { recursive: true })
    fs.mkdirSync(path.join(rootPath, FILES_DIR), { recursive: true })
    fs.mkdirSync(path.join(rootPath, TRASH_DIR), { recursive: true })
    const now = Date.now()
    const store = new ShareStore(rootPath)
    store.meta = {
      space: {
        spaceId: space.spaceId,
        groupId: space.groupId,
        name: String(space.name || '共享空间').slice(0, 60),
        hostUserId: space.hostUserId || '',
        hostDeviceId: space.hostDeviceId || '',
        createdBy: space.createdBy || space.hostUserId || '',
        rootPath,
        createdAt: now,
        updatedAt: now,
        status: 'normal',
      },
      entries: {},
      versions: {},
      logs: [],
    }
    store._save()
    return store
  }

  static open (rootPath) {
    const store = new ShareStore(rootPath)
    store._load()
    return store
  }

  _load () {
    const raw = fs.readFileSync(this.metaPath, 'utf8')
    this.meta = JSON.parse(raw)
    if (!this.meta.entries) this.meta.entries = {}
    if (!this.meta.versions) this.meta.versions = {}
    if (!Array.isArray(this.meta.logs)) this.meta.logs = []
    return this.meta
  }

  _save () {
    fs.mkdirSync(this.metaDir, { recursive: true })
    this.meta.space.updatedAt = Date.now()
    const tmp = this.metaPath + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(this.meta, null, 2))
    fs.renameSync(tmp, this.metaPath)
  }

  _log (operatorId, action, entryId, detail) {
    this.meta.logs.push({
      logId: crypto.randomUUID(),
      groupId: this.meta.space.groupId,
      spaceId: this.meta.space.spaceId,
      entryId: entryId || '',
      operatorId: operatorId || '',
      action,
      detail: detail || '',
      createdAt: Date.now(),
    })
    if (this.meta.logs.length > 5000) this.meta.logs.splice(0, this.meta.logs.length - 5000)
  }

  // 取某父目录的相对路径（root → ''）；非法父目录抛错
  _parentRelPath (parentId) {
    if (!parentId || parentId === ROOT_ID) return ''
    const e = this.meta.entries[parentId]
    if (!e || e.type !== 'folder' || e.status !== 'normal') throw new Error('父目录不存在')
    return e.relativePath
  }

  // 把相对路径(由净化段拼成)解析为 files 下的绝对路径，并做穿越兜底校验
  _absForRel (relPath, fileName) {
    const abs = path.join(this.filesDir, relPath || '', fileName || '')
    if (!isInside(this.filesDir, abs)) throw new Error('路径越界')
    return abs
  }

  _findChild (parentId, type, name) {
    const pid = parentId || ROOT_ID
    return Object.values(this.meta.entries).find((e) =>
      e.parentId === pid && e.status === 'normal' && e.type === type && e.name === name) || null
  }

  // -------- 查询 --------
  spaceInfo () {
    const s = this.meta.space
    const fileCount = Object.values(this.meta.entries).filter((e) => e.type === 'file' && e.status === 'normal').length
    let updatedAt = s.updatedAt
    for (const e of Object.values(this.meta.entries)) if (e.status === 'normal') updatedAt = Math.max(updatedAt, e.updatedAt || 0)
    return { spaceId: s.spaceId, groupId: s.groupId, name: s.name, hostUserId: s.hostUserId, hostDeviceId: s.hostDeviceId, createdBy: s.createdBy, createdAt: s.createdAt, updatedAt, status: s.status, fileCount }
  }

  // 列目录：返回该 parent 下 normal 的文件夹与文件(当前版本)。不含历史版本、不含 deleted。
  listDir (parentId) {
    const pid = parentId || ROOT_ID
    if (pid !== ROOT_ID) {
      const p = this.meta.entries[pid]
      if (!p || p.type !== 'folder' || p.status !== 'normal') return { ok: false, error: '目录不存在' }
    }
    const entries = Object.values(this.meta.entries)
      .filter((e) => e.parentId === pid && e.status === 'normal')
      .map((e) => this._publicEntry(e))
    return { ok: true, parentId: pid, breadcrumb: this._breadcrumb(pid), entries }
  }

  _breadcrumb (parentId) {
    const crumbs = [{ entryId: ROOT_ID, name: '根目录' }]
    const chain = []
    let cur = parentId
    while (cur && cur !== ROOT_ID) {
      const e = this.meta.entries[cur]
      if (!e) break
      chain.unshift({ entryId: e.entryId, name: e.name })
      cur = e.parentId
    }
    return crumbs.concat(chain)
  }

  _publicEntry (e) {
    return {
      entryId: e.entryId, parentId: e.parentId, name: e.name, type: e.type, ext: e.ext || '',
      currentVersion: e.currentVersion || 0, currentVersionId: e.currentVersionId || '',
      size: e.size || 0, hash: e.hash || '', relativePath: e.relativePath || '',
      createdBy: e.createdBy || '', updatedBy: e.updatedBy || '', createdAt: e.createdAt, updatedAt: e.updatedAt,
      versionCount: Object.values(this.meta.versions).filter((v) => v.entryId === e.entryId).length,
    }
  }

  // -------- 新建文件夹 --------
  createFolder (operatorId, parentId, name) {
    const chk = checkSegment(name)
    if (!chk.ok) return { ok: false, error: chk.error }
    name = chk.value
    let parentRel
    try { parentRel = this._parentRelPath(parentId) } catch (e) { return { ok: false, error: String(e.message || e) } }
    if (this._findChild(parentId || ROOT_ID, 'folder', name)) return { ok: false, error: '同名文件夹已存在' }
    const rel = parentRel ? parentRel + '/' + name : name
    let abs
    try { abs = this._absForRel(rel, '') } catch (e) { return { ok: false, error: String(e.message || e) } }
    fs.mkdirSync(abs, { recursive: true })
    const now = Date.now()
    const entry = {
      entryId: crypto.randomUUID(), spaceId: this.meta.space.spaceId, groupId: this.meta.space.groupId,
      parentId: parentId || ROOT_ID, name, type: 'folder', ext: '', relativePath: rel,
      currentVersion: 0, currentVersionId: '', size: 0, hash: '',
      createdBy: operatorId || '', updatedBy: operatorId || '', createdAt: now, updatedAt: now, status: 'normal',
    }
    this.meta.entries[entry.entryId] = entry
    this._log(operatorId, 'create_folder', entry.entryId, name)
    this._save()
    return { ok: true, entry: this._publicEntry(entry) }
  }

  // -------- 上传文件（新文件 / 新版本） --------
  // opts: { fileName, tempPath, uploadedBy, intent:'new'|'version', entryId, changeNote, rename:bool }
  placeUpload (opts) {
    const o = opts || {}
    const tempPath = o.tempPath
    if (!tempPath || !fs.existsSync(tempPath)) return { ok: false, error: '临时文件不存在' }
    const uploadedBy = o.uploadedBy || ''
    let size = 0; let hash = ''
    try { size = fs.statSync(tempPath).size; hash = sha256File(tempPath) } catch (e) { return { ok: false, error: '读取临时文件失败' } }

    if (o.intent === 'version') {
      const entry = this.meta.entries[o.entryId]
      if (!entry || entry.type !== 'file' || entry.status !== 'normal') return { ok: false, error: '目标文件不存在' }
      const nextNo = (entry.currentVersion || 0) + 1
      // 命名永远基于目标条目的逻辑基名，避免 _V01_V02 叠加；忽略上传文件原名
      const vfname = versionFileName(entry.logicalBase, entry.ext, nextNo)
      let abs
      try { abs = this._absForRel(entry.relativePath, vfname) } catch (e) { return { ok: false, error: String(e.message || e) } }
      try { moveInto(tempPath, abs) } catch (e) { return { ok: false, error: '落盘失败:' + (e.message || e) } }
      const now = Date.now()
      const version = {
        versionId: crypto.randomUUID(), entryId: entry.entryId, spaceId: entry.spaceId, groupId: entry.groupId,
        versionNo: nextNo, versionFileName: vfname, fileSize: size, fileHash: hash,
        storageRelativePath: (entry.relativePath ? entry.relativePath + '/' : '') + vfname,
        uploadedBy, uploadedAt: now, changeNote: String(o.changeNote || '').slice(0, 300),
      }
      this.meta.versions[version.versionId] = version
      entry.currentVersion = nextNo; entry.currentVersionId = version.versionId
      entry.size = size; entry.hash = hash; entry.updatedBy = uploadedBy; entry.updatedAt = now
      this._log(uploadedBy, 'upload_version', entry.entryId, vfname)
      this._save()
      return { ok: true, entry: this._publicEntry(entry), version }
    }

    // 新文件
    const parsed = parseLogicalName(safeFileName(o.fileName, 'file'))
    const logicalBase = parsed.base
    const ext = parsed.ext
    let displayName = logicalBase + ext
    let parentRel
    try { parentRel = this._parentRelPath(o.parentId) } catch (e) { return { ok: false, error: String(e.message || e) } }

    const existing = this._findChild(o.parentId || ROOT_ID, 'file', displayName)
    if (existing && !o.rename) {
      // 重名且未指定改名 → 交回上层决策（改名为新文件 / 作为新版本）。绝不静默覆盖。
      return { ok: false, conflict: true, entryId: existing.entryId, name: displayName, error: '同名文件已存在' }
    }
    if (existing && o.rename) {
      // 作为新文件改名：追加 (n) 直到不冲突
      let i = 1
      while (this._findChild(o.parentId || ROOT_ID, 'file', logicalBase + '(' + i + ')' + ext)) i++
      displayName = logicalBase + '(' + i + ')' + ext
    }
    const newBase = parseLogicalName(displayName).base
    const rel = parentRel ? parentRel + '/' + displayName : displayName
    let abs
    try { abs = this._absForRel(parentRel, displayName) } catch (e) { return { ok: false, error: String(e.message || e) } }
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    try { moveInto(tempPath, abs) } catch (e) { return { ok: false, error: '落盘失败:' + (e.message || e) } }
    const now = Date.now()
    const entryId = crypto.randomUUID()
    const version = {
      versionId: crypto.randomUUID(), entryId, spaceId: this.meta.space.spaceId, groupId: this.meta.space.groupId,
      versionNo: 0, versionFileName: displayName, fileSize: size, fileHash: hash,
      storageRelativePath: rel, uploadedBy, uploadedAt: now, changeNote: String(o.changeNote || '').slice(0, 300),
    }
    const entry = {
      entryId, spaceId: this.meta.space.spaceId, groupId: this.meta.space.groupId,
      parentId: o.parentId || ROOT_ID, name: displayName, type: 'file', ext, logicalBase: newBase,
      currentVersion: 0, currentVersionId: version.versionId, size, hash,
      relativePath: parentRel, createdBy: uploadedBy, updatedBy: uploadedBy, createdAt: now, updatedAt: now, status: 'normal',
    }
    this.meta.versions[version.versionId] = version
    this.meta.entries[entryId] = entry
    this._log(uploadedBy, 'upload_file', entryId, displayName)
    this._save()
    return { ok: true, entry: this._publicEntry(entry), version }
  }

  // -------- 历史版本 --------
  listHistory (entryId) {
    const entry = this.meta.entries[entryId]
    if (!entry || entry.type !== 'file') return { ok: false, error: '文件不存在' }
    const versions = Object.values(this.meta.versions)
      .filter((v) => v.entryId === entryId)
      .sort((a, b) => b.versionNo - a.versionNo)
      .map((v) => ({ versionId: v.versionId, versionNo: v.versionNo, versionFileName: v.versionFileName, fileSize: v.fileSize, fileHash: v.fileHash, uploadedBy: v.uploadedBy, uploadedAt: v.uploadedAt, changeNote: v.changeNote || '' }))
    return { ok: true, entryId, name: entry.name, versions }
  }

  // 取某版本的绝对路径（供下载）。version 缺省取当前版本。
  versionAbsPath (entryId, versionId) {
    const entry = this.meta.entries[entryId]
    if (!entry || entry.type !== 'file' || entry.status !== 'normal') return null
    const vid = versionId || entry.currentVersionId
    const v = this.meta.versions[vid]
    if (!v || v.entryId !== entryId) return null
    let abs
    try { abs = this._absForRel('', v.storageRelativePath) } catch (_) { return null }
    if (!fs.existsSync(abs)) return null
    return { abs, fileName: v.versionFileName, size: v.fileSize, hash: v.fileHash, versionNo: v.versionNo }
  }

  // -------- 重命名 --------
  rename (operatorId, entryId, newName) {
    const entry = this.meta.entries[entryId]
    if (!entry || entry.status !== 'normal') return { ok: false, error: '条目不存在' }
    const chk = checkSegment(newName)
    if (!chk.ok) return { ok: false, error: chk.error }
    newName = chk.value
    if (entry.type === 'folder') {
      if (this._findChild(entry.parentId, 'folder', newName)) return { ok: false, error: '同名文件夹已存在' }
      const parentRel = entry.relativePath.includes('/') ? entry.relativePath.slice(0, entry.relativePath.lastIndexOf('/')) : ''
      const oldRel = entry.relativePath
      const newRel = parentRel ? parentRel + '/' + newName : newName
      let oldAbs, newAbs
      try { oldAbs = this._absForRel(oldRel, ''); newAbs = this._absForRel(newRel, '') } catch (e) { return { ok: false, error: String(e.message || e) } }
      if (fs.existsSync(newAbs)) return { ok: false, error: '目标目录已存在' }
      fs.renameSync(oldAbs, newAbs)
      // 更新自身与所有后代的 relativePath/storageRelativePath 前缀
      const prefix = oldRel + '/'
      for (const e of Object.values(this.meta.entries)) {
        if (e.entryId === entry.entryId) continue
        if (e.relativePath === oldRel) e.relativePath = newRel
        else if (e.relativePath && e.relativePath.startsWith(prefix)) e.relativePath = newRel + '/' + e.relativePath.slice(prefix.length)
      }
      for (const v of Object.values(this.meta.versions)) {
        if (v.storageRelativePath === oldRel) v.storageRelativePath = newRel
        else if (v.storageRelativePath && v.storageRelativePath.startsWith(prefix)) v.storageRelativePath = newRel + '/' + v.storageRelativePath.slice(prefix.length)
      }
      entry.name = newName; entry.relativePath = newRel; entry.updatedBy = operatorId; entry.updatedAt = Date.now()
      this._log(operatorId, 'rename', entry.entryId, newName)
      this._save()
      return { ok: true, entry: this._publicEntry(entry) }
    }
    // 文件重命名：保持版本关系——逻辑基名整体更名，所有物理版本文件随之改名
    const parsed = parseLogicalName(newName)
    const newBase = parsed.base; const newExt = parsed.ext
    const newDisplay = newBase + newExt
    if (this._findChild(entry.parentId, 'file', newDisplay)) return { ok: false, error: '同名文件已存在' }
    const versions = Object.values(this.meta.versions).filter((v) => v.entryId === entryId)
    // 预校验目标文件不存在
    for (const v of versions) {
      const vname = versionFileName(newBase, newExt, v.versionNo)
      const abs = this._absForRel(entry.relativePath, vname)
      const oldAbs = this._absForRel('', v.storageRelativePath)
      if (abs !== oldAbs && fs.existsSync(abs)) return { ok: false, error: '目标文件名冲突' }
    }
    for (const v of versions) {
      const vname = versionFileName(newBase, newExt, v.versionNo)
      const oldAbs = this._absForRel('', v.storageRelativePath)
      const newAbs = this._absForRel(entry.relativePath, vname)
      if (oldAbs !== newAbs) { try { fs.renameSync(oldAbs, newAbs) } catch (e) { return { ok: false, error: '重命名失败:' + (e.message || e) } } }
      v.versionFileName = vname
      v.storageRelativePath = (entry.relativePath ? entry.relativePath + '/' : '') + vname
    }
    entry.name = newDisplay; entry.logicalBase = newBase; entry.ext = newExt; entry.updatedBy = operatorId; entry.updatedAt = Date.now()
    this._log(operatorId, 'rename', entry.entryId, newDisplay)
    this._save()
    return { ok: true, entry: this._publicEntry(entry) }
  }

  // -------- 删除（移入 .trash，标记 deleted，历史版本一并保留入回收站） --------
  remove (operatorId, entryId) {
    const entry = this.meta.entries[entryId]
    if (!entry || entry.status !== 'normal') return { ok: false, error: '条目不存在' }
    const stamp = Date.now() + '-' + entry.entryId.slice(0, 8)
    // 收集要标 deleted 的条目（文件夹含后代）
    const affected = [entry]
    if (entry.type === 'folder') {
      const prefix = entry.relativePath + '/'
      for (const e of Object.values(this.meta.entries)) {
        if (e.entryId !== entry.entryId && e.status === 'normal' && (e.relativePath === entry.relativePath || (e.relativePath && e.relativePath.startsWith(prefix)))) affected.push(e)
      }
    }
    try {
      fs.mkdirSync(this.trashDir, { recursive: true })
      if (entry.type === 'folder') {
        const src = this._absForRel(entry.relativePath, '')
        const dst = path.join(this.trashDir, stamp + '__' + entry.name)
        if (fs.existsSync(src)) fs.renameSync(src, dst)
      } else {
        // 文件：把该条目的所有物理版本文件移入回收站
        const dir = path.join(this.trashDir, stamp + '__' + entry.name)
        fs.mkdirSync(dir, { recursive: true })
        for (const v of Object.values(this.meta.versions)) {
          if (v.entryId !== entry.entryId) continue
          const src = this._absForRel('', v.storageRelativePath)
          if (fs.existsSync(src)) fs.renameSync(src, path.join(dir, v.versionFileName))
        }
      }
    } catch (e) { return { ok: false, error: '移入回收站失败:' + (e.message || e) } }
    const now = Date.now()
    for (const e of affected) { e.status = 'deleted'; e.updatedAt = now; e.updatedBy = operatorId; e.trashStamp = stamp }
    this._log(operatorId, 'delete', entry.entryId, entry.name)
    this._save()
    return { ok: true, entryId: entry.entryId, affected: affected.length }
  }

  recentLogs (n) {
    return this.meta.logs.slice(-(n || 50)).reverse()
  }
}

module.exports = {
  ShareStore,
  // 纯函数导出（供测试与复用）
  parseLogicalName, versionFileName, padVersion, isReservedName, checkSegment, safeFileName, isInside, sha256File,
  ROOT_ID,
}
