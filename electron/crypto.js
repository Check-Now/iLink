'use strict'

// 阶段3:端到端加密原语
// - 身份密钥对:X25519
// - 会话密钥:ECDH(我的私钥, 对方公钥) -> HKDF-SHA256 -> 32B
// - 消息加密:AES-256-GCM(随机 12B IV)
// 说明:静态-静态 ECDH,同一对用户共享同一会话密钥;每条消息随机 IV 保证安全。

const crypto = require('crypto')

const HKDF_INFO = Buffer.from('freedom-e2e-v1')
const HKDF_SALT = Buffer.from('freedom-hkdf-salt-v1')

function generateKeyPair () {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519')
  return {
    pub: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    priv: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  }
}

function importPub (b64) {
  return crypto.createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' })
}

function importPriv (b64) {
  return crypto.createPrivateKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'pkcs8' })
}

// privObj: KeyObject(私钥) pubObj: KeyObject(对方公钥)
function deriveKey (privObj, pubObj) {
  const shared = crypto.diffieHellman({ privateKey: privObj, publicKey: pubObj })
  return Buffer.from(crypto.hkdfSync('sha256', shared, HKDF_SALT, HKDF_INFO, 32))
}

function encrypt (key, plaintextStr) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintextStr, 'utf8')), cipher.final()])
  const tag = cipher.getAuthTag()
  return { iv: iv.toString('base64'), tag: tag.toString('base64'), ct: ct.toString('base64') }
}

function decrypt (key, blob) {
  const iv = Buffer.from(blob.iv, 'base64')
  const tag = Buffer.from(blob.tag, 'base64')
  const ct = Buffer.from(blob.ct, 'base64')
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
}

// 原始 Buffer 版(文件分块加密用)
function encryptBuf (key, buf) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(buf), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), ct])
}
function decryptBuf (key, buf) {
  const iv = buf.subarray(0, 12)
  const tag = buf.subarray(12, 28)
  const ct = buf.subarray(28)
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv)
  d.setAuthTag(tag)
  return Buffer.concat([d.update(ct), d.final()])
}

module.exports = { generateKeyPair, importPub, importPriv, deriveKey, encrypt, decrypt, encryptBuf, decryptBuf }
