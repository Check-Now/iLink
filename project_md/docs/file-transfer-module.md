# 文件传输模块说明

## 模块定位
文件传输模块负责文件选择、发送、接收、进度、取消、重试、大小限制、图片预览、手动接收、断点续传和完整性校验。

文本消息使用 UDP，文件传输使用 TCP 直连。P2P presence 会发布当前节点的文件传输 TCP 端口 `tport`。

## 相关文件
- `electron/filetransfer.js`：TCP 文件传输协议、加密分块、断点续传、SHA-256 校验。
- `electron/main.js`：`file:*` IPC、文件发送编排、离线文件 outbox、接收落盘、危险文件打开确认。
- `electron/preload.js`：暴露 `api.file`。
- `electron/vault.js`：保存文件消息、设置、离线发件箱。
- `src/App.jsx`：文件选择、拖拽/粘贴、文件消息 UI、进度、接收/拒绝/取消/重试。

## 传输协议
`FileTransfer` 使用 TCP socket，每帧格式为：

```text
4 字节大端长度 + payload
长度为 0 表示 EOF
```

发送顺序：
1. 明文握手帧：`{ v, from, spub, resume }`。
2. 接收端如果支持断点续传，回明文控制帧：`{ resumeFrom }`。
3. 加密元数据帧：`{ mid, fname, size, mime, scope, to, name, batch, sticker, sha256 }`。
4. 多个加密文件分块帧，每块单独 AES-256-GCM。
5. EOF 帧。

## 加密与校验
- 会话密钥来自 `crypto.js`：X25519 ECDH + HKDF-SHA256。
- 元数据和文件分块都用 AES-256-GCM。
- 发送前计算整文件 SHA-256。
- 接收完成后校验大小和 SHA-256。
- 校验失败会删除 `.part`，不会落地为正式文件。

## 私聊文件发送流程
1. 渲染进程调用 `api.file.send('private', toId, paths, batch, opts)`。
2. `main.js` 的 `sendFilesInternal()` 为每个文件创建文件消息。
3. 消息写入 `Vault.history[toId]`。
4. outbox 写入 `{ kind: 'file', path, fname, size, mime }`。
5. `outboxDrain(toId)` 在对端可达时调用 `ft.sendFile(...)`。
6. TCP 传输完成后触发 `file:sent`，主进程移除对应 outbox 条目。

## 群聊文件发送流程
1. 渲染进程调用 `api.file.send('room', roomId, paths, batch, opts)`。
2. `sendFilesInternal()` 找到群成员。
3. 在线成员直接 `ft.sendFile(memberId, filePath, 'room', mid, roomId, ...)`。
4. 离线成员写入 outbox，条目类型为 `roomfile`，`mid` 使用 `原始mid@memberId` 避免多成员补发冲突。
5. 群文件消息写入 `Vault.history[roomId]`。

## 接收流程
1. `FileTransfer._onConn(socket)` 处理握手、元数据和数据帧。
2. 未完成内容写到系统临时目录：`freedom-<mid>.part`。
3. 网络中断时保留 `.part`，用于下次同 `mid` 续传。
4. 接收完整并校验成功后 emit `done`。
5. `main.js` 的 `onFileDone(info)` 根据 `settings.receiveMode` 决定自动落地或手动确认。
6. 自动接收调用 `finalizeFile(info)`，移动到 `settings.downloadDir` 或系统下载目录。
7. 手动接收推送 `file:offer`，用户调用 `file:accept` 后才落地，`file:reject` 会删除临时文件。

## 进度和状态事件
- `file:progress`：`{ mid, received, size, dir }`，`dir` 为 `in` 或 `out`。
- `file:received`：文件已落地并生成聊天消息。
- `file:offer`：手动接收模式下的待确认文件。
- `file:sent`：发送端 TCP 传输完成。
- `file:failed`：发送或接收失败。
- `file:rejected`：文件超过 `settings.maxFileMB` 限制。

## 图片和表情
- 图片文件会尝试生成 `dataUrl` 预览。
- 小于等于 2MB 的图片直接内嵌原图预览。
- 大图生成缩略 JPEG，避免渲染层预览丢失。
- 表情包通过 `opts.sticker` 标记，UI 中不展示普通文件操作。

## 取消与重试
- `file:cancel(mid)`：取消发送中或接收中的传输。
- `file:retry(toId, mid, filePath, batch)`：复用原 `mid` 重试私聊文件。
- 失败但未取消的文件保留在 outbox，等待对端重新可达后继续尝试。

## 安全处理
- 打开危险扩展名文件前，`main.js` 会弹出原生确认框。
- 危险扩展包括 `exe`、`msi`、`bat`、`cmd`、`ps1`、`vbs`、`js`、`jar`、`reg`、`lnk` 等。
- 文件内容不走聊天消息 UDP 包，避免大包和明文暴露。

## 影响范围提示
- 改 `electron/filetransfer.js`：影响 TCP 协议兼容、断点续传、加密和完整性。
- 改 `sendFilesInternal()`：影响私聊/群聊文件投递、离线补发和消息状态。
- 改 `finalizeFile()`：影响接收文件落地位置、预览和历史记录。
- 改 `src/App.jsx` 文件 UI：影响文件消息展示、操作按钮和进度反馈。

## 建议验证
- 在线私聊文件发送和接收。
- 对端离线时发送文件，上线后补发。
- 群聊中在线/离线成员混合场景。
- 大文件中断后继续传输，确认 `.part` 续传。
- 超过 `maxFileMB` 后出现拒绝提示。
- 手动接收模式下接受和拒绝两条路径。
