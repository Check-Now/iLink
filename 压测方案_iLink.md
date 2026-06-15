# iLink 局域网 P2P 通讯软件 — 性能 / 并发 / 边界压测方案

> 版本：v1（方案与脚本设计阶段，不含实现代码、不修改业务代码）
> 适用对象：iLink（仓库 freedom），Electron 30 + React 18 + 局域网 P2P
> 压测环境：**单机无头进程内压测**（复用 `electron/p2p.js`、`electron/filetransfer.js` 类，绕过 UDP 广播发现，手动注入 peer）
> 编制依据：`electron/p2p.js`、`electron/filetransfer.js`、`electron/main.js`、`electron/vault.js`、`test/*.js`、`project_md/*`

---

## 0. 关键架构结论（决定一切测试设计的前提）

**这是一个纯 P2P、去中心化、无中心服务器的系统。** 必须先纠正传统 C/S 压测的几个默认假设：

1. **没有"服务端"可压。** Electron 主进程（`electron/main.js`）就是每台机器的"本机后端"，每个客户端自带一份。所谓"1000 人同时在线"= 局域网里 1000 个对等节点，而**不是** 1000 个连接打向一台服务器。因此"服务端 CPU / 内存 / DB 连接数 / 吞吐"这些指标要重新定义为**单节点资源**与**全网聚合行为**两层。
2. **没有网络登录接口。** "登录"= 本地用 scrypt 解密 vault（`electron/vault.js` 的 `unlock`）+ 启动 P2P socket 绑定。登录成功率 ≈ vault 解锁成功率 + socket 绑定成功率，**与网络并发无关**。
3. **没有数据库。** "数据库"= 本地单文件加密存储 `data/store.enc`（AES-256-GCM），每节点一份。"落库"= `vault.appendMessage()` 写入内存并 flush 到该文件。不存在连接池/锁等待，但存在**单文件写入串行化**与**HISTORY_CAP=1000 截断**风险。
4. **三种通信通道并存**（详见 1.11）：UDP 广播（发现/心跳/群广播）、UDP 单播（私聊+ACK+群补达）、TCP（文件传输）。
5. **群广播是 best-effort、无 ACK。** 这是消息丢失风险的头号来源（详见 2、7）。
6. **消息无全局序号、无重排缓冲。** UDP 到达顺序即展示顺序，乱序风险天然存在（详见 2.乱序）。
7. **去重窗口有限：`SEEN_MAX = 800`。** 高吞吐下老 mid 被挤出，可能导致重复展示（头号重复风险）。

> 因此本方案的"压测目标"实质是：在单机用进程内多节点复现 LAN 规模，**重点验证消息正确性（丢失/重复/乱序）和可靠性机制（ACK/重发/离线补发/重连）**，资源指标作为辅助观测。

---

## 第一步：项目通信架构识别

### 1.1 服务端启动入口
无独立服务端。本机后端 = Electron 主进程入口 `electron/main.js`（`package.json` 的 `"main": "electron/main.js"`）。
- `npm run dev`：并行启动 Vite(5173) + Electron。
- `npm run dev:second`：`FREEDOM_DATA_DIR=data-2` 启动第二实例，用于本机双开 P2P 联调。
- 主进程内 `startP2P()` / `stopP2P()` 初始化并启停 `P2P` 与 `FileTransfer`。

### 1.2 客户端启动入口
渲染进程 `src/main.jsx` 挂载 `src/App.jsx`。UI 通过 `window.api`（`electron/preload.js` 暴露）→ `ipcRenderer.invoke` → `ipcMain.handle` 调用后端。客户端与服务端同进程组，无独立网络客户端。

### 1.3 登录认证流程（本地，无网络）
`electron/vault.js`：`setup(password)` 首次建身份（scrypt KDF，参数见 `SCRYPT`，校验块 `MAGIC='FREEDOM_VAULT_OK'`）→ `unlock(password)` 解密 `store.enc` → 解锁后 `startP2P()` 发布 presence。
- IPC：`auth:setup` / `auth:unlock` / `auth:changePassword` / `auth:lock` / `auth:reset`。
- 压测含义：登录是 **CPU 密集（scrypt）+ 本地 IO**，并发"登录"= 并发解锁 + 并发 socket 绑定，瓶颈在 scrypt 与端口绑定，不在网络。

