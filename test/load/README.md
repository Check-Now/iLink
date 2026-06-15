# iLink 压测工具（test/load）

独立、零侵入的压测套件，复用 `electron/p2p.js`、`electron/filetransfer.js`、`electron/crypto.js`、`electron/vault.js`，**不修改任何业务代码**，可直接 `node` 运行（无需 Electron）。

## ⚠️ 先读：协议现实与字段缺失说明

本项目是**纯 P2P / 去中心化**架构，通用压测约定里的几项在这里**并不存在**，本套件做了忠实替代（对应需求"协议不完整请说明 / 无法实现请给替代方案"）：

| 通用约定 | 本项目现实 | 本套件的做法 |
|---|---|---|
| `serverUrl` 服务端地址 | 无中心服务端 | 占位字段，仅用于**生产环境保护**（见下） |
| `loginApi` 登录接口 | 本地 vault 解锁（scrypt+AES-GCM），无网络 | `loginTest` 可选做真实 vault setup/unlock 基准 |
| `wsUrl` WebSocket/TCP 地址 | UDP 广播(51888)+UDP 单播+TCP 文件 | 进程内实例化 P2P/FileTransfer 类，手动注入 peer |
| `serverAckCount` 服务端 ACK | 无服务端，ACK 是对端 UDP 回执 | 统计发送端收到的 `msg-status:delivered` |
| `dbPersistCount` 数据库落库 | 无 DB，本地加密单文件 store.enc | 以接收端去重后到达数作落库代理（已注明） |
| `main.js` 的离线发件箱编排 | 依赖 Electron，无法 headless 加载 | harness 用等价最小实现复刻 outboxDrain（底层仍调真实 p2p API） |

**群聊投递**：headless 注入模式下 UDP 广播不可达（节点不绑发现端口），故群消息走**可靠单播补达**路径（`sendRoomMember` + did ACK，即 app 对在线/离线成员的可靠投递路径）。纯广播 best-effort 段需真实多机发现模式，属本套件的已知不覆盖项。

## 目录
```
test/load/
  config.js          # 全部可配置参数（含环境变量覆盖）+ testRunId
  run.js             # 入口：编排所有场景并出报告
  cleanup.js         # 按 testRunId 清理测试数据
  lib/
    sim-client.js    # 模拟客户端（登录/连接/收发/ACK/断连重连/日志）
    harness.js       # 引擎（多节点工厂/全互联/心跳/离线发件箱/资源采样）
    scenarios.js     # 在线/单聊/群聊/重连/离线补发场景 + burst/sustained 加压
    files.js         # 文件并发传输 + 中断续传 + SHA-256 校验
    verify.js        # 一致性统计（丢失/重复/乱序/延迟）
    util.js          # 分位/CSV/资源采样
    report.js        # 7 类报告输出 + 通过标准评估
  results/<testRunId>/   # 报告输出
```

## 运行方式

### 1. 安装依赖
无需额外依赖（仅用 Node 内置模块 + 项目已有 electron 模块）。确保项目已 `npm install`（用到 electron 目录的源码，不需启动 Electron）。

### 2. 准备测试账号
自动生成，无需手工准备：每个模拟用户在内存中通过 `crypto.generateKeyPair()` 生成身份（id+X25519 密钥对）。如需真实 vault 登录基准：`ILINK_LT_LOGIN_TEST=1`。

### 3. 启动服务端
**不需要**。P2P 架构无独立服务端；本套件在单进程内实例化节点。

### 4. 启动压测
```bash
# 默认配置（20 用户 × 50 消息 + 群聊 + 重连 + 离线补发 + 文件）
node test/load/run.js

# 自定义（环境变量，前缀 ILINK_LT_）
ILINK_LT_USER_COUNT=100 ILINK_LT_MSG_PER_USER=50 ILINK_LT_SEND_MODE=burst node test/load/run.js
ILINK_LT_USER_COUNT=300 ILINK_LT_QPS=1000 ILINK_LT_RAMPUP_SEC=15 node test/load/run.js

# 只跑某些场景
ILINK_LT_SC_FILE=0 ILINK_LT_SC_RECONNECT=0 node test/load/run.js

# 文件并发
ILINK_LT_FILE_SENDERS=10 ILINK_LT_FILE_SIZE_MB=100 node test/load/run.js
```

### 5. 查看报告
`test/load/results/<testRunId>/`：
- `summary.json`：机器可读全量结果
- `final_report.md`：人读报告（环境/参数/场景/结论/各指标/是否通过/丢失/重复/乱序/延迟/资源/问题/复现/建议）
- `messages.csv`、`latency.csv`、`clients.csv`、`errors.log`、`file_transfer_report.csv`

## 逐步加压
`rampUpSeconds` 控制节点分批上线；`sendMode=sustained`+`qps` 控制持续恒定速率；`sendMode=burst` 全员同时发。默认不会一开始打满。

## 每条消息的探针字段
`testRunId / testMessageId(=业务 mid) / senderId / receiverId|groupId / sendIndex / clientSendTime / payloadSize / randomContent`，用于精确校验丢失、重复、乱序、延迟。

## 主要可配置参数（环境变量名 = ILINK_LT_ + 大写）
`USER_COUNT, MSG_PER_USER, GROUP_ID, GROUP_SIZE, CONCURRENCY, DURATION_SEC, RAMPUP_SEC, SEND_MODE(burst|sustained), QPS, SEND_INTERVAL_MS, PAYLOAD_SIZE`；场景开关 `SC_ONLINE/SC_PRIVATE/SC_GROUP/SC_RECONNECT/SC_OFFLINE/SC_FILE`；重连 `RC_RATIO/RC_COUNT/RC_DOWN_MS/RC_SIMULTANEOUS`；文件 `FILE_SENDERS/FILE_SIZE_MB/FILE_RESUME/FILE_SCOPE`；`LOGIN_TEST/LOGIN_ACCOUNTS`；`OUTPUT_DIR/TEST_DATA_DIR/RUN_ID/VERBOSE`。

## 九、安全限制
1. **默认仅本机/内网**。`run.js` 启动即检查 `serverUrl`：若形似生产地址（非 localhost/127/10./192.168./172.16-31.），**拒绝运行**。
2. 确属测试环境才放行：`ILINK_LT_CONFIRM_PROD=1`。
3. 不触碰任何业务数据：测试 vault/临时文件写入隔离目录 `TEST_DATA_DIR`（默认 `test/load/.testdata`），绝不写 `data/`、`data-2/`。
4. 所有产物带 `testRunId`，便于清理。
5. **清理测试数据**：
```bash
node test/load/cleanup.js              # 列出可清理的 testRunId
node test/load/cleanup.js <testRunId>  # 清理指定 run（报告/测试数据/残留 .part）
node test/load/cleanup.js --all        # 清理全部 LT-* 产物
```

## 已知限制
- 单机进程内可上千节点，但 **UDP 广播发现 / presence 风暴 / 真实带宽** 不在覆盖范围（需真实多机环境）。
- 延迟为单机回环测得，偏乐观；真实多机 LAN 需重新标定基线。
- 乱序按设计无法保证为 0（协议无序号），按实测量化而非硬判。
