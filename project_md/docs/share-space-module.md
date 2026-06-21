# 群共享空间模块说明

## 模块定位
在纯 P2P 局域网群聊基础上新增「群共享空间」：一个群可建多个共享空间，每个空间由其创建者本机充当「共享主机」存储全部文件与元数据。无中心服务器、无云盘架构。

## 相关文件
- `electron/sharespace.js`：宿主端权威存储——名称/路径安全校验、目录项/日志元数据、上传落盘、文件夹重命名、文件/文件夹递归删除、文件/文件夹下载清单。纯逻辑，可单元测试。
- `electron/p2p.js`：新增 `sendShare()` 加密单播控制信令（请求/响应，reqId 去重）+ 群系统消息透传 `share` 载荷。
- `electron/filetransfer.js`：`sendFile()` 第 10 参 `share` 透传共享空间上下文；`done` 事件原样回传，用于上传/下载路由。
- `electron/vault.js`：新增 `shareSpaces`（已知空间）/`shareSnapshots`（目录缓存快照）字段与读写方法，`_ensureFields` 兼容迁移。
- `electron/main.js`：`share:*` IPC、宿主端信令处理、文件落地路由、广播事件、在线检测、缓存快照编排。
- `electron/preload.js`：`api.share.*`。
- `src/App.jsx`：群聊头部「共享空间」入口、列表页、目录页、顶部批量下载/删除/文件夹重命名、离线提示、重名冲突弹窗。

## 架构要点
- **宿主权威 + 成员缓存**：宿主磁盘 `meta.json` + 物理文件为权威；成员仅缓存目录快照供离线只读。
- **广播复用群聊**：空间创建/上传/新建文件夹等以 `system: 'share-*'` 群系统消息广播，复用既有在线广播 + 离线发件箱补发，仅在聊天框展示、不弹通知。
- **控制信令走加密单播**：目录列表/新建文件夹/文件夹重命名/文件或文件夹删除/文件或文件夹下载请求经 `p2p.sendShare` 加密请求-响应。
- **文件内容走 FileTransfer TCP**：复用分片加密、SHA-256、`.part` 暂存与断点续传。

## 存储布局（宿主本机）
```
<rootPath>/files/<目录树>/<文件...>     真实文件
<rootPath>/.ilink-share/meta.json       元数据（space/entries/logs）
```
默认 `rootPath` = `<dataDir>/group_shares/{groupId}/{spaceId}/`，也可创建时自定义目录。

## 操作规则
- 群空间只有创建者可以删除。
- 空间内文件所有群成员都可以下载和删除，不支持上传新版本、历史版本和重命名。
- 空间内文件夹所有群成员都可以下载、重命名和删除；删除文件夹会递归删除其下所有内容。
- 文件和文件夹在目录页通过勾选后使用顶部下载/删除按钮批量操作。

## P2P 事件/接口（沿用项目风格）
- 控制信令统一封装为 `share` 包：`{ kind:'req'|'res', reqId, action, data }`，`action` ∈ `dir_list / folder_create / rename / delete / download`。
- 广播复用群 `system` 消息：`share-space-created`，附 `share` 载荷；目录变更通过静默 `share sync` 通知刷新。
- 文件上传/下载复用 FileTransfer，`share` 上下文 `{ op:'upload'|'download', spaceId, parentId, entryId, reqId, relativePath, ... }`。

## 安全
路径穿越（`..`/绝对路径/盘符）、Windows 非法字符与保留名（CON/PRN/NUL/COM1…）一律拒绝；落盘前 `.part` 暂存校验后改名；上传/下载双向 SHA-256 校验；非群成员请求拒绝；空间删除限创建者。

## 自测
`test/sharespace.test.js` 覆盖 `ShareStore` 上传/重名改名/文件夹下载清单/递归删除与路径穿越拒绝；`test/pathutil.test.js` 覆盖文件名净化（含 sharespace 复用）。运行 `npm test`。
