'use strict'

function applyWindowBoundsOptions (opts) {
  return {
    ...(opts || {}),
    fullscreen: false,
    kiosk: false,
    fullscreenable: false,
    resizable: true,
    alwaysOnTop: false,
    skipTaskbar: false,
  }
}

function windowVisibleInDisplays (bounds, displays) {
  if (!bounds) return false
  const right = bounds.x + bounds.width
  const bottom = bounds.y + bounds.height
  return (displays || []).some(({ workArea }) => {
    if (!workArea) return false
    return right > workArea.x + 80 &&
      bounds.x < workArea.x + workArea.width - 80 &&
      bottom > workArea.y + 80 &&
      bounds.y < workArea.y + workArea.height - 80
  })
}

function centeredWindowBounds (bounds, workArea) {
  const area = workArea || { x: 0, y: 0, width: 1200, height: 720 }
  const src = bounds || {}
  const width = Math.min(Math.max(src.width || 1100, 900), area.width)
  const height = Math.min(Math.max(src.height || 720, 560), area.height)
  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    width,
    height,
  }
}

function safeWindowBounds (bounds, displays, primaryWorkArea) {
  if (windowVisibleInDisplays(bounds, displays) && bounds.width >= 400 && bounds.height >= 300) return null
  return centeredWindowBounds(bounds, primaryWorkArea)
}

module.exports = {
  applyWindowBoundsOptions,
  windowVisibleInDisplays,
  centeredWindowBounds,
  safeWindowBounds,
}
