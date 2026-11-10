# Pi runtime compatibility

这份文档记录 PiDeck 对两个 Pi 实现的适配边界。结论来自本地源码对比和协议层测试；“大概率不支持”表示接口虽然存在，但字段、语义或运行环境仍与 PiDeck 的假设不同，不能仅凭命令成功启动就视为兼容。

## 对比基线

- PiDeck：`upstream/PiDeck`，commit `1d397757`。
- 原版 TypeScript Pi：`upstream/pi-mono`，commit `4d9aa837c`，`packages/coding-agent`。
- Rust Pi：`upstream/pi_agent_rust`，commit `9d4872a0`。

上游项目：[PiDeck](https://github.com/ayuayue/PiDeck)、[pi-mono](https://github.com/badlogic/pi-mono)、[pi_agent_rust](https://github.com/Dicklesworthstone/pi_agent_rust)。

## PiDeck 当前适配

| 能力 | 原版 TypeScript Pi | pi_agent_rust | PiDeck 处理方式 |
|---|---|---|---|
| 启动与 RPC | 支持 `--mode rpc` | 支持 `--mode rpc` | 仍使用同一 stdio JSON-RPC 边界；启动前探测 `--version` 判断实现 |
| 模型列表 | `get_available_models` 返回模型对象 | 同名 RPC 返回 `{ models: [...] }`，字段基本兼容 | RPC 优先；失败或空结果回退文本表格；文本解析拒绝 `Showing ...` 诊断行；Rust 文本回退不传 TypeScript 专属 `--offline` |
| 模型能力字段 | `contextWindow`、`maxTokens`、`reasoning`、`input` 等 | 同名字段，图片能力通过 `input: ["image"]` 表示 | 归一化成 PiDeck 的 `AvailableModel`，按 provider/id 去重 |
| Agent 完成事件 | 有 `agent_settled` | 主要有 `agent_end`，没有原版同名 settled 事件 | Rust 收到带 `sessionId` 的 `agent_end` 时，短暂调用 `get_state` 确认无待处理工作 |
| 会话父子关系 | session header 使用 `parentSession` | session header 序列化为 `branchedFrom`，并兼容读取 `parentSession` | 两种字段都识别；只有父文件存在且位于当前 sessions 根目录内才建立嵌套关系 |
| 原生 subagent | 原版扩展/工具生态各自决定会话存储 | Rust 内置 `subagent` 只有在 `--tools` 显式启用时才加入；子进程使用 `--no-session`，结果是临时的 | 不把无 session 的内部 worker 当作第二个 PiDeck Agent；持久化分支按父会话字段归组 |
| 运行时选择 | 自动检测 | 自动检测 | 设置中提供“自动 / 原版 TypeScript / Rust”以及两条可选路径；启动时自动检测并缓存实现类型 |
| 更新 | PiDeck 原有 npm 更新链 | 不是 npm 包，PiDeck 不代替 Rust 自身更新 | Rust 版本只做检测，不显示原版 npm 更新为可用 |
| 子代理运行状态 | 扩展调用 `ctx.ui.setStatus`，经 `extension_ui_request` 上报 | 需真实运行验证 | 仅在 `PIDECK_DESKTOP=1` 且存在 UI 上下文时发布；主进程按 key 前缀消费，通道缺失时安全降级为不亮灯 |

## 功能差异与风险矩阵

### 已确认可复用的协议能力

Rust 源码明确实现了 PiDeck 依赖的 `prompt`、`abort`、`get_state`、`get_messages`、`set_model`、`cycle_model`、`set_thinking_level`、`compact`、`new_session`、`fork`、`get_fork_messages`、`export_html`、`switch_session`、`get_commands` 和扩展 UI 回写等 RPC 入口，也支持 `--session`、`--session-dir`、`--no-session`、`--no-extensions`、`--no-skills` 和 `--no-themes`，因此 PiDeck 的核心“一个会话对应一个 RPC runtime”模型可以保持不变。

这里没有把 PiDeck 的 `get_entries`、`clone` 和 `reload_config` 写成 Rust 已确认支持：当前 Rust RPC 源码未发现同名入口。PiDeck 对 `get_entries` 已有降级路径，对 `reload_config` 已捕获失败并保持当前状态；`clone` 属于需要真实 Rust 版本验证的会话操作，不能只按原版协议声明兼容。

### 大概率不支持或需要单独验证的能力

| PiDeck 功能 | 风险 | 原因/处理 |
|---|---|---|
| PiDeck 内置扩展 | 高 | Rust 有 QuickJS/扩展兼容层，但扩展依赖 Node API、包解析、事件细节时可能不同。`-e` 注入路径能启动不代表行为完全相同；Rust 的 `--no-extensions` / `--no-skills` 等开关存在，但 `--no-context-files` 不是两者共同契约。应逐个验证安全门、提问、计划、todo 和视觉扩展。 |
| 扩展 UI 交互 | 中高 | RPC 事件名和 payload 大体相近，但 UI request 的队列、取消、字段完整性需要真实运行验证。 |
| 第三方 npm 扩展 | 高 | Rust 不是 Node runtime；依赖 Node 内置模块或 npm 原生包的扩展不能假设可用。 |
| `/settings`、`/share`、`/login` 等 TUI 命令 | 中 | 这些不是 PiDeck 的主协议面；Rust 的交互命令矩阵仍有 `?`，PiDeck 不应依赖其存在。 |
| OAuth / provider 登录 | 中高 | Rust 有自己的 provider/auth 实现和额外 provider；凭据文件、OAuth 流程和模型目录不应假设与 TypeScript 版本逐字节一致。 |
| 扩展安装/更新 | 中高 | Rust 有 `install/remove/update/list`，同时还有 Rust-only 的 `doctor/info/search/update-index`；PiDeck 原有 npm 包安装提示和参数不能覆盖全部 Rust 行为。Rust 运行时不会使用原版 npm 更新链。 |
| `--approve` / `--no-approve` | 高 | 这是原版 Pi 的信任参数；Rust 版本不应按原版版本号推断支持。PiDeck 已在 Rust runtime 上跳过这些参数。 |
| 自动重试/自动压缩时序 | 中 | 两个实现都有相关事件，但 Rust 没有 `agent_settled`，所以 PiDeck 使用 `agent_end + get_state` 的保守收敛路径。仍需用真实 provider 验证快速重试、压缩和 abort 的边界时序。 |
| 图片输入 | 中 | Rust RPC 的模型能力通过 `input` 暴露；PiDeck 已归一化 `images`。实际 provider 是否接受图片、大小限制和扩展读取图片仍需 provider 级验证。 |
| 模型目录完整性 | 中 | `get_available_models` 只反映当前实现加载到的 registry、配置和凭据；两个版本可列出不同数量，不应把数量差异直接判断成 PiDeck bug。 |
| Git 提交摘要轻量 RPC | 中 | PiDeck 会额外启动无 session/无 tools 的 RPC。两种实现共有参数已收敛；原版专属 `--no-context-files` 已移除，避免 Rust 直接因未知参数退出。 |

## 两个已修复问题的设计

### 模型列表

旧逻辑把文本输出第一行之后的所有行都按模型解析。Rust 在表格后会输出类似 `Showing 1 of N providers...` 的说明，因此该说明被误当成 provider/model。

现在的链路是（RPC 启动参数保持两种实现的交集；Rust 不接受 TypeScript 专属 `--offline`）：

```text
PiDeck -> pi --mode rpc --no-session -> get_available_models
      -> normalizePiRpcModels -> AvailableModel[]
      -> RPC 不可用时才使用严格的 --list-models 文本回退
```

文本回退会定位 `provider model` 表头，并要求行尾是合法的 `yes/no` 能力列；Rust 的 `Showing ...` 因而不会进入模型数组。

### 新建对话和重复 Agent

PiDeck 的显示层应只展示当前 session catalog 中的顶层会话；内部 subagent 若没有持久化 session，不应被重新扫描成 PiDeck Agent。对于确实写入 session 文件的子会话，扫描器同时读取原版 `parentSession` 和 Rust `branchedFrom`，并把子会话挂到父会话的 `parentSessionPath` 下，避免顶层重复。

Rust 原生 subagent 本身通过 `--no-session` 运行临时 child。若未来 Rust 改为持久化 child，仍应沿用 `branchedFrom` 关联，而不是在 PiDeck 中额外创建一个独立主 Agent。

### 子代理运行状态通道

子代理工具调用返回后（例如子代理提问并 detach），工具事件不再更新，PiDeck 侧栏需要另一条持续的状态来源。扩展复用 pi 已有的扩展 UI 回写，不新增 HTTP/文件轮询：

```text
extension publishSubagentStatus
  -> ctx.ui.setStatus("pideck.subagent-status.v1:<runId>", JSON)
  -> pi extension_ui_request(method=setStatus)
  -> AgentManager.observeSubagentStatusSlot
  -> parseSubagentStatusSnapshot
  -> SubagentRunTracker.observeStatusSnapshot
  -> agents:subagent-status -> renderer
```

边界：

- 只在桌面宿主（`PIDECK_DESKTOP=1`）发布，避免终端 TUI 状态栏出现 JSON。
- 载荷只含子会话路径、状态和诊断字段，不转发工具结果；单帧限 16 KiB、单任务限 64 行，丢行即标记 `truncated`。
- 心跳 1s；主进程 30s 未收到新帧只收运行灯，不判定任务成功或杀掉子进程。每个 Agent 使用一个最近到期定时器，即使父回合已结束、渲染层空闲，也会主动经现有 `agents:subagent-status` 推送清理；同状态心跳仍刷新到期时间，但不反复重建定时器。失败行保留到最后一次有效观察后 30 分钟。
- 同一路径的先后执行按首次观察建立归属，不比较不透明的 executionId 大小。状态槽只优先于**当前执行**的工具帧；旧 workflow 的心跳、complete/clear 和工具终态不能覆盖恢复后的新执行。单代理/恢复发布器携带实际新 runId，workflow 在拿到 launch 路径时同步带上实际 runId（不沿用自动恢复 trace 的旧源 id）；缺少 executionId 时回退到 workflow + taskKey / toolCallId。旧行从无 runId 到补齐 runId 只是元数据完善，不能重新取得归属。
- 成功/清槽后仍保留有界归属墓碑，防止旧失败复活；每 Agent 最多 64 个会话、64 个状态源栅栏，每会话最多 64 次执行。无任何来源更新的栅栏 30 分钟后惰性淘汰，持续的旧心跳只保活归属保护，不刷新新行或旧失败的显示 TTL。超过窗口/容量后不保证识别任意历史迟到帧；完全无身份的同 key 重执行无法区分。空清单不创建活跃任务；stop/restart/exit/stopAll 统一释放定时器及所有状态。
- 原版 TypeScript Pi 1.5.1 已确认该通道可用；Rust 运行时是否支持 `ctx.ui.setStatus` 仍需真实运行验证，不支持时表现为不亮灯而不是崩溃。

## 运行时切换说明

1. 启动时以 `--version` 自动判断 TypeScript（裸 semver）或 Rust（`pi <version>`）并缓存。
2. 设置中选择运行时；每个实现可填写独立路径。留空时按 PATH 查找，原版优先尝试 `legacy-pi` / `pi-ts`，Rust 优先尝试 `pi-rust` / `pi_agent_rust`。如果两者都只叫 `pi`，建议填写两个显式路径；显式选择时 PiDeck 会再次校验版本前缀，发现选错会拒绝启动。
3. 选择变化只影响新启动的 Agent；已运行的 RPC 进程不会被强制替换。
4. WSL 仍是独立环境；WSL 命令优先于 Windows 侧保存的实现路径。
5. Rust 版本更新请使用其自身发布/构建流程；PiDeck 的 npm 更新按钮不会替换 Rust 可执行文件。

## 后续真实验证清单

- 用至少一个 Anthropic/OpenAI/Gemini provider 分别验证文本、图片、reasoning、切换模型和上下文统计。
- 验证 abort、自动 retry、自动 compact、follow-up/steer 的状态时序。
- 验证 PiDeck 内置扩展：安全策略、ask question、plan/todo 和视觉。
- 验证 Rust `subagent` 开启方式（默认工具列表不一定包含它）以及并发/链式 child 的输出是否只作为父 Agent 的 tool 结果展示。
- 验证从 TypeScript Pi 创建的 session、从 Rust Pi 创建的 session 以及跨实现 resume/fork。
