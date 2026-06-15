# iLink 局域网 P2P 通讯工具 — 功能盘点与自测报告

> 角色：资深软件测试 / 产品 / 代码审查
> 范围：纯静态代码逆向分析 + 静态自测（运行环境不可用，原因见第七节）
> 原则：只认代码里能找到的实现，不臆造功能；区分前端 / 后端 / 存储 / 通信是否都落地。
> 本轮**不改代码、不重构、不删代码**，仅做发现、盘点、自测与报告。

---

## 第一步：项目结构扫描

| 项目 | 结论 | 依据 |
| -- | -- | -- |
| 项目名 / 用途 | **iLink**（包名 freedom），"Windows 局域网 P2P 加密通讯工具" | `package.json` name=freedom, productName=iLink, description |
| 技术栈 | Electron 桌面应用 + React 前端 + Vite 构建 + Tailwind | `package.json` 依赖 |
| 前端框架 | React 18.3（单文件 `src/App.jsx`，约 3170 行）+ lucide-react 图标 + framer-motion（已装但代码未见使用） | `src/App.jsx`、`src/main.jsx` |
| 后端 / 桌面端 | **Electron 30**（主进程 Node.js），无独立服务端、无 Web 服务器 | `electron/main.js` (main 入口) |
| 数据库 / 存储 | **无数据库**。本地文件存储：主密码派生密钥 AES‑256‑GCM 加密的 `store.enc`，加上明文 `account.json`（仅 KDF 参数/salt/校验块）；日志 `ilink.log`；表情包目录 `data/stickers/` | `electron/vault.js`、`electron/logger.js` |
| 主入口文件 | 主进程 `electron/main.js`；渲染进程 `src/main.jsx` → `src/App.jsx`；预加载 `electron/preload.js` | `package.json` main 字段 |
| 主要配置文件 | `package.json`（含 electron-builder 配置）、`vite.config.js`、`tailwind.config.js`、`postcss.config.js`、`.npmrc` | 根目录 |
| 路由结构 | 无前端路由库。**单页 + 窗口参数路由**：`?window=chat&conv=...`（独立聊天窗）、`?window=shot`（截图窗）；其余为主窗 | `App.jsx` L3137‑3164、`main.js` `loadAppWindow` |
| API 接口结构 | 无 HTTP API。**全部为 Electron IPC**（`ipcMain.handle` ↔ `preload` `contextBridge`）。约 60 个 IPC 通道 | `main.js`、`preload.js` |
| 通信方式 | **UDP**（dgram）：广播发现 + 心跳 + 在线状态 + 私聊/群聊文本（单播/广播）+ 信令（typing/recall/reaction/nudge/ack）。**TCP**（net）：大文件直传（分块加密 + 断点续传）。无 HTTP/WebSocket。 | `electron/p2p.js`、`electron/filetransfer.js` |
| 文件上传下载 | TCP 自实现协议（4 字节长度前缀分帧），端到端 AES‑256‑GCM 分块加密 + SHA‑256 校验 + 断点续传 | `electron/filetransfer.js` |
| 消息收发 | UDP 单播（私聊，带 ACK + 超时重发）/ UDP 广播（群聊，best‑effort）；离线消息走持久化"发件箱"（outbox），对端上线后补发 | `p2p.js`、`main.js` outbox 编排 |
| 登录认证 | **本地主密码**（scrypt N=16384 派生 32B 密钥 + AES‑GCM 校验块），无账号服务器、无网络登录 | `vault.js` `setup/unlock/changePassword` |
| 数据模型 | `identity`、`keys`(X25519)、`history`、`contacts`、`groups`、`settings`、`drafts`、`reads`、`outbox` —— 全部为加密 JSON 内的对象，非关系表 | `vault.js` `_ensureFields` |
| 日志 | `electron/logger.js`：写 `data/ilink.log`，仅元数据（事件类型/mid/文件名大小/对端 id），2MB 轮转。**承诺不记录正文/密钥** | `logger.js` |
| 测试文件 | **无任何测试**：无 test 脚本、无测试依赖、无 `__tests__`/`.test.` 文件 | `package.json` scripts/devDeps |

### 加密体系（关键）
- 身份密钥：X25519 密钥对（`crypto.js generateKeyPair`）。
- 会话密钥：静态‑静态 ECDH（`diffieHellman`）→ HKDF‑SHA256 → 32B。
- 消息：AES‑256‑GCM（每条随机 12B IV）。
- 本地存储：主密码 scrypt → AES‑256‑GCM 加密 `store.enc`。
- 结论：**端到端加密是真实实现的**，明文不出网（抓包只见 `enc` 密文）。

---

## 第二步 / 第三步：从代码反向识别的功能总览

