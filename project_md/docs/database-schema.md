# 本地存储结构说明

## 模块定位
项目没有 SQL 数据库，也没有远程数据库。当前“数据库”是本地加密文件，由 `electron/vault.js` 的 `Vault` 统一读写。

## 文件结构
```text
data/
  account.json   // KDF 参数、salt、verifier
  store.enc      // AES-256-GCM 加密后的业务数据
  ilink.log      // 审计日志，仅元数据

data-2/
  account.json
  store.enc
  ilink.log
```

开发环境：
- 默认数据目录：`data`
- 第二实例：`FREEDOM_DATA_DIR=data-2`

生产环境：
- 数据目录在可执行文件同级的 `data`。

## `account.json`
`account.json` 是明文 JSON，但只保存解锁所需的非业务元数据。

```js
{
  v: 1,
  kdf: 'scrypt',
  N: 16384,
  r: 8,
  p: 1,
  keyLen: 32,
  salt: '<hex>',
  verifier: '<base64 AES-GCM(FREEDOM_VAULT_OK)>',
  createdAt: 1710000000000,
  updatedAt: 1710000000000
}
```

注意：
- 不保存密码。
- 不保存身份私钥。
- 不保存消息正文。

## `store.enc`
`store.enc` 是 AES-256-GCM 加密后的 JSON。解密后的逻辑结构如下：

```js
{
  identity: Identity,
  keys: KeyPair,
  history: Record<ConversationId, Message[]>,
  contacts: Record<PeerId, Contact>,
  groups: Group[],
  settings: Settings,
  drafts: Record<ConversationId, string>,
  reads: Record<ConversationId, number>,
  outbox: Record<PeerId, OutboxItem[]>,
  createdAt: number,
  readsInit: boolean
}
```

所有字段由 `Vault._ensureFields()` 补齐默认值。新增字段应优先在该方法中做兼容迁移。

## Identity
```js
{
  id: '<uuid>',
  name: '<nickname>'
}
```

## KeyPair
```js
{
  pub: '<base64 spki der>',
  priv: '<base64 pkcs8 der>'
}
```

用途：
- `pub` 会通过 presence 发布给局域网对端。
- `priv` 只保存在本地加密存储内。

## Contact
```js
{
  id: '<peerId>',
  name: '<peer name>',
  pub: '<peer public key>',
  address: '<last known ip>',
  status: '<status text>',
  avatar: Avatar | null,
  remark: '<local remark>',
  lastSeen: number
}
```

注意：
- `remark` 仅本地可见。
- 在线数据会与本地联系人合并后展示。

## Group
```js
{
  id: 'room:<uuid>',
  name: '<group name>',
  ownerId: '<peerId>',
  members: ['<peerId>'],
  avatar: Avatar | null,
  createdAt: number,
  updatedAt: number
}
```

群信息会随群消息同步。群头像由群主通过单独的 `room-avatar` 包同步。

## Message
```js
{
  mid: '<uuid>',
  type: 'file',          // 文本消息通常没有 type
  scope: 'private' | 'room' | 'group',
  from: '<peerId>',
  to: '<peerId or roomId>',
  name: '<sender name>',
  text: '<message text>',
  room: GroupMeta | null,
  system: '<system event>' | null,
  ts: number,
  self: boolean,
  status: 'sending' | 'sent' | 'delivered' | 'queued' | 'failed' | null,
  burn: boolean,
  ttl: number,
  reply: object | null,
  fwd: object | null,
  batch: object | null,
  avatar: Avatar | null,
  reactions: Record<string, string[]>,
  recalled: boolean,
  recalledText: string,

  // 文件消息字段
  fname: string,
  size: number,
  mime: string,
  path: string,
  dataUrl: string,
  sticker: boolean
}
```

注意：
- 阅后即焚消息不写入 `history`。
- 每个会话最多保留 `HISTORY_CAP = 1000` 条。
- `retentionDays > 0` 时解锁后会清理过期历史。

## Settings
```js
{
  burnDefault: boolean,
  burnTtl: number,
  anonymous: boolean,
  autoLockMin: number,
  retentionDays: number,
  theme: 'system' | string,
  uiStyle: 'classic' | 'minimal' | 'material' | 'dark' | 'skeuo' | 'glass' | 'flat' | 'neu' | 'gradient' | 'card' | 'hand',
  fontPx: number,
  chatFont: string,
  chatFontPx: number,
  nudgeText: string,
  notifyEnabled: boolean,
  notifyPreview: boolean,
  showTyping: boolean,
  sendKey: 'enter' | string,
  minimizeToTray: boolean,
  autoStart: boolean,
  closeAction: 'ask' | 'tray' | 'quit',
  receiveMode: 'auto' | 'manual',
  downloadDir: string,
  maxFileMB: number,
  markdown: boolean,
  pinned: string[],
  muted: string[],
  statusText: string,
  presence: 'online' | 'busy' | 'away' | 'dnd',
  udpPort: number,
  broadcastAddrs: string,
  avatar: Avatar
}
```

`Vault._ensureFields()` 接受 `online`、`busy`、`away`、`dnd`（免打扰）四种合法值，未知值安全回退为 `online`，`dnd` 可正常持久化。前端、设置层、`vault.js`、`p2p.js` 的 presence 枚举已统一。

## Drafts
```js
{
  [convId]: '<draft text>'
}
```

空文本会删除草稿。

## Reads
```js
{
  [convId]: 1710000000000
}
```

表示每个会话已读到的最新消息时间戳。`setRead()` 只允许单调前进。

## Outbox
```js
{
  [peerId]: [
    TextOutboxItem,
    FileOutboxItem,
    RoomTextOutboxItem,
    RoomFileOutboxItem,
    RecallOutboxItem
  ]
}
```

### TextOutboxItem
```js
{
  mid,
  kind: 'text',
  text,
  opts,
  ts
}
```

### FileOutboxItem
```js
{
  mid,
  kind: 'file',
  path,
  fname,
  size,
  mime,
  batch,
  sticker,
  ts
}
```

### RoomTextOutboxItem
```js
{
  mid: '<msgMid>@<memberId>',
  kind: 'roomtext',
  msgMid,
  roomId,
  text,
  opts,
  ts
}
```

### RoomFileOutboxItem
```js
{
  mid: '<fileMid>@<memberId>',
  kind: 'roomfile',
  msgMid,
  roomId,
  path,
  fname,
  size,
  mime,
  batch,
  sticker,
  ts
}
```

### RecallOutboxItem
```js
{
  mid: '__recall__<targetMid>',
  kind: 'recall',
  targetMid,
  ts
}
```

注意：
- 阅后即焚消息不进入 outbox。
- 文件 outbox 只保存本地路径，如果文件被删除，补发会失败并移除。

## 迁移要求
- 新增顶层字段：在 `_ensureFields(data)` 中补默认值。
- 新增设置字段：在 `_ensureFields(data).settings` 中补默认值，并在 UI 中处理缺省。
- 新增消息字段：渲染层要兼容旧消息没有该字段。
- 不要直接改 `store.enc`，应通过 `Vault` API 修改。
