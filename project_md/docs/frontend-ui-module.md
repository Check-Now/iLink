# 前端 UI 模块说明

## 模块定位
前端 UI 模块负责用户可见界面、交互状态、聊天窗口、设置、截图、文件消息、搜索、历史、头像和主题样式。

渲染层不直接访问 Node.js 能力，所有系统能力通过 `window.api` 调用 preload 暴露的 IPC。

## 相关文件
- `src/main.jsx`：React 入口。
- `src/App.jsx`：主要组件和业务状态。
- `src/index.css`：全局样式、主题、布局和动画。
- `electron/preload.js`：渲染层 API 来源。
- `electron/main.js`：渲染层调用的主进程 API 实现。

## 入口流程
1. `src/main.jsx` 渲染 `<App />`。
2. `App` 调用 `api.auth.status()`。
3. 根据状态展示：
   - `SetupScreen`
   - `UnlockScreen`
   - `ChatScreen`
4. 如果 URL 查询参数包含独立聊天窗口信息，`ChatScreen` 会使用 `standaloneConv` 进入独立会话视图。

## 主要组件
- `SetupScreen`：首次设置密码。
- `UnlockScreen`：解锁和重置入口。
- `ChatScreen`：主聊天界面和大部分业务状态。
- `SettingsPanel`：设置、改密、锁定、清历史、清草稿、日志入口。
- `ShotScreen`：截图选区界面。
- `DetailPane`：右侧详情、成员、搜索面板。
- `SearchPane`：消息和文件搜索。
- `HistoryPanel`：历史记录浏览。
- `GroupMemberList`：群成员列表和群操作。
- `ProfileDialog`：联系人资料、备注、头像设置。
- `AvatarCropper`：头像裁剪。
- `FileMsg` / `BatchMsg`：文件消息和批量附件。
- `Bubble`：文本消息气泡。

## 状态来源
`ChatScreen` 初始化时会加载：
- `api.p2p.getSelf()`
- `api.p2p.getPeers()`
- `api.store.getHistory()`
- `api.store.getReads()`
- `api.store.getGroups()`
- `api.settings.get()`
- `api.store.getDrafts()`

## 事件订阅
`ChatScreen` 订阅：
- `api.settings.onChanged`
- `api.p2p.onReady`
- `api.p2p.onPeers`
- `api.p2p.onMessage`
- `api.p2p.onTyping`
- `api.p2p.onNetError`
- `api.file.onProgress`
- `api.file.onReceived`
- `api.file.onOffer`
- `api.file.onSent`
- `api.file.onFailed`
- `api.file.onRejected`
- `api.msg.onRecall`
- `api.msg.onReaction`
- `api.msg.onStatus`
- `api.msg.onNudge`
- `api.store.onGroups`
- `api.shot.onResult`

组件卸载时应清理订阅函数，避免重复事件处理。

## 主要用户动作
- 发送文本：`sendTextToConv()` -> `api.p2p.sendPrivate()` 或 `api.p2p.sendRoom()`。
- 发送文件：`sendFiles()` -> `api.file.send()`。
- 粘贴图片：`api.file.saveImage()` 后进入待发送附件。
- 截图：`api.shot.begin()`，完成后由 `shot:result` 写入发送框。
- 接受/拒绝文件：`api.file.accept()` / `api.file.reject()`。
- 重试消息：`api.p2p.resend()`。
- 重试文件：`api.file.retry()`。
- 撤回：`api.msg.recall()`。
- 表情回应：`api.msg.react()`。
- 创建群：`api.store.createGroup()`。
- 修改设置：`api.settings.set()`。

## 样式系统
`src/index.css` 使用 CSS 变量组织主题和风格：
- 全局主题：浅色、深色、系统主题。
- UI 风格：classic、minimal、material、dark、skeuo、glass、flat、neu、gradient、card、hand。
- 聊天布局：三栏、两栏、独立聊天窗口。
- 消息样式：自己/对方/阅后即焚气泡、文件卡片、批量附件、表情回应、系统消息。
- 窗口样式：无边框窗口、标题栏拖拽、窗口按钮。

## 与主进程的边界
- 渲染层只负责 UI 状态和用户操作。
- 认证、存储、P2P、文件传输、截图底图、文件打开等能力必须走 `window.api`。
- 新增 UI 功能如果需要本地系统能力，先在 `electron/main.js` 增加 IPC，再在 `electron/preload.js` 暴露。

## 修改注意事项
- `src/App.jsx` 很大，改动前先定位相关组件和函数，避免全文件重排。
- 修改 `window.api` 调用时必须确认 `preload.js` 是否已暴露。
- 事件 payload 改动必须同时更新主进程发送端和 UI 订阅端。
- 样式变更优先复用现有 CSS 变量和类名。
- 独立聊天窗口和主窗口共用同一套 React 入口，改聊天界面时要同时考虑 `standaloneConv`。

## 建议验证
- 首次设置和解锁页面。
- 主窗口聊天和独立聊天窗口。
- 私聊、群聊、文件消息、截图发送。
- 设置变更后 UI 主题、字体、通知开关是否即时生效。
- 搜索、历史定位、消息撤回、回应、未读数。
