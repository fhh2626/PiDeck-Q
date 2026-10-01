# 开发与打包

<script setup>
import { useData } from 'vitepress'
const { theme } = useData()
</script>

当前版本：**{{ theme.version }}**，由仓库根 `package.json` 提供。

## 环境与入口

- Node.js **24.19.0**、npm **11+**、Git、xmake。
- C++20 编译工具链；Windows 使用 MSVC。
- Xmake 配置使用 Qt **6.11.2** 和 Node runtime **24.19.0** 的本地 package 定义。
- Windows 运行桌面窗口需要 **WebView2 Runtime**。
- 使用真实 Agent 需安装 Pi Agent 或 Pi_Agent_Rust，并配置模型与认证。

当前原生 SDK 与 staging 流程以 Windows 为主。代码有 macOS/Linux 分支，不代表这些平台已有经过验证的完整安装包。

```bash
git clone https://github.com/fhh2626/PiDeck-Q.git
cd PiDeck-Q
npm install
npm run make-icon
npm run dev
```

`dev` 构建 renderer、Sidecar 和原生 debug 目标，再运行 `release/win-unpacked/PiDeck-Q.exe`；不是 Electron，也不承诺所有进程自动热重载。

## 代码结构与通信

| 路径 | 职责 |
| --- | --- |
| `native/src/main.cpp` | Qt6/QtWebView 宿主入口 |
| `src/native-node/index.ts` | Node Sidecar 装配入口 |
| `src/main/backend/createBackend.ts` | 业务服务装配 |
| `src/main/backend/registerBackendRpc.ts` | 按域注册 IPC |
| `src/main/` | 会话、pi 进程、Git、设置、终端等领域 |
| `src/shared/` | IPC 名称、类型、桌面 API 契约 |
| `src/renderer/` | React/Jotai 前端与 Web 前端 |

Qt ↔ Sidecar 使用本地 TCP 长度前缀 JSON；renderer ↔ Sidecar 使用环回 HTTP RPC + SSE；只有 Sidecar ↔ pi 使用 stdio JSONL RPC。不存在当前 preload/WebChannel 入口。

## 实际命令

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 原生 Windows debug 构建与启动 |
| `npm run typecheck` | TypeScript 与浏览器测试类型检查 |
| `npm test` | 全量单测（替身，不要求真实 pi） |
| `npm run test:browser` | Playwright 浏览器回归 |
| `npm run build` | 类型检查、renderer 和 Sidecar 构建 |
| `npm run build:native` | Xmake 原生构建 |
| `npm run pack` | 构建并校验 Windows staging 目录 |
| `npm run dist:win` | Windows staging 与宿主 RPC 验证；安装器编译目前关闭 |
| `npm run test:native-host-rpc` | 原生宿主 RPC 集成验证 |
| `npm run test:native-gui` | 原生 GUI 集成验证 |
| `npm run docs:dev` | VitePress 开发服务 |
| `npm run docs:build` | 文档构建与内部链接检查 |
| `npm run docs:preview` | 预览文档产物 |

当前没有 `npm run dist`、`dist:mac`、`dist:linux` 或 `preview`。桌面 staging 由 Xmake 与 `scripts/stage-native-runtime.mjs` 完成，包含 Qt、Node、renderer、Sidecar 和资源，不使用 electron-builder/asar。

## 官网与贡献

VitePress 源码位于 `docs-site/`。部署根路径由 `VITEPRESS_BASE` 控制，站点 origin 由 `DOCS_SITE_ORIGIN` 控制，`public/CNAME` 保存自定义域名。

当前版本展示跟随 manifest；上游历史记录单独标注。贡献遵循仓库根 `AGENTS.md` 的依赖边界、测试门禁与提交授权规则。
