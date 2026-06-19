'use strict'

// 群共享空间·宿主端权威存储（纯 P2P，无中心服务器）
// 设计：
//  - 共享空间数据存储在“共享主机”(创建者)本机；本模块只在主机进程运行，负责落盘与元数据管理。
//  - 物理布局：
//      <rootPath>/files/<目录树>/<文件...>       真实文件
//      <rootPath>/.ilink-share/meta.json         元数据（空间/目录项/日志）
//  - 安全：对端可控的名称一律净化；禁止路径穿越/盘符/通配符/Windows 保留名；落盘前 .part 暂存校验后改名。
// 注意：本文件不依赖 electron，便于在 Node 下直接做单元测试。

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const fsp = require('fs').promises
const { win32 } = require('path')

const META_DIR = '.ilink-share'
const META_FILE = 'meta.json'
const FILES_DIR = 'files'
const MAX_SEGMENT_LEN = 200
const ROOT_ID = 'root'

// Windows 保留设备名（基名，忽略大小写与扩展名）
const RESERVED = new Set(['con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9'])

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

// 异步流式计算 SHA-256（不阻塞事件循环，适合大文件）
function sha256FileAsync (filePath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256')
    const rs = fs.createReadStream(filePath, { highWaterMark: 4 * 1024 * 1024 })
    rs.on('error', reject)
    rs.on('data', (d) => h.update(d))
    rs.on('end', () => resolve(h.digest('hex')))
  })
}

// 流式复制并上报已复制字节数（不阻塞主线程；用于本机上传时展示进度条）
function copyWithProgress (src, dest, onProgress) {
  return new Promise((resolve, reject) => {
    let copied = 0
    const rs = fs.createReadStream(src, { highWaterMark: 8 * 1024 * 1024 })
    const ws = fs.createWriteStream(dest)
    rs.on('error', reject); ws.on('error', reject)
    rs.on('data', (chunk) => { copied += chunk.length; try { onProgress && onProgress(copied) } catch (_) {} })
    ws.on('finish', () => resolve())
    rs.pipe(ws)
  })
}

// 异步落盘：同卷优先用 rename（瞬时）；跨卷或保留源文件时用异步复制（不阻塞主线程）。
// keepSrc=true 表示源文件需保留（宿主本机上传自己的文件时，绝不删用户原文件）。onProgress 存在时流式复制并上报进度。
async function moveIntoAsync (src, dest, keepSrc, onProgress) {
  if (!keepSrc && !onProgress) {
    try { await fsp.rename(src, dest); return } catch (e) { if (!e || e.code !== 'EXDEV') throw e } // 同卷瞬时；跨卷再退回 copy
  }
  const part = dest + '.part' // 写到 .part 再改名，避免外部看到半成品
  if (onProgress) await copyWithProgress(src, part, onProgress)
  else await fsp.copyFile(src, part)
  await fsp.rename(part, dest)
  if (!keepSrc) { try { await fsp.unlink(src) } catch (_) {} }
}

// ============ 单个共享空间的宿主存储 ============
class ShareStore {
  constructor (rootPath) {
    this.rootPath = rootPath
    this.metaDir = path.join(rootPath, META_DIR)
    this.metaPath = path.join(this.metaDir, META_FILE)
    this.filesDir = path.join(rootPath, FILES_DIR)
    this.meta = null
  }

