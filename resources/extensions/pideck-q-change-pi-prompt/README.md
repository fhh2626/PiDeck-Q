# PiDeck-Q-Change-Pi-Prompt

PiDeck-Q 随包内置扩展。PiDeck 默认启用，用户可在设置 → 扩展中关闭。
接管 Pi 的基础身份、Guidelines 和文档提示，按来源替换 pwsh 指南并为 pi-subagents 增补委派与前台执行策略。
在 standalone Pi（如 `pi.exe`）环境下硬性执行 Native 子代理前台策略：
- 支持：direct native 前台调用与 inline `workflowScript` 前台编排（顶层强制 `async: false` 与 `foregroundOnly: true`；内部通过 AST 静态证明每个 native child 显式声明 `async: false`）。
- 暂不支持：`workflowScriptPath` 与 named workflow resource（`{ workflow, args }`）。这些入口的真实脚本在 pi-subagents 内部解析，change-pi-prompt 无法在 `tool_call` 拦截边界完成相同的 AST 前台验证，因此 standalone 下直接 fail closed 阻断（非 standalone 环境不受此限制）。
- 外部 Runner（`external-cli` / `external-job`）在 standalone 下不可用并直接阻断；无法确认 runner 类型的未知 Agent 同样 fail closed 阻断。
探测 bash / powershell 与 grep / find 的后端可用性；缺失则对本会话 `setActiveTools` 隐藏对应工具，并删掉 Available tools 行。grep/find 采用静态探测（检查普通文件及可检查的执行权限；不执行、不下载；不保证 DLL/架构等运行时条件）。托管目录（`<agentDir>/bin`）优先于 PATH 判定且仅识别 `rg`/`fd`（不识别 `fdfind`）；PATH 候选区分平台（Windows 查 `.exe`，find 在 PATH 上支持 `fd` 与 `fdfind`）。如果对应托管路径存在但不是可执行的普通文件，则直接判该工具不可用，不退回 PATH。
不修改 pi-subagents 上游源码；不改写 child 的 `tools` allowlist，也不把 PowerShell 挂到名为 `bash` 的槽上。
父 Agent 与 native child 均按真实工具名 prune；native child 角色 prompt 保持完全一致，不被替换为父 Agent 身份。
enabled=false 时真正完全停用（不修改 prompt、provider payload、tool call、active tools 或 child settings）。

## 安装结构

入口是 `resources/extensions/pideck-q-change-pi-prompt.ts`，实现位于同名目录。
本目录刻意没有 `index.ts`，避免 Pi 自动发现两个入口而重复注册。
旧的全局 `~/.pi/agent/extensions/change-pi-prompt.ts` 会在启动时清理，以免与随包 `-e` 入口重复加载。

pwsh 和 subagent **均为可选依赖**：插件不导入、安装或执行它们；仅从当前工具元数据识别。
- 未安装、已禁用、来源不明：不接管该工具贡献，不生成专属指南。
- 同名工具由其他扩展提供：不误认为目标插件。
- 缺少元数据 API：保留无法归属的规则，不猜测提供者。
- 没有 ask_question / todo：不输出对应使用要求。
- `pruneUnavailableShells`（默认 true）：只探测 bash.exe / Git Bash / `settings.shellPath` 与 pwsh/powershell 是否存在，不 spawn 命令。缺失则隐藏该工具并省略对应 prompt 段；不按操作系统一刀切。pwsh adapter 占用 `bash` 名称时保留该槽（仅父 Agent）。
- `pruneUnavailableSearchTools`（默认 true）：按上述静态探测规则，`rg`/`fd` 不可用时分别隐藏 grep/find；已安装后启动新父会话即可恢复（仍须在父会话的 defaultTools 与 child allowlist 中启用）。`ls` 不依赖这两个程序，不受影响。静态探测不保证 DLL 完整性、CPU 架构或进程实际 spawn 成功。
- `settings.shellPath` 按文件名分类：`bash.exe` / `bash` / `sh.exe` / `sh` 计入 bash；`pwsh.exe` / `pwsh` / `powershell.exe` / `powershell` 计入 powershell；其它名字（如 `cmd.exe`）不计入任何后端。配置的 shell 路径绝不再被当作 bash 的同义词。

## 子 Agent 工具环境（只 prune，不改名）

