'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const lifecycle = require('../electron/window-lifecycle')

test('window lifecycle helpers constrain unsafe windows without touching visible ones', () => {
  assert.deepEqual(lifecycle.applyWindowBoundsOptions({ width: 800, fullscreen: true, alwaysOnTop: true }), {
    width: 800,
    fullscreen: false,
    kiosk: false,
    fullscreenable: false,
    resizable: true,
    alwaysOnTop: false,
    skipTaskbar: false,
  })

  const display = { workArea: { x: 0, y: 0, width: 1200, height: 800 } }
  assert.equal(lifecycle.windowVisibleInDisplays({ x: 100, y: 100, width: 900, height: 600 }, [display]), true)
  assert.equal(lifecycle.safeWindowBounds({ x: 100, y: 100, width: 900, height: 600 }, [display], display.workArea), null)

  assert.deepEqual(lifecycle.safeWindowBounds({ x: -2000, y: 100, width: 1000, height: 600 }, [display], display.workArea), {
    x: 100,
    y: 100,
    width: 1000,
    height: 600,
  })

  assert.deepEqual(lifecycle.safeWindowBounds({ x: 100, y: 100, width: 300, height: 200 }, [display], display.workArea), {
    x: 150,
    y: 120,
    width: 900,
    height: 560,
  })
})
