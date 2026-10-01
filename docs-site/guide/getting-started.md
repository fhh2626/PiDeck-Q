# 快速开始

<script setup>
import { useData } from 'vitepress'
const { theme } = useData()
</script>

当前 PiDeck-Q 版本：**{{ theme.version }}**。

PiDeck-Q 同时支持 [Pi Agent](https://pi.dev) 和 [Pi_Agent_Rust](https://github.com/Dicklesworthstone/pi_agent_rust)。桌面应用管理窗口、项目与会话，Agent 能力仍由运行时提供。

## 下载安装

从 [GitHub Releases](https://github.com/fhh2626/PiDeck-Q/releases) 查看实际发布的文件与平台说明，不假定每个版本都有安装器或所有平台产物。当前仓库的 staging 流程以 Windows 为主，安装器编译暂时关闭。

Windows 桌面运行需要 WebView2 Runtime。macOS/Linux 的源码分支不能视作经过验证的安装包。

先按运行时官方文档安装 Pi Agent 或 Pi_Agent_Rust，配置 Provider/认证。验证对应命令（Rust 命令可能为 `pi-rust`）：

```bash
pi --version
```

首次启动会检测 Agent 路径；检测失败时在设置中填写所选运行时的可执行文件路径。

## 从源码运行

需要 Node.js **24.19.0**、npm **11+**、Git、xmake、C++20/MSVC 工具链；Qt **6.11.2** 由本地 Xmake package 定义提供。详见 [开发与打包](/guide/development)。

```bash
git clone https://github.com/fhh2626/PiDeck-Q.git
cd PiDeck-Q
npm install
npm run make-icon
npm run dev
```

当前 `dev` 流程面向 Windows 原生桌面，不是 Electron。

## 基本工作流

1. 添加本地项目目录。
2. 创建会话，选择模型与思考等级。
3. 发送任务，或使用 `/`、`@`、`!` 输入辅助。
4. 查看历史、文件、Git 和终端。

## 普通浏览器 UI 预览

```bash
npm run test:browser:server
```

这是浏览器测试/界面预览服务，不是内置浏览器面板；模拟接口不能证明真实 Agent、文件或宿主功能可用。真实桌面行为需在原生宿主下验证。

局域网 Web 前端是另一项能力，可在设置中开启 Web 服务；它不是桌面里的浏览器面板。服务包含认证 token，默认关闭，不应无保护地暴露到公网。
