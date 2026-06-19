'use strict'

const { basename, extname } = require('path').win32

const MAX_FILENAME_LEN = 200
const RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
])

function isReservedName (segment) {
  const base = basename(String(segment || '')).split('.')[0].trim().toLowerCase()
  return RESERVED.has(base)
}

function cleanBaseName (value) {
  return basename(String(value == null ? '' : value))
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .replace(/^\.+$/, '')
    .replace(/[. ]+$/, '')
    .trim()
}

function safeFileName (name, fallback) {
  const fb = (fallback && String(fallback)) || 'file'
  let n = cleanBaseName(name)
  if (!n || isReservedName(n)) n = cleanBaseName(fb)
  if (!n || isReservedName(n)) n = 'file'
  if (n.length > MAX_FILENAME_LEN) {
    const ext = extname(n).slice(0, 16)
    n = (n.slice(0, MAX_FILENAME_LEN - ext.length) + ext).replace(/[. ]+$/, '')
  }
  if (!n || isReservedName(n)) n = 'file'
  return n
}

module.exports = { safeFileName, isReservedName, MAX_FILENAME_LEN }
