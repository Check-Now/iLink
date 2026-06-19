# API 列表

## API 形态
当前项目没有 HTTP API。渲染进程通过 `window.api` 调用 `electron/preload.js` 暴露的 Electron IPC API。

调用型 API 使用：

```js
ipcRenderer.invoke('<channel>', ...args)
```

事件型 API 使用：

```js
ipcRenderer.on('<channel>', handler)
```

## 应用 API
| Renderer API | IPC Channel | 作用 |
| --- | --- | --- |
| `api.ping()` | `app:ping` | 返回应用版本、Electron/Node/Chrome 版本、平台、主机名和时间 |

## 认证 API
| Renderer API | IPC Channel | 作用 |
| --- | --- | --- |
| `api.auth.status()` | `auth:status` | 返回 `setup` / `locked` / `unlocked` |
| `api.auth.setup(pw)` | `auth:setup` | 首次创建账户和身份 |
| `api.auth.unlock(pw)` | `auth:unlock` | 解锁本地加密存储并启动 P2P |
| `api.auth.changePassword(oldPw, newPw)` | `auth:changePassword` | 修改主密码 |
| `api.auth.resetIdentity()` | `auth:resetIdentity` | 删除本地账户和加密存储 |
| `api.auth.lock()` | `auth:lock` | 锁定应用并停止 P2P |

## 存储 API
| Renderer API | IPC Channel | 作用 |
| --- | --- | --- |
| `api.store.getHistory()` | `store:getHistory` | 获取全部会话历史 |
| `api.store.getDrafts()` | `store:getDrafts` | 获取草稿 |
| `api.store.getReads()` | `store:getReads` | 获取已读位 |
| `api.store.setRead(convId, ts)` | `store:setRead` | 设置会话已读时间 |
| `api.store.setDraft(convId, text)` | `store:setDraft` | 保存/清空草稿 |
| `api.store.clearHistory()` | `store:clearHistory` | 清空全部历史 |
| `api.store.clearConversation(convId)` | `store:clearConversation` | 清空单个会话 |
| `api.store.clearDrafts()` | `store:clearDrafts` | 清空全部草稿 |
| `api.store.setRemark(peerId, remark)` | `store:setRemark` | 设置联系人本地备注 |
| `api.store.getGroups()` | `store:getGroups` | 获取群组列表 |
| `api.store.createGroup(name, members)` | `store:createGroup` | 创建群聊 |
| `api.store.addGroupMembers(groupId, memberIds)` | `store:addGroupMembers` | 添加群成员 |
| `api.store.removeGroupMember(groupId, memberId)` | `store:removeGroupMember` | 群主移除成员 |
| `api.store.transferGroupOwner(groupId, ownerId)` | `store:transferGroupOwner` | 转让群主 |
| `api.store.setGroupAvatar(groupId, avatar)` | `store:setGroupAvatar` | 设置群头像 |
| `api.store.leaveGroup(groupId)` | `store:leaveGroup` | 退出群聊 |
| `api.store.onGroups(cb)` | `store:groups` | 订阅群组变更 |

## 设置 API
| Renderer API | IPC Channel | 作用 |
| --- | --- | --- |
| `api.settings.get()` | `settings:get` | 获取设置 |
| `api.settings.set(patch)` | `settings:set` | 修改设置，并按需重启 P2P |
| `api.settings.onChanged(cb)` | `settings:changed` | 订阅主进程侧设置变更 |

## 窗口 API
| Renderer API | IPC Channel | 作用 |
| --- | --- | --- |
| `api.win.minimize()` | `win:minimize` | 最小化当前窗口 |
| `api.win.maximize()` | `win:maximize` | 工作区最大化/还原 |
| `api.win.focus()` | `win:focus` | 聚焦当前窗口 |
| `api.win.close()` | `win:close` | 关闭当前窗口 |
| `api.chat.openWindow(convId)` | `chat:openWindow` | 打开独立聊天窗口 |
| `api.ui.setUnread(n)` | `ui:setUnread` | 设置任务栏/托盘未读状态 |

## P2P API
| Renderer API | IPC Channel | 作用 |
| --- | --- | --- |
| `api.p2p.getSelf()` | `p2p:getSelf` | 获取本机节点信息 |
| `api.p2p.getPeers()` | `p2p:getPeers` | 获取联系人和在线节点合并列表 |
| `api.p2p.setName(name)` | `p2p:setName` | 修改昵称并广播 |
| `api.p2p.sendRoom(roomId, text, opts)` | `p2p:sendRoom` | 发送群聊文本 |
| `api.p2p.sendPrivate(toId, text, opts)` | `p2p:sendPrivate` | 发送私聊文本 |
| `api.p2p.resend(toId, mid, text, opts)` | `p2p:resend` | 重试私聊文本 |
| `api.p2p.reconnect()` | `p2p:reconnect` | 手动重建 UDP socket |
| `api.p2p.sendTyping(toId)` | `p2p:typing` | 发送正在输入 |
| `api.p2p.nudge(toId)` | `p2p:nudge` | 发送拍一拍 |

