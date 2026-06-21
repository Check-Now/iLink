# 聊天模块说明

## 模块定位
聊天模块负责私聊、群聊、消息发送、消息接收、消息存储、消息状态、撤回、表情回应、正在输入、提醒和离线补发。

当前没有中心服务器，聊天消息由本机 Electron 主进程通过 `P2P` 在局域网内直接发送。

## 相关文件
- `electron/main.js`：聊天 IPC、消息持久化、离线发件箱、通知、渲染事件分发。
- `electron/p2p.js`：UDP 发现、加密消息、ACK、重发、群发、撤回、回应、正在输入。
- `electron/vault.js`：消息历史、联系人、已读位、草稿、离线发件箱。
- `electron/preload.js`：暴露 `api.p2p`、`api.msg`、`api.store`。
- `src/App.jsx`：聊天 UI、会话列表、输入框、消息展示、搜索、历史、重试。

## 会话类型
- 私聊：`convId = peerId`，消息 `scope = 'private'`。
- 群聊：`convId = room.id`，群 ID 格式为 `room:<uuid>`，消息 `scope = 'room'`。
- 全员广播：`P2P.sendGroup()` 仍存在，但主流程中 `main.js` 对 `scope === 'group'` 的收到消息直接忽略，当前 UI 主体以私聊和群聊为主。

## 消息核心字段
```js
{
  mid,        // 消息唯一 ID
  scope,      // private | room | group
  from,       // 发送者 id
  to,         // 私聊目标 id，群聊可为空或群 id
  name,       // 发送者显示名
  text,       // 正文
  room,       // 群聊元数据
  system,     // 系统消息类型
  ts,         // 时间戳
  burn,       // 是否阅后即焚
  ttl,        // 阅后即焚秒数
  reply,      // 回复引用
  fwd,        // 转发来源
  batch,      // 同批文本/附件归组
  avatar,     // 发送者头像公开载荷
  self,       // 是否本机发出
  status      // sending | sent | delivered | queued | failed
}
```

## 私聊发送流程
1. 渲染进程调用 `api.p2p.sendPrivate(toId, text, opts)`。
2. `preload.js` 映射到 `ipcRenderer.invoke('p2p:sendPrivate', ...)`。
3. `main.js` 创建 `mid` 和本地回显消息。
4. 普通消息写入 `Vault.history[toId]`，并进入 `Vault.outbox[toId]`。
5. `outboxDrain(toId)` 判断 `p2p.reachable(toId)`，可达时调用 `p2p.resendPrivate(...)` 投递。
6. `P2P` 用对方公钥派生会话密钥，AES-256-GCM 加密正文，通过 UDP 单播发送。
7. 对端收到后回 ACK，发送端收到 ACK 后触发 `msg-status: delivered`，主进程移除 outbox。

## 阅后即焚消息
- `opts.burn = true`。
- 只允许对端在线可达时直发。
- 不写入本地历史。
- 不进入离线发件箱。
- 不支持离线暂存和补发。

## 群聊发送流程
1. 渲染进程调用 `api.p2p.sendRoom(roomId, text, opts)`。
2. `main.js` 读取群信息，校验本机仍是群成员。
3. `P2P.sendRoom(room, text, opts)` 对在线成员逐个加密载荷，使用 UDP 广播发送。
4. 本机把非阅后即焚消息写入 `Vault.history[room.id]`。
5. 对离线或暂时没有公钥的成员，主进程写入 `outbox[memberId]`，条目类型为 `roomtext`。
6. 该成员重新可达后，`outboxDrain()` 调用 `P2P.sendRoomMember()` 单独补发，并按 `did = msgMid@memberId` 跟踪 ACK。

## 接收流程
1. `P2P._onPacket()` 解包并校验 `MAGIC`。
2. 根据包类型处理 `presence`、`msg`、`ack`、`typing`、`recall`、`reaction` 等。
3. `msg` 包先按发送方公钥派生会话密钥，再解密正文。
4. 私聊和单发群聊补发会回 ACK。
5. `P2P` 按 `mid` 去重后 emit `message`。
6. `main.js` 收到 `p2p.on('message')` 后更新联系人、群信息、历史记录，并推送 `p2p:message`。
7. `src/App.jsx` 的 `handleIncoming(m)` 更新会话列表和当前消息区。

## 消息状态
- `sending`：已进入发送流程，等待底层发送/ACK。
- `sent`：底层 UDP 发送成功或文件 TCP 发送完成。
- `delivered`：私聊文本收到 ACK。
- `queued`：对端当前不可达，消息保留在 outbox 等待补发。
- `failed`：不在 outbox 中且发送失败，或手动重试仍失败。

## 撤回与回应
- 撤回：`api.msg.recall(scope, toId, mid)` -> `msg:recall` -> `P2P.sendRecall()`。
- 私聊撤回会进入 outbox，等待对端上线后可靠投递；收到 `recallack` 后移除。
- 回应：`api.msg.react(scope, toId, mid, emoji)` -> `P2P.sendReaction()`，本地同时写入 `Vault.addReaction()`。

## 正在输入和拍一拍
- 正在输入：`api.p2p.sendTyping(toId)`，群聊时 `main.js` 自动转为 `sendTypingRoom(room)`。
- 拍一拍：`api.p2p.nudge(toId)`，文本来自设置 `settings.nudgeText`。

## 影响范围提示
- 改 `electron/p2p.js`：影响局域网发现、消息协议、ACK、加密、去重和所有端到端通信。
- 改 `electron/main.js`：影响 IPC、持久化、离线补发、通知和渲染事件。
- 改 `electron/vault.js`：影响历史、outbox、联系人、群组和数据兼容。
- 改 `src/App.jsx`：影响 UI 行为、消息展示、状态更新和用户交互。

## 建议验证
- 私聊在线发送：状态应从 `sending` 到 `sent/delivered`。
- 私聊离线发送：状态应为 `queued`，对端上线后补发。
- 群聊离线成员：上线后收到之前的群消息。
- 阅后即焚：不落库、不离线补发。
- 撤回：本机和对端均标记撤回，离线后上线也能收到撤回信号。
- ACK 测试：运行 `npm test`（`test/p2p.test.js` 覆盖私聊 ACK→delivered 与超时 failed）。