### 1.4 单聊消息发送流程
入口 IPC `p2p:sendPrivate`（`main.js:1124`）：
1. 阅后即焚（burn）：对端必须在线，直发 `p2p.resendPrivate()`，不入发件箱。
2. 普通私聊：写本地回显 echo → `vault.outboxAdd(toId,{kind:'text',...})` 持久化发件箱 → `outboxDrain(toId)` 尝试投递。
3. `p2p.resendPrivate(toId, mid, text, opts)`（`p2p.js:442`）：对端可达则 AES-GCM 加密 → UDP 单播 → `_trackAck` 跟踪 ACK；不可达返回 `{ok:false}`，条目留在发件箱等 presence 补发。
- 可靠性：`ACK_TIMEOUT_MS=1500`，`ACK_MAX_RETRY=3`（首发+3 重发=4 次），耗尽 emit `msg-status:failed`，main 保留发件箱条目下次 presence 再发。
- 状态机：`sending → sent → delivered`（收 ACK）/ `failed` / `queued`（离线暂存）。

### 1.5 群聊消息发送流程
入口 IPC `p2p:sendRoom`（`main.js:1117`）→ `p2p.sendRoom(room,text,opts)`（`p2p.js:474`）：
1. 超长拦截：`isTextTooLong`（>`MAX_TEXT_CHARS=3000` 拒绝）。
2. **逐成员加密**：对每个在线且有公钥的成员 `enc[id]=AES-GCM(memberKey, plaintext)`，密文体随成员数线性增长。
3. **广播一次**：`_broadcastMsg(pkt)`——若包 > `SAFE_DATAGRAM_BYTES=60000` 则**跳过广播**，返回 `ok` 但 `recipients` 仍统计，交由单播补达。
4. 广播是 best-effort，**不跟踪 ACK，不重发**。
- 在线成员的可靠补达：`outboxDrainAll()` / `sendRoomMember(toId,room,mid,did,text,opts)`（`p2p.js:505`，`main.js:714`）逐成员单播 + `did=mid@member` 独立 ACK + 重发。
- 离线成员：`vault.outboxAdd(mem,{...})`，presence 上线时 `outboxDrain` 补发。

### 1.6 消息接收流程
`p2p.js:_onPacket`（`p2p.js:252`）→ `m.t==='msg'`（`p2p.js:291`）：
1. 取自己那份密文（私聊 `m.enc`；群聊 `m.enc[this.id]`），AES-GCM 解密。
2. 若 `m.to===this.id` 且 scope∈{private,room}→ 先回 ACK（重复包也回，覆盖丢失的 ACK）。
3. `_markSeen(m.mid)` 去重（命中则 return，不展示）。
4. emit `message` 事件 → main 落库 `vault.appendMessage` + `sendToRenderer('p2p:message')`。
- **群广播包无 `m.to`，不回 ACK**（best-effort）；群单播补达包带 `m.to+m.did`，按 did 回执。

### 1.7 ACK / delivered 流程
- 发送端：`_trackAck(mid,toId,pkt)` 起 1500ms 定时器 → 超时 `_retryAck` 重发（最多 3 次）→ 收到 `t:'ack'` → `_onAck` emit `msg-status:delivered`。
- 接收端：`_sendAck(toId,address,uport,mid)` 回 `{t:'ack',from,to,mid}` 单播。
- 群补达用 `did` 区分同一 mid 发往多个成员的回执，互不串号。
- 撤回另有 `recall`/`recallack` 确认通道。

### 1.8 离线消息流程
持久化发件箱在 vault：`getOutbox/outboxAdd/outboxRemove`。
- 发送时对端不可达 → 入发件箱（text/file/roomfile/recall 四种 kind）。
- 对端 presence 到达且 `reachable()` 为真 → `outboxDrain(peerId)`（`main.js:695`）逐条补发；`outboxDrainAll`（`main.js:739`）在任一 peer 可达时遍历所有发件箱。
- `reachable(toId)`（`p2p.js:431`）= 在线 + 有 address + uport + pub。

### 1.9 断线重连流程
`p2p.js`：socket 致命错误 / 绑定失败 / 网卡 IP 变化（`_checkInterfaces` 每 4s）→ `_scheduleReconnect`（指数退避，封顶 15s）→ `reconnect()` 重建 socket，**保留 id/peers/pending 发件箱**，重新心跳发现。瞬时错误（ECONNRESET/EMSGSIZE 等，`isTransientSockError`）被忽略，不升级为重连。