> 以下功能均能定位到具体代码，非凭按钮/菜单臆测。

1. **身份与认证模块**：首次设置主密码、解锁、改密码、锁定、重置身份、自动锁定（闲置 N 分钟）。
2. **本地加密存储模块**：身份/私钥/历史/联系人/群/设置/草稿/已读位/发件箱全部加密落盘，原子写（tmp+rename），延迟保存（300ms 去抖）。
3. **局域网发现 / 在线状态模块**：UDP 广播 presence + 2s 心跳 + 6s 离线判定；自定义 UDP 端口与广播地址；网卡变化自动重连；指数退避自愈重连；手动重连。
4. **联系人模块**：自动从在线对端 + 历史收集；本机备注（remark，仅本地）；资料卡（ID/IP/状态/签名）。
5. **个人资料模块**：昵称、个性签名（statusText）、头像（文字/预设色/图片/GIF 动图，带圆形裁剪缩放）、匿名模式、个人状态（在线/忙碌/离开/免打扰）。
6. **单聊（私聊）模块**：文本发送，ACK 确认 + 超时重发（最多 4 次），离线暂存→上线补发，发送状态（发送中/已发送/已送达/失败/待发送），手动重试。
7. **群聊模块**：建群、加人、踢人、退群、群主转让、群头像（群主改、同步成员）、群成员列表、群内 typing；在线成员走广播，离线成员走发件箱单发补达 + ACK。
8. **文件传输模块**：TCP 直传、端到端加密、进度/测速/ETA、断点续传（.part + resumeFrom）、SHA‑256 完整性校验、取消、失败重试、私聊离线暂存补发、群文件逐成员投递；危险可执行文件打开前原生告警；手动/自动接收模式；下载目录、单文件大小上限。
9. **消息记录 / 持久化模块**：按会话存储（上限 1000 条/会话），乱序按 ts 插入，重启恢复，分页懒加载（每页 60），保留天数清理（retentionDays）。
10. **富消息模块**：回复引用、转发（逐条/合并）、撤回（双方，自己可"重新编辑"）、表情回应（reaction）、Markdown 渲染（**粗** *斜* `码`、链接、@提及）、阅后即焚（burn，仅内存不落库 + 倒计时进度条）。
11. **搜索模块**：会话内/全局搜索（消息+文件+用户名），高亮，定位跳转；历史记录面板（按日期分组，按图片/文件筛选）。
12. **通知模块**：系统通知（窗口隐藏时）、应用内 toast、任务栏闪烁/未读红点 overlay、托盘图标闪烁、消息预览开关、免打扰、会话静音（muted）。
13. **表情包模块**：导入图片到 `data/stickers`，发送复用文件通道（标记 sticker）。
14. **截图模块**：冻结全屏→框选→标注→复制/保存/发送到聊天，Ctrl+V 粘贴图片。
15. **设置模块**：外观（主题/11 种皮肤/字号/动图静态/聊天字体字号）、通知与输入（发送键、Markdown、最小化到托盘、开机自启、关闭行为）、文件、网络、隐私、关于。
16. **窗口与系统集成模块**：无边框窗口控制（最小化/最大化到工作区/关闭）、独立聊天窗、托盘、关闭行为（询问/托盘/退出）、开机自启（仅打包后）。
17. **戳一戳（nudge）模块**：UDP 单播 + 窗口抖动 + 自定义戳文字。
18. **日志/审计模块**：在线上下线、消息失败、文件收发/排队/取消等元数据落盘。
19. **检查更新模块**：UI 存在，但为**占位返回**（current=latest，"绿色版构建，暂未配置远程更新源"）。

> 项目中**不存在**：管理后台、权限角色体系、服务端数据库、Web 接口、黑名单可用入口（见下）。请勿将其计入已实现。

---

## 第四步：完整功能矩阵

状态取值：✅已完整 / 🟡部分实现 / 🎭仅UI / ❌未实现 / ⚠️有风险 / ❓无法判断

