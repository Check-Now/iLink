'use strict'
/* 公共工具：分位统计、资源采样、CSV、睡眠、目录。零业务依赖。 */

const fs = require('fs')
const path = require('path')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function ensureDir (dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); return dir }

function percentile (sortedAsc, p) {
  if (!sortedAsc.length) return 0
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1))
  return sortedAsc[idx]
}

function stats (arr) {
  if (!arr || !arr.length) return { count: 0, avg: 0, p50: 0, p95: 0, p99: 0, max: 0, min: 0 }
  const s = arr.slice().sort((a, b) => a - b)
  const sum = s.reduce((a, b) => a + b, 0)
  return {
    count: s.length,
    avg: +(sum / s.length).toFixed(2),
    p50: percentile(s, 50),
    p95: percentile(s, 95),
    p99: percentile(s, 99),
    max: s[s.length - 1],
    min: s[0],
  }
}

// CSV：行数组 -> 字符串。每个字段做最小转义。
function toCsv (header, rows) {
  const esc = (v) => {
    const s = v == null ? '' : String(v)
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
  }
  const lines = [header.join(',')]
  for (const r of rows) lines.push(header.map((h) => esc(r[h])).join(','))
  return lines.join('\n') + '\n'
}

// 进程资源采样器（单节点 CPU% / RSS / heap），后台周期采样
class ResourceSampler {
  constructor (intervalMs = 1000) {
    this.intervalMs = intervalMs
    this.samples = []
    this._timer = null
    this._lastCpu = process.cpuUsage()
    this._lastTs = Date.now()
  }
  start () {
    this._timer = setInterval(() => {
      const now = Date.now()
      const cpu = process.cpuUsage(this._lastCpu)
      const elapsedUs = (now - this._lastTs) * 1000
      const cpuPct = elapsedUs > 0 ? +(((cpu.user + cpu.system) / elapsedUs) * 100).toFixed(1) : 0
      const mem = process.memoryUsage()
      this.samples.push({ ts: now, cpuPct, rssMB: +(mem.rss / 1048576).toFixed(1), heapMB: +(mem.heapUsed / 1048576).toFixed(1) })
      this._lastCpu = process.cpuUsage()
      this._lastTs = now
    }, this.intervalMs)
    if (this._timer.unref) this._timer.unref()
  }
  stop () { if (this._timer) clearInterval(this._timer); this._timer = null }
  summary () {
    if (!this.samples.length) return { cpuPctAvg: 0, cpuPctMax: 0, rssMBMax: 0, rssMBStart: 0, rssMBEnd: 0, heapMBMax: 0, samples: [] }
    const cpu = this.samples.map((s) => s.cpuPct)
    const rss = this.samples.map((s) => s.rssMB)
    const heap = this.samples.map((s) => s.heapMB)
    // 稳态基线：取约 30% 进度处的样本（已过冷启动/ramp 分配），用于判断"是否持续无上限增长"
    const steadyIdx = Math.min(rss.length - 1, Math.floor(rss.length * 0.3))
    return {
      cpuPctAvg: +(cpu.reduce((a, b) => a + b, 0) / cpu.length).toFixed(1),
      cpuPctMax: Math.max(...cpu),
      rssMBStart: rss[0],
      rssMBSteady: rss[steadyIdx],