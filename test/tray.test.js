'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const { createTrayController, trayTooltip } = require('../electron/tray')

test('tray controller updates tooltip, unread state, and flash lifecycle', () => {
  assert.equal(trayTooltip({ dnd: false }, 0), 'iLink')
  assert.equal(trayTooltip({ dnd: true }, 0), 'iLink - \u514d\u6253\u6270')
  assert.equal(trayTooltip({ dnd: false }, 3), 'iLink - 3 \u6761\u672a\u8bfb')

  const runtime = { dnd: false }
  const timers = []
  const trayInstances = []
  class FakeTray {
    constructor (icon) {
      this.icon = icon
      this.tooltip = ''
      this.menu = null
      this.handlers = {}
      trayInstances.push(this)
    }

    setImage (icon) { this.icon = icon }
    setToolTip (tip) { this.tooltip = tip }
    setContextMenu (menu) { this.menu = menu }
    on (event, fn) { this.handlers[event] = fn }
  }
  const controller = createTrayController({
    Tray: FakeTray,
    Menu: { buildFromTemplate: (template) => template },
    runtime,
    getAppIcon: () => null,
    showWindow: () => {},
    setDnd: (on) => { runtime.dnd = !!on },
    onQuit: () => {},
    makeBadgeIcon: () => 'base',
    makeBlankIcon: () => 'blank',
    makeDndIcon: () => 'dnd',
    setInterval: (fn) => { timers.push(fn); return 'timer-1' },
    clearInterval: () => {},
  })

  const tray = controller.setup()
  assert.equal(trayInstances.length, 1)
  assert.equal(tray.icon, 'base')
  assert.equal(tray.tooltip, 'iLink')
  assert.equal(tray.menu[1].checked, false)

  controller.setUnread(2)
  assert.equal(tray.tooltip, 'iLink - 2 \u6761\u672a\u8bfb')

  controller.startFlash()
  assert.equal(controller.isFlashing(), true)
  timers[0]()
  assert.equal(tray.icon, 'blank')

  controller.stopFlash()
  assert.equal(controller.isFlashing(), false)
  assert.equal(tray.icon, 'base')

  runtime.dnd = true
  controller.update()
  assert.equal(tray.icon, 'dnd')
  assert.equal(tray.tooltip, 'iLink - \u514d\u6253\u6270')
  assert.equal(tray.menu[1].checked, true)
})