`getAllTools()` 是「已注册能力」，`getActiveTools()` 是「当前真正暴露给模型的能力」。子 Agent 的工具名单来自 pi-subagents 的硬 allowlist，本扩展不能按真实环境补上未声明的工具名。

- 真实后端缺失、或父 Agent 最终未激活的 `bash` / `powershell`：从 child 的 active tools 里隐藏。
- 父会话 reconciliation 会按本机探测结果，把 shell-capable agent 的 `subagents.agentOverrides.<name>.tools` 写成真名 allowlist（只有 PowerShell 就把 `bash` 换成 `powershell`；两个都有就都留；都没有就都去掉）。这是共享 settings，跟当前 tab 是否激活无关。
- 不覆盖用户已经手写的 `tools`；本扩展上次写入且未被改过的 allowlist 才会随探测结果更新。reviewer 等未声明 shell 的 agent 不写 `tools`。
- 不改 `pideck-q-subagents/agents/*.md`，也不把 PowerShell 挂到名为 `bash` 的槽。本次会话里 pi-subagents 若已读完 catalog，新 allowlist 从下一次会话或 `/reload` 生效。
- pwsh adapter 占用 `bash` 名称时：父会话可保留该槽；child 不把它当成真实 bash，也不把它注入共享 child settings。
- 不扩权：原本不声明 shell 的子 Agent（如 reviewer）不会被追加 `powershell`；child 身份无法解析时只做 prune，绝不主动加工具。
- 父 Agent 最终未激活的工具（包括 `grep`/`find`/`ls` 等 builtin 与 extension tool）都从 child active tools 裁掉；仅 `contact_supervisor`、`structured_output`、`subagent_supervisor` 等子会话专用协调工具可例外。缺失或旧版父快照没有 `parentActiveTools` 时 fail closed，仅保留这些子会话专用工具。
- child 启动后再次 prune：`before_agent_start` 中先 `setActiveTools`，再生成 Child Tool Environment 块（`<!-- change-pi-prompt:child-tools:v1 -->`），因此块内文案与实际 active tools 一致。
- child 执行时二次门禁：在每次普通 `tool_call` 执行前重新读取 parent 的 owner 快照。父会话动态撤销的工具在 child 下一次调用时即刻阻断；缺少有效快照或环境缺少 `setActiveTools` 时阻断普通工具调用（仅保留 child-only 协调工具）；child 禁止发起到下一级子 Agent 的执行型嵌套委派。
- 角色 prompt 永不重写：仅追加/替换 child-tools 块，列出本 child 的最终活动工具。若 grep/find 被裁掉，明确要求不要按角色 prompt 调用它们；有 PowerShell 时提示用 Get-ChildItem / Select-String。
- 不修改 `pideck-q-subagents/**`。

### 全局 reconciliation 只由 parent 执行

子 Agent 与父 Agent 共用同一份 `settings.json`，但子 Agent 的 active tools **不是**父 Agent 的 active tools（pi-subagents 只按 agent frontmatter + capability ceiling 生成 child allowlist）。因此：

- `reload()` 只加载配置，不再触发 reconciliation。
- `session_start` 只做 session-local 的 shell 与搜索后端 prune，不写任何共享 override。
- `before_agent_start` 先判定 child session：child 只处理本会话 active tools 与 prompt；只有 parent 会执行 `reconcileChildEnvironments(parentActiveTools)`。
- `tool_call` 在 child session 中只做只读 catalog 加载，不再重写共享 override（避免「第一只 child 正常、下一只不同步」）。
- parent 会把最终 child policy 发布成 `<agentDir>/change-pi-prompt/effective-shell-policy.<owner>.json`（`<owner>` 是 parent 的 session 身份，缺失时退化为 `session-<pid>`），并原子写入（tmp → rename）；child 只读取属于自己 parent 的那个文件作为上界（没有 owner、缺失/损坏/跨平台快照一律忽略）。
  - 每次执行型 native 委派（direct agent 或 inline `workflowScript`）均在 `tool_call` 拦截边界重新读取父会话当前 `getActiveTools()`、重新协调并原子发布最新快照；若协调期间活动工具变化、跨进程锁获取失败、快照写入失败或环境缺少 `getActiveTools`/`setActiveTools` API，一律 fail closed 阻断执行，防止使用旧快照放行已撤销工具。
  - 文件内容为 `version: 2`：`shell: { bash, powershell }` + `parentActiveTools`（来自 parent 最终的 `getActiveTools()`，绝不是 `getAllTools()`）。`version: 1` 旧快照仍可读，但不提供工具继承上限；child 对缺失的 `parentActiveTools` fail closed。
  - 之所以按 owner 分文件：PiDeck 允许多个 Agent session 共享同一个 agentDir，全局单文件会让 Parent B 覆盖 Parent A 的 ceiling，导致 A 的 child 读到别人的上界。
  - owner key 通过环境变量 `CHANGE_PI_PROMPT_SHELL_POLICY_OWNER` 传给 child：foreground native child 与 parent 同进程，detached runner child 是独立进程，靠继承到的环境变量仍能解析到同一个 owner 文件；child 在第一次 `before_agent_start` 时冻结 owner key。
  - 超过 7 天未更新的 owner 快照会在 parent 写入时顺带清理，避免文件无限积累。

