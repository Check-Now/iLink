# CODE_INDEX.md

## 根目录

### `package.json`
- 作用：项目元信息、Electron 入口、开发/构建脚本、依赖声明。
- 关键脚本：
  - `npm run dev`：同时启动 Vite 和 Electron。
  - `npm run dev:second`：使用 `FREEDOM_DATA_DIR=data-2` 启动第二实例，便于本机 P2P 测试。
  - `npm run build`：构建渲染进程。
  - `npm run dist`：构建并打包 Windows 应用。

### `vite.config.js`
- 作用：Vite 配置。
- 关键配置：
  - `base: './'`：生产环境通过 `file://` 加载资源。
  - `server.host = 127.0.0.1`、`server.port = 5173`：与 Electron 开发模式入口一致。
  - `build.outDir = 'dist'`。

### `tailwind.config.js` / `postcss.config.js`
- 作用：Tailwind 和 PostCSS 配置。

### `index.html`
- 作用：Vite 渲染进程 HTML 入口。

### `icon.png` / `noSign.png`
- 作用：应用图标和免打扰托盘图标资源。

### `CLAUDE.md`
- 作用：项目内 LLM 协作约束，强调先分析、最小改动、手术式修改和验证。

## Electron 主进程

### `electron/main.js`
- 作用：Electron 主进程入口，也是当前项目的本机后端核心。
- 主要职责：
  - 创建主窗口、独立聊天窗口和截图窗口。
  - 管理托盘、通知、未读角标、窗口行为。
  - 初始化 `Vault`、`P2P`、`FileTransfer`、`Logger`。
  - 注册全部 `ipcMain.handle(...)` API。
  - 串联 P2P 消息、文件传输、存储和渲染层事件。
- 主要函数：
  - `resolveDataDir()`：解析运行数据目录。
  - `createWindow()`：创建主窗口。
  - `openChatWindow(convId)`：打开独立会话窗口。
  - `startP2P()` / `stopP2P()`：启动/停止 P2P 和文件传输。
  - `sendToRenderer(channel, payload)`：向所有窗口推送事件。
  - `mergedPeers()` / `emitPeers()`：合并在线节点与本地联系人。
  - `outboxDrain(peerId)` / `outboxDrainAll()`：离线发件箱补发。
  - `sendFilesInternal(scope, toId, paths, batch, opts)`：文件发送编排。
  - `finalizeFile(info)` / `onFileDone(info)`：接收文件落地和手动接收处理。
- 主要 IPC：
  - `auth:*`、`settings:*`、`store:*`
  - `p2p:*`、`msg:*`
  - `file:*`
  - `win:*`、`ui:*`、`chat:*`
  - `shot:*`、`avatar:*`、`stickers:*`、`sys:*`

### `electron/preload.js`
- 作用：安全桥接层，通过 `contextBridge.exposeInMainWorld('api', ...)` 暴露渲染进程 API。
- 主要命名空间：
  - `api.auth`
  - `api.store`
  - `api.settings`
  - `api.p2p`
  - `api.file`
  - `api.msg`
  - `api.win`
  - `api.chat`
  - `api.ui`
  - `api.shot`
  - `api.avatar`
  - `api.stickers`
  - `api.sys`
- 主要事件订阅：
  - `p2p:peers`、`p2p:message`、`p2p:ready`、`p2p:typing`、`p2p:neterror`
  - `file:progress`、`file:received`、`file:offer`、`file:sent`、`file:failed`、`file:rejected`
  - `msg:recall`、`msg:reaction`、`msg:nudge`、`msg:status`
  - `store:groups`、`settings:changed`、`shot:result`

### `electron/p2p.js`
- 作用：局域网 P2P 节点发现、消息加密投递和 ACK 可靠性层。
- 主要常量：
  - `DISCOVERY_PORT = 51888`
  - `MAGIC = 'FRDM1'`
  - `HEARTBEAT_MS = 2000`
  - `OFFLINE_MS = 6000`
  - `ACK_TIMEOUT_MS = 1500`
  - `ACK_MAX_RETRY = 3`
- 主要函数：
  - `localIPv4Interfaces()`：读取本机非内网 IPv4 网卡。
  - `broadcastAddr(ni)`：计算广播地址。
  - `publicAvatar(avatar)`：限制可广播头像载荷。
- 主要类：`P2P`
- 主要方法：
  - `start()` / `stop()` / `reconnect(reason)`
  - `getSelf()` / `getPeers()`
  - `setName()` / `setAnonymous()` / `setStatus()` / `setPresence()` / `setAvatar()`
  - `resendPrivate()` / `privateEcho()` / `reachable()`
  - `sendGroup()` / `sendRoom()` / `sendRoomMember()`
  - `sendTyping()` / `sendTypingRoom()`
  - `sendRecall()` / `sendReaction()` / `sendNudge()`
  - `sendRoomAvatar()`
