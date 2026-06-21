'use strict'

// 线协议编解码：MAGIC 前缀 + JSON 载荷。纯函数、无状态、无 electron 依赖，便于单测与复用。
// 注意：改动 MAGIC 或载荷结构会破坏版本兼容（旧端无法识别本端数据报），需谨慎并保证向后兼容。

const MAGIC = 'FRDM1'
const SAFE_DATAGRAM_BYTES = 60000 // 单个 UDP 数据报安全上限(<理论 65507)；群发广播包超过此值则跳过广播，改由可靠单播投递

function encode (obj) { return Buffer.from(MAGIC + JSON.stringify(obj), 'utf8') }

function decode (buf) {
  if (!buf || buf.length <= MAGIC.length) return null
  if (buf.toString('utf8', 0, MAGIC.length) !== MAGIC) return null
  try { return JSON.parse(buf.toString('utf8', MAGIC.length)) } catch (_) { return null }
}

module.exports = { MAGIC, SAFE_DATAGRAM_BYTES, encode, decode }
