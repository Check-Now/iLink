'use strict'
// 单元测试：验证 safeFileName 对“对端可控文件名”的净化，防止路径穿越/任意文件写入。
// 运行：node test/pathutil-smoke.js
const assert = require('assert')
const path = require('path')
const { safeFileName, MAX_FILENAME_LEN } = require('../electron/pathutil')

// 1) 正常文件名保持不变（合法路径不被误改）
assert.strictEqual(safeFileName('photo.png', 'fb'), 'photo.png', '普通文件名应不变')
assert.strictEqual(safeFileName('我的文档.pdf', 'fb'), '我的文档.pdf', '中文名应保留')

// 2) 路径穿越：目录部分必须被剥离，只剩纯文件名
assert.strictEqual(safeFileName('../../etc/passwd', 'fb'), 'passwd', 'unix ../ 应被剥离')
assert.strictEqual(safeFileName('..\\..\\Startup\\evil.exe', 'fb'), 'evil.exe', 'windows ..\\ 应被剥离')
assert.strictEqual(safeFileName('/etc/cron.d/x', 'fb'), 'x', '绝对路径应只取末段')
assert.strictEqual(safeFileName('a/b/c.txt', 'fb'), 'c.txt', '多层目录应只取末段')

// 3) 纯 '.'/'..'/空 → 回退到 fallback（避免危险或无效落盘名）
assert.strictEqual(safeFileName('..', 'file-1'), 'file-1', '".." 应回退 fallback')
assert.strictEqual(safeFileName('.', 'file-2'), 'file-2', '"." 应回退 fallback')
assert.strictEqual(safeFileName('', 'file-3'), 'file-3', '空名应回退 fallback')
assert.strictEqual(safeFileName(null, 'file-4'), 'file-4', 'null 应回退 fallback')

// 4) 非法/控制字符被替换；Windows 盘符绝对路径被剥离
assert.strictEqual(safeFileName('a*b?c<d>.txt', 'fb'), 'a_b_c_d_.txt', '非法字符应被替换为下划线')
assert.strictEqual(safeFileName('C:\\Windows\\System32\\evil.dll', 'fb'), 'evil.dll', '盘符绝对路径应只取末段')
assert.ok(!/[\x00-\x1f]/.test(safeFileName('a\nb\tc.txt', 'fb')), '控制字符应被清理')

// 5) 超长文件名被截断但保留扩展名
const long = 'x'.repeat(500) + '.png'
const trimmed = safeFileName(long, 'fb')
assert.ok(trimmed.length <= MAX_FILENAME_LEN, '超长名应被截断到上限内')
assert.ok(trimmed.endsWith('.png'), '截断后应保留扩展名')

// 6) 关键不变量：把净化后的名拼到下载目录，结果仍在下载目录内（不逃逸）
const dir = path.resolve('/tmp/downloads')
for (const evil of ['../../evil', '..\\..\\evil', '/etc/x', '....//x', 'a/../../b']) {
  const dest = path.resolve(dir, safeFileName(evil, 'file-x'))
  assert.ok(dest.startsWith(dir + path.sep), '净化后路径必须仍在下载目录内: ' + evil + ' -> ' + dest)
}

console.log('✅ safeFileName 路径穿越/非法字符/超长/回退 全部通过')
process.exit(0)