### 1.10 文件上传/下载/分片/断点续传流程
`electron/filetransfer.js`，TCP 直连：
- 帧协议：`4字节大端长度 + 负载`，长度 0 = EOF。帧1 明文握手 `{v,from,spub,resume}` → 接收端回 `{resumeFrom:N}` → 帧2 密文元数据 `{mid,fname,size,mime,scope,to,sha256,...}` → 帧3.. 密文分块（`CHUNK=64KB`，每块独立 AES-GCM）→ EOF。
- 断点续传：接收端保留 `.part`（`os.tmpdir()/freedom-<mid>.part`），同 mid 重传回传已收字节，发送端从偏移续发。
- 完整性：收尾对整文件重算 SHA-256 + 校验字节数，任一不符删 `.part` 报 `failed`，绝不落盘。
- 超时：`SOCKET_TIMEOUT_MS=30000`；等续传偏移 `OFFSET_WAIT_MS=3000`；残留 `.part` 保留 `PART_TTL_MS=7天`。
- 取消：`cancel(mid)` 销毁读流+socket；网络中断保留 `.part`，用户取消/校验失败删 `.part`。
- 事件：`incoming/progress/send-progress/sent/done/failed/error`。

### 1.11 使用的通信协议
| 通道 | 协议 | 端口 | 用途 |
|---|---|---|---|
| 发现/心跳/群广播 | **UDP 广播** | `DISCOVERY_PORT=51888`（固定） | presence 心跳(2s)、群消息广播、群控制信号(撤回/reaction) |
| 私聊/群补达/ACK/typing/nudge | **UDP 单播** | 随机端口 `uport`（绑 0） | 私聊消息+ACK、群单成员补达、正在输入、拍一拍、群头像 |
| 文件传输 | **TCP** | 随机端口 `tport`（绑 0） | 大文件分块加密传输、断点续传 |
| UI↔后端 | **Electron IPC** | — | 渲染进程调用 |
- 包封装：`MAGIC='FRDM1' + JSON`；加密 X25519 + HKDF-SHA256 + AES-256-GCM。
- 关键尺寸边界：`MAX_TEXT_CHARS=3000`、`SAFE_DATAGRAM_BYTES=60000`、UDP 理论上限 65507。

### 1.12 数据库存储位置与消息表结构
无 SQL 数据库。`data/store.enc`（默认实例）/`data-2/store.enc`（第二实例），AES-256-GCM 加密的单 JSON：identity、contacts、groups、history（按 convId 分组，`HISTORY_CAP=1000` 截断）、drafts、reads、outbox、settings。`data/account.json` 存 KDF 参数+校验块。迁移入口 `Vault._ensureFields()`。

### 1.13 日志输出位置
`electron/logger.js` → 数据目录下 `ilink.log`（`data/ilink.log`、`data-2/ilink.log`），记录元数据（不含正文/密钥），带轮转 `_rotateIfNeeded`。压测后用日志分析脚本统计 error/warn、重连、EMSGSIZE 等。

### 1.14 可用于压测的接口、事件名、字段结构
**直接复用的类（无头压测主入口）：**
- `new P2P({id,name,pub,priv,disableDiscovery:true})` → `.start()` / `._upsertPeer(id,name,addr,uport,pub)` 注入对端 / `.resendPrivate` / `.sendRoom` / `.sendRoomMember` / `.privateEcho` / `.reachable` / `.stop()`。
- `new FileTransfer({id,pub,priv,resolvePeer,ownName})` → `.start(onPort)` / `.sendFile(toId,path,scope,mid,metaTo,...)` / `.cancel(mid)` / `.stop()`。
- `require('./crypto').generateKeyPair()` 造密钥对。

**可监听的事件（统计抓手）：**
- P2P：`message`、`msg-status`（sent/delivered/failed/queued）、`peers`、`ready`、`typing`、`recall`、`reaction`、`neterror`、`reconnect`。
- FileTransfer：`incoming`、`progress`、`send-progress`、`sent`、`done`、`failed`、`error`。

