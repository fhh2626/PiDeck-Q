# PiDeck-Q-Change-Pi-Prompt

PiDeck-Q 随包内置扩展。默认关闭；在设置 → 扩展中启用。
接管 Pi 的基础身份、Guidelines 和文档提示，按来源替换 pwsh 指南并为 pi-subagents 增补委派策略。
探测 bash / powershell 后端是否存在；缺失则对本会话 `setActiveTools` 隐藏对应工具，并删掉 Available tools 行与 shell/pwsh 指南。
不修改工具执行实现、参数 schema、项目 AGENTS.md、技能、记忆或子代理角色。

## 安装结构

入口是 `resources/extensions/pideck-q-change-pi-prompt.ts`，实现位于同名目录。
本目录刻意没有 `index.ts`，避免 Pi 自动发现两个入口而重复注册。
旧的全局 `~/.pi/agent/extensions/change-pi-prompt.ts` 会在启动时清理，以免与随包 `-e` 入口重复加载。

pwsh 和 subagent **均为可选依赖**：插件不导入、安装或执行它们；仅从当前工具元数据识别。
- 未安装、已禁用、来源不明：不接管该工具贡献，不生成专属指南。
- 同名工具由其他扩展提供：不误认为目标插件。
- 缺少元数据 API：保留无法归属的规则，不猜测提供者。
- 没有 ask_question / todo：不输出对应使用要求。
- `pruneUnavailableShells`（默认 true）：只探测 bash.exe / Git Bash / `settings.shellPath` 与 pwsh/powershell 是否存在，不 spawn 命令。缺失则隐藏该工具并省略对应 prompt 段；不按操作系统一刀切。pwsh adapter 占用 `bash` 名称时保留该槽。

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
  "unknownGuidelines": "preserve"
}
```

- pwsh：是否替换目标 Shell 指南；subagent：是否添加原生 subagent 委派策略；均不代表安装或启用插件。
- pruneUnavailableShells：是否按后端探测隐藏不可用的 bash/powershell；`false` 时既不 `setActiveTools` 也不裁剪 prompt 中的 Shell 行。
- unknownGuidelines：`preserve` 保留无法归属的规则；`skip` 撤销整个本次转换。
- 接管规则通过工具来源元数据识别，不依赖旧文本正则。原生 subagent 默认模式的执行指南始终保留，避免其短 description 未覆盖的安全规则丢失。
- 多个来源共有的规则，只要其中有未接管来源，就保留。
- 新增的未知 Pi core 规则默认保留；不模糊猜测语义。

## subagent 的长 description

systemPrompt hook 不能修改工具 description。使用 pi-subagents 自带 custom 接口：

1. 确认已安装 `pi-subagents`（Nico Bailon，适配 0.66.0），工具名为 `subagent`。
2. `/change-pi-prompt init-subagent`：只创建缺失的 `<agentDir>/subagent-tool-description.md`。
3. 在 `<agentDir>/extensions/subagent/config.json` 顶层设置 `"toolDescriptionMode": "custom"` 和 `"asyncByDefault": false`。每次 `before_agent_start` 都会检查后者；缺省或 true 会警告，因为独立 Pi 二进制无法启动后台子 agent。`before_agent_start`、`context`、`before_provider_request` 和 `tool_result` 会把上游强制安全段、工具描述、已注入 skill，以及对 `pi-subagents/skills/` 的 `read` 结果中的默认后台说明改写为：插件默认是 `asyncByDefault:true`，本环境必须 `async:false`。不修改 pi-subagents 源码或磁盘文件。用语义窗口匹配，而不是整段原文；用户自己的 `async: true` 不替换。
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