### provider 可加载性 ≠ 工具权限（两层职责）

| 层 | 文件 | 职责 |
|---|---|---|
| 共享 superset | `<agentDir>/settings.json` 的 `subagents.agentOverrides.<agent>.subagentOnlyExtensions` | 「这些 provider 可以被 child 加载」——只增不减（除非文件真的不存在） |
| per-owner ceiling | `effective-shell-policy.<owner>.json` 的 `parentActiveTools` | 「这个 parent 实际允许 child 使用哪些 builtin / extension tools」 |

- 当前 parent inactive 某工具时，只看 `resolveLoadableToolProvider()`（provider 是否存在且可加载）决定 settings：一个仍存在、可加载的 provider 不得因为本 session inactive 而被删除，否则会让另一个 session 后续启动 child 时丢 provider。
- 对 extension tool，`resolveToolProviderExtension()` 单独判定当前 parent 是否启用及 provider 是否存在，反映在 `compatibilityStatus[agent].missingTools` 里；builtin 无需 provider，其权限由 child 的父工具上限单独裁剪。
- child 侧的 `reconcileChildExtensionTools()` 只做 prune：builtin / extension tool 不在 `parentActiveTools` 就移除，**不会**因为 parent 有就主动加入。`BUILTIN_OR_INTERNAL_CHILD_TOOLS` 只表示无需外部 provider，不再代表免受父会话工具上限约束。
- 唯有子会话专用协调工具可超出父上限；无 `version 2` 快照时（旧 parent 或文件缺失）fail closed。grep/find 还需通过本会话的 rg/fd 后端探测。
- child 最终顺序：搜索后端 prune → 读 owner policy → 父工具上限 prune → shell prune → `setActiveTools()` → 生成 Child Tool Environment。prompt 必须在最终 active tools 之后生成。

### reconciliation 跨进程锁

`settings.json` 与 `managed-child-extensions.json` 是所有 session 共用的，atomic rename 只能防半文件，不能防 lost update（A、B 同时读旧值再各写各的）。因此整段 read-merge-write 都在 `<agentDir>/change-pi-prompt/reconciliation.lock` 内执行（`openSync(..., 'wx')`，退避重试，默认上限 2s）：先拿锁，再重新读最新文件，merge，原子写入，释放。

- 锁内容是 `{ pid, createdAt, token }`；新建未写完的空锁、无法解析的内容或缺少有效数值 `createdAt` 的内容均会依据文件系统的修改时间（mtime/ctime）计算年龄，仅在超过 30s 时才被当作崩溃残留回收，避免并发创建窗口内误删有效的新锁。
- 释放锁时会校验当前锁文件内容是否仍与本次持有的 `token` 一致，避免覆盖或误删已被其他进程接管的锁。
- 超时拿不到锁时不破坏共享文件，reconciliation 返回 `undefined`，由 runtime 写诊断并**不**重建局部状态。
- 只有 parent 会拿锁；child session 绝不执行 reconciliation，也不写 settings / managed paths。

### 调度与计划动作门禁界限

