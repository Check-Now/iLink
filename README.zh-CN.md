<div align="center">

# iLink

**面向 Windows 的局域网私密聊天与文件传输工具，不需要中心服务器。**

iLink 适合办公室、教室、实验室、家庭网络等同一局域网场景，用来聊天、传文件，并通过绿色版随身携带本地数据。

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Platform: Windows](https://img.shields.io/badge/Platform-Windows-blue.svg)](#下载)
[![Release](https://img.shields.io/github/v/release/Check-Now/iLink?label=release)](https://github.com/Check-Now/iLink/releases)

[下载](#下载) · [功能](#功能) · [工作方式](#工作方式) · [从源码构建](#从源码构建) · [English](README.md)

</div>

---

## 下载

当前公开版本是 Windows 绿色版 zip：

[下载 Freedom.zip](https://github.com/Check-Now/iLink/releases/download/v0.0.0/Freedom.zip)

使用方式：

1. 下载 `Freedom.zip`。
2. 解压到任意位置，也可以放在 U 盘里。
3. 双击 `iLink.exe`。
4. 如果要迁移到另一台电脑，请把整个解压目录一起复制，尤其不要漏掉 `data` 文件夹。

不需要安装程序。打包后的应用会把运行数据写在 `iLink.exe` 同级的 `./data`。

## iLink 是什么？

iLink 是一个 Windows 桌面应用，用于同一局域网内的私密沟通。它适合不想搭建聊天服务器、又希望在本地网络中快速交换消息和文件的人。

它是一个本地优先的 Electron 应用：

- 没有中心聊天服务器
- 不需要云端账号
- 局域网内自动发现在线设备
- 设备之间直接加密通信
- 本地数据加密保存
- 复制应用目录即可迁移绿色版数据

## 功能

- **私聊**：在同一局域网内进行一对一聊天。
- **群聊**：支持群成员管理和群消息。
- **文件传输**：通过 TCP 直连传输，支持断点续传和 SHA-256 校验。
- **离线发件箱**：对方重新在线后，待发送消息和文件会继续尝试补发。
- **本地数据保险箱**：使用主密码加密本地业务数据。
- **截图、表情包、托盘通知和本地设置**：覆盖日常桌面使用。
- **Windows 绿色版**：应用目录和 `data` 文件夹一起移动，即可保留同一份本地账号数据。

## 工作方式

iLink 不把聊天内容转发到托管服务器。每个应用实例都在 Electron 主进程里运行自己的本地后端。

```text
Windows 电脑 A                  Windows 电脑 B
-------------                   -------------
iLink.exe                       iLink.exe
./data                          ./data
    |                               |
    |  通过 UDP 做局域网发现        |
    |<----------------------------->|
    |  直接交换加密消息和文件       |
    |<----------------------------->|
```

应用使用 UDP 做局域网发现，使用 TCP 直连传输文件。本地业务数据写入 `data/`，加密聊天数据保存在 `data/store.enc`。

## 数据与迁移

| 环境 | 数据位置 |
| --- | --- |
| 开发环境 | `./data` |
| 第二个本机测试实例 | `./data-2` |
| 打包后的绿色版 | `iLink.exe` 同级的 `./data` |

如果要迁移到另一台电脑或 U 盘，请复制整个解压目录，包括 `data/`。只复制 `iLink.exe` 不会带走本地账号和消息数据。

## 安全说明

iLink 会用主密码派生出的密钥加密本地业务数据。当前实现中的 P2P 消息使用 X25519、HKDF-SHA256 和 AES-256-GCM。

需要明确的边界：

- iLink 尚未经过第三方安全审计。
- 它面向可信局域网，不是匿名互联网聊天工具。
- 拿到 `data` 文件夹并知道主密码的人，可以打开本地账号数据。
- 不要公开提交 `data/`、`data-2/`、日志、私钥、账号文件或生产配置。
- 收到可执行文件时，应用会在打开前提示风险。

## 从源码构建

要求：

- Windows
- Node.js 和 npm
- Git

安装依赖并启动开发环境：

```powershell
npm install
npm run dev
```

启动第二个本机实例，用于在同一台电脑上模拟两个节点：

```powershell
npm run dev:second
```

运行测试和构建：

```powershell
npm test
npm run build
```

生成 Windows 绿色版：

```powershell
npm run dist
```

产物位置：

```text
release/Freedom.zip
```

## 项目结构

```text
electron/      Electron 主进程：窗口、IPC、本地存储、P2P、文件传输
src/           React 渲染进程界面
test/          node:test 单元测试
project_md/    项目说明和模块文档
build/         构建用资源，例如打包图标
dist/          Vite 构建产物，不提交到 Git
release/       electron-builder 产物，不提交到 Git
data/          本地运行数据，不提交到 Git
```

## 常见问题

### iLink 需要互联网吗？

不需要。它面向同一局域网内的设备，发现设备和传输文件都不依赖互联网。

### 可以跨不同网络使用吗？

当前不支持。iLink 的设计基于局域网发现和本地直连。

### 有手机端吗？

没有。当前公开版本面向 Windows 桌面端。

### 我的数据在哪里？

在 `data` 文件夹里。绿色版中，它位于 `iLink.exe` 同级目录。

### 可以删除 `data` 吗？

只有在你想重置本地账号，并删除本地消息、设置和状态时才应该删除。

## 路线图

- 面向普通用户的新手引导。
- 更完整的 Windows 多机测试说明。
- 真实截图和简短使用指南。
- 在发布流程稳定后补充 CI。

## 贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。请保持改动聚焦，提交前先运行测试。

## 许可证

iLink 使用 [MIT License](LICENSE)。