**关键字段：** message `{mid,scope,from,to,text,room,ts,batch,self}`；msg-status `{mid,toId,status}`；file done `{mid,transferMid,from,fname,size,sha256?,tempPath,scope,to}`。

---

## 第二步：正式使用环境模拟（在线规模）方案

> 单机进程内每个"在线用户"= 一个 `P2P` 实例（独立 id/密钥/uport）。绑定 `disableDiscovery:true` 绕过 51888 端口争用，节点间用 `_upsertPeer` 全互联注入。500/1000 节点在单机可达（每节点 1 个 uniSock，无 discSock）。

### 2.1 阶段划分与每阶段观测项
| 阶段 | 在线节点数 | 拓扑构建方式 |
|---|---|---|
| S1 | 10 | 全互联注入 peer |
| S2 | 50 | 全互联 |
| S3 | 100 | 全互联 |
| S4 | 300 | 全互联（关注 O(N²) peer 表内存） |
| S5 | 500 | 全互联 |
| S6 | 1000 | 全互联（架构上限观测，可能需分批/降低互联度） |

每阶段统计（对照原始要求 1-9）：
1. **登录成功率** = 成功 `unlock`+`start`(ready) 节点数 / 目标数。无头模式下用 vault 解锁子用例 + socket 绑定成功率衡量。
2. **连接建立耗时** = 从 `start()` 到 `ready` 事件的耗时分布（P50/P95）。
3. **在线状态准确性** = 真实建立节点数 vs 各节点 `getPeers()` 中 online 计数的一致性（注入模式下应 100%；发现模式下测发现完整率）。
4. **心跳稳定性** = presence 间隔抖动（仅发现模式有意义，需单独子场景开 discovery）。
5. **掉线率** = 测试窗口内非预期 `online:false` 翻转次数 / 节点数。
6. **单节点 CPU** = 进程 CPU%（`process.cpuUsage()` 采样）。
7. **单节点内存** = `process.memoryUsage().rss/heapUsed` 时间序列，关注是否随节点数/时长**单调上涨不回落**（peers Map、keyCache、seen 数组）。
8. **"数据库连接数"→ 存储写入** = flush 次数/耗时、store.enc 体积增长（无连接池概念）。
9. **日志错误数** = `ilink.log` 中 error/warn/neterror/reconnect 计数。

### 2.2 规模化特别关注的架构风险（在线维度）
- **presence 风暴（仅真实发现模式）**：N 节点每 2s 各向全网广播 presence，全网处理量 O(N²)。无头注入模式默认不触发，需要单独的"发现模式小规模（10-50）"子场景去观测真实广播开销。
- **peer 表内存**：每节点维护 N-1 个 peer + keyCache，300/500/1000 节点时单节点内存随之上升，需取内存基线曲线。
- **keyCache 增长**：每对端公钥派生一次 AES key 永久缓存，1000 节点 = 999 条缓存/节点。

---

## 第三步：多人多消息并发测试方案

> 所有场景在进程内多节点上跑，**消息体内嵌测试探针字段**：`seq`（每 sender→conv 单调递增）、`sendTs`（高精度发送时刻）。接收端按 mid 配对、按 seq 验序、按 sendTs 算延迟（同进程单调时钟，延迟测量精确）。

### 3.1 场景清单
| 编号 | 场景 | 驱动方式 |
|---|---|---|
| C1 | 多人单聊并发发送 | N 对节点两两私聊，各发 M 条 |
| C2 | 多人 → 同一群聊同时发 | K 个 sender 向同一 room 各发 M 条 |
| C3 | 多个群同时发 | G 个 room 并行，各自成员互发 |
| C4 | 单用户连续快速发送 | 1 sender 向 1 conv 高频连发 M 条（压去重窗口/顺序） |
| C5 | 多人同时发图片消息 | 同 C1/C2，payload 带小图（base64，注意 3000 字上限与 60KB 包限） |
| C6 | 多人同时发文件消息 | 转第四步文件场景，文本通道发文件 meta |
| C7 | 发送中客户端断开 | 发送方发到一半 `stop()`，验证发件箱保留与重发 |
| C8 | 发送中服务端重启 | 接收方 `reconnect()`，验证 ACK 丢失后重发去重 |
| C9 | 断线后重连补发离线消息 | 接收方先离线积压发件箱，再上线触发 `outboxDrain` |
| C10 | 大量客户端同时重连 | N 节点同时 `reconnect()`，验证补发风暴下不丢不重 |