| 模块 | 功能 | 状态 | 前端位置 | 后端位置 | 存储 | 接口/事件 | 判断依据 | 缺失点/风险 | 建议 |
| -- | -- | -- | -- | -- | -- | -- | -- | -- | -- |
| 认证 | 首次设主密码 | ✅ | SetupScreen | `vault.setup` | account.json+store.enc | `auth:setup` | scrypt+GCM 校验块完整 | 密码最短仅 4 位 | 提高强度/提示 |
| 认证 | 解锁 | ✅ | UnlockScreen | `vault.unlock` | 同上 | `auth:unlock` | 校验 verifier=MAGIC | — | — |
| 认证 | 改密码 | ✅ | SettingsPanel | `vault.changePassword` | account.json 重写 | `auth:changePassword` | 旧密码校验+换 salt/key | — | — |
| 认证 | 锁定/自动锁定 | ✅ | 设置/闲置定时器 | `auth:lock` | 内存清密钥 | `auth:lock` | 闲置计时调用 lock | — | — |
| 认证 | 重置身份 | ✅ | Unlock/设置 | `vault.reset` | 删文件 | `auth:resetIdentity` | unlink 两文件 | 不可恢复（已二次确认） | — |
| 存储 | 本地加密落盘 | ✅ | — | `vault._saveNow` | store.enc | — | AES‑GCM+原子写 | — | — |
| 发现 | UDP 广播发现/心跳 | ✅ | — | `p2p._sendPresence/_sweep` | — | UDP presence | 2s 心跳/6s 离线 | 见安全风险 | — |
| 发现 | 自定义端口/广播地址 | ✅ | 设置-网络 | `settings:set`→重启 P2P | settings | `settings:set` | 校验端口范围 | — | — |
| 发现 | 断线自愈/网卡切换重连 | ✅ | — | `p2p._scheduleReconnect/_checkInterfaces` | — | `p2p:reconnect` | 指数退避+签名比对 | — | — |
| 在线状态 | 在线/忙/离开/免打扰 | ✅ | 状态选择器 | `p2p.setPresence` | settings.presence | presence 包 | 随心跳广播 | — | — |
| 联系人 | 自动汇集联系人 | ✅ | 会话列表 | `vault.upsertContacts` | contacts | `p2p:peers` | presence/消息触发 | — | — |
| 联系人 | 本机备注 | ✅ | ProfileDialog | `vault.setContactRemark` | contacts.remark | `store:setRemark` | 仅本地不广播 | — | — |
| 资料 | 昵称/签名/状态文本 | ✅ | ProfileDialog | `p2p.setName/setStatus` | settings | `p2p:setName`等 | 随 presence 同步 | — | — |
| 资料 | 头像(文字/预设/图片/GIF) | ✅ | AvatarCropper | `publishableAvatar`/`avatar:pickImage` | settings.avatar | `avatar:pickImage` | 32KB 内同步,超限转静态 | 大 GIF 仅本地动 | — |
| 资料 | 匿名模式 | ✅ | 设置-隐私 | `p2p.setAnonymous` | settings.anonymous | `settings:set` | displayName 返回"匿名" | — | — |
| 私聊 | 文本发送+ACK+重发 | ✅ | handleSend/sendTextToConv | `p2p.resendPrivate/_trackAck` | history+outbox | `p2p:sendPrivate` | 单播+ACK+3 次重发 | — | — |
| 私聊 | 离线暂存→上线补发 | ✅ | — | `outboxDrain`/`vault.outbox*` | outbox(持久) | `p2p:peers`触发 | 发件箱持久+presence 驱动 | — | — |
| 私聊 | 发送状态(发/达/失/待) | ✅ | MsgStatus | `msg-status`链 | history.status | `msg:status` | 状态机完整,重启恢复 | — | — |
| 私聊 | 手动重试 | ✅ | retryMessage | `p2p:resend` | outbox | `p2p:resend` | 复用同 mid | — | — |
| 群聊 | 建群/加人/踢人/退群/转让 | ✅ | 群管理 UI | `store:createGroup`等 | groups | `store:*Group*` | 权限校验(群主)齐全 | 见乱序/丢包风险 | — |
| 群聊 | 在线成员消息广播 | ⚠️ | sendTextToConv | `p2p.sendRoom`(广播) | history | UDP 广播 msg | **在线成员无 ACK/重发** | 广播丢包即静默丢失 | 给在线成员也走 ACK |
| 群聊 | 离线成员补达 | ✅ | — | `sendRoomMember`+outbox | outbox | did/ACK | 单发+ACK+重发 | — | — |
| 群聊 | 群头像同步 | ✅ | changeGroupAvatar | `sendRoomAvatar` | groups.avatar | `room-avatar` | 仅群主,逐成员加密单播 | — | — |
| 群聊 | 大群/长消息 | ⚠️ | — | `p2p.sendRoom` | — | UDP 单包多成员 enc | 单 UDP 包含全员密文 | 超 MTU/64KB 静默失败 | 分片或限长 |
| 文件 | TCP 加密直传 | ✅ | sendFiles | `ft.sendFile/_onConn` | 落地下载目录 | `file:send` | 分帧+GCM 分块 | — | — |
| 文件 | 进度/测速/ETA | ✅ | FileMsg/onProgress | `progress/send-progress` | — | `file:progress` | 真实字节回调 | — | — |
| 文件 | 断点续传 | ✅ | — | resume/resumeFrom/.part | tmp .part | 控制帧 | 偏移续传+7 天清理 | — | — |
| 文件 | SHA‑256 完整性校验 | ✅ | — | `_hashFile`/finish verify | — | meta.sha256 | 大小+哈希双校验,失败删 part | — | — |
| 文件 | 取消/失败重试 | ✅ | cancel/retryFile | `ft.cancel`/`file:retry` | — | `file:cancel/retry` | 双向取消 | 群文件不支持重试(已提示) | — |
| 文件 | 手动接收模式 | ✅ | 设置-文件 | `onFileDone`(manual) | pendingFiles | `file:offer/accept` | offer→accept 流程 | — | — |
| 文件 | 大小上限 | ✅ | 设置-文件 | `sendFilesInternal`校验 | settings.maxFileMB | `file:rejected` | 超限拒发+提示 | — | — |
| 文件 | 危险文件打开告警 | ✅ | — | `file:open` DANGEROUS_EXT | — | `file:open` | 原生确认框 | — | — |
| 消息记录 | 持久化/恢复/分页 | ✅ | convos/loadOlder | `vault.appendMessage` | history(≤1000) | `store:getHistory` | 重启恢复+懒加载 | 单会话硬上限 1000 | 大量历史会被截断 |
| 消息记录 | 保留天数清理 | ✅ | 设置-隐私 | `vault.pruneHistory` | history | `settings:set` | 解锁/改设置时裁剪 | — | — |
| 富消息 | 回复引用 | ✅ | doReply/Bubble | plaintext.reply | history | — | 渲染+携带 | — | — |
| 富消息 | 转发(逐条/合并) | ✅ | doForward | sendTextToConv(fwd) | history | — | 两模式实现 | 仅文本可转发 | — |
| 富消息 | 撤回(双方)+重新编辑 | ✅ | doRecall | `msg:recall`+`vault.markRecalled` | history | `msg:recall`/recallack | 撤回信号入发件箱+ACK | — | — |
| 富消息 | 表情回应 | ✅ | doReact | `msg:react`/`addReaction` | history.reactions | `msg:reaction` | 持久化+同步 | 群/私聊均 best‑effort 信令 | — |
| 富消息 | 阅后即焚 | ✅ | burnOn | 仅内存不落库 | 不落库 | — | 倒计时+离线禁发 | — | — |
| 富消息 | Markdown/链接/@ | ✅ | renderRich | — | — | — | 正则渲染 | — | — |
| 搜索 | 会话/全局搜索 | ✅ | SearchPane | — | 内存 convos | — | 纯前端过滤 | — | — |
| 搜索 | 历史面板 | ✅ | HistoryPanel | — | 内存 convos | — | 日期分组+筛选 | — | — |
| 通知 | 系统通知/预览 | ✅ | — | `notify` | — | Notification | 隐藏时触发 | — | — |
| 通知 | 任务栏/托盘闪烁红点 | ✅ | ui.setUnread | `setOverlayIcon`/tray flash | — | `ui:setUnread` | 位图生成 | — | — |
| 通知 | 免打扰/静音 | ✅ | 状态/会话菜单 | `setDnd`/muted | settings | — | 全局+单会话 | — | — |
| 表情包 | 导入/发送/删除 | ✅ | emoji 面板 | `stickers:*` | data/stickers | `stickers:*` | 文件复用通道 | — | — |
| 截图 | 框选/标注/复制/保存/发送 | ✅ | ShotScreen | `shot:*`/desktopCapturer | tmp png | `shot:*` | 全屏冻结+选区窗 | 仅主显示器(getPrimaryDisplay) | 多屏支持 |
| 戳一戳 | nudge+抖动+自定义 | ✅ | nudge UI | `p2p.sendNudge` | settings.nudgeText | `p2p:nudge` | UDP 单播 | 仅在线可送 | — |
| 设置 | 各类设置项保存 | ✅ | SettingsPanel | `settings:set`/`vault.setSettings` | settings | `settings:set` | 真实落盘+生效 | — | — |
| 设置 | 开机自启 | 🟡 | 设置-通知 | `applyAutoStart` | settings.autoStart | — | **仅打包后(app.isPackaged)生效** | 开发态/便携态不生效 | 文档说明 |
| 窗口 | 无边框控制/独立聊天窗/托盘 | ✅ | WinBtns/openChatWindow | `win:*`/Tray | — | `win:*`/`chat:openWindow` | 完整 | — | — |
| 日志 | 审计日志 | ✅ | 设置-关于"打开日志" | `logger.log` | ilink.log | `sys:revealLog` | 元数据+轮转 | — | — |
| 更新 | 检查更新 | 🎭 | 设置-关于 | `app:checkUpdate` | — | `app:checkUpdate` | **占位返回 latest=current** | 无真实更新源 | 接入或隐藏 |
| 隐私 | 黑名单 | ❌ | 无 UI 入口 | `setBlacklist([])`/`'blacklist'→[]` | settings(强制空) | — | **后端恒空,前端无入口** | 形同未实现 | 移除或实现 |
| 安全 | 身份↔公钥绑定认证 | ⚠️ | — | `_upsertPeer`(pub 可被覆盖) | — | presence | **presence 明文,id/pub 可仿冒** | LAN 内可冒名/中间人 | TOFU 固定/指纹校验 |

