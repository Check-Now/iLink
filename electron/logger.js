'use strict'

// 传输/审计日志：把关键运行事件落地为 data 目录下的 ilink.log，便于内网排障。
// 隐私原则：只记录元数据（事件类型、mid、文件名/大小、对端 id/昵称、错误码等），
//          绝不记录消息正文/密钥等敏感内容（与端到端加密的隐私模型一致）。
// 超过 2MB 自动轮转一份 .old，仅保留最近两段，避免无限增长。

const fs = require('fs')
const path = require('path')

const MAX_BYTES = 2 * 1024 * 1024

class Logger {
  constructor () { this.file = null }

  init (dir) {
    try {
      if (!dir) return
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      this.file = path.join(dir, 'ilink.log')
      this._rotateIfNeeded()
      this.log('app', 'logger-init')
    } catch (_) { this.file = null }
  }

  _rotateIfNeeded () {
    try {
      if (this.file && fs.existsSync(this.file) && fs.statSync(this.file).size > MAX_BYTES) {
        const old = this.file + '.old'
        try { fs.unlinkSync(old) } catch (_) {}
        fs.renameSync(this.file, old)
      }
    } catch (_) {}
  }

  // cat: 类别(app/peer/msg/file/net)；event: 事件名；fields: 仅元数据
  log (cat, event, fields) {
    if (!this.file) return
    try {
      this._rotateIfNeeded()
      const rec = { t: new Date().toISOString(), cat, event, ...(fields || {}) }
      fs.appendFileSync(this.file, JSON.stringify(rec) + '\n')
    } catch (_) {}
  }
}

module.exports = { Logger }