### 3.2 每场景必统计指标（对照原始要求 1-14，由校验脚本计算）
1. 发送消息总数（各 sender 计数累加）
2. 服务端接收总数 = 各接收节点 `_onPacket` 解密成功计数（在去重前埋点统计）
3. 接收方实际收到总数 = 各节点 `message` 事件去重后计数
4. "落库"总数 = 模拟 `appendMessage` 计数（无头下用回调计数代理）
5. **消息丢失数** = 应收集合 − 实收集合（按 mid，区分 private 必达 vs group best-effort）
6. **消息重复数** = `message` 事件中同 mid 出现 >1 次的次数（直接命中 SEEN_MAX 风险）
7. **消息乱序数** = 接收序列中 seq 非单调递增的逆序对数 / 错位条数
8. 平均延迟 = mean(recvTs − sendTs)
9. P95 延迟
10. P99 延迟
11. ACK 成功率 = `delivered` 数 / 应 ACK 的私聊+群补达数
12. 失败重试次数 = `_retryAck` 触发次数（需探针计数）+ `failed` 事件数
13. 客户端掉线数 = 测试窗口内 online 翻转
14. 服务端错误日志 = neterror/error 事件 + ilink.log error 行

### 3.3 重点风险假设（须被测试证伪/证实）
- **H1 群广播丢失**：C2 在高并发或大群（成员多→包超 60KB 跳过广播）下，未走单播补达的在线成员会丢消息。预期 group 丢失率 > 0，须量化。
- **H2 去重窗口溢出**：C4 单 conv 连发 > 800 条且伴随重发，老 mid 被挤出 `seen`，重发包可能被重复展示。预期重复率随条数上升。
- **H3 乱序**：C1/C4 UDP 单播无序号，重发会把旧消息插到新消息后，产生乱序。预期乱序数 > 0。
- **H4 重连去重**：C8/C10 重连后 pending 重发 + 接收端 seen 是否仍有效（seen 不随重连清空，应能去重）。
- **H5 阅后即焚离线**：burn 消息对端离线直接拒绝（不入发件箱），须验证不会静默丢失也不误暂存。

---

## 第四步：文件传输并发测试方案

> 每个"用户"= 一个 `FileTransfer` 实例（独立 TCP server 端口）。`resolvePeer` 返回目标 `{address:'127.0.0.1',tport,pub}`。源文件用随机字节预生成并预存 SHA-256 期望值。

### 4.1 场景清单
| 编号 | 场景 | 参数 |
|---|---|---|
| F1 | 10 用户同时发 10MB | 10 并发 × 10MB |
| F2 | 10 用户同时发 100MB | 10 并发 × 100MB（关注内存/磁盘/耗时） |
| F3 | 50 用户同时发 10MB | 50 并发 × 10MB（连接/句柄压力） |
| F4 | 多人 → 群聊发文件 | 群文件经发件箱逐成员单播 TCP |
| F5 | 传输中断后恢复 | 发到一半断 socket，保留 `.part`，同 mid 重传验续传 |
| F6 | 传输中客户端退出 | 发送方/接收方中途 `stop()` |
| F7 | 传输中服务端重启 | 接收方进程内重启 server |
| F8 | 完成后 hash 校验 | 落地文件 SHA-256 vs 源（done 已内置校验，再独立复核） |

### 4.2 每场景必统计指标（对照原始要求 1-11）
1. 文件发送数量（`sendFile` 调用数）
2. 文件成功数量（`done` 事件数）
3. 文件失败数量（`failed` 事件数）
4. 平均传输速度 = size / (sent−connect)，MB/s
5. 平均完成耗时（connect → done）
6. **hash 校验通过率** = SHA-256 一致数 / 完成数（须 100%）
7. **断点续传成功率** = F5 续传后 done 且 hash 通过数 / 续传尝试数
8. 临时文件清理情况 = 失败/取消后 `.part` 是否按规则删/留（校验失败删、网络中断留）
9. 单节点磁盘占用 = `os.tmpdir()` 下 `freedom-*.part` 与落地文件体积
10. 带宽占用 = 进程内总字节/秒（同机为回环，作相对吞吐参考）
11. 文件传输错误日志 = `error`/`failed` 事件 + ilink.log