- 主要事件：
  - `ready`、`peers`、`message`、`typing`
  - `msg-status`、`recall`、`recall-ack`、`reaction`
  - `room-avatar`、`nudge`、`neterror`、`reconnect`

### `electron/filetransfer.js`
- 作用：TCP 直连文件传输，支持加密、进度、取消、断点续传、完整性校验。
- 主要常量：
  - `CHUNK = 64 * 1024`
  - `MIME`：常见扩展名 MIME 映射
- 主要函数：
  - `guessMime(name)`：根据文件名推断 MIME。
- 主要类：`FileTransfer`
- 主要方法：
  - `start(onPort)` / `stop()`
  - `sendFile(toId, filePath, scope, mid, metaTo, batch, sticker)`
  - `cancel(mid)`
  - `_hashFile(filePath)`
  - `_onConn(socket)`
- 主要事件：
  - `incoming`
  - `progress`
  - `send-progress`
  - `sent`
  - `failed`
  - `done`
  - `error`

### `electron/vault.js`
- 作用：本地加密账户和业务数据存储。
- 主要常量：
  - `SCRYPT`：主密码 KDF 参数。
  - `MAGIC = 'FREEDOM_VAULT_OK'`
  - `HISTORY_CAP = 1000`
- 主要类：`Vault`
- 主要方法：
  - `setup(password)` / `unlock(password)` / `changePassword(oldPw, newPw)`
  - `reset()` / `lock()` / `flush()`
  - `getIdentity()` / `getKeys()` / `setNickname(name)`
  - `getHistory()` / `appendMessage(convId, msg)` / `clearHistory()` / `clearConversation(convId)`
  - `getContacts()` / `upsertContacts(list)` / `setContactRemark(id, remark)`
  - `getGroups()` / `createGroup()` / `upsertGroup()` / `removeGroup()` / `transferGroupOwner()`
  - `getDrafts()` / `setDraft()` / `clearDrafts()`
  - `getReads()` / `setRead()`
  - `getOutbox()` / `outboxAdd()` / `outboxRemove()`
  - `getSettings()` / `setSettings(patch)`
  - `pruneHistory(days)` / `markRecalled()` / `addReaction()` / `setMessageStatus()`

### `electron/crypto.js`
- 作用：端到端加密原语封装。
- 主要函数：
  - `generateKeyPair()`：生成 X25519 身份密钥对。
  - `importPub()` / `importPriv()`：导入公钥/私钥。
  - `deriveKey(privObj, pubObj)`：ECDH + HKDF 派生会话密钥。
  - `encrypt()` / `decrypt()`：字符串 AES-256-GCM。
  - `encryptBuf()` / `decryptBuf()`：Buffer AES-256-GCM，用于文件分块。

### `electron/logger.js`
- 作用：运行审计日志，写入数据目录下 `ilink.log`。
- 主要类：`Logger`
- 主要方法：
  - `init(dir)`
  - `log(cat, event, fields)`
  - `_rotateIfNeeded()`
- 注意：日志记录元数据，不应记录消息正文、密钥或敏感内容。

## React 渲染进程

### `src/main.jsx`
- 作用：React 入口，挂载 `<App />`。

### `src/App.jsx`
- 作用：主要 UI、状态管理和用户交互逻辑。
- 主要组件：
  - `App`
  - `SetupScreen`
  - `UnlockScreen`
  - `ChatScreen`
  - `SettingsPanel`
  - `ShotScreen`
  - `DetailPane`
  - `SearchPane`
  - `HistoryPanel`
  - `FileMsg`
  - `BatchMsg`
  - `Bubble`
  - `ProfileDialog`
  - `AvatarCropper`
  - `GroupMemberList`
- 主要业务函数：
  - `handleIncoming(m)`：接收 P2P 消息并更新会话。
  - `sendTextToConv(convId, value, opts)`：发送私聊/群聊文本。
  - `sendFiles(paths, batch, opts)`：发送文件。
  - `acceptFile(mid)` / `rejectFile(mid)` / `retryFile(m)`：文件接收和重试。
  - `retryMessage(m)`：文本消息重试。
  - `createGroup()`：创建群聊。
  - `renameSelf(name)`：修改昵称。
  - `patchSettings(patch)`：保存设置。

### `src/index.css`
- 作用：全局样式、主题、聊天布局、消息气泡、窗口壳、截图界面、表情/文件消息样式。
- 关键特性：
  - CSS 变量主题。
  - 多种 UI 风格：classic、minimal、material、dark、skeuo、glass、flat、neu、gradient、card、hand。
  - 三栏/两栏聊天布局、独立聊天窗口样式。

## 测试

### `test/ack-smoke.js`
- 作用：直接复用 `P2P` 类验证私聊 ACK 路径。
- 覆盖点：
  - 正常发送：`sending -> sent -> delivered`
  - 接收端去重
  - ACK 超时重试后失败
- 运行方式：
  - `node test/ack-smoke.js`
