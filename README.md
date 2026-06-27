# iLink

> Windows 局域网 P2P 加密通讯工具，支持私聊、群聊、文件传输和绿色版迁移。  
> A Windows LAN P2P encrypted messenger with private chat, group chat, file transfer, and portable data migration.

## 中文

### 简介

iLink 是一个 Windows Electron 桌面应用。它没有中心化聊天服务器，Electron 主进程负责本地存储、局域网发现、P2P 消息和文件传输，React 渲染进程负责界面。

应用数据默认写入本地 `data` 目录；打包后的绿色版会在 `iLink.exe` 同级目录创建 `data`，因此整目录复制到其他电脑或 U 盘后可以继续使用原数据。

### 核心功能

- 局域网内 P2P 在线发现
- 私聊、群聊、消息撤回、离线待发
- TCP 直连文件传输、断点续传和 SHA-256 校验
- 主密码加密本地数据，业务数据写入 `data/store.enc`
- 截图、表情包、托盘通知和本地设置
- Windows zip 绿色版打包，输出 `release/Freedom.zip`

### 技术栈

- Electron 30, Node.js, Electron IPC
- React 18, Vite 5, Tailwind CSS
- UDP 局域网发现，TCP 文件传输
- scrypt, X25519, HKDF-SHA256, AES-256-GCM
- Node.js 内置 `node:test`

### 快速开始

```powershell
npm install
npm run dev
```

第二个本机测试实例使用独立数据目录：

```powershell
npm run dev:second
```

### 构建与打包

```powershell
npm test
npm run build
npm run dist
```

`npm run dist` 会生成 Windows 绿色版 zip：

```text
release/Freedom.zip
```

### 数据目录

- 开发环境：`./data`
- 第二实例：`./data-2`
- 打包环境：`iLink.exe` 同级的 `./data`

这些目录包含账号、加密存储和日志，不应提交到 Git。

### 项目结构

```text
electron/     Electron 主进程、本地存储、P2P、文件传输、托盘等逻辑
src/          React 渲染进程
test/         node:test 单元测试
project_md/   项目上下文和模块文档
dist/         Vite 构建产物，不提交
release/      electron-builder 产物，不提交
data/         本地运行数据，不提交
```

### 安全说明

iLink 的本地业务数据经过主密码派生密钥加密后写入磁盘。请不要提交 `data/`、`data-2/`、日志、个人账号数据或生产配置。收到可执行文件时，应用会在打开前提示风险。

### 许可证

本项目使用 MIT License，详见 [LICENSE](LICENSE)。

## English

### Overview

iLink is a Windows Electron desktop application. It does not use a central chat server. The Electron main process handles local storage, LAN discovery, P2P messaging, and file transfer, while the React renderer handles the user interface.

Runtime data is stored in the local `data` directory. In the packaged portable build, `data` is created next to `iLink.exe`, so the whole folder can be copied to another PC or USB drive without losing the local account data.

### Features

- LAN peer discovery
- Private chat, group chat, message recall, and offline outbox
- Direct TCP file transfer with resume support and SHA-256 verification
- Master-password encrypted local storage in `data/store.enc`
- Screenshot capture, stickers, tray notifications, and local settings
- Windows portable zip packaging as `release/Freedom.zip`

### Tech Stack

- Electron 30, Node.js, Electron IPC
- React 18, Vite 5, Tailwind CSS
- UDP LAN discovery and TCP file transfer
- scrypt, X25519, HKDF-SHA256, AES-256-GCM
- Node.js built-in `node:test`

### Quick Start

```powershell
npm install
npm run dev
```

Run a second local test instance with a separate data directory:

```powershell
npm run dev:second
```

### Build and Package

```powershell
npm test
npm run build
npm run dist
```

`npm run dist` creates the Windows portable zip:

```text
release/Freedom.zip
```

### Data Directory

- Development: `./data`
- Second instance: `./data-2`
- Packaged app: `./data` next to `iLink.exe`

These folders contain account data, encrypted storage, and logs. They must not be committed to Git.

### Project Structure

```text
electron/     Electron main process, local storage, P2P, file transfer, tray logic
src/          React renderer process
test/         node:test unit tests
project_md/   Project context and module notes
dist/         Vite build output, ignored
release/      electron-builder output, ignored
data/         Local runtime data, ignored
```

### Security

iLink encrypts local business data on disk with a key derived from the master password. Do not commit `data/`, `data-2/`, logs, personal account data, or production configuration. The app warns before opening received executable files.

### License

This project is released under the MIT License. See [LICENSE](LICENSE).