### 4.3 文件维度风险假设
- **H6 30s 空闲超时**：F2/F3 高并发下若单连接被 CPU 抢占停顿 > 30s，`SOCKET_TIMEOUT_MS` 触发误判失败。须量化并发上限。
- **H7 句柄/内存**：F3 50 并发 × 多 64KB 缓冲 + 同时 SHA-256 流式读，关注 fd 数与 rss。
- **H8 续传哈希边界**：续传是整文件重算 SHA-256，注释明确"增量哈希无法覆盖续传前已落盘部分"——F5 须验证续传后整文件 hash 仍正确。
- **H9 .part 堆积**：大量失败后 `.part` 是否仅靠 7 天 TTL 清理，短期是否撑爆 tmpdir。

---

## 第五步：完整压测计划表

| 测试编号 | 测试类型 | 测试场景 | 并发规模 | 持续时间 | 测试步骤 | 关键指标 | 通过标准 | 风险 |
|---|---|---|---|---|---|---|---|---|
| L1 | 在线/容量 | 节点批量上线 S1–S6 | 10/50/100/300/500/1000 | 每阶段 60s 稳态 | 批量 new P2P→start→全互联注入→等 ready→采样资源 | 登录成功率、ready 耗时 P95、节点内存曲线 | 成功率 100%、内存不持续上涨 | peer 表 O(N²)、端口/句柄耗尽 |
| L2 | 在线/发现 | 真实 UDP 发现风暴 | 10/30/50 | 120s | 开 discovery 真实广播，测发现完整率与 presence 抖动 | 发现完整率、心跳抖动、CPU | 完整率≥99%、抖动<1×心跳 | presence O(N²) 风暴 |
| C1 | 并发/单聊 | 多人单聊并发 | 100 对 ×100 条 | ≤300s | 两两私聊连发，监听 message/msg-status | 丢失/重复/乱序、P95/P99、ACK 率 | 私聊丢失=0、重复=0、ACK≥99.9% | 乱序、重发风暴 |
| C2 | 并发/群聊 | 多人轰同一群 | 群 50 人，20 sender×100 条 | ≤300s | 同 room 并发 sendRoom + 单播补达 | 群丢失率、重复、乱序、P95 | 在线成员经补达后丢失=0 | 广播 best-effort 丢失 |
| C3 | 并发/多群 | 多群同时发 | 20 群 ×10 人 ×50 条 | ≤300s | 并行多 room | 同上 + 单节点 CPU | 同 C2 | 加密 O(成员) CPU |
| C4 | 边界/吞吐 | 单会话高频连发 | 1→1，2000 条 | 连发 | 高频 resendPrivate，越过 SEEN_MAX=800 | 重复率、乱序、丢失 | 重复=0（验证或暴露 H2） | 去重窗口溢出 |
| C5 | 并发/图片 | 多人发图片消息 | 50×50 条带小图 | ≤180s | payload 嵌 base64 小图 | 同 C1 + 超限拦截命中 | 不静默丢失、超限被拦截 | 60KB 包限、3000 字限 |
| C7 | 容错 | 发送中客户端断开 | 20 对 | — | 发一半 stop()，重启后看补发 | 补发成功率、重复 | 重连后补齐、不重复 | 发件箱/seen 一致性 |
| C8 | 容错 | 发送中服务端重启 | 20 对 | — | 接收方 reconnect() | 丢失、重复、delivered 终态 | 最终一致、不丢不重 | ACK 丢失后重发 |
| C9 | 容错/离线 | 重连补发离线消息 | 50 离线条/节点 | — | 接收方离线积压→上线 drain | 补发完整率、顺序、重复 | 完整率 100%、重复=0 | outbox 顺序 |
| C10 | 容错/风暴 | 大量客户端同时重连 | 200 节点同时 | — | 集体 reconnect() | 丢失、重复、恢复耗时 | 不丢不重、秒级恢复 | 补发风暴 |
| F1 | 文件并发 | 10×10MB | 10 | — | 并发 sendFile + done/hash | 成功率、速度、hash 通过率 | 成功率 100%、hash 100% | 内存/磁盘 |
| F2 | 文件并发 | 10×100MB | 10 | — | 同上大文件 | 完成耗时、内存峰值 | 不 OOM、hash 100% | 30s 空闲超时 |
| F3 | 文件并发 | 50×10MB | 50 | — | 高并发 | fd 数、失败数、速度 | 失败=0、hash 100% | 句柄/超时 |
| F4 | 文件/群 | 群文件分发 | 群 10 人 | — | 群文件逐成员单播 | 各成员成功率、hash | 全员 100% | 串行单播耗时 |
| F5 | 文件/续传 | 中断恢复 | 10 | — | 发一半断→同 mid 重传 | 续传成功率、hash | 续传率 100%、hash 100% | 续传哈希边界 H8 |
| F6 | 文件/容错 | 传输中退出 | 10 | — | 中途 stop() | .part 保留/删除正确性 | 网络中断留 part、取消删 | 临时文件 |
| F8 | 文件/校验 | 完成后 hash | 全量复核 | — | 落地文件独立 SHA-256 | hash 通过率 | 100% | — |

