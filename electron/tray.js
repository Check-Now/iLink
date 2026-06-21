'use strict'

function trayTooltip (runtime, unread) {
  const count = Number(unread) || 0
  if (count > 0) return 'iLink - ' + count + ' \u6761\u672a\u8bfb'
  return runtime && runtime.dnd ? 'iLink - \u514d\u6253\u6270' : 'iLink'
}

function createTrayController (deps) {
  const d = deps || {}
  let tray = null
  let flashTimer = null
  let flashOn = false

  const baseIcon = () => {
    if (d.runtime && d.runtime.dnd) return d.makeDndIcon()
    const icon = d.getAppIcon ? d.getAppIcon() : null
    return icon ? icon.resize({ width: 16, height: 16 }) : d.makeBadgeIcon(false)
  }
  const buildMenu = () => d.Menu.buildFromTemplate([
    { label: '\u663e\u793a\u4e3b\u7a97\u53e3', click: d.showWindow },
    { label: '\u5168\u5c40\u514d\u6253\u6270', type: 'checkbox', checked: !!(d.runtime && d.runtime.dnd), click: (item) => d.setDnd(item.checked) },
    { type: 'separator' },
    { label: '\u9000\u51fa', click: d.onQuit },
  ])
  const update = (unread) => {
    if (!tray) return
    try {
      tray.setContextMenu(buildMenu())
      if (!flashTimer) tray.setImage(baseIcon())
      tray.setToolTip(trayTooltip(d.runtime, unread))
    } catch (_) {}
  }
  const stopFlash = () => {
    if (flashTimer) { (d.clearInterval || clearInterval)(flashTimer); flashTimer = null }
    flashOn = false
    if (tray) { try { tray.setImage(baseIcon()) } catch (_) {} }
  }
  return {
    setup () {
      if (tray) return tray
      try {
        tray = new d.Tray(baseIcon())
        tray.setToolTip('iLink')
        tray.setContextMenu(buildMenu())
        tray.on('click', () => { stopFlash(); d.showWindow() })
      } catch (_) {}
      return tray
    },
    update,
    startFlash () {
      if (!tray || flashTimer || (d.runtime && d.runtime.dnd)) return
      flashTimer = (d.setInterval || setInterval)(() => {
        if (!tray) return
        flashOn = !flashOn
        try { tray.setImage(flashOn ? d.makeBlankIcon() : baseIcon()) } catch (_) {}
      }, 500)
    },
    stopFlash,
    setUnread (unread) {
      if (Number(unread) === 0) stopFlash()
      update(unread)
    },
    isFlashing () { return !!flashTimer },
    getTray () { return tray },
  }
}

module.exports = { createTrayController, trayTooltip }