- `subagent` 的 `action` 分类严格区分为纯只读管理动作与执行动作：
  - 会触发或恢复任务执行的动作（`schedule.run`、`schedule.run-due`、`schedule.resume`、`schedule.create`）在父会话边界会被严格阻断，因为它们启动/恢复的是异步、脱离即时上下文验证的目标；在子会话边界则直接被作为嵌套执行阻断。
  - 纯管理动作（`schedule.list`、`schedule.show`、`schedule.history`、`schedule.pause`、`schedule.delete` 以及 `list`、`status`、`guide`）允许安全通行。
  - **边界说明**：此处的门禁仅针对通过 `tool_call` 发起的调度 action 调用。由 `pideck-q-subagents` 内部定时器在后台自行触发的已存任务不经过 `tool_call` handler，不在此处门禁范围内。

### 子会话工具 API fail-closed

- 子会话执行普通工具时，环境必须同时提供 `getActiveTools` 与 `setActiveTools` 两个 API；任一 API 缺失均直接 fail-closed 阻断普通工具调用，防止无法获取或收敛子会话的实际活动工具边界。
- 启动时若 API 不齐备，子会话的允许工具集直接置空，杜绝使用注册表或旧快照放行工具。专用的子会话协调工具（`contact_supervisor`、`structured_output`、`subagent_supervisor`）仍保留例外。

## 用户修改文案

1. `/change-pi-prompt init`：只创建缺失的配置与模板，永不覆盖已有文件。
2. 编辑 `<agentDir>/change-pi-prompt/prompts/*.md`。
3. `/change-pi-prompt reload`：校验并原子加载配置；下一次用户请求生效。

Windows 默认目录：`C:\Users\<user>\.pi\agent\change-pi-prompt`。
实际目录使用 Pi 的 `getAgentDir()`，因此支持宿主自定义 agentDir。

模板包括：identity、execution、tools、read、edit、batchEdit、write、shell、pwsh、userInput、taskTracking、delegation、validation、communication、environment。
内置默认文案集中在 `defaults.ts` 开头。发布更新不触碰用户 Markdown。
仅 environment.md 支持 `{{hostOs}}`、`{{today}}`；其余模板为纯文本，不执行代码。
不存在的模板使用默认值；空文件、未知占位符、保留标记、超过 64 KiB 的文件会拒绝加载。
加载失败保留上一份有效配置；首次加载失败则保持原 prompt，不静默重新启用默认改写。
配置路径不接受符号链接；不自动读取项目级自定义配置。

## config.json

```json
{
  "schemaVersion": 1,
  "enabled": true,
  "replaceIdentity": true,
  "replaceGuidelines": true,
  "removeDocumentation": true,
  "pwsh": true,
  "subagent": true,
  "pruneUnavailableShells": true,
  "pruneUnavailableSearchTools": true,
  "unknownGuidelines": "preserve"
}
```

- pwsh：是否替换目标 Shell 指南；subagent：是否添加原生 subagent 委派策略；均不代表安装或启用插件。
- pruneUnavailableShells：是否按后端探测隐藏不可用的 bash/powershell；`false` 时既不 `setActiveTools` 也不裁剪 prompt 中的 Shell 行。
- pruneUnavailableSearchTools：是否按后端探测隐藏不可用的 grep/find；`false` 时不因 rg/fd 缺失隐藏它们或裁剪 prompt 行，父会话活动工具上限仍生效。
- unknownGuidelines：`preserve` 保留无法归属的规则；`skip` 撤销整个本次转换。
- 接管规则通过工具来源元数据识别，不依赖旧文本正则。原生 subagent 默认模式的执行指南始终保留，避免其短 description 未覆盖的安全规则丢失。
- 多个来源共有的规则，只要其中有未接管来源，就保留。
- 新增的未知 Pi core 规则默认保留；不模糊猜测语义。

## subagent 的长 description

systemPrompt hook 不能修改工具 description。使用 pi-subagents 自带 custom 接口：

1. 确认已安装 `pi-subagents`（Nico Bailon，适配 0.66.0），工具名为 `subagent`。
2. `/change-pi-prompt init-subagent`：只创建缺失的 `<agentDir>/subagent-tool-description.md`。
3. 在 `<agentDir>/extensions/subagent/config.json` 顶层设置 `"toolDescriptionMode": "custom"`。在独立 Pi（standalone Pi）环境下，若该配置文件完全不存在，`change-pi-prompt` 会在首次会话或子代理调用时自动生成最小前台安全配置（`asyncByDefault: false, forceTopLevelAsync: false`）；已有用户配置绝不覆盖，仅执行安全合规校验。`before_agent_start`、`context`、`before_provider_request` 和 `tool_result` 会把上游强制安全段、工具描述、已注入 skill，以及对 `pi-subagents/skills/` 的 `read` 结果中的默认后台说明改写为：插件默认是 `asyncByDefault:true`，本环境必须 `async:false`。不修改 pi-subagents 上游源码。用语义窗口匹配，而不是整段原文；用户自己的 `async: true` 不替换。
4. 开启新会话，使 subagent 工具重新注册。