> 持续时间标"≤"为上限，达成统计样本即可停止；容错类以事件完成为准。

---

## 第六步：需要准备的测试工具与脚本设计

> 全部为 `test/` 下**独立脚本**，仅 `require` 现有 `electron/*` 类，**不修改任何业务代码**。建议新建 `test/load/` 子目录归类，沿用现有 smoke test 的 `require('../../electron/...')` 模式与 `node` 直跑、`assert` 风格。

### 6.1 测试账号 / 身份生成（`test/load/gen-identities.js`）
- 职责：批量调用 `crypto.generateKeyPair()` 生成 N 组 `{id,name,pub,priv}`，可选 `vault.setup(pw)` 造真实加密身份用于登录子用例。
- 输出：`test/load/fixtures/identities-<N>.json`（内存或落盘复用，避免每次重算）。
- 账号方案：id 用 `crypto.randomUUID()`；name 用 `node-<i>`；密钥对即身份，无需服务端注册（去中心化）。

### 6.2 模拟客户端 / 节点工厂（`test/load/node-factory.js`）
- 职责：封装 `makeP2PNode(identity,{discovery})`、`makeFileNode(identity)`、`wireFullMesh(nodes)`（两两 `_upsertPeer` 注入，建立全互联）、`attachProbes(node,collector)`（挂全部事件监听并计数）。
- 关键：无头模式 `disableDiscovery:true`；`_upsertPeer(id,name,'127.0.0.1',peer.uport,peer.pub)` 用真实 uport 互联，使单播真正回环可达。
- 探针字段注入：发送时把 `seq`/`sendTs` 拼进 text（如 JSON 前缀），接收端解析。

### 6.3 UDP / 在线规模压测脚本（`test/load/run-online.js`）
- 职责：执行第五步 L1/L2，参数化节点数；阶段间 `process.cpuUsage()`/`memoryUsage()` 采样写时间序列。
- 输出：`results/online-<N>.json`（成功率、ready 耗时分布、内存曲线）。

### 6.4 消息并发压测脚本（`test/load/run-messaging.js`）
- 职责：执行 C1–C10，参数 `--scenario --senders --msgs --groupSize`。
- 核心循环：按场景驱动 `resendPrivate`/`sendRoom`/`sendRoomMember`，收集 collector，跑完 `flushWait` 后导出原始事件流给一致性校验脚本。
- 容错场景内置 `stop()`/`reconnect()` 钩子与时序控制。

### 6.5 消息一致性校验脚本（`test/load/verify-consistency.js`）
- 职责：吃 collector 原始事件流，计算第三步 1–14 全部指标。
- 算法：
  - 丢失 = 发送 mid 集合 − 接收 mid 集合（按 scope 分别统计，private/room-补达 应为空集）。
  - 重复 = 接收事件按 mid 分组 count>1。
  - 乱序 = 对每条 (sender,conv) 接收序列求 seq 逆序对数。
  - 延迟 = recvTs−sendTs 数组 → mean/P95/P99（排序取分位）。
  - ACK 率 = delivered / 应 ACK 数。
- 输出：结构化 JSON + 控制台摘要，断言对照第七步通过标准。

### 6.6 文件 hash / 续传校验脚本（`test/load/run-files.js` + `verify-files.js`）
- 职责：执行 F1–F8；预生成随机文件并存期望 SHA-256；监听 `done` 取 `tempPath` 独立重算 hash 复核；F5 注入中断与续传；统计速度/耗时/`.part` 状态。
- 输出：`results/files-<scenario>.json`。

