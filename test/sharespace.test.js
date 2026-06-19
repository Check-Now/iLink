'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { ShareStore } = require('../electron/sharespace')

function tempDir () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-share-test-'))
}

function createStore (rootPath) {
  return ShareStore.create(rootPath, {
    spaceId: 'space-1',
    groupId: 'room-1',
    name: 'Team Files',
    hostUserId: 'host',
    hostDeviceId: 'device',
    createdBy: 'host',
  })
}

test('ShareStore uploads, renames conflicts, downloads folders, and removes descendants', async (t) => {
  const dir = tempDir()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  const store = createStore(path.join(dir, 'share'))
  const source = path.join(dir, 'report.txt')
  fs.writeFileSync(source, 'hello')

  const folder = store.createFolder('u1', 'root', 'Docs')
  assert.equal(folder.ok, true)

  const first = await store.placeUpload({
    fileName: 'report.txt',
    srcPath: source,
    copyOnly: true,
    uploadedBy: 'u1',
    parentId: folder.entry.entryId,
    hash: 'hash-1',
  })
  assert.equal(first.ok, true)
  assert.equal(first.entry.name, 'report.txt')

  const conflict = await store.placeUpload({
    fileName: 'report.txt',
    srcPath: source,
    copyOnly: true,
    uploadedBy: 'u1',
    parentId: folder.entry.entryId,
    hash: 'hash-1',
  })
  assert.equal(conflict.ok, false)
  assert.equal(conflict.conflict, true)

  const renamedUpload = await store.placeUpload({
    fileName: 'report.txt',
    srcPath: source,
    copyOnly: true,
    rename: true,
    uploadedBy: 'u1',
    parentId: folder.entry.entryId,
    hash: 'hash-2',
  })
  assert.equal(renamedUpload.ok, true)
  assert.equal(renamedUpload.entry.name, 'report(1).txt')

  const beforeRename = store.downloadList(folder.entry.entryId)
  assert.equal(beforeRename.ok, true)
  assert.deepEqual(beforeRename.files.map((f) => f.relativePath).sort(), ['Docs/report(1).txt', 'Docs/report.txt'])

  const renamedFolder = store.rename('u2', folder.entry.entryId, 'Renamed')
  assert.equal(renamedFolder.ok, true)
  assert.equal(renamedFolder.entry.relativePath, 'Renamed')

  const afterRename = store.downloadList(folder.entry.entryId)
  assert.equal(afterRename.ok, true)
  assert.deepEqual(afterRename.files.map((f) => f.relativePath).sort(), ['Renamed/report(1).txt', 'Renamed/report.txt'])
  for (const f of afterRename.files) assert.equal(fs.existsSync(f.abs), true)

  const removed = store.remove('u3', folder.entry.entryId)
  assert.equal(removed.ok, true)
  assert.equal(removed.affected, 3)
  assert.deepEqual(store.listDir('root').entries, [])
})

test('ShareStore rejects unsafe segments and path traversal fallbacks', () => {
  const dir = tempDir()
  try {
    const store = createStore(path.join(dir, 'share'))

    assert.equal(store.createFolder('u1', 'root', 'CON').ok, false)
    assert.equal(store.createFolder('u1', 'root', 'bad/name').ok, false)
    assert.throws(() => store._absForRel('..', 'escape.txt'), /路径越界/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