---

## 第五步：重点"假功能"识别结论

逐条核对常见"假功能"清单：

| 可疑点 | 实际结论 |
| -- | -- |
| 按钮无逻辑 | 未发现明显纯装饰按钮；主要功能均有 IPC 落地 |
| 页面未接真实接口 | 未发现；所有页面接 IPC |
| 前端显示成功但后端无 ACK | **私聊有真 ACK**；**群聊对在线成员无 ACK（best‑effort，存在丢失可能）** —— 见矩阵 ⚠️ |
| 进度条非真实进度 | 进度真实（基于 TCP 字节回调 + 测速）✅ |
| 在线状态无心跳 | 有真实 2s 心跳 + 6s 离线判定 ✅ |
| 聊天记录无持久化 | 真实加密持久化（store.enc）✅，阅后即焚故意不落库 |
| 文件入口无真实流程 | 真实 TCP 传输 + 加密 + 校验 ✅ |
| 断点续传无 chunk 状态 | 真实续传（.part + resumeFrom 偏移）✅ |
| 设置不真正保存 | 真实保存并生效 ✅ |
| 管理页无权限校验 | 无管理页；群操作有群主权限校验 ✅ |
| 文件完成只是 UI 状态 | 有 SHA‑256 + 大小校验，失败删 .part 不落盘 ✅ |
| **检查更新** | **🎭 仅 UI / 占位返回** |
| **黑名单** | **❌ 后端恒为空数组、前端无入口，形同未实现** |
| **开机自启** | **🟡 仅打包后生效** |

