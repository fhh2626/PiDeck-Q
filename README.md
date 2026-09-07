![PiDeck-Q](screenshots/0.png)

<h1 align="center">PiDeck-Q</h1>

<p align="center">
  <a href="README.zh-CN.md">中文文档</a>
</p>

<p align="center">
  <strong>A desktop workbench supporting both the original <a href="https://pi.dev">Pi Agent</a> and the Rust-based <a href="https://github.com/Dicklesworthstone/pi_agent_rust">Pi_Agent_Rust</a>, designed for managing multiple coding-agent sessions.</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/status-experimental-orange" alt="Status: experimental" />
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="License: MIT" />
  <img src="https://img.shields.io/badge/Electron-38-47848f" alt="Electron 38" />
  <img src="https://img.shields.io/badge/React-19-61dafb" alt="React 19" />
  <img src="https://img.shields.io/badge/version-0.7.0-yellow" alt="Version 0.7.0" />
</p>

## Overview

PiDeck-Q is based on the excellent [PiDeck](https://github.com/ayuayue/PiDeck) project, a desktop GUI for [Pi Agent](https://pi.dev). Building on that foundation, PiDeck-Q ships a **native C++/Qt** desktop host and places greater emphasis on a **lightweight footprint**, **runtime efficiency**, **responsive interactions**, and **better context management**.

As PiDeck-Q aims to remain lightweight and focus dedicatedly on the Pi and Pi_Agent_Rust ecosystem (with no plans to support other backends), PiDeck-Q will no longer sync upstream commits starting from August 17, 2026.

## Highlights

- Native desktop host implemented in **C++ and Qt**, replacing a full Electron shell for a smaller footprint and more responsive windowing.
- Supports both the original [Pi Agent](https://pi.dev) and the Rust-based [Pi_Agent_Rust](https://github.com/Dicklesworthstone/pi_agent_rust). Pi_Agent_Rust is currently less mature than the original Pi Agent, but uses less memory and delivers a smoother experience.
- Removes less commonly used features, such as the Feishu bot and desktop pet, to reduce application size and memory usage.
- Significantly improves the responsiveness and interaction performance of the native interface.
- Removes telemetry.
- Supports in-context tool trimming and Codex-like context compression.

## Screenshots

![PiDeck-Q conversation workspace](screenshots/1.png)

![PiDeck-Q project and session management](screenshots/2.png)

## License

[MIT](LICENSE)
