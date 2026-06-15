'use strict'

// 文件名/路径安全工具（纯函数，无 electron/fs 依赖，便于单元测试）。
// 用途：把“对端可控”的文件名净化为安全的纯文件名，防止路径穿越/任意文件写入。

// 用 win32 版 basename/extname：本应用目标平台为 Windows，且无论测试运行在何平台
// 都需同时识别 '/' 与 '\\' 两种分隔符，避免对端用 Windows 风格路径绕过净化。
const { basename, extname } = require('path').win32

const MAX_FILENAME_LEN = 200 // 落盘文件名长度上限，避免超长名导致写入失败

// 把任意（可能来自网络对端的）文件名净化为只含单层、无非法字符的安全文件名。
// 步骤：① 取 basename 去掉目录部分（含 ../、..\\ 与绝对路径）→ ② 过滤路径分隔符/盘符/通配符/控制字符
//      → ③ 排除 '.'/'..'/空 等危险或无效结果回退到 fallback → ④ 截断超长名
function safeFileName (name, fallback) {
  const fb = (fallback && String(fallback)) || 'file'
  let n = basename(String(name == null ? '' : name)) // 去掉任何目录部分（含 ../、..\\ 与绝对路径）
  // 过滤 Windows/Unix 下的非法或危险字符（含路径分隔符、盘符冒号、通配符、控制字符）
  n = n.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+$/, '').trim()
  if (!n) n = basename(fb) || 'file'
  if (n.length > MAX_FILENAME_LEN) {
    const ext = extname(n).slice(0, 16) // 保留扩展名（限长，防超长扩展名绕过）
    n = n.slice(0, MAX_FILENAME_LEN - ext.length) + ext
  }
  return n
}

module.exports = { safeFileName, MAX_FILENAME_LEN }