> 总体：这是一个**真实实现度很高**的项目，"假功能"极少，集中在"检查更新""黑名单""开机自启"三处。

---

## 第六步：自测用例（基于真实功能）

> 因运行环境不可用，"实际结果/是否通过"以**静态代码推演**填写（标注 [静态]）；需双机联调的项标 [需联调]。

| 编号 | 模块 | 功能 | 前置条件 | 测试步骤 | 预期结果 | 实际结果(静态) | 通过 | 备注 |
| -- | -- | -- | -- | -- | -- | -- | -- | -- |
| T01 | 认证 | 首次设密码 | 无 account.json | 输入两次一致密码(≥4)→创建 | 生成身份+密钥,进入主界面 | 代码路径完整 | [静态]✅ | 密码<4 被拦 |
| T02 | 认证 | 错误密码解锁 | 已有账户 | 输入错误密码 | 提示"密码错误",不解锁 | verifier 校验失败抛错 | [静态]✅ | |
| T03 | 认证 | 改密码旧密码错 | 已解锁 | 输入错误旧密码 | 提示"原密码错误" | 校验阻断 | [静态]✅ | |
| T04 | 认证 | 自动锁定 | autoLockMin=1 | 闲置>1 分钟 | 自动锁定回解锁页 | 定时器调用 lock | [静态]✅ | |
| T05 | 认证 | 重置身份 | 已有账户 | 勾选确认→重置 | 删除两文件,回首次设置 | unlink 实现 | [静态]✅ | 不可逆 |
| T06 | 发现 | 上线发现 | 两端同端口同网段 | A、B 启动 | 互相在线,显示 IP | presence 广播+单播补发 | [需联调] | |
| T07 | 发现 | 离线判定 | A、B 在线 | A 拔网/退出 | B 在 ~6s 内显示 A 离线 | sweep 6s | [需联调] | |
| T08 | 发现 | 改端口隔离 | — | A 用 51888,B 用 51999 | 互不可见 | 端口不同不互通 | [静态]✅ | |
| T09 | 发现 | 网卡切换重连 | 在线 | 切 WiFi/插拔网线 | 自动重连恢复在线 | _checkInterfaces 4s | [需联调] | |
| T10 | 私聊 | 在线发文本 | A、B 在线 | A 发"hello" | B 收到,A 显示已送达(双勾) | ACK→delivered | [需联调] | |
| T11 | 私聊 | 离线暂存补发 | B 离线 | A 发消息→B 上线 | 显示"待发送"→上线自动送达 | outbox+drain | [需联调] | |
| T12 | 私聊 | ACK 丢失重发 | 弱网 | 制造 ACK 丢失 | 1.5s 超时重发,≤4 次 | _retryAck | [需联调] | |
| T13 | 私聊 | 失败手动重试 | B 一直不可达 | 等待失败→点重试 | 状态置 sending→queued/failed | resend | [需联调] | |
| T14 | 私聊 | 空消息 | — | 发空白 | 拦截"空消息" | trim 校验 | [静态]✅ | |
| T15 | 群聊 | 建群权限 | 多人在线 | 建群选成员 | 建群成功,广播"群聊已创建" | createGroup | [需联调] | |
| T16 | 群聊 | 非群主踢人 | 普通成员 | 调 removeGroupMember | 拒绝"只有群主可移出" | 权限校验 | [静态]✅ | |
| T17 | 群聊 | 在线群发丢包 | 多端,弱网 | 群发长文本 | **可能部分成员收不到且无重发** | 广播无 ACK | [需联调]⚠️ | 风险点 |
| T18 | 群聊 | 离线成员补达 | 成员离线 | 群发→成员上线 | 成员上线后收到 | roomtext outbox | [需联调] | |
| T19 | 群聊 | 大群长消息 | 成员很多 | 群发超长文本 | **可能 EMSGSIZE 静默失败** | 单 UDP 包超限 | [需联调]⚠️ | 风险点 |
| T20 | 群聊 | 群主退群移交 | 群主 | 群主退群 | 群主移交给首成员 | leaveGroup | [需联调] | |
| T21 | 文件 | 在线发小文件 | A、B 在线 | 发图片 | B 收到,可预览,SHA 校验通过 | filetransfer 全链路 | [需联调] | |
| T22 | 文件 | 大文件进度 | — | 发 100MB | 进度/速度/ETA 实时 | progress 回调 | [需联调] | |
| T23 | 文件 | 断点续传 | 传输中断 | 中途断网→恢复 | 从断点续传,不重头 | .part+resumeFrom | [需联调] | |
| T24 | 文件 | 完整性损坏 | — | 篡改 .part | 哈希不符,删 part 报失败 | verify | [静态]✅ | |
| T25 | 文件 | 超大小上限 | maxFileMB=10 | 发 20MB | 拒发+"超过 10MB"提示 | 校验 | [静态]✅ | |
| T26 | 文件 | 危险文件打开 | 收到 .exe | 点打开 | 原生告警二次确认 | DANGEROUS_EXT | [静态]✅ | |
| T27 | 文件 | 手动接收拒绝 | receiveMode=manual | 收到→拒绝 | 删临时文件不落盘 | reject unlink | [静态]✅ | |
| T28 | 富消息 | 撤回+重新编辑 | 已发消息 | 撤回自己消息 | 显示[已撤回],可重新编辑 | markRecalled | [需联调] | |
| T29 | 富消息 | 阅后即焚离线 | 对方离线 | 开 burn 发送 | 拒绝"不支持暂存" | burn+reachable | [静态]✅ | |
| T30 | 富消息 | 阅后即焚倒计时 | 在线 | 发 burn,等 TTL | 到期消失,不落库 | 内存清理 | [需联调] | |
| T31 | 搜索 | 全局搜索定位 | 有历史 | 搜关键词→点结果 | 切会话+滚动高亮 | locateMessage | [静态]✅ | |
| T32 | 通知 | 后台收消息 | 窗口隐藏 | 收消息 | 系统通知+托盘闪烁+红点 | notify/flash | [需联调] | |
| T33 | 通知 | 免打扰 | 开 dnd | 收消息 | 不通知不闪烁 | notify 早退 | [静态]✅ | |
| T34 | 截图 | 截图发送 | — | 截图→框选→发送 | 落临时 png+加入待发 | shot:done | [需联调] | |
| T35 | 设置 | 改皮肤/字号 | — | 切换 | 即时生效并保存 | applyDisplay+落盘 | [静态]✅ | |
| T36 | 设置 | 改网络重启 P2P | — | 改端口→应用 | stopP2P+startP2P | networkChanged | [静态]✅ | |
| T37 | 稳定 | 客户端重启恢复 | 有历史/发件箱 | 重启解锁 | 历史/状态/未读/发件箱恢复 | 持久化齐全 | [需联调] | |
| T38 | 稳定 | 重复点击发送 | — | 连点发送 | 去抖(空文本拦截/mid 去重) | trim+seenSet | [静态]🟡 | 见风险 R8 |
| T39 | 边界 | 空数据/无会话发送 | 未选会话 | 点发送 | 提示"请选择会话" | canSendToConv | [静态]✅ | |
| T40 | 安全 | 身份仿冒 | LAN 内攻击者 | 广播他人 id+自己 pub | **对端 pub 被覆盖,可中间人** | _upsertPeer | [需联调]⚠️ | 风险点 |

