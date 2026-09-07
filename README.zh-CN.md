![PiDeck-Q](screenshots/0.png)

<h1 align="center">PiDeck-Q</h1>

<p align="center">
  <a href="README.md">English</a>
</p>

<p align="center">
  <strong>一款同时支持原版 <a href="https://pi.dev">Pi Agent</a> 与 Rust 后端 <a href="https://github.com/Dicklesworthstone/pi_agent_rust">Pi_Agent_Rust</a> 的桌面工作台，用于管理多个编码 Agent 会话。</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/status-experimental-orange" alt="Status: experimental" />
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="License: MIT" />
  <img src="https://img.shields.io/badge/Electron-38-47848f" alt="Electron 38" />
  <img src="https://img.shields.io/badge/React-19-61dafb" alt="React 19" />
  <img src="https://img.shields.io/badge/version-0.7.0-yellow" alt="Version 0.7.0" />
</p>

## 项目简介

PiDeck-Q 基于优秀的 [PiDeck](https://github.com/ayuayue/PiDeck) 项目开发。PiDeck 是 [Pi Agent](https://pi.dev) 的桌面 GUI；在此基础上，PiDeck-Q 采用 **原生C++/Qt 实现**，更加注重**轻量化**、**运行效率**、**交互流畅度**与**更好的上下文管理**。

由于 PiDeck-Q 的目标是坚持保持轻量化、专注于 Pi 与 Pi_Agent_Rust 生态（无意支持其他后端），因此自 2026 年 8 月 17 日起，PiDeck-Q 将不再同步上游的 commit。

## 主要特点

- 使用原生 **C++ 与 Qt** 实现，取代 Electron ，以减小体积并提升窗体与交互响应。
- 同时支持原版 [Pi Agent](https://pi.dev) 与 Rust 后端 [Pi_Agent_Rust](https://github.com/Dicklesworthstone/pi_agent_rust)。Pi_Agent_Rust 目前的功能成熟度暂不及原版 Pi Agent，但内存占用更低，运行也更加流畅。
- 移除了飞书机器人、桌面宠物等较少使用的功能，以减小应用体积和内存占用。
- 针对原生界面的响应速度与交互流畅度进行了大幅优化。
- 移除了遥测功能。
- 支持上下文中的工具调用与输出裁剪，以及类 Codex 的上下文压缩。

## 界面预览

![PiDeck-Q 会话工作区](screenshots/1.png)

![PiDeck-Q 项目与会话管理界面](screenshots/2.png)

## 开源许可

[MIT](LICENSE)
