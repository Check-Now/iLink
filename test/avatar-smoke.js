'use strict'
// 单元测试：avatarutil 的 publicAvatar/baseAvatar/avatarCrop（p2p 与 main 去重后共用的逻辑）。
// 运行：node test/avatar-smoke.js
const assert = require('assert')
const { publicAvatar, avatarCrop, AVATAR_MAX_CHARS } = require('../electron/avatarutil')

// 非法/空 → null
assert.strictEqual(publicAvatar(null), null, 'null → null')
assert.strictEqual(publicAvatar({}), null, '无 type → null')
assert.strictEqual(publicAvatar({ type: 'xxx' }), null, '非法 type → null')

// 文字头像：text 截断到 2 字
assert.deepStrictEqual(publicAvatar({ type: 'text', text: 'ABCD' }), { type: 'text', text: 'AB' }, '文字截断 2 字')
// 预设色保留
assert.deepStrictEqual(publicAvatar({ type: 'preset', color: '#abc' }), { type: 'preset', color: '#abc' }, '预设色保留')

// 图片小图：保留原图 + 裁剪参数
const small = publicAvatar({ type: 'image', imageDataUrl: 'data:img,' + 'a'.repeat(100), zoom: 150, x: 30, y: 70 })
assert.strictEqual(small.type, 'image'); assert.ok(small.imageDataUrl, '小图保留 imageDataUrl')
assert.strictEqual(small.zoom, 150); assert.strictEqual(small.x, 30); assert.strictEqual(small.y, 70)

// 裁剪参数钳制 + 默认值
assert.deepStrictEqual(avatarCrop({ zoom: 999, x: -5, y: 200 }), { zoom: 240, x: 0, y: 100 }, 'crop 钳制')
assert.deepStrictEqual(avatarCrop({}), { zoom: 120, x: 50, y: 50 }, 'crop 默认值')

// 图片：原图超限但有静态帧 → 退静态帧
const big = 'data:img,' + 'a'.repeat(AVATAR_MAX_CHARS + 10)
const stat = 'data:img,' + 'b'.repeat(100)
assert.strictEqual(publicAvatar({ type: 'image', imageDataUrl: big, staticDataUrl: stat }).imageDataUrl, stat, '原图超限退静态帧')

// 图片：原图与静态帧都超限 → 丢弃图片数据（仅保留 type）
const r2 = publicAvatar({ type: 'image', imageDataUrl: big, staticDataUrl: big })
assert.strictEqual(r2.type, 'image'); assert.strictEqual(r2.imageDataUrl, undefined, '都超限则无 imageDataUrl')

console.log('✅ avatarutil publicAvatar/baseAvatar/avatarCrop 验证通过')
process.exit(0)
