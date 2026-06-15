'use strict'
/*
 * 文件传输并发场景：复用 electron/filetransfer.js（TCP + 分块 AES-GCM + SHA-256 + 断点续传）。
 * 覆盖：并发发送、进度记录、传输中断、断点续传、完成后 SHA-256 校验、成功/失败统计。
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { sleep, ensureDir } = require('./util')

function genFile (dir, sizeBytes, tag) {
  ensureDir(dir)
  const fp = path.join(dir, 'src-' + tag + '.bin')
  const fd = fs.openSync(fp, 'w')
  const buf = crypto.randomBytes(1024 * 1024)
  let written = 0
  const h = crypto.createHash('sha256')
  while (written < sizeBytes) {
    const n = Math.min(buf.length, sizeBytes - written)
    const slice = n === buf.length ? buf : buf.subarray(0, n)
    fs.writeSync(fd, slice); h.update(slice); written += n
  }
  fs.closeSync(fd)
  return { fp, sha256: h.digest('hex'), size: sizeBytes }
}

// 为参与文件传输的客户端启动 TCP 文件节点，并提供 resolvePeer
async function setupFileNodes (clients) {
  const info = new Map()
  const resolvePeer = (id) => info.get(id)
  for (const c of clients) { await c.startFile(resolvePeer); }
  for (const c of clients) info.set(c.id, { id: c.id, address: '127.0.0.1', tport: c.tport, pub: c.pub })
  return { resolvePeer, info }
}

async function fileScenario (h, cfg, collector) {
  const fcfg = cfg.file
  const cs = h.clients.filter((c) => c.online)
  const nSenders = Math.max(1, Math.min(fcfg.senders, Math.floor(cs.length / 2) || 1))
  const senders = cs.slice(0, nSenders)
  const receivers = cs.slice(nSenders, nSenders * 2)
  while (receivers.length < senders.length) receivers.push(cs[(nSenders + receivers.length) % cs.length])

  await setupFileNodes(senders.concat(receivers))

  const srcDir = path.join(cfg.testDataDir, 'filesrc-' + cfg.testRunId)
  const sizeBytes = Math.max(1, Math.round(fcfg.testFileSizeMB * 1024 * 1024))
  const src = genFile(srcDir, sizeBytes, 'main')

  const results = []
  const transfers = []

  for (let i = 0; i < senders.length; i++) {
    const s = senders[i]; const r = receivers[i]
    const mid = cfg.testRunId + '.file.' + i
    const rec = { mid, from: s.id, to: r.id, size: sizeBytes, ok: false, hashOk: false, ms: 0, speedMBps: 0, resumed: false, failed: false }
    transfers.push(rec)

    const start = Date.now()
    const donePromise = new Promise((resolve) => {
      const onDone = (info) => {
        if (info.transferMid !== mid && info.mid !== mid) return
        rec.ms = Date.now() - start
        rec.speedMBps = rec.ms > 0 ? +((sizeBytes / 1048576) / (rec.ms / 1000)).toFixed(2) : 0
        try {
          const got = crypto.createHash('sha256').update(fs.readFileSync(info.tempPath)).digest('hex')
          rec.hashOk = got === src.sha256
        } catch (_) { rec.hashOk = false }
        rec.ok = true
        try { fs.unlinkSync(info.tempPath) } catch (_) {}
        r.ft.removeListener('done', onDone); r.ft.removeListener('failed', onFail)
        resolve()
      }
      const onFail = (info) => {
        if (info.mid && info.mid !== mid) return
        if (rec.ok) return
        // 中断续传场景：首次失败后会重发，不立即判定失败
      }
      r.ft.on('done', onDone); r.ft.on('failed', onFail)
    })
    results.push({ s, r, mid, donePromise })
  }

  // 并发发起
  for (const it of results) it.s.ft.sendFile(it.r.id, src.fp, fcfg.scope, it.mid, it.r.id)

  // 中断 + 断点续传：对第一个传输，中途断开后同 mid 重发
  if (fcfg.interruptResume && results.length) {
    const it = results[0]
    transfers[0].resumed = true
    // 等到收到部分进度后断开发送 socket（网络中断 → 接收端保留 .part）
    await new Promise((resolve) => {
      let broke = false
      const onProg = (p) => {
        if (broke || p.mid !== it.mid) return
        if (p.received > sizeBytes * 0.4) {
          broke = true
          try { const e = it.s.ft.outbound.get(it.mid); e && e.socket && e.socket.destroy() } catch (_) {}
          it.r.ft.removeListener('progress', onProg)
          resolve()
        }
      }
      it.r.ft.on('progress', onProg)
      setTimeout(() => { if (!broke) { it.r.ft.removeListener('progress', onProg); resolve() } }, 4000)
    })
    await sleep(300)
    it.s.ft.sendFile(it.r.id, src.fp, fcfg.scope, it.mid, it.r.id) // 同 mid 重发 → 断点续传
  }

  // 等待全部完成（上限超时）
  const deadline = Date.now() + Math.max(30000, sizeBytes / 1048576 * 3000)
  await Promise.race([
    Promise.all(results.map((it) => it.donePromise)),
    (async () => { while (Date.now() < deadline && transfers.some((t) => !t.ok)) await sleep(200) })(),
  ])

  for (const t of transfers) { if (!t.ok) t.failed = true; collector.fileTransfers.push(t) }

  // 临时文件残留检查
  let partLeftover = 0
  try { for (const f of fs.readdirSync(require('os').tmpdir())) if (/^freedom-.*\.part$/.test(f) && f.includes(cfg.testRunId)) partLeftover++ } catch (_) {}
  try { fs.rmSync(srcDir, { recursive: true, force: true }) } catch (_) {}

  const success = transfers.filter((t) => t.ok).length
  const hashPass = transfers.filter((t) => t.hashOk).length
  return {
    name: 'file',
    sent: transfers.length,
    success,
    failed: transfers.length - success,
    successRate: +(success / transfers.length).toFixed(4),
    hashPassRate: success ? +(hashPass / success).toFixed(4) : 0,
    resumeTried: transfers.filter((t) => t.resumed).length,
    resumeOk: transfers.filter((t) => t.resumed && t.ok && t.hashOk).length,
    avgSpeedMBps: +(transfers.filter((t) => t.ok).reduce((a, t) => a + t.speedMBps, 0) / (success || 1)).toFixed(2),
    avgMs: Math.round(transfers.filter((t) => t.ok).reduce((a, t) => a + t.ms, 0) / (success || 1)),
    partLeftover,
    fileSizeMB: fcfg.testFileSizeMB,
  }
}

module.exports = { fileScenario, genFile }
