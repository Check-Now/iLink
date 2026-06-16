# 群共享空间模块说明

## 模块定位
在纯 P2P 局域网群聊基础上新增「群共享空间」：一个群可建多个共享空间，每个空间由其创建者本机充当「共享主机」存储全部文件与元数据。无中心服务器、无云盘架构。

## 相关文件
- `electron/sharespace.js`（新增）：宿主端权威存储——版本命名、名称/路径安全校验、目录项/版本/日志元数据、上传落盘、历史版本、重命名、删除入回收站。纯逻辑，可单元测试。
- `electron/p2p.js`：新增 `sendShare()` 加密单播控制信令（请求/响应，reqId 去重）+ 群系统消息透传 `share` 载荷。
- `electron/filetransfer.js`：`sendFile()` 第 10 参 `share` 透传共享空间上下文；`done` 事件原样回传，用于上传/下载路由。
- `electron/vault.js`：新增 `shareSpaces`（已知空间）/`shareSnapshots`（目录缓存快照）字段与读写方法，`_ensureFields` 兼容迁移。
- `electron/main.js`：`share:*` IPC、宿主端信令处理、文件落地路由、广播事件、在线检测、缓存快照编排。
- `electron/preload.js`：`api.share.*`。
- `src/App.jsx`：群聊头部「共享空间」入口、列表页、目录页、文件操作菜单、历史版本弹窗、离线提示、重名冲突弹窗。

## 架构要点
- **宿主权威 + 成员缓存**：宿主磁盘 `meta.json` + 物理多版本文件为权威；成员仅缓存目录快照供离线只读。
- **广播复用群聊**：空间创建/上传/新建文件夹等以 `system: 'share-*'` 群系统消息广播，复用既有在线广播 + 离线发件箱补发，仅在聊天框展示、不弹通知。
- **控制信令走加密单播**：目录列表/新建文件夹/历史/重命名/删除/下载请求经 `p2p.sendShare` 加密请求-响应。
- **文件内容走 FileTransfer TCP**：复用分片加密、SHA-256、`.part` 暂存与断点续传。

## 存储布局（宿主本机）
```
<rootPath>/files/<目录树>/<文件...>     真实文件（含全部历史物理版本）
<rootPath>/.ilink-share/meta.json       元数据（space/entries/versions/logs）
<rootPath>/.trash/                      删除项（移入而非物理删除，可恢复）
```
默认 `rootPath` = `<dataDir>/group_shares/{groupId}/{spaceId}/`，也可创建时自定义目录。

## 版本命名
- 版本 0（原始）：`需求文档.docx`；版本 k：`需求文档_VKK.docx`（V01..V99，超过 99 为 V100…）。
- 新版本命名永远基于目标条目的**逻辑基名**，忽略上传文件原名，杜绝 `_V01_V02` 叠加。
- 主列表显示逻辑名（最新版本），历史版本列表显示各物理版本名。

## P2P 事件/接口（沿用项目风格）
- 控制信令统一封装为 `share` 包：`{ kind:'req'|'res', reqId, action, data }`，`action` ∈ `dir_list / folder_create / history / rename / delete / download`。
- 广播复用群 `system` 消息：`share-space-created / share-folder-created / share-file-uploaded / share-file-version-uploaded / share-renamed / share-deleted / share-space-deleted`，附 `share` 载荷。
- 文件上传/下载复用 FileTransfer，`share` 上下文 `{ op:'upload'|'download', spaceId, parentId, intent, entryId, reqId, ... }`。

## 安全
路径穿越（`..`/绝对路径/盘符）、Windows 非法字符与保留名（CON/PRN/NUL/COM1…）一律拒绝；落盘前 `.part` 暂存校验后改名；上传/下载双向 SHA-256 校验；非群成员请求拒绝；删除/重命名限宿主或群主。

## 自测
`test/sharespace-smoke.js`（核心逻辑）、`test/sharespace-signal-smoke.js`（控制信令）、`test/sharespace-transfer-smoke.js`（端到端传输，含 100MB 大文件），已并入 `npm test`。
