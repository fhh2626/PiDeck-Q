![PiDeck-Q](screenshots/0.png)

<h1 align="center">PiDeck-Q</h1>

<p align="center">
  <a href="README.zh-CN.md">中文文档</a>
</p>

<p align="center">
  <strong>A desktop workbench for managing multiple coding-agent sessions with the original <a href="https://pi.dev">Pi Agent</a> and <a href="https://github.com/opensec-git/Pi-Bolt">Pi-Bolt</a>.</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/status-experimental-orange" alt="Status: experimental" />
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="License: MIT" />
  <img src="https://img.shields.io/badge/Qt-6-41cd52" alt="Qt 6" />
  <img src="https://img.shields.io/badge/React-19-61dafb" alt="React 19" />
  <img src="https://img.shields.io/badge/version-0.5.0-yellow" alt="Version 0.5.0" />
</p>

## Overview

PiDeck-Q is based on the excellent [PiDeck](https://github.com/ayuayue/PiDeck) project, a desktop GUI for [Pi Agent](https://pi.dev). Building on that foundation, PiDeck-Q ships a **native C++/Qt** desktop host and places greater emphasis on a **lightweight footprint**, **runtime efficiency**, **responsive interactions**, and **better context management**.

PiDeck-Q focuses on a lightweight desktop for the original Pi Agent and Pi-Bolt. It stopped syncing upstream commits on August 17, 2026 to maintain that focus.

## Highlights

- Native desktop host implemented in **C++ and Qt**, replacing a full Electron shell for a smaller footprint and more responsive windowing.
- Ships a **native C++ business backend** beside the Qt host, so the portable package bundles no Node.js runtime of its own; Node.js is used for frontend builds, extension resource bundling and automated tests, while the built-in TypeScript extensions run on the agent runtime's own Node. The coding agent runtime (Pi Agent / Pi-Bolt) remains an external dependency that PiDeck-Q launches.
- Supports the original [Pi Agent](https://pi.dev) and [Pi-Bolt](https://github.com/opensec-git/Pi-Bolt), its precompiled RPC-compatible distribution. Select Pi-Bolt under Settings → Developer → Pi Runtime Preference, or set a custom Pi path to its executable in auto mode.
- Removes less commonly used features, such as the Feishu bot and desktop pet, to reduce application size and memory usage.
- Significantly improves the responsiveness and interaction performance of the native interface.
- Removes telemetry.
- Supports in-context tool trimming and Codex-like context compression.

## Screenshots

![PiDeck-Q conversation workspace](screenshots/1.png)

![PiDeck-Q project and session management](screenshots/2.png)


## Session navigation

Select Agent sessions in the project sidebar. Sessions remain in their projects, without a separate open-session tab list, preview mode or pin state. Drag a sidebar session to a conversation edge to split the view, or into the center of an existing pane to replace it. Each pane owns its stop and restart controls. File editors and terminals retain their own tabs.

## License

[MIT](LICENSE)