  // 创建新空间（写 meta + 目录骨架）。space: { spaceId, groupId, name, hostUserId, hostDeviceId, createdBy }
  static create (rootPath, space) {
    fs.mkdirSync(path.join(rootPath, META_DIR), { recursive: true })
    fs.mkdirSync(path.join(rootPath, FILES_DIR), { recursive: true })
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

  _fileRelPath (entry) {
    if (!entry || entry.type !== 'file') return ''
    return entry.storageRelativePath || ((entry.relativePath ? entry.relativePath + '/' : '') + entry.name)
  }

  _fileAbs (entry) {
    return this._absForRel(entry.relativePath || '', entry.name)
  }

  _findChild (parentId, type, name) {
    const pid = parentId || ROOT_ID
    return Object.values(this.meta.entries).find((e) =>
      e.parentId === pid && e.status === 'normal' && e.type === type && e.name === name) || null
  }

  getEntry (entryId) {
    const entry = this.meta.entries[entryId]
    return entry && entry.status === 'normal' ? this._publicEntry(entry) : null
  }

  // -------- 查询 --------
  spaceInfo () {
    const s = this.meta.space
    const fileCount = Object.values(this.meta.entries).filter((e) => e.type === 'file' && e.status === 'normal').length
    let updatedAt = s.updatedAt
    for (const e of Object.values(this.meta.entries)) if (e.status === 'normal') updatedAt = Math.max(updatedAt, e.updatedAt || 0)
    return { spaceId: s.spaceId, groupId: s.groupId, name: s.name, hostUserId: s.hostUserId, hostDeviceId: s.hostDeviceId, createdBy: s.createdBy, createdAt: s.createdAt, updatedAt, status: s.status, fileCount }
  }

  // 列目录：返回该 parent 下 normal 的文件夹与文件。
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

  search (query) {
    const q = String(query || '').trim().toLowerCase()
    if (!q) return { ok: true, entries: [] }
    const entries = Object.values(this.meta.entries)
      .filter((e) => e.status === 'normal' && String(e.name || '').toLowerCase().includes(q))
      .map((e) => {
        const breadcrumb = this._breadcrumb(e.type === 'folder' ? e.entryId : (e.parentId || ROOT_ID))
        return {
          ...this._publicEntry(e),
          breadcrumb,
          pathText: breadcrumb.map((c) => c.name).join(' / ') + (e.type === 'file' ? ' / ' + e.name : ''),
        }
      })
    return { ok: true, entries }
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
      size: e.size || 0, hash: e.hash || '', relativePath: e.relativePath || '',
      createdBy: e.createdBy || '', updatedBy: e.updatedBy || '', createdAt: e.createdAt, updatedAt: e.updatedAt,
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
      size: 0, hash: '', createdBy: operatorId || '', updatedBy: operatorId || '',
      createdAt: now, updatedAt: now, status: 'normal',
    }
    this.meta.entries[entry.entryId] = entry
    this._log(operatorId, 'create_folder', entry.entryId, name)
    this._save()
    return { ok: true, entry: this._publicEntry(entry) }
  }

  // -------- 上传文件（仅新文件）。异步，避免大文件同步 I/O 阻塞主进程 --------
  // opts: { fileName, tempPath|srcPath, uploadedBy, parentId, rename, hash, copyOnly }
  //   hash: 传输层已校验的 SHA-256，可跳过对大文件的二次哈希；copyOnly: 复制源文件进库并保留源（宿主本机上传）
  async placeUpload (opts) {
    const o = opts || {}
    const tempPath = o.tempPath || o.srcPath
    const keepSrc = !!o.copyOnly
    if (!tempPath || !fs.existsSync(tempPath)) return { ok: false, error: '临时文件不存在' }
    const uploadedBy = o.uploadedBy || ''
    let size = 0; let hash = o.hash || ''
    try { size = fs.statSync(tempPath).size } catch (e) { return { ok: false, error: '读取临时文件失败' } }
    if (!hash) { try { hash = await sha256FileAsync(tempPath) } catch (e) { return { ok: false, error: '读取临时文件失败' } } }

    let displayName = safeFileName(o.fileName, 'file')
    let parentRel
    try { parentRel = this._parentRelPath(o.parentId) } catch (e) { return { ok: false, error: String(e.message || e) } }

    const existing = this._findChild(o.parentId || ROOT_ID, 'file', displayName)
    if (existing && !o.rename) {
      // 重名且未指定改名 → 交回上层决策（改名为新文件 / 跳过）。绝不静默覆盖。
      return { ok: false, conflict: true, entryId: existing.entryId, name: displayName, error: '同名文件已存在' }
    }
    if (existing && o.rename) {
      const ext = win32.extname(displayName)
      const base = ext ? displayName.slice(0, displayName.length - ext.length) : displayName
      let i = 1
      while (this._findChild(o.parentId || ROOT_ID, 'file', base + '(' + i + ')' + ext)) i++
      displayName = base + '(' + i + ')' + ext
    }
    const ext = win32.extname(displayName)
    const rel = parentRel ? parentRel + '/' + displayName : displayName
    let abs
    try { abs = this._absForRel(parentRel, displayName) } catch (e) { return { ok: false, error: String(e.message || e) } }
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    try { await moveIntoAsync(tempPath, abs, keepSrc, o.onProgress ? (b) => o.onProgress(b, size) : null) } catch (e) { return { ok: false, error: '落盘失败:' + (e.message || e) } }
    const now = Date.now()
    const entryId = crypto.randomUUID()
    const entry = {
      entryId, spaceId: this.meta.space.spaceId, groupId: this.meta.space.groupId,
      parentId: o.parentId || ROOT_ID, name: displayName, type: 'file', ext,
      size, hash, relativePath: parentRel, storageRelativePath: rel,
      createdBy: uploadedBy, updatedBy: uploadedBy, createdAt: now, updatedAt: now, status: 'normal',
    }
    this.meta.entries[entryId] = entry
    this._log(uploadedBy, 'upload_file', entryId, displayName)
    this._save()
    return { ok: true, entry: this._publicEntry(entry) }
  }

