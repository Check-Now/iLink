'use strict'
const { nativeImage } = require('electron')
const path = require('path')

// 托盘/角标/免打扰图标生成（从 main.js 抽出；纯 nativeImage 绘制逻辑，无应用状态耦合）

function makeDotIcon (rgb, size) {
  size = size || 32
  const buf = Buffer.alloc(size * size * 4)
  const c = (size - 1) / 2
  const r = size / 2
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      const d = Math.sqrt((x - c) * (x - c) + (y - c) * (y - c))
      if (d <= r) { buf[i] = rgb[2]; buf[i + 1] = rgb[1]; buf[i + 2] = rgb[0]; buf[i + 3] = 255 }
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size })
}

function makeBadgeIcon (badge) {
  const size = 32
  const buf = Buffer.alloc(size * size * 4)
  const c = (size - 1) / 2
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      const d = Math.sqrt((x - c) * (x - c) + (y - c) * (y - c))
      if (d <= size / 2) { buf[i] = 88; buf[i + 1] = 209; buf[i + 2] = 48; buf[i + 3] = 255 } // 缁?BGRA)
      if (badge) {
        const bd = Math.sqrt((x - (size - 8)) * (x - (size - 8)) + (y - 8) * (y - 8))
        if (bd <= 7) { buf[i] = 48; buf[i + 1] = 59; buf[i + 2] = 255; buf[i + 3] = 255 } // 绾㈣鏍?BGRA)
      }
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size })
}

// 免打扰图标：优先使用项目根目录 noSign.png，加载失败回退为生成的红圆白杠
let dndIconImg = null
function makeDndIcon () {
  if (dndIconImg) return dndIconImg
  try {
    const img = nativeImage.createFromPath(path.join(__dirname, '..', 'noSign.png'))
    if (img && !img.isEmpty()) { dndIconImg = img.resize({ width: 16, height: 16 }); return dndIconImg }
  } catch (_) {}
  const size = 32
  const buf = Buffer.alloc(size * size * 4)
  const c = (size - 1) / 2
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      const d = Math.sqrt((x - c) * (x - c) + (y - c) * (y - c))
      if (d <= size / 2) { buf[i] = 48; buf[i + 1] = 59; buf[i + 2] = 255; buf[i + 3] = 255 } // 红 (BGRA)
      if (y >= 13 && y <= 18 && x >= 7 && x <= 24 && d <= size / 2) { buf[i] = 255; buf[i + 1] = 255; buf[i + 2] = 255; buf[i + 3] = 255 } // 白杠
    }
  }
  dndIconImg = nativeImage.createFromBitmap(buf, { width: size, height: size }).resize({ width: 16, height: 16 })
  return dndIconImg
}
// 透明图标：托盘闪烁的"灭"帧
let blankIconImg = null
function makeBlankIcon () {
  if (blankIconImg) return blankIconImg
  blankIconImg = nativeImage.createFromBitmap(Buffer.alloc(16 * 16 * 4), { width: 16, height: 16 })
  return blankIconImg
}

module.exports = { makeDotIcon, makeBadgeIcon, makeDndIcon, makeBlankIcon }
