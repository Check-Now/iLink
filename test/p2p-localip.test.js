const test = require('node:test')
const assert = require('node:assert')
const { bestLocalIp } = require('../electron/p2p')

test('bestLocalIp skips virtual adapters and prefers real LAN range', () => {
  const ifs = [
    { address: '172.28.160.1', ifname: 'vEthernet (Default Switch)' }, // Hyper-V 虚拟网卡
    { address: '192.168.1.50', ifname: '以太网' },                      // 真实局域网
  ]
  assert.strictEqual(bestLocalIp(ifs), '192.168.1.50')
})

test('bestLocalIp ranks 192.168 over 10 over 172-private', () => {
  const ifs = [
    { address: '172.16.5.5', ifname: 'eth2' },
    { address: '10.0.0.4', ifname: 'eth1' },
    { address: '192.168.0.9', ifname: 'eth0' },
  ]
  assert.strictEqual(bestLocalIp(ifs), '192.168.0.9')
})

test('bestLocalIp falls back to virtual when no physical exists', () => {
  const ifs = [{ address: '172.28.160.1', ifname: 'vEthernet (WSL)' }]
  assert.strictEqual(bestLocalIp(ifs), '172.28.160.1')
})

test('bestLocalIp returns loopback on empty', () => {
  assert.strictEqual(bestLocalIp([]), '127.0.0.1')
})