---

## 第七步：执行自测（环境说明）

**当前环境无法运行项目**，原因：
1. 本会话提供的隔离 Linux 沙箱启动失败（VM service not running），无法 `npm install` / 启动。
2. 即便沙箱可用，本项目是 **Windows Electron GUI 应用**，依赖：桌面图形环境、托盘、原生对话框、`desktopCapturer` 截图、`app.setLoginItemSettings` 等 —— 无法在无头 Linux 中真实运行。
3. 核心通信是 **局域网 UDP/TCP P2P**，需要**至少两台同网段机器**（或同机多实例 `npm run dev` + `npm run dev:second`）才能验证收发、在线、补发、续传等。

**因此本轮以静态代码自测为主。** 若要在 Windows 本机做真机自测，建议：

```
npm install
npm run dev          # 启动实例 1（VITE+Electron）
npm run dev:second   # 启动实例 2（FREEDOM_DATA_DIR=data-2，与实例 1 同机互发）
```

要验证的关键运行项：登录解锁、双实例互相发现、私聊收发与已送达、离线补发、群聊在线/离线投递、文件传输+断点续传+哈希、截图、通知、重启恢复。

---

## 第八步：自测报告（结论汇总）

| 编号 | 模块 | 功能 | 测试结果 | 证据 | 级别 | 建议修复方式 |
| -- | -- | -- | -- | -- | -- | -- |
| T17 | 群聊 | 在线成员消息可靠性 | 不达标(潜在丢失) | sendRoom 广播无 ACK/重发 | P1 | 在线成员也纳入 did/ACK 重发路径 |
| T19 | 群聊 | 大群/长消息 | 不达标(潜在静默失败) | 单 UDP 包承载全员密文,超 MTU | P1 | 文本长度上限/分片/超限回退 TCP |
| T40 | 安全 | 身份↔公钥绑定 | 不达标(可仿冒) | presence 明文,_upsertPeer 覆盖 pub | P1 | 首次信任固定(TOFU)+公钥指纹核对 |
| —  | 更新 | 检查更新 | 仅 UI | app:checkUpdate 占位 | P2 | 接入真实源或隐藏入口 |
| —  | 隐私 | 黑名单 | 未实现 | setBlacklist([]),无入口 | P2 | 实现或移除残留代码 |
| —  | 系统 | 开机自启 | 受限 | 仅 app.isPackaged | P3 | 文档注明仅安装版生效 |
| —  | 记录 | 单会话 1000 上限 | 受限 | HISTORY_CAP=1000 | P3 | 文档说明/可配置 |
| —  | 截图 | 多显示器 | 受限 | 仅 getPrimaryDisplay | P3 | 支持多屏选择 |
| 其余 | 多模块 | 见第六步 | 静态通过/待联调 | 见各行 | — | 真机联调确认 |

