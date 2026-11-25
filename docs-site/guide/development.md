# 开发与打包

<script setup>
import { useData } from 'vitepress'
const { theme } = useData()
</script>

当前版本：**{{ theme.version }}**，由仓库根 `package.json` 提供。

## 环境与入口

- Node.js **24.19.0**、npm **11+**、Git、xmake。
- C++20 编译工具链；Windows 使用 MSVC。
- Xmake 使用 Qt **6.11.2** 的本地 package 定义。Node.js **24.19.0** 仅作为构建和测试工具。
- Windows 运行桌面窗口需要 **WebView2 Runtime**。
- 使用真实 Agent 需安装 Pi Agent 或 Pi-Bolt，并配置模型与认证。

当前原生 SDK 与 staging 流程以 Windows 为主。代码有 macOS/Linux 分支，不代表这些平台已有经过验证的完整安装包。

```bash
git clone https://github.com/fhh2626/PiDeck-Q.git
cd PiDeck-Q
npm install
npm run make-icon
npm run dev
```

`dev` 构建 renderer、扩展资源和原生 debug 目标，再运行 `release/win-unpacked/PiDeck-Q.exe`；不是 Electron，也不承诺所有进程自动热重载。

## 代码结构与通信

| 路径 | 职责 |
| --- | --- |
| `native/src/main.cpp` | Qt6/QtWebView 宿主入口 |
| `native/backend/` | 原生 C++ 业务后端（`PiDeckBackend.exe`，随包的 sidecar） |
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
| `npm run pack` | 构建并校验 Windows staging 目录（默认 `release/win-unpacked`；设 `PIDECK_STAGE_DIR` 可落到隔离的测量目录） |
| `npm run dist:win` | Windows staging 与宿主 RPC 验证；安装器编译目前关闭 |
| `npm run test:native-host-rpc` | 原生宿主 RPC 集成验证 |
| `npm run test:native-gui` | 原生 GUI 集成验证 |
| `npm run docs:dev` | VitePress 开发服务 |
| `npm run docs:build` | 文档构建与内部链接检查 |
| `npm run docs:preview` | 预览文档产物 |

桌面 staging 由 Xmake 与 `scripts/stage-extension-dependencies.mjs` 完成，包含 Qt、renderer、扩展资源和 C++ 后端。`npm run pack` 和 `scripts/verify-pack-stage.mjs` 使用同一 `PIDECK_STAGE_DIR`，默认目录是 `release/win-unpacked`。安装包不包含 Node 业务后端或 Node 解释器。

## 通过 GitHub Actions 发布 Windows ZIP

工作流合入默认分支 `main` 后，进入 **Actions → Release Windows ZIP → Run workflow**。从 `main` 或已包含工作流的 `native2` 构建预览时，保持 `publish` 未勾选。ZIP 保存到该次运行的 Artifacts，不创建标签或 Release。

预览先运行 `npm test`，再运行 `npm run pack`。版本来自所选提交的 `package.json`。如果该版本已有标签或 Release，就在同一版本系列的最大编号上递增，例如从 `0.5.1` 到 `0.5.1.1`。后缀用于发布标签、`PiDeck-Q-<版本>-win.zip` 和原生版本号，仓库的 manifest 和锁文件保持不变。验证包时，在装有 WebView2 Runtime 和 [Microsoft Visual C++ x64 运行库](https://aka.ms/vc14/vc_redist.x64.exe) 的机器上解压并运行 `PiDeck-Q.exe`。

正式发布只能从 `main` 触发。试跑成功后再次运行工作流，勾选 `publish`，填写 `preview_run_id`、试跑 ZIP 的 `zip_sha256`（可在预览摘要中核对）和 `release_notes`，按需勾选 `prerelease`。发布会下载并校验同一份 ZIP，不重新构建。若 `main` 已推进或标签已占用，请构建并试跑新预览。上传失败后标签可能保留，GitHub CLI 可能清理草稿，请先确认远端状态。建议通过仓库规则禁止更新或删除已创建的发布标签。

## Pi 正则兼容性

PiDeck 支持使用 Node.js 22.19.0 或更新版本运行的 Pi Agent。全量测试仍使用仓库要求的 Node.js 24.19.0。修改安全规则校验器或升级 `regexpp` 时，先用 Node 24 安装依赖，再单独用 Node 22.19.0 执行：

```bash
node scripts/security-regex-validator/generate-unicode16.mjs --check
node --test tests/securityRegexValidatorBundle.test.mjs
```

这组测试用 Node 22 的原生正则验证 Unicode 16 组名兼容性。更新共享校验器或 `regexpp` 后，用 Node 24 执行 `npm run build:security-regex-validator`，更新 C++ 后端的嵌入产物。

## 官网与贡献

VitePress 源码位于 `docs-site/`。部署根路径由 `VITEPRESS_BASE` 控制，站点 origin 由 `DOCS_SITE_ORIGIN` 控制，`public/CNAME` 保存自定义域名。

当前版本展示跟随 manifest；上游历史记录单独标注。贡献遵循仓库根 `AGENTS.md` 的依赖边界、测试门禁与提交授权规则。
