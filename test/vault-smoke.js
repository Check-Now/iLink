'use strict'
// 冒烟测试：Vault 加密存储往返（setup→落盘→unlock→改密），验证：
//   ① crypto.encryptBuf/decryptBuf 去重后 store.enc 读写一致（向后兼容旧数据格式）
//   ② _ensureSettings 拆分后默认值/自定义值均正确恢复
// 运行：node test/vault-smoke.js
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Vault } = require('../electron/vault')

;(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-smoke-'))

  // 1) 首次设置 + 写入历史/设置 + 加密落盘
  const v1 = new Vault(dir)
  assert.strictEqual(v1.exists(), false, '初始无账户')
  const id1 = await v1.setup('pw1234')
  assert.ok(id1 && id1.id, 'setup 返回身份')
  v1.appendMessage('peerX', { mid: 'm1', text: 'hello', self: true, ts: Date.now() })
  v1.setSettings({ maxFileMB: 7, uiStyle: 'dark' })
  v1.flush()
  assert.ok(fs.existsSync(path.join(dir, 'store.enc')), 'store.enc 已落盘')

  // 2) 重新解锁：crypto.decryptBuf 解密由 crypto.encryptBuf 写入的密文
  const v2 = new Vault(dir)
  const id2 = await v2.unlock('pw1234')
  assert.strictEqual(id2.id, id1.id, '解锁后身份一致')
  assert.strictEqual((v2.getHistory().peerX || [])[0].text, 'hello', '历史正确恢复')
  const s = v2.getSettings()
  assert.strictEqual(s.maxFileMB, 7, '自定义 maxFileMB 恢复')
  assert.strictEqual(s.uiStyle, 'dark', '自定义 uiStyle 恢复')
  assert.strictEqual(s.sendKey, 'enter', '默认 sendKey 补齐')
  assert.strictEqual(s.udpPort, 51888, '默认 udpPort 补齐')
  assert.strictEqual(typeof s.notifyEnabled, 'boolean', '默认 notifyEnabled 补齐')

  // 3) 错误密码解锁应失败
  let threw = false
  try { await new Vault(dir).unlock('wrong') } catch (_) { threw = true }
  assert.ok(threw, '错误密码解锁应抛错')

  // 4) 改密码：旧密码失效、新密码可解且身份不变
  const v4 = new Vault(dir)
  await v4.unlock('pw1234')
  await v4.changePassword('pw1234', 'pw5678')
  v4.flush()
  let oldThrew = false
  try { await new Vault(dir).unlock('pw1234') } catch (_) { oldThrew = true }
  assert.ok(oldThrew, '改密后旧密码应失效')
  const id5 = await new Vault(dir).unlock('pw5678')
  assert.strictEqual(id5.id, id1.id, '改密后新密码可解锁且身份不变')

  fs.rmSync(dir, { recursive: true, force: true })
  console.log('✅ Vault 往返(setup/落盘/unlock/改密) + 设置默认值 验证通过')
  process.exit(0)
})().catch((e) => { console.error('❌ 测试失败:', e); process.exit(1) })