---

## 第九步：问题清单（按优先级）

| 优先级 | 问题 | 影响范围 | 代码位置 | 复现步骤 | 原因分析 | 建议修复 |
| -- | -- | -- | -- | -- | -- | -- |
| **P1** | 群聊对**在线**成员消息无 ACK/重发，UDP 丢包即静默丢失 | 群聊可靠性 | `p2p.js sendRoom`（广播 best‑effort），`main.js sendRoomStored` | 弱网下群发，部分在线成员收不到且不补发 | 仅离线成员走 outbox+ACK；在线成员靠一次性广播 | 在线成员也按 did 单发+ACK+重发（复用 sendRoomMember 机制） |
| **P1** | 大群/长文本单 UDP 包超限静默失败 | 大群群聊 | `p2p.js sendRoom`（一个包含全员 enc） | 成员多/正文长时群发 | 全员密文塞进一个 UDP datagram，超 MTU/64KB；EMSGSIZE 被当瞬时错误忽略 | 限制正文长度 / 拆包 / 超限自动改 TCP |
| **P1** | LAN 身份可仿冒、公钥可被覆盖（中间人） | 全局安全 | `p2p.js _onPacket`/`_upsertPeer`（pub 随 presence 更新） | 攻击者广播 victim id + 攻击者 pub | presence 明文且无身份↔公钥认证，后到的 pub 覆盖先前的 | TOFU 固定首次公钥；公钥指纹人工核对；变更告警 |
| P2 | 检查更新为占位 | 关于页 | `main.js app:checkUpdate` | 点"检查更新"永远"无更新" | 未配置远程源 | 接入 electron-updater 或隐藏入口 |
| P2 | 黑名单形同未实现 | 隐私 | `main.js settings:set('blacklist'→[])`、`p2p.setBlacklist([])` | 无任何拉黑入口 | 后端恒置空、前端无 UI | 实现拉黑或清理残留死代码（本轮不删，仅记录） |
| P2 | 主密码最短 4 位 | 安全 | `vault.setup/changePassword` | 设 4 位弱密码 | 强度阈值过低 | 提升最小长度+强度提示 |
| P3 | 开机自启仅打包后生效 | 启动 | `main.js applyAutoStart` | 开发/便携态开开关无效 | `app.isPackaged` 判定 | 文档注明 |
| P3 | 单会话历史上限 1000、群文本无长度上限、截图仅主屏 | 记录/群聊/截图 | `vault HISTORY_CAP`、`sendRoom`、`shot:begin getPrimaryDisplay` | 超长历史/超长群消息/多屏 | 设计取舍 | 文档化或增强 |
| P3 | 群消息排序依赖发送方时钟 ts | 群聊顺序 | `appendMessage`/`pushMsg` 按 ts 插入 | 两端时钟偏差大 | 用本地 ts 排序 | 可接受；必要时引入逻辑时钟 |

