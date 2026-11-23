# PiDeck-Q-Change-Pi-Prompt

这个可选扩展只优化原版 Pi 的基础系统提示词。它使用 Pi 的 `before_agent_start` 接口，按已识别的基础提示词边界替换身份、内置工具指南与通用工作说明，并按配置移除 Pi 自身的文档介绍。

## 职责范围

扩展保留项目 `AGENTS.md`、技能、附加提示词，以及其他工具和扩展提供的说明。只有来源明确为 Pi builtin 的工具才获得相应的内置指南。自定义扩展即使注册 `read`、`write` 或 `bash` 等同名工具，也继续使用自己的说明。

其他扩展通过 Pi 的 `systemPromptOptions.sections` 显式覆盖 `tools`、`rules` 或 `docs` 段落时，对应段落保持原样。子 Agent 的自定义 `docs` 段落也会保留。

通过 `customPrompt` 或 `forceSystemPrompt` 提供的完整提示词保持原样，包括子 Agent 的自定义角色提示词。子 Agent 使用原版 Pi 基础提示词时，只可按配置移除 Pi 自身的文档介绍。无法识别或存在边界歧义的提示词会原样返回。

各扩展分别维护自己的行为。

| 能力 | 所属扩展 |
| --- | --- |
| Pi 基础身份、工作方式、通用沟通与验证指南 | `pideck-q-change-pi-prompt` |
| 委派前的一句说明、子 Agent 工具描述、前台执行约束 | `pideck-q-subagents` |
| 子 Agent 的工具权限、shell 环境和父会话授权快照 | `pideck-q-subagents` |
| 600 秒监督检查、`CONTINUE / STOP`、实时 Supervisor 交互 | `pideck-q-subagents` |
| 用户问答工具说明与使用指南 | `pideck-q-ask-question` |
| Web 搜索与抓取说明 | 对应的 Web 扩展 |

关闭本扩展不会关闭子 Agent 的环境协调、权限检查、前台工作流或 Supervisor 通信。本扩展不改写其他工具的参数、description、provider payload、历史消息或工具结果，也不写入 subagent 设置。

## 使用

扩展入口为 `resources/extensions/pideck-q-change-pi-prompt.ts`，实现与入口同目录发布。可在 PiDeck 的扩展管理中启用或停用。

可用命令如下。

```text
/change-pi-prompt status
/change-pi-prompt init
/change-pi-prompt reload
/change-pi-prompt preview
```

`init` 只创建缺失的配置与 Markdown 模板，不覆盖已有内容。配置目录为 `<agentDir>/change-pi-prompt`。`reload` 验证完整的新配置后再替换当前配置，读取失败会继续使用上次有效配置。`preview` 只显示已转换的基础块，不保存项目或技能上下文。

模板包含 `identity`、`execution`、`tools`、`read`、`edit`、`batchEdit`、`write`、`shell`、`validation`、`communication` 与 `environment`。

默认配置如下。

```json
{
  "schemaVersion": 1,
  "enabled": true,
  "replaceIdentity": true,
  "replaceGuidelines": true,
  "removeDocumentation": true,
  "pruneUnavailableShells": true,
  "pruneUnavailableSearchTools": true,
  "unknownGuidelines": "preserve"
}
```

`pruneUnavailableShells` 与 `pruneUnavailableSearchTools` 只让基础提示词中的 builtin 工具列表与宿主报告的 active tools 一致。后端探测和 `setActiveTools` 由 subagents 的环境模块负责。

`unknownGuidelines` 为 `preserve` 时保留无法归属的说明。设置为 `skip` 时，一旦存在无法识别的规则就保留整段原始提示词。

只有 `environment.md` 支持 `{{hostOs}}` 与 `{{today}}`。配置与模板是固定路径的普通文件，单文件上限为 64 KiB，不执行模板代码，也不接受指向其他文件的符号链接。

## 升级兼容

旧配置中的布尔键 `subagent` 与 `pwsh` 仍可读取，但不再控制其他扩展。旧 `delegation.md`、`userInput.md` 和 `pwsh.md` 保留在用户目录中，本扩展不再加载它们。用户可通过对应扩展的原生配置修改委派或工具说明。

旧的 `init-subagent` 命令已移除。子 Agent 的自定义 description 继续由 subagents 自身的 `subagent-tool-description.md` 接口读取。

子 Agent 环境状态改由 `<agentDir>/subagents/environment` 保存。升级时，subagents 会读取旧目录中的托管元数据，清理它曾自动注入的 prompt 扩展路径，同时保留用户自定义的 provider 路径和设置。

## 验证

```text
npm run typecheck
npm test
```

基础提示词测试位于本目录的 `tests`。环境协调、权限上限、shell 探测和旧配置迁移测试位于仓库的 `tests/subagentEnvironment*.test.mjs`。