  // -------- 下载清单 --------
  // 返回某个文件或文件夹下所有可下载文件；文件夹清单中的 relativePath 保留文件夹根目录。
  downloadList (entryId) {
    const entry = this.meta.entries[entryId]
    if (!entry || entry.status !== 'normal') return { ok: false, error: '条目不存在' }
    if (entry.type === 'file') {
      let abs
      try { abs = this._fileAbs(entry) } catch (_) { return { ok: false, error: '文件路径无效' } }
      if (!fs.existsSync(abs)) return { ok: false, error: '文件不存在' }
      return { ok: true, type: 'file', rootName: entry.name, files: [{ entryId: entry.entryId, abs, fileName: entry.name, relativePath: entry.name, size: entry.size || 0, hash: entry.hash || '' }] }
    }
    if (entry.type !== 'folder') return { ok: false, error: '条目类型无效' }
    const rootRel = entry.relativePath
    const prefix = rootRel + '/'
    const files = []
    for (const e of Object.values(this.meta.entries)) {
      if (!e || e.status !== 'normal' || e.type !== 'file') continue
      if (!(e.relativePath === rootRel || (e.relativePath && e.relativePath.startsWith(prefix)))) continue
      let abs
      try { abs = this._fileAbs(e) } catch (_) { continue }
      if (!fs.existsSync(abs)) continue
      files.push({ entryId: e.entryId, abs, fileName: e.name, relativePath: this._fileRelPath(e), size: e.size || 0, hash: e.hash || '' })
    }
    return { ok: true, type: 'folder', rootName: entry.name, files }
  }

  // -------- 重命名（仅文件夹） --------
  rename (operatorId, entryId, newName) {
    const entry = this.meta.entries[entryId]
    if (!entry || entry.status !== 'normal') return { ok: false, error: '条目不存在' }
    if (entry.type !== 'folder') return { ok: false, error: '文件不支持重命名' }
    const chk = checkSegment(newName)
    if (!chk.ok) return { ok: false, error: chk.error }
    newName = chk.value
    if (this._findChild(entry.parentId, 'folder', newName)) return { ok: false, error: '同名文件夹已存在' }
    const parentRel = entry.relativePath.includes('/') ? entry.relativePath.slice(0, entry.relativePath.lastIndexOf('/')) : ''
    const oldRel = entry.relativePath
    const newRel = parentRel ? parentRel + '/' + newName : newName
    let oldAbs, newAbs
    try { oldAbs = this._absForRel(oldRel, ''); newAbs = this._absForRel(newRel, '') } catch (e) { return { ok: false, error: String(e.message || e) } }
    if (fs.existsSync(newAbs)) return { ok: false, error: '目标目录已存在' }
    fs.renameSync(oldAbs, newAbs)
    const prefix = oldRel + '/'
    for (const e of Object.values(this.meta.entries)) {
      if (e.entryId === entry.entryId) continue
      if (e.relativePath === oldRel) e.relativePath = newRel
      else if (e.relativePath && e.relativePath.startsWith(prefix)) e.relativePath = newRel + '/' + e.relativePath.slice(prefix.length)
      if (e.type === 'file') e.storageRelativePath = (e.relativePath ? e.relativePath + '/' : '') + e.name
    }
    entry.name = newName; entry.relativePath = newRel; entry.updatedBy = operatorId; entry.updatedAt = Date.now()
    this._log(operatorId, 'rename_folder', entry.entryId, newName)
    this._save()
    return { ok: true, entry: this._publicEntry(entry) }
  }

  // -------- 删除：真删除文件/文件夹（文件夹含所有后代）。不可恢复。 --------
  remove (operatorId, entryId) {
    const entry = this.meta.entries[entryId]
    if (!entry || entry.status !== 'normal') return { ok: false, error: '条目不存在' }
    const affected = [entry]
    if (entry.type === 'folder') {
      const prefix = entry.relativePath + '/'
      for (const e of Object.values(this.meta.entries)) {
        if (e.entryId !== entry.entryId && e.status === 'normal' && (e.relativePath === entry.relativePath || (e.relativePath && e.relativePath.startsWith(prefix)))) affected.push(e)
      }
    }
    try {
      if (entry.type === 'folder') {
        const abs = this._absForRel(entry.relativePath, '')
        if (fs.existsSync(abs)) fs.rmSync(abs, { recursive: true, force: true })
      } else {
        const abs = this._fileAbs(entry)
        if (fs.existsSync(abs)) fs.unlinkSync(abs)
      }
    } catch (e) { return { ok: false, error: '删除失败:' + (e.message || e) } }
    const ids = new Set(affected.map((e) => e.entryId))
    for (const id of ids) delete this.meta.entries[id]
    this._log(operatorId, 'delete', entry.entryId, entry.name)
    this._save()
    return { ok: true, entryId: entry.entryId, affected: affected.length }
  }

}

module.exports = {
  ShareStore,
  // 纯函数导出（供测试与复用）
  isReservedName, checkSegment, safeFileName, isInside, sha256File,
  ROOT_ID,
}
