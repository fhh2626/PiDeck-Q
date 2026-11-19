![PiDeck-Q](screenshots/0.png)

<h1 align="center">PiDeck-Q</h1>

<p align="center">
  <a href="README.md">English</a>
</p>

<p align="center">
  <strong>一款面向 Pi 系编码 Agent 的桌面工作台，支持原版 <a href="https://pi.dev">Pi Agent</a> 与 <a href="https://github.com/opensec-git/Pi-Bolt">Pi-Bolt</a>，用于管理多个编码 Agent 会话。</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/status-experimental-orange" alt="Status: experimental" />
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="License: MIT" />
  <img src="https://img.shields.io/badge/Qt-6-41cd52" alt="Qt 6" />
  <img src="https://img.shields.io/badge/React-19-61dafb" alt="React 19" />
  <img src="https://img.shields.io/badge/version-0.5.0-yellow" alt="Version 0.5.0" />
</p>

## 项目简介

PiDeck-Q 基于优秀的 [PiDeck](https://github.com/ayuayue/PiDeck) 项目开发。PiDeck 是 [Pi Agent](https://pi.dev) 的桌面 GUI；在此基础上，PiDeck-Q 采用 **原生C++/Qt 实现**，更加注重**轻量化**、**运行效率**、**交互流畅度**与**更好的上下文管理**。

PiDeck-Q 专注于为原版 Pi Agent 与 Pi-Bolt 提供轻量化桌面工作台。为保持这一方向，自 2026 年 8 月 17 日起，PiDeck-Q 不再同步上游的 commit。

## 主要特点

- 使用原生 **C++ 与 Qt** 实现，取代 Electron ，以减小体积并提升窗体与交互响应。
- 包内附带**原生 C++ 业务后端**（`PiDeckBackend`），因此便携包不再打包自己的 Node.js 运行时；Node.js 用于前端构建、扩展资源打包和自动化测试，内置 TypeScript 扩展跑在 Agent 运行时自带的 Node 上。编码 Agent 运行时（Pi Agent / Pi-Bolt）仍是 PiDeck-Q 拉起的外部依赖。
- 支持原版 [Pi Agent](https://pi.dev) 和 [Pi-Bolt](https://github.com/opensec-git/Pi-Bolt)。Pi-Bolt 是原版 Pi Agent 的预编译发行版，与原版 RPC 兼容。可在「设置 → 开发设置 → Pi 运行时偏好」中选择 Pi-Bolt，也可以在自动模式中将自定义 Pi 路径指向它的可执行文件。
- 移除了飞书机器人、桌面宠物等较少使用的功能，以减小应用体积和内存占用。
- 针对原生界面的响应速度与交互流畅度进行了大幅优化。
- 移除了遥测功能。
- 支持上下文中的工具调用与输出裁剪，以及类 Codex 的上下文压缩。

## 界面预览

![PiDeck-Q 会话工作区](screenshots/1.png)

![PiDeck-Q 项目与会话管理界面](screenshots/2.png)


## 会话导航

通过左侧项目树选择 Agent 会话。会话保留在所属项目中，不再提供会话标签、预览或固定模式。将左侧会话拖到对话面板边缘即可分屏，拖到分屏中心可替换该面板。停止和重启操作位于各会话面板中。文件编辑器和终端保留自己的标签。

## 开源许可

[MIT](LICENSE)
