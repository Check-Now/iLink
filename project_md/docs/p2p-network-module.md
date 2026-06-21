# P2P 网络模块说明

## 模块定位
P2P 网络模块负责局域网节点发现、在线状态维护、端到端加密消息投递、ACK、重发、群聊广播、单成员补发、网络重连和文件传输端口发布。

核心实现位于 `electron/p2p.js`，由 `electron/main.js` 在解锁后创建并启动。

## 相关文件
- `electron/p2p.js`：P2P 协议和 socket 管理。
- `electron/crypto.js`：X25519、HKDF、AES-256-GCM。
- `electron/main.js`：P2P 生命周期、事件处理、渲染层转发、outbox 补发。
- `electron/filetransfer.js`：使用 P2P 发现到的 IP、公钥和 `tport` 做 TCP 文件传输。

## 网络端口
- UDP 发现端口默认 `51888`，可通过设置 `udpPort` 修改。
- UDP 单播端口随机绑定，写入 presence 的 `uport`。
- TCP 文件端口随机监听，启动后通过 `p2p.setTport(tport)` 写入 presence。

## 发现机制
1. `P2P.start()` 创建 UDP 单播 socket。
2. 单播 socket 绑定完成后启动 discovery socket。
3. discovery socket 绑定 `discoveryPort` 并启用广播。
4. 周期性发送 presence 包。
5. 收到对端 presence 后写入 `peers`，并对首次见到的节点单播回 presence。
6. 定时 sweep 超过 `OFFLINE_MS` 未见心跳的节点，标记离线。

## Presence 载荷
```js
{
  t: 'presence',
  from: '<self id>',
  name: '<display name>',
  pub: '<public key>',
  uport: number,
  tport: number,
  status: '<status text>',
  presence: 'online' | 'busy' | 'away' | 'dnd',
  avatar: Avatar | null,
  ts: number
}
```

## 包类型
| 类型 | 作用 |
| --- | --- |
| `presence` | 在线发现、昵称、公钥、端口、头像和状态同步 |
| `bye` | 应用退出或停止 P2P 时通知离线 |
| `msg` | 私聊、群聊或广播消息 |
| `ack` | 私聊/单发群聊补发的可靠投递确认 |
| `typing` | 正在输入 |
| `recall` | 消息撤回 |
| `recallack` | 私聊撤回确认 |
| `reaction` | 表情回应 |
| `nudge` | 拍一拍 |
| `room-avatar` | 群头像同步 |

## 加密模型
- 每个节点有本地持久化 X25519 身份密钥对。
- 公钥通过 presence 发布。
- 发送消息时，用本机私钥和对端公钥做 ECDH。
- ECDH 结果经过 HKDF-SHA256 派生 32 字节 AES 密钥。
- 每条消息使用随机 12 字节 IV 的 AES-256-GCM。
- 群聊不是共享群密钥，而是对每个在线成员分别加密一份 payload。

## 私聊可靠性
私聊文本使用 UDP 单播，但在协议层加 ACK：
1. 发送端生成 `mid`。
2. `resendPrivate()` 加密后发送 `msg`。
3. 接收端在解密前后按 `mid` 去重，并向发送端回 `ack`。
4. 发送端收到 `ack` 后 emit `msg-status: delivered`。
5. 超过 `ACK_TIMEOUT_MS` 未收到 ACK，则重发。
6. 超过 `ACK_MAX_RETRY` 后 emit `msg-status: failed`。
7. `main.js` 如果发现 outbox 中仍有该消息，会把 UI 状态改回 `queued`，等待下一次 presence 补发。

## 群聊可靠性
群聊在线发送是广播 best-effort：
- 对在线且有公钥的成员加密 payload。
- 广播包中 `enc` 是 `{ memberId: encryptedBlob }`。
- 每个接收端只取自己的密文。

离线成员可靠补发：
- `main.js` 为离线成员写入 `roomtext` 或 `roomfile` outbox。
- 上线后用 `sendRoomMember()` 单发。
- `did = msgMid@memberId` 用作 ACK 跟踪 ID，避免同一群消息发给多个成员时确认串线。

## 去重
`P2P` 使用 `seenSet` 和 `seen` 数组记录最近处理过的 `mid`，上限为 `SEEN_MAX = 800`。重复包仍可回 ACK，但不会重复 emit 给 UI。

## 网络重连
P2P 会处理两类重连：
- socket 致命错误后指数退避重连，封顶 15 秒。
- 网卡 IPv4 地址集合变化后重连。

重连保留身份、peers、pending ACK 等内存状态，但会重建 socket 和定时器。

## 广播地址
默认广播目标包括：
- `255.255.255.255`
- 根据本机 IPv4 和 netmask 计算出的子网广播地址
- 用户设置中的 `broadcastAddrs`

## 与文件传输的关系
P2P 只负责发现和文本/控制消息。文件内容走 `FileTransfer` 的 TCP 连接，但依赖 P2P 提供：
- 对端 IP 地址
- 对端 TCP 端口 `tport`
- 对端公钥
- 在线状态

## 修改注意事项
- 修改 `MAGIC` 或包结构会影响版本兼容。
- 修改 ACK 时序要同步测试 `test/p2p.test.js`（`npm test`）。
- 修改 presence 字段要同步 `main.js`、`vault.js`、UI 和文件传输。
- 群聊补发依赖 `did` 规则，不要把 `msgMid` 直接当多成员补发 ACK ID。