> 关于十大重点关注项的快速结论：能否启动=需 Windows 真机（代码完整）；登录=✅真实；消息收发=私聊✅可靠/群聊⚠️在线无 ACK；丢失=群在线/大包有风险；重复=mid 去重(seenSet 上限 800)；乱序=按 ts 插入已处理；在线状态=✅心跳真实；文件传输=✅真实；文件损坏=✅哈希校验拦截；中断恢复=✅断点续传；UI 假功能=极少；配置保存=✅真实；持久化=✅真实；安全风险=⚠️见 P1 安全项。

---

## 第十步：最终结论

**1. 已完整实现的功能**：本地主密码认证与加密存储、X25519+AES‑GCM 端到端加密、UDP 局域网发现/心跳/在线状态、私聊文本（ACK+超时重发+离线发件箱补发+发送状态）、群聊管理（建/加/踢/退/转让/群头像，含权限校验）、TCP 文件传输（加密+进度+断点续传+SHA‑256 校验+取消/重试+大小上限+危险文件告警）、消息持久化/分页/保留清理、回复/转发/撤回/重新编辑/表情回应/阅后即焚/Markdown、搜索与历史面板、通知（系统/托盘/红点/免打扰/静音）、表情包、截图、戳一戳、设置（外观/通知/文件/网络/隐私/关于）、无边框窗口/独立聊天窗/托盘、审计日志。

**2. 部分实现**：开机自启（仅打包后生效）。

**3. 仅 UI / 占位**：检查更新（始终返回"无更新"）。

**4. 存在明显风险**：群聊在线成员无 ACK/重发（潜在丢消息）；大群/长消息单 UDP 包超限静默失败；LAN 身份可仿冒、公钥可被覆盖（中间人）。

**5. 无法静态判断、需运行/联调验证**：所有需要双机收发的实时行为（发现、收发、补发、续传、通知、重启恢复）——见第六步 [需联调] 项。

**6. 核心可用程度**：**单聊 + 文件传输链路达到"可用"水平**（加密、可靠投递、断点续传、完整性校验都齐全，实现质量高）。**群聊为"基本可用但不够可靠"**（离线补达可靠，在线/大包场景有丢失风险）。整体是一个完成度相当高、工程细节扎实的实现，远超"仅界面"水平。

**7. 最需优先修复**：P1 三项 —— ①群聊在线成员可靠投递（ACK/重发）；②群聊大包/长文本超限处理；③LAN 身份与公钥的可信绑定（TOFU/指纹）。

**8. 下一步建议补齐**：群聊送达/已读回执与 UI；群消息长度限制与提示；公钥指纹核对界面；检查更新真实接入（或隐藏）。

**9. 暂不建议开发**：管理后台、服务端/数据库、角色权限体系、网络登录账号系统 —— 与"局域网无服务端 P2P"定位冲突，会显著增加复杂度，非当前架构所需。

**10. 发内网测试版前需补齐的"最低功能"**：
- 必做（P1）：群聊在线成员可靠投递（避免丢消息）；群消息长度上限/分片，避免大包静默失败。
- 强烈建议（安全）：公钥 TOFU 固定 + 变更告警（哪怕先不做指纹 UI），降低 LAN 冒名风险；提高主密码最小长度。
- 体验兜底（P2）：把"检查更新""黑名单"等占位/未实现入口隐藏或标注，避免误导测试者。
- 其余（私聊、文件、通知、设置、持久化）已达可发布的内测水平，重点做一轮**双机真机联调**覆盖第六步 [需联调] 用例即可。

---

*备注：本报告为静态代码审查结论，标注 [需联调] 的项必须在 Windows 双机/同机双实例环境实跑确认后方可作为最终验收依据。本轮未修改任何代码。*
