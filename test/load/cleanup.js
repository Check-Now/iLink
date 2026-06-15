'use strict'
/*
 * 测试数据清理。所有压测产物都带 testRunId，便于安全清理（不触碰任何业务数据）。
 * 用法：
 *   node test/load/cleanup.js              # 列出可清理的 testRunId
 *   node test/load/cleanup.js <testRunId>  # 清理指定 run 的报告/测试数据/残留 .part
 *   node test/load/cleanup.js --all        # 清理全部 LT-* 压测产物
 */

const fs = require('fs')
const os = require('os')
const path = require('path')

const RESULTS = path.join(__dirname, 'results')
const TESTDATA = path.join(__dirname, '.testdata')

function rm (p) { try { fs.rmSync(p, { recursive: true, force: true }); return true } catch (_) { return false } }

function listRuns () {
  const out = new Set()
  for (const base of [RESULTS, TESTDATA]) {
    try { for (const f of fs.readdirSync(base)) { const m = f.match(/LT-[\w.-]+/); if (m) out.add(m[0]) } } catch (_) {}
  }
  return Array.from(out)
}

function cleanRun (id) {
  let n = 0
  if (rm(path.join(RESULTS, id))) n++
  try { for (const f of fs.readdirSync(TESTDATA)) if (f.includes(id)) { if (rm(path.join(TESTDATA, f))) n++ } } catch (_) {}
  try { for (const f of fs.readdirSync(os.tmpdir())) if (/^freedom-.*\.part$/.test(f) && f.includes(id)) { if (rm(path.join(os.tmpdir(), f))) n++ } } catch (_) {}
  console.log(`已清理 ${id}：${n} 项`)
}

const arg = process.argv[2]
if (!arg) {
  const runs = listRuns()
  if (!runs.length) console.log('没有发现可清理的压测产物。')
  else { console.log('可清理的 testRunId：'); runs.forEach((r) => console.log('  ' + r)); console.log('\n清理：node test/load/cleanup.js <testRunId>  或  --all') }
} else if (arg === '--all') {
  const runs = listRuns()
  runs.forEach(cleanRun)
  rm(TESTDATA)
  console.log(`完成，共处理 ${runs.length} 个 run。`)
} else {
  cleanRun(arg)
}