## P2P 事件
| Renderer API | Event Channel | 作用 |
| --- | --- | --- |
| `api.p2p.onPeers(cb)` | `p2p:peers` | 在线节点/联系人列表变化 |
| `api.p2p.onMessage(cb)` | `p2p:message` | 收到聊天消息 |
| `api.p2p.onReady(cb)` | `p2p:ready` | P2P 启动或重连成功 |
| `api.p2p.onNetError(cb)` | `p2p:neterror` | 网络错误 |
| `api.p2p.onTyping(cb)` | `p2p:typing` | 对端正在输入 |

## 消息 API
| Renderer API | IPC Channel | 作用 |
| --- | --- | --- |
| `api.msg.recall(scope, toId, mid)` | `msg:recall` | 撤回消息 |
| `api.msg.react(scope, toId, mid, emoji)` | `msg:react` | 添加表情回应 |

## 消息事件
| Renderer API | Event Channel | 作用 |
| --- | --- | --- |
| `api.msg.onRecall(cb)` | `msg:recall` | 收到撤回事件 |
| `api.msg.onReaction(cb)` | `msg:reaction` | 收到表情回应 |
| `api.msg.onNudge(cb)` | `msg:nudge` | 收到拍一拍 |
| `api.msg.onStatus(cb)` | `msg:status` | 消息状态变更 |

## 文件 API
| Renderer API | IPC Channel | 作用 |
| --- | --- | --- |
| `api.file.send(scope, toId, paths, batch, opts)` | `file:send` | 发送文件 |
| `api.file.pick(scope, toId)` | `file:pick` | 弹窗选择并立即发送文件 |
| `api.file.choose()` | `file:choose` | 弹窗选择文件但不立即发送 |
| `api.file.saveImage(dataUrl)` | `file:saveImage` | 粘贴图片保存为临时文件 |
| `api.file.accept(mid)` | `file:accept` | 手动接收文件 |
| `api.file.reject(mid)` | `file:reject` | 拒绝接收文件 |
| `api.file.cancel(mid)` | `file:cancel` | 取消传输 |
| `api.file.retry(toId, mid, filePath, batch)` | `file:retry` | 重试文件发送 |
| `api.file.open(path)` | `file:open` | 打开文件，危险扩展名会确认 |
| `api.file.showInFolder(path)` | `file:showInFolder` | 打开文件所在目录 |
| `api.file.chooseDir()` | `file:chooseDir` | 选择下载目录 |

## 文件事件
| Renderer API | Event Channel | 作用 |
| --- | --- | --- |
| `api.file.onIncoming(cb)` | `file:incoming` | 文件连接进入 |
| `api.file.onProgress(cb)` | `file:progress` | 传输进度 |
| `api.file.onReceived(cb)` | `file:received` | 文件接收完成 |
| `api.file.onOffer(cb)` | `file:offer` | 手动接收模式下的待确认文件 |
| `api.file.onSent(cb)` | `file:sent` | 文件发送完成 |
| `api.file.onFailed(cb)` | `file:failed` | 文件失败 |
| `api.file.onRejected(cb)` | `file:rejected` | 文件因大小限制被拒绝发送 |

## 头像、截图、表情 API
| Renderer API | IPC Channel | 作用 |
| --- | --- | --- |
| `api.avatar.pickImage()` | `avatar:pickImage` | 选择头像图片 |
| `api.shot.begin(mode)` | `shot:begin` | 开始截图 |
| `api.shot.getImage()` | `shot:getImage` | 获取截图底图 |
| `api.shot.done(dataUrl)` | `shot:done` | 完成截图并写入发送框/剪贴板 |
| `api.shot.copy(dataUrl)` | `shot:copy` | 复制截图 |
| `api.shot.save(dataUrl)` | `shot:save` | 保存截图 |
| `api.shot.cancel()` | `shot:cancel` | 取消截图 |
| `api.shot.onResult(cb)` | `shot:result` | 截图完成结果 |
| `api.stickers.list()` | `stickers:list` | 列出表情 |
| `api.stickers.add()` | `stickers:add` | 导入表情 |
| `api.stickers.remove(id)` | `stickers:remove` | 删除表情 |

## 系统 API
| Renderer API | IPC Channel | 作用 |
| --- | --- | --- |
| `api.sys.openExternal(url)` | `sys:openExternal` | 打开 http/https 外部链接 |
| `api.sys.revealLog()` | `sys:revealLog` | 打开日志所在目录 |

## 修改 API 的注意事项
- 新增主进程 IPC 后，必须同步更新 `electron/preload.js`。
- 渲染层只能使用 `window.api`，不要直接启用 Node 集成。
- 事件通道命名要避免和 invoke 通道语义冲突。
- 修改消息或文件事件 payload 时，要同时检查 `src/App.jsx` 中的订阅处理。
