# 认证模块说明

## 模块定位
认证模块负责应用首次初始化、密码解锁、修改密码、锁定、重置身份，以及解锁后启动 P2P 网络和加载用户设置。

认证是本地认证，不依赖远程服务器。密码不会发送到网络。

## 相关文件
- `electron/vault.js`：账户文件、主密码 KDF、本地加密存储、解锁状态。
- `electron/main.js`：`auth:*` IPC、解锁后启动 P2P、锁定时停止 P2P。
- `electron/preload.js`：暴露 `api.auth`。
- `src/App.jsx`：`SetupScreen`、`UnlockScreen`、设置中的改密/锁定/重置入口。

## 数据文件
- `data/account.json`：非敏感账户元数据，包含 KDF 参数、salt、verifier。
- `data/store.enc`：加密后的业务数据，包含身份、私钥、消息历史、联系人、群组、设置等。

开发环境默认使用 `data`。第二实例通过 `FREEDOM_DATA_DIR=data-2` 使用独立数据目录。

## 首次设置流程
1. 渲染进程调用 `api.auth.status()`。
2. 如果 `Vault.exists()` 为 false，状态为 `setup`。
3. 用户输入新密码，调用 `api.auth.setup(pw)`。
4. `Vault.setup()`：
   - 校验密码长度至少 4 位。
   - 生成 salt。
   - 使用 scrypt 派生 32 字节主密钥。
   - 写入 `account.json`。
   - 初始化身份 ID、昵称、X25519 密钥对和默认数据结构。
   - 加密写入 `store.enc`。
5. `main.js` 调用 `startP2P()`，并应用运行设置。

## 解锁流程
1. 状态为 `locked` 时，用户输入密码。
2. `api.auth.unlock(pw)` 调用 `Vault.unlock()`。
3. `Vault` 读取 `account.json`，用同样 KDF 派生密钥。
4. 解密 verifier 并比对 `FREEDOM_VAULT_OK`。
5. 解密 `store.enc` 并通过 `_ensureFields()` 补齐字段。
6. 如果配置了历史保留天数，会执行 `pruneHistory(retentionDays)`。
7. `main.js` 启动 P2P 和文件传输。

## 锁定流程
1. `api.auth.lock()` 调用 `auth:lock`。
2. 主进程关闭独立聊天窗口。
3. `stopP2P()` 停止 UDP、TCP 和相关定时器。
4. `Vault.lock()` flush 数据后清空内存中的主密钥和业务数据。

## 修改密码流程
1. 用户在设置面板输入旧密码和新密码。
2. `Vault.changePassword(oldPw, newPw)` 用旧密码验证 verifier。
3. 生成新 salt 和新主密钥。
4. 重写 `account.json`。
5. 用新密钥重写 `store.enc`。

## 重置身份流程
1. `api.auth.resetIdentity()` 调用 `auth:resetIdentity`。
2. 主进程关闭聊天窗口并停止 P2P。
3. `Vault.reset()` 删除 `account.json` 和 `store.enc`。
4. 下次进入 `setup` 状态。

## 安全边界
- 主密码只用于本地解锁。
- X25519 私钥保存在 `store.enc` 中，受主密码保护。
- `account.json` 不包含业务数据和私钥。
- 锁定时应停止网络，避免锁屏后继续处理聊天。
- 日志不应记录密码、私钥或消息正文。

## 设置联动
解锁或设置变更后，`main.js` 会通过 `applyRuntimeSettings()` 应用：
- 最小化到托盘
- 通知开关和通知预览
- 关闭行为
- 开机启动
- 免打扰状态
- 在线状态和状态文本
- UDP 端口和广播地址变更时重启 P2P

## 影响范围提示
- 改 `Vault._ensureFields()`：影响旧数据迁移和默认值。
- 改 `Vault.setup()` / `unlock()`：影响登录、数据解密和 P2P 启动前置条件。
- 改 `auth:*` IPC：影响登录页、设置页和锁定/重置流程。
- 改数据目录解析：影响开发双开和生产数据落盘位置。

## 建议验证
- 新数据目录首次设置。
- 正确密码解锁。
- 错误密码失败。
- 修改密码后旧密码不能解锁，新密码可以。
- 锁定后 P2P 停止，重新解锁后恢复。
- 重置后状态回到 `setup`。