### 6.7 日志分析脚本（`test/load/analyze-log.js`）
- 职责：解析 `data*/ilink.log`，统计 error/warn、neterror、reconnect、EMSGSIZE/包超限、文件失败等分类计数，与事件统计交叉验证。

### 6.8 测试报告生成脚本（`test/load/gen-report.js`）
- 职责：汇总各 `results/*.json` + 日志分析，生成 `results/REPORT-<时间戳>.md`（含计划表填值、通过/未通过标记、风险命中、资源曲线表）。可选输出 CSV 供画图。

### 6.9 公共度量工具（`test/load/metrics.js`）
- 职责：高精度计时（`process.hrtime.bigint()`）、分位计算、CPU/内存采样器、计数器集合。被各脚本复用。

> **运行编排建议**：在 `package.json` 增 `test:load` 脚本（不改业务代码），或用一个 `test/load/run-all.js` 顺序跑场景并调用 `gen-report.js`。

---

## 第七步：建议通过标准

| # | 指标 | 通过标准 | 说明 |
|---|---|---|---|
| 1 | 私聊消息丢失率 | **= 0** | 私聊有 ACK+重发+持久发件箱，必达 |
| 2 | 私聊消息重复率 | **= 0** | 依赖 seen 去重；C4 须验证不溢出 |
| 3 | 群消息丢失率（在线成员，经单播补达后） | **= 0** | 纯广播 best-effort 段可 >0，但补达后应归零 |
| 4 | 单聊 P95 延迟 | **< 500ms** | 同机回环参考值，真实 LAN 另设基线 |
| 5 | 群聊 P95 延迟 | **< 1000ms** | 含逐成员加密+广播/补达 |
| 6 | ACK 成功率 | **> 99.9%** | 私聊+群补达的 delivered 比例 |
| 7 | 100 人并发在线 | **进程不崩溃、无未捕获异常** | 内存稳定、无 EADDR 类致命错 |
| 8 | 断线重连成功率 | **> 99%** | reconnect 后恢复收发且不丢不重 |
| 9 | 文件 hash 校验通过率 | **= 100%** | done 内置校验 + 独立复核双保险 |
| 10 | 断点续传成功率 | **= 100%** | F5 续传后整文件 hash 一致 |
| 11 | 单节点内存 | **不持续无上限增长** | 稳态后 rss 回落或平台期；关注 peers/keyCache/seen |
| 12 | 存储写入 | **无写入失败、store.enc 无损坏** | 替代"DB 连接耗尽/锁等待"语义 |
| 13 | 消息乱序 | **私聊 ≤ 可接受阈值并有结论** | 无序号设计，须量化而非假定为 0；建议作为已知风险记录 |
| 14 | 错误日志 | **无 error 级、warn 可解释** | neterror/EMSGSIZE 须能归因 |

### 7.1 标准说明与已知架构性结论（须在报告中如实呈现）
- **乱序（#13）不应被设成"必须=0"**：当前协议无消息序号、无重排缓冲，UDP 单播+重发天然可能乱序。建议把它定为"量化并评估业务可接受度"，而非硬性 0。
- **群广播段的丢失**：best-effort 广播本身不保证送达，"群丢失率=0"只在"在线成员经单播补达"口径下成立；纯广播口径应单独报告。
- **去重窗口（SEEN_MAX=800）**：#2 的前提是单会话活跃 mid 不超过去重窗口；C4 专门压这个边界，若复现重复应作为风险上报而非直接判失败。
- **同机延迟仅作相对参考**：#4/#5 的 ms 阈值在单机回环偏乐观，真实多机 LAN 需重新标定基线。

---

## 附：执行前置与边界提醒
- 不压真实生产；全部在隔离的本地数据目录（如 `FREEDOM_DATA_DIR=test-data`）运行，避免污染 `data/`、`data-2/`。
- 单机 1000 节点需放宽进程 fd 上限；文件大场景需预留磁盘（F2 10×100MB≈1GB 源 + 落地）。
- 无头注入模式不覆盖真实 UDP 发现/presence 风暴，须靠 L2 小规模真实发现场景补足。
- 本方案仅设计，不含实现；脚本全部独立于 `electron/` 业务代码，零侵入。


