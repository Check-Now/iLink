'use strict'

// 头像载荷处理（纯函数，无 electron 依赖，供 p2p 与 main 共用，消除重复的限长/裁剪逻辑）。
// p2p 层须保持 electron-free（纯 Node 可单测），故图片缩略图兜底留在 main 进程的 publishableAvatar。

const AVATAR_MAX_CHARS = 32 * 1024 // 可广播头像的最大字符数（超限退静态帧或丢弃图片数据）

// 裁剪参数透传：对方看到的缩放/位置必须与本机一致（统一钳制范围）
function avatarCrop (avatar) {
  return {
    zoom: Math.max(100, Math.min(240, (avatar && avatar.zoom) || 120)),
    x: Math.max(0, Math.min(100, avatar && avatar.x != null ? avatar.x : 50)),
    y: Math.max(0, Math.min(100, avatar && avatar.y != null ? avatar.y : 50)),
  }
}

// 头像基础字段（类型/文字/颜色，不含图片数据）；非法类型返回 null
function baseAvatar (avatar) {
  if (!avatar || typeof avatar !== 'object') return null
  const type = avatar.type === 'image' ? 'image' : (avatar.type === 'preset' ? 'preset' : (avatar.type === 'text' ? 'text' : ''))
  if (!type) return null
  const out = { type }
  if (avatar.text) out.text = String(avatar.text).slice(0, 2)
  if (avatar.color) out.color = String(avatar.color).slice(0, 32)
  return out
}

// 轻量可广播头像（无 electron 依赖）：图片优先原图、超限退静态首帧、再超限则丢弃图片数据。
function publicAvatar (avatar) {
  const out = baseAvatar(avatar)
  if (!out) return null
  if (out.type === 'image' && avatar.imageDataUrl) {
    const raw = String(avatar.imageDataUrl)
    const stat = typeof avatar.staticDataUrl === 'string' ? avatar.staticDataUrl : ''
    const pick = raw.length <= AVATAR_MAX_CHARS ? raw : (stat && stat.length <= AVATAR_MAX_CHARS ? stat : '')
    if (pick) { out.imageDataUrl = pick; Object.assign(out, avatarCrop(avatar)) }
  }
  return out
}

module.exports = { AVATAR_MAX_CHARS, avatarCrop, baseAvatar, publicAvatar }
