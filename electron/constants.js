'use strict'

// 跨主进程模块共享的常量（纯 Node，无 electron 依赖，可被 p2p 等 electron-free 模块安全引用）。
// 目的：消除同一枚举在 main/p2p/vault 各写一份导致的漂移——此前 presence 的 'dnd' 在各处
// 白名单不一致，曾导致免打扰状态在持久化层被回退。

const PRESENCE_VALUES = ['online', 'busy', 'away', 'dnd']
const DEFAULT_PRESENCE = 'online'
// 校验并归一 presence：合法值原样返回，未知值安全回退默认（online）。
function normalizePresence (p) { return PRESENCE_VALUES.includes(p) ? p : DEFAULT_PRESENCE }

module.exports = { PRESENCE_VALUES, DEFAULT_PRESENCE, normalizePresence }
