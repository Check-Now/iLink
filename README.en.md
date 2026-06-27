<div align="center">

# iLink

**Private LAN messaging and file transfer for Windows. No server required.**

iLink helps people on the same local network chat, send files, and carry their data with a portable Windows build.

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Platform: Windows](https://img.shields.io/badge/Platform-Windows-blue.svg)](#download)
[![Release](https://img.shields.io/github/v/release/Check-Now/iLink?label=release)](https://github.com/Check-Now/iLink/releases)

[Download](#download) · [Features](#features) · [How It Works](#how-it-works) · [Build from Source](#build-from-source) · [简体中文](README.md)

</div>

---

## Download

The current public build is a portable Windows zip:

[Download Freedom.zip](https://github.com/Check-Now/iLink/releases/download/v0.0.0/Freedom.zip)

Use it like a normal portable app:

1. Download `Freedom.zip`.
2. Extract it anywhere, including a USB drive.
3. Double-click `iLink.exe`.
4. Keep the generated `data` folder together with the app if you move it.

No installer is required. The packaged app stores its runtime data next to `iLink.exe` in `./data`.

## What Is iLink?

iLink is a Windows desktop app for private communication inside a local network. It is useful when people are in the same office, classroom, lab, home network, or temporary working space and want a simple way to exchange messages and files without setting up a chat server.

It is built as a local-first Electron app:

- no central chat server
- no cloud account
- LAN peer discovery
- direct encrypted messaging between peers
- local encrypted storage
- portable data migration by copying the app folder

## Features

- **Private chats** for one-to-one conversations on the same LAN.
- **Group chats** with member management and group messages.
- **File transfer** over direct TCP connections, with resume support and SHA-256 verification.
- **Offline outbox** for messages and files that should be retried when a peer comes back online.
- **Local data vault** encrypted with a master password.
- **Screenshots, stickers, tray notifications, and local settings** for daily desktop use.
- **Portable Windows build**: move the app and `data` folder together to keep using the same local account.

## How It Works

iLink does not route chat through a hosted service. Each app instance runs its own local backend inside the Electron main process.

```text
Windows PC A                    Windows PC B
-----------                     -----------
iLink.exe                       iLink.exe
./data                          ./data
    |                               |
    |  LAN discovery over UDP       |
    |<----------------------------->|
    |  encrypted messages/files     |
    |<----------------------------->|
```

The app uses UDP for local peer discovery and direct TCP connections for file transfer. Local business data is saved under `data/`; encrypted chat data is stored in `data/store.enc`.

## Data and Portability

| Environment | Data location |
| --- | --- |
| Development | `./data` |
| Second local test instance | `./data-2` |
| Packaged app | `./data` next to `iLink.exe` |

To move iLink to another computer or USB drive, copy the whole extracted folder, including `data/`. Do not copy only `iLink.exe`.

## Security Notes

iLink encrypts local business data with a key derived from the master password. P2P messages use X25519 key agreement, HKDF-SHA256, and AES-256-GCM in the current implementation.

Important limits:

- iLink has not received an independent security audit.
- It is designed for trusted local networks, not anonymous internet messaging.
- Anyone with access to your `data` folder and master password can open your local account.
- Do not publish `data/`, `data-2/`, logs, private keys, account files, or production configuration.
- The app warns before opening received executable files.

## Build from Source

Requirements:

- Windows
- Node.js and npm
- Git

Install dependencies and start the development app:

```powershell
npm install
npm run dev
```

Run a second local instance for same-machine peer testing:

```powershell
npm run dev:second
```

Run tests and build the app:

```powershell
npm test
npm run build
```

Create the portable Windows package:

```powershell
npm run dist
```

The package is written to:

```text
release/Freedom.zip
```

## Project Structure

```text
electron/      Electron main process: windows, IPC, storage, P2P, file transfer
src/           React renderer UI
test/          node:test unit tests
project_md/    Project notes and module documentation
build/         Build-only assets such as the packaged app icon
dist/          Vite output, ignored by Git
release/       electron-builder output, ignored by Git
data/          Local runtime data, ignored by Git
```

## FAQ

### Does iLink need the internet?

No. It is meant for devices on the same local network. Internet access is not required for peer discovery or local file transfer.

### Can I use it across different networks?

Not currently. iLink is designed around LAN discovery and direct local connections.

### Is there a mobile app?

No. The current public build targets Windows desktop.

### Where is my data?

In the `data` folder. In the portable package, it is next to `iLink.exe`.

### Can I delete `data`?

Only if you want to reset the local account and remove local messages, settings, and stored state.

## Roadmap

- Better first-run guidance for non-technical users.
- More complete Windows multi-machine testing notes.
- Optional screenshots and a short usage guide.
- CI once the project settles on a stable release workflow.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Keep changes focused, and run tests before opening a pull request.

## License

iLink is released under the [MIT License](LICENSE).