命令不修改 pi-subagents 配置，不覆盖已有 description；未检测到目标工具时不写任何文件。
项目配置目录（标准 Pi 为 `.pi`）中的 `subagent-tool-description.md` 优先于全局文件。
默认模板不使用占位符；上游 custom 接口会自动追加完整安全指南，不应重复粘贴或移除。
上游支持 `{{full}}` / `{{compact}}` / `{{safety}}` 等原生占位符，由 pi-subagents 自行渲染。
custom 模式下上游不提供 promptSnippet/promptGuidelines；本插件仍按活动工具的名称和来源生成 Delegation，不依赖这些字段存在。默认模式则保留上游指南；custom 模式使用自动追加的安全段，减少重复而不删除执行约束。
多步或并行任务只允许一个顶层前台 workflow（async:false），子任务通过 runs.run/runs.all 编排；模板保留调用契约，模型选择沿用上游默认行为。
自定义描述也保留单 workflow 约束，避免关闭系统指南替换后丢失该约束。
bg_wait、subagent_supervisor、外部 CLI 行为和子代理角色均不改写。
旧提供者不再适配；旧的用户模板不会被初始化命令自动迁移或删除，升级时应手动检查并替换 delegation.md。
自定义 SYSTEM.md 与子代理 customPrompt 整体跳过；父 prompt 已转换的继承前缀不重复转换。

## 诊断

- `/change-pi-prompt status`：当前配置、上次转换结果、可选来源规则指纹。
- `/change-pi-prompt preview`：仅在 UI 中预览上次已转换基础块，不保存，不包含后续项目/技能上下文。
- 同一会话中目标指南变化会提示；指纹不跨进程持久化，不保证自动检测两次启动之间的更新。
- 默认日志不输出完整 prompt、模板、项目内容。

## 兼容性与安全边界

已验证原版 Pi 0.84.4 实际构建器与公开 ExtensionAPI 类型。
pwsh 1.1.1、pi-subagents 0.66.0 的来源契约已核对；规则归属测试使用可控替身。
未进行真实模型会话或 Pi_Agent_Rust 端到端验证，不宣称所有版本兼容。

转换仅接受有序的基础头：身份 / Available tools / Guidelines / Pi documentation。
文档前三个路径标签作为结构锚点；正文条目可以更新，不依赖 tui.md 尾句。
未知标题、边界缺失、未缩进的复杂多行指南、结构歧义均保持原 prompt，并报告状态。
文档条目必须是连续列表；用户 append 文本还会通过结构化 options 检查边界。
不从 options 重建全部 prompt，避免覆盖其他扩展已经做出的链式修改。
保留区块直接从原字符串切片，CRLF 不被全局规范化，模板里的 `$&` 等字符原样输出。

没有可用结构化来源时，文本结构识别是保守兼容路径，不是抵抗恶意扩展伪造来源的安全沙箱。
后执行的扩展仍可改写 prompt；本插件不劫持事件顺序或模型请求载荷。
自己生成的基础块加版本标记来保证幂等；重复传入已标记文本保持原样。
Pi 正常每次用户请求会重建基础 prompt，因此配置/日期会刷新；若宿主只提供已转换缓存，则需重建或开启新会话。

## 测试

Node 22.19+（内置 TypeScript type stripping）：

```powershell
node --test "<extension-directory>/change-pi-prompt/tests/*.test.mjs"
```

可选真实构建器测试：设置 `CHANGE_PI_PROMPT_TEST_PI_DIR` 为单独安装的 Pi 0.84.4 npm 包目录，再运行同一命令。
无需模型、网络调用、真实 Pi 子进程或可选插件。未指定该变量时仅跳过真实构建器测试。
类型检查应对 Pi 0.84.4 的真实类型运行 strict / noEmit / allowImportingTsExtensions；不要用手写 API stub 代替。
