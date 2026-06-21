# Project Context

## 项目简介
这是一个局域网内网聊天软件，当前产品名为 iLink，仓库名为 freedom。项目形态是 Windows Electron 桌面应用，主要功能包括首次创建身份、密码解锁、局域网在线发现、私聊、群聊、文件传输、截图、表情、消息记录、离线待发、托盘通知和本地设置。

当前实现不是传统的 `client/server` 分离架构：没有独立后端服务，也没有中心化聊天服务器。Electron 主进程承担本机“后端”职责，React 渲染进程负责界面，局域网通信通过 P2P 完成。

## 技术栈
- 前端：React 18、Vite 5、Tailwind CSS、framer-motion、lucide-react
- 桌面端/本机后端：Electron 30、Node.js、Electron IPC
- 数据库：本地加密文件存储，`data/store.enc` 保存加密业务数据，`data/account.json` 保存 KDF 参数和校验块
- 通讯协议：Electron IPC、局域网 UDP 广播/单播发现与消息投递、TCP 直连文件传输
- 加密方式：主密码 scrypt 派生、AES-256-GCM 本地加密；P2P 使用 X25519、HKDF-SHA256、AES-256-GCM
- 文件传输方式：TCP 直连、长度帧协议、分块加密、`.part` 断点续传、SHA-256 完整性校验
- 测试：Node 内置 `node:test` 单元测试，位于 `test/*.test.js`（crypto、p2p、pathutil、pinned、sharespace、vault），运行 `npm test`（即 `node --test`）

## 目录结构
- `/electron`：Electron 主进程和核心业务逻辑，包括窗口、IPC、P2P、文件传输、加密、本地存储、日志
- `/src`：React 渲染进程，主要 UI 和交互集中在 `src/App.jsx`
- `/test`：轻量脚本测试
- `/data`：开发环境默认本地数据目录，包含账户、加密存储和日志
- `/data-2`：第二实例开发数据目录，用于本机双开测试
- `/dist`：Vite 构建产物
- `/project_md`：项目上下文、代码索引和模块文档
- 根目录配置：`package.json`、`vite.config.js`、`tailwind.config.js`、`postcss.config.js`

## 核心模块

### 认证与本地存储模块
负责首次设置密码、解锁、修改密码、锁定、重置身份、联系人/群组/消息/设置持久化。核心文件是 `electron/vault.js` 和 `electron/main.js` 中的 `auth:*`、`store:*`、`settings:*` IPC。

### P2P 聊天模块
负责局域网发现、在线状态、私聊、群聊、消息 ACK、离线待发、撤回、表情回应、正在输入、窗口通知。核心文件是 `electron/p2p.js`、`electron/main.js` 和 `src/App.jsx`。

### 文件传输模块
负责文件选择、发送、接收、进度、取消、重试、超限校验、自动/手动接收、断点续传和哈希校验。核心文件是 `electron/filetransfer.js`、`electron/main.js` 和 `src/App.jsx`。

### 群聊模块
负责群创建、成员增删、群主转让、退出群聊、群头像同步、群消息和群文件离线补发。核心逻辑分布在 `electron/main.js`、`electron/p2p.js`、`electron/vault.js` 和 `src/App.jsx`。

### 渲染层 UI 模块
负责登录/解锁、主聊天界面、设置面板、历史记录、搜索、截图界面、头像裁剪、文件消息、表情包和独立聊天窗口。核心文件是 `src/App.jsx` 和 `src/index.css`。

## 主流程
1. 渲染进程通过 `window.api` 调用 `electron/preload.js` 暴露的接口。
2. `preload.js` 将调用映射为 `ipcRenderer.invoke(...)` 或事件订阅。
3. `electron/main.js` 处理 IPC，调用 `Vault`、`P2P`、`FileTransfer` 等模块。
4. P2P 或文件模块产生事件后，主进程保存必要数据，再通过 `sendToRenderer(...)` 推送给所有窗口。
5. 渲染进程更新会话、消息、进度、未读数和通知状态。

## 编码要求
- 不改变现有大框架：保留 Electron 主进程 + React 渲染进程 + P2P 的架构。
- 优先最小改动：功能修复优先落在现有模块和 IPC 上。
- 修改前先分析相关文件：尤其是 `electron/main.js`、`electron/preload.js`、`src/App.jsx` 三者的调用链。
- 输出修改文件列表：每次改动后说明新增/修改/删除的文件。
- 每次改动后说明影响范围：区分 UI、IPC、P2P、存储、文件传输、日志和测试影响。
- 不要把运行数据当源码改动：`data`、`data-2`、`dist`、`node_modules` 通常不是业务源码修改目标。
- 不要虚构服务端接口：当前没有 HTTP API 服务，主要 API 是 Electron IPC。
- 涉及存储字段时必须兼容旧数据：`Vault._ensureFields()` 是迁移和默认值补齐入口。

## 文档索引
- `CODE_INDEX.md`：代码文件索引
- `docs/chat-module.md`：聊天模块说明
- `docs/file-transfer-module.md`：文件传输模块说明
- `docs/auth-module.md`：认证模块说明
- `docs/database-schema.md`：本地加密存储结构
- `docs/api-list.md`：Electron IPC/API 列表
- `docs/p2p-network-module.md`：P2P 网络与加密说明
- `docs/group-module.md`：群聊模块说明
- `docs/frontend-ui-module.md`：渲染层 UI 说明
