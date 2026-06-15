# 群聊模块说明

## 模块定位
群聊模块负责创建群、群消息、群文件、成员增删、群主转让、退出群聊、群头像同步和离线成员补发。

群聊没有中心服务器，群元数据随 P2P 消息同步到成员本地。

## 相关文件
- `electron/main.js`：群聊 IPC、权限校验、系统消息、离线补发、群头像同步。
- `electron/p2p.js`：群聊广播、单成员补发、群头像单播、群正在输入。
- `electron/vault.js`：群组数据结构和持久化。
- `electron/preload.js`：`api.store` 群聊接口。
- `src/App.jsx`：群创建 UI、成员列表、详情面板、群消息和群设置操作。

## 群数据结构
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

## 创建群
1. UI 调用 `api.store.createGroup(name, members)`。
2. `main.js` 自动把自己加入成员列表，并设置自己为 `ownerId`。
3. `Vault.createGroup()` 创建 `room:<uuid>`。
4. `P2P.sendRoom()` 发送系统消息 `room-created`。
5. 本地保存系统消息，并推送 `store:groups` 和 `p2p:message`。

## 添加成员
1. UI 调用 `api.store.addGroupMembers(groupId, memberIds)`。
2. 主进程校验：
   - 应用已解锁。
   - 群存在。
   - 本机仍是群成员。
   - 新成员存在于已知联系人/在线节点。
   - 新成员不在当前群内。
3. `Vault.upsertGroup()` 更新成员列表。
4. `P2P.sendRoom()` 发送 `member-added` 系统消息。

当前实现允许群成员添加成员，不限群主。

## 移除成员
1. UI 调用 `api.store.removeGroupMember(groupId, memberId)`。
2. 主进程校验本机必须是群主。
3. 不允许移除群主。
4. 更新成员列表。
5. 发送 `member-removed` 系统消息，并通过 `extraRecipients` 额外通知被移除成员。
6. 被移除成员收到后会删除本地群、清空该群历史和草稿。

## 退出群聊
1. UI 调用 `api.store.leaveGroup(groupId)`。
2. 本地从成员列表中移除自己。
3. 如果群主退出并且还有其他成员，群主转给剩余成员中的第一个。
4. 发送 `member-left` 系统消息。
5. 本地删除群、清空群历史和草稿。

## 转让群主
1. UI 调用 `api.store.transferGroupOwner(groupId, ownerId)`。
2. `Vault.transferGroupOwner()` 要求新群主必须是群成员。
3. 发送 `owner-transferred` 系统消息。

当前主进程入口没有显式校验“只有现群主可转让”，如果要收紧权限，应在 `store:transferGroupOwner` 中补校验。

## 群头像
1. UI 选择头像后调用 `api.store.setGroupAvatar(groupId, avatar)`。
2. 主进程要求本机是群主。
3. 头像载荷限制在约 32KB 内，过大时使用压缩/静态帧。
4. `P2P.sendRoomAvatar()` 对群成员逐个加密单播头像载荷。
5. 同时发送 `avatar-changed` 系统消息。
6. 接收端只接受群主发来的群头像更新。

## 群消息
在线群消息：
- `P2P.sendRoom()` 对在线成员逐个加密。
- 使用 UDP 广播发送。
- 接收端按 `room.id` 写入对应会话。

离线补发：
- 发送时对未覆盖成员写入 outbox。
- 文本条目为 `roomtext`。
- 文件条目为 `roomfile`。
- 对端上线后用单播可靠补发。

## 群文件
群文件发送由 `sendFilesInternal('room', roomId, paths, ...)` 处理：
- 在线成员直接 TCP 发送。
- 离线成员写入 `roomfile` outbox。
- 群消息本地记录一次，不按成员重复记录。

## 群 UI
`src/App.jsx` 中相关组件：
- `GroupMemberList`：群成员展示和操作。
- `DetailPane`：右侧详情面板，包含群成员和搜索入口。
- `ChatScreen`：群创建、群头像、成员变更、退出、转让等操作状态。

## 修改注意事项
- 群元数据通过消息同步，没有中心端权威数据。
- 权限校验必须在主进程做，不能只依赖 UI。
- 修改群系统消息类型时，要检查接收端 `main.js` 对 `system` 的特殊处理。
- 群离线补发依赖 outbox，不要绕过 `Vault.outboxAdd()`。
