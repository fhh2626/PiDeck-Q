# 聊天消息操作与 Shell 提示修复计划（执行者：Implementor LLM）

> **执行状态：2026-09-29 已全部执行完毕（阶段 1–9）。**
> 阶段 1 采用双语方案（新增 `copy.ts` + `PIDECK_UI_LANGUAGE` 注入），其余阶段按本文件原计划落地。
> 结果：`npm run typecheck` 退出码 0；`npm test` 3254 用例 / 3251 通过 / 0 失败 / 3 跳过（修复了
> 阶段 1 文案改动后暴露的 `runtime.test.mjs` 旧断言）。本文件保留作为变更说明与回归依据。
> 后续 review 发现的缺陷由 `docs/chat-message-ops-review-fix-plan.md` 跟踪修复。
>
> 基线：本仓库当前工作区（含尚未提交的 Web 鉴权 / 原子写 / shell 静默等改动）。
> 行号基于 2026-09-29 的工作区快照，**执行前先用 `Select-String` 复核**；行号漂移时以文中引用的代码片段为准。

## 0. 执行总规则（每个阶段都适用）

1. **不提交**：禁止 `git add` / `git commit` / `git push` / 建分支。
2. **前提不成立就停**：每个阶段开头都有「前提检查」。任一不符合时，停止该阶段，并用 `ask_question` 说明实际看到的代码，不要自行发明替代方案。
3. **编码规范（项目硬性要求）**：
   - 禁止 `any`，禁止任何 `as` 断言（包括放宽类型的断言），需要时改用带类型注解的变量。
   - 新增或修改的逻辑都要加中文注释，说明**为什么**这样做。
   - 用户可见文案走 i18n，`rendererCopy.zh-CN.ts` 与 `rendererCopy.en-US.ts` 同步加 key。
   - 不引入新的 npm 依赖。
4. **文件编辑**：
   - 只用 edit 工具做精确替换。
   - 禁止用 `Set-Content` / `Out-File` 重写整个文件，会破坏 UTF-8 中文。
   - 一次 edit 调用里的多处替换是「全成或全败」，改完要 `read` 回来核对。
5. **Shell 注意**：
   - 环境是 PowerShell，没有 `rg`，改用 `Select-String`。
   - 双引号字符串会展开 `${...}`，拼命令时注意。
6. **测试运行**：可能挂住的命令一律限时，模板如下：
   ```powershell
   $p = Start-Process -FilePath node -ArgumentList '--test','tests/xxx.test.mjs' -RedirectStandardOutput "$env:TEMP\t.out" -RedirectStandardError "$env:TEMP\t.err" -NoNewWindow -PassThru
   if (-not (Wait-Process -Id $p.Id -Timeout 300 -ErrorAction SilentlyContinue)) { }
   if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force }
   Get-Content "$env:TEMP\t.out" -Tail 40; Remove-Item "$env:TEMP\t.out","$env:TEMP\t.err" -ErrorAction SilentlyContinue
   ```
7. **反向验证**：
   - 每个新测试都要做一次：临时破坏被测逻辑，确认测试变红，再**恢复**。
   - 恢复后用 `Select-String` 确认破坏代码已不存在。
   - 临时探针文件（如 `tests/tmp-*.test.mjs`）用完必须删除。
8. **阶段门禁**：每个阶段结束都要：
   - 跑该阶段列出的定向测试；
   - 跑 `npm run typecheck`（限时 600 秒）；
   - 全部绿了再进入下一阶段。
9. **不修无关失败**：遇到与本计划无关的已有失败，记录下来并报告，不要顺手修。

## 阶段总览

| 阶段 | 问题 | 主要文件 |
|---|---|---|
| 1 | 所有 shell 都不可用时，按界面语言提示（中/英）；只要还有别的 shell 就静默 | `resources/extensions/pideck-q-change-pi-prompt/runtime.ts`、`copy.ts` |
| 2 | 回复没有文字时（纯工具/停止后），操作栏和删除按钮不显示 | `TurnRow.tsx` |
| 3 | TurnRow 的 memo 忽略回调，导致按钮不出现、闭包过期 | `SessionRuntimeInjector.tsx`、`TurnRow.tsx` |
| 4 | error 态（如 API 请求失败）下编辑/删除/重发全部被隐藏或失败 | `SessionRuntimeCoordinator.ts`、`AgentManager.ts`、`useSessionRuntimeController.ts` |
| 5 | error 态的 `agent_settled` 跳过缓存清理 | `AgentManager.ts` |
| 6 | 删除时残留悬空的工具调用；删除用户消息后回复串到上一轮 | `SessionFileEditor.ts`、`useSessionMessageCommands.ts`、i18n |
| 7 | 停止（abort）后缓存与文件错位，删除/编辑命中错误条目（原因 C） | `agentUtils.ts`、`AgentManager.ts` |
| 8 | 重发没反应、锁不释放、失败后原文丢失、历史未刷新 | `useSessionMessageCommands.ts`、i18n |
| 9 | 全量门禁 | — |

**已确认的产品决策（用户已拍板）：**

- 删除**用户消息**时，连同它这一轮的 AI 回复（思考、工具调用、回答）一起删除。
- 删除 **AI 回复**时，删除这一轮的全部回复：从该轮用户消息之后，到下一条用户消息之前的所有 assistant / toolResult。
- 重发在「文件已截断、但提交失败」时，把原消息文本放回输入框并提示；**不**做文件回滚，图片不自动恢复。
- 所有 shell 工具都不可用时，提示文案按界面语言在中文 / 英文之间切换：
  - `zh-CN`：`PowerShell 及其他 Shell 工具均不可用，已对本会话隐藏对应工具。`
  - `en-US`：`PowerShell and all other shell tools are unavailable. They have been hidden for this session.`
  - 语言由 PiDeck 通过环境变量 `PIDECK_UI_LANGUAGE` 注入 pi 子进程（pi 扩展本身读不到 PiDeck 界面语言），因此所有操作系统都把提示语统一为同一套双语文案，不再点名 bash。

---

## 阶段 1：Shell 不可用提示文案

**状态：已实现（含双语）。**

- 文案不再硬编码：新增 `resources/extensions/pideck-q-change-pi-prompt/copy.ts`，导出
  `resolveExtensionLocale(env, systemLocale)`、`shellUnavailableCopy(locale)`、`COPY_ZH_CN` / `COPY_EN_US`。
- 语言来源：`src/main/pi/PiProcess.ts` 在 `PiProcessOptions` 新增 `uiLocale`，写入子进程环境变量
  `PIDECK_UI_LANGUAGE`；`AgentManager` 从 `platformDeps.getLocale?.()` 取值，`createBackend.ts` 用现有的
  `currentMainProcessLocale()` 注入。
- `runtime.ts` 的 `pruneUnavailableShells` 收集 5 条用户可见文案时统一走 `copy.*`，
  其中「全部 shell 不可用」一条用 `copy.allShellsHidden`。
- 测试：`resources/extensions/pideck-q-change-pi-prompt/tests/copy.test.mjs`；
  `tests/changePiPromptChildCompatibility.test.mjs` 用例 15d / 15e；
  `tests/extensionPackagingDeps.test.mjs` 清单已包含 `copy.ts`；
  `resources/extensions/pideck-q-change-pi-prompt/tests/runtime.test.mjs` 中
  `session_start hides missing Git Bash and keeps Windows PowerShell` 已改为断言「静默」（需求变更）。
- 限制：界面语言在 pi 进程 spawn 时确定；运行中切换语言，需等该会话 runtime 重启后才会生效。
- 限制：WSL 下依赖 `WSLENV` 传递 `PIDECK_UI_LANGUAGE`（见 `docs/chat-message-ops-review-fix-plan.md` 阶段 C）。

**背景：**

- 工作区里已有未提交的改动：`shouldNotifyHiddenShells` 已实现，只要还剩一个可用 shell 就静默；相关测试 38/38 已通过。
- 本阶段只改文案，再补一个「全部不可用」的集成测试。

**前提检查：**

- `resources/extensions/pideck-q-change-pi-prompt/runtime.ts` 中 `pruneUnavailableShells` 里约第 389–391 行是：
  ```ts
  if (shouldNotifyHiddenShells(hidden, next)) {
      warnOnce(ctx, `未找到可用的 shell 后端（${hidden.join(', ')}），已对本会话隐藏对应工具。`);
  }
  ```
- `tests/changePiPromptChildCompatibility.test.mjs` 第 1057 行附近存在测试 `session_start on Windows with PowerShell but no Git Bash hides bash without notifying`。

**修改：**

1. 把上面的 `warnOnce(...)` 改为 `warnOnce(ctx, copy.allShellsHidden);`（已落地）。
   - 不要改 `lastShellStatus.push(...)` 那行，诊断信息仍然记录被隐藏的工具名。
2. 在 1057 行那个测试之后新增测试 `session_start with no usable shell notifies once with the platform-neutral message`：
   - 复制 1057 测试的骨架（`createMockPi`、`registerPromptExtension`、`ctx`）。
   - 用 `for (const platform of ["win32", "linux"])` 循环，每次循环都新建 tempDir、mockPi 和 notifications。
   - 参数：
     - `probeHost: { platform, env: { Path: "", PATH: "" }, exists: () => false }`；
     - 工具：`read`、`bash`、`powershell`。
   - 只调用 `session_start` **一次**（`reason: "startup"`）。`runtime.ts` 约 407、427 行会在 session_start / session_shutdown 时清空 warnOnce 去重集合，所以多次调用会多次提示，这是已有的设计，本计划不改。
   - 断言：
     - `mockPi.getActiveTools()` 深等于 `["read"]`；
     - 通知文案恰好 1 条，且等于当前 locale 对应的 `copy.allShellsHidden`（中文用例不看 CJK 以外的差异）。
   - 注意：`probeShellAvailability` 在 linux 下可能还有别的探测路径（例如 `/bin/bash`）。`exists: () => false` 应该能覆盖；如果 linux 下 bash 仍然判为可用，停下报告。

**验证：**

- 运行 `node --test tests/changePiPromptChildCompatibility.test.mjs`，应全绿。
- 反向验证：临时把文案改回旧文案，新测试应变红；然后恢复。
- 运行 `npm run typecheck`。

---

## 阶段 2：无文字回复也显示删除按钮

**背景：**

- `src/renderer/src/components/session/turn/TurnRow.tsx` 约第 480 行，操作栏只有在 `mergedText && !editing` 时才渲染。
- 所以「只有工具调用 / 停止后没有文字」的一轮完全没有删除入口。

**前提检查：**

- 第 288 行附近有 `const mergedText = assistantMessages.map(...)...join("\n\n");`。
- 第 311–314 行附近有 `const deleteMessage = () => { const targetId = assistantMessages.at(-1)?.message.id; ... }`。
- 操作栏 JSX 以 `{/* 操作栏 */}` 注释开头，紧接 `{mergedText && !editing && (`。

**修改：**

1. 在 `mergedText` 定义之后（`if (displayItems.length === 0 ...) return null;` 之前）新增：
   ```ts
   // 删除只需要本轮最后一条 assistant 的 id（后端按整轮删除），与是否有可见文字无关：
   // 纯工具调用、停止后空回复的轮次也必须能删，否则用户无法清理失败轮次。
   const lastAssistantId = assistantMessages.at(-1)?.message.id;
   const canDeleteTurn = Boolean(
       lastAssistantId && props.onDeleteMessage && !props.isStreaming && !props.agentRunning,
   );
   ```
2. 把 `deleteMessage` 和 `saveEdit` 里的 `assistantMessages.at(-1)?.message.id` 替换为 `lastAssistantId`。
3. 改造操作栏 JSX，保证行为如下：
   - 外层条件从 `mergedText && !editing` 改为 `(mergedText || canDeleteTurn) && !editing`。
   - `CopyMenu` 和分享按钮（`Share`）外面包一层 `{mergedText && (<>...</>)}`，因为没有文字时复制和分享没有意义。
   - 原来的 `{!props.isStreaming && !props.agentRunning && assistantMessages.at(-1)?.message.id && (` 改为 `{!props.isStreaming && !props.agentRunning && lastAssistantId && (`。
   - 编辑按钮条件从 `props.onEditMessage &&` 改为 `mergedText && props.onEditMessage &&`，因为编辑空文本没有意义。
   - 删除按钮条件保持 `props.onDeleteMessage &&`。
   - 不新增 CSS class，不改现有 className。

**测试**（新增到 `tests/turnRowExecutionProcess.test.mjs` 末尾；该文件是读源码断言的风格）：

- 测试名：`TurnRow action bar shows delete for turns without visible text`。
- 断言以下正则都能在源码中匹配：
  - `/\(mergedText \|\| canDeleteTurn\) && !editing/`
  - `/mergedText && props\.onEditMessage/`
  - `/const lastAssistantId = assistantMessages\.at\(-1\)\?\.message\.id;/`

**验证：**

- 运行 `node --test tests/turnRowExecutionProcess.test.mjs tests/imageDisplayAndPreviewFixRed.test.mjs tests/sessionRuntimeBindingCoverage.test.mjs`。
- 运行 `npm run typecheck`。

---

## 阶段 3：消息操作回调引用稳定 + TurnRow memo 比较回调

**背景：**

- `turnRowPropsEqual`（`TurnRow.tsx` 约第 572 行）不比较 `onEditMessage` / `onDeleteMessage`。
- 所以 runtime 从不可变更切到可变更时，历史轮次不会重渲染，按钮一直不出现；target 换代后，历史轮次还拿着旧闭包。
- 不能简单地把回调加进比较：`App.tsx` 每次渲染都会重建 `services.*` 回调，`SessionRuntimeInjector` 的 `messageActions` 又依赖它们，会导致流式期间整列 TurnRow 重渲染。
- 所以要先让回调引用稳定。

**前提检查：**

- `src/renderer/src/components/session/SessionRuntimeInjector.tsx` 第 139–168 行是 `const messageActions = React.useMemo(() => {...}, [canDispatchMessageMutation, messageCommandTarget?.sessionId, ..., services.resendUserMessage, services.editMessage, services.deleteMessage, services.forkFromUserMessage]);`。
- `tests/sessionRuntimeBindingCoverage.test.mjs` 第 130–133 行用正则断言 `services\.deleteMessage\?\.\(\s*messageCommandTarget,\s*messageId\s*\)` 等 4 条。

**修改：**

1. `SessionRuntimeInjector.tsx`：
   - 在 `messageActions` 之前新增：
     ```tsx
     // latest-ref：App 每次渲染都会重建 services.* 回调。若把它们放进 useMemo 依赖，
     // messageActions 每帧都换引用，TurnRow 按引用比较回调时会在流式期间整列重渲染。
     // ref 让包装函数只在「能否派发 / 目标 runtime / 能力有无」变化时换新，点击时仍调用最新实现。
     const latestMessageServicesRef = React.useRef(services);
     latestMessageServicesRef.current = services;
     const hasResendService = Boolean(services.resendUserMessage);
     const hasEditService = Boolean(services.editMessage);
     const hasDeleteService = Boolean(services.deleteMessage);
     const hasForkService = Boolean(services.forkFromUserMessage);
     ```
   - `useMemo` 内部 4 个回调改成读 ref，例如：
     ```tsx
     onDeleteMessage: hasDeleteService
         ? (messageId: string) =>
             latestMessageServicesRef.current.deleteMessage?.(messageCommandTarget, messageId)
         : undefined,
     ```
     另外三个同理：`resendUserMessage(messageCommandTarget, message)`、`editMessage(messageCommandTarget, messageId, newText)`、`forkFromUserMessage(messageCommandTarget, message)`。
   - 依赖数组中的 4 个 `services.xxx` 替换为 `hasResendService, hasEditService, hasDeleteService, hasForkService`，其余依赖保持不变。
   - 前提：`services` 的类型可以直接作为 `useRef` 的推断类型。如果 typecheck 报类型问题，给 `useRef` 显式写泛型参数（用 services 已有的类型名），**不要**用 `as`。
2. `TurnRow.tsx` 的 `turnRowPropsEqual`：
   - 在 return 的比较链末尾追加：
     ```ts
     prev.onEditMessage === next.onEditMessage &&
     prev.onDeleteMessage === next.onDeleteMessage
     ```
   - 同步修改函数上方的注释：说明 `onEditMessage` / `onDeleteMessage` 由 `SessionRuntimeInjector` 保证引用稳定，只在「可变更与否 / target 换代」时变化，必须比较，否则按钮显隐和 target 会过期；其他回调仍然忽略。
3. 修改 `tests/sessionRuntimeBindingCoverage.test.mjs` 第 130–133 行的 4 条正则，去掉 `services\.` 前缀：
   - 例：`/\.deleteMessage\?\.\(\s*messageCommandTarget,\s*messageId\s*\)/`。
   - 意图不变：仍然断言按 target 派发。
   - 在修改处加注释说明原因：改为 latest-ref 调用。

**测试**（新增到 `tests/turnRowExecutionProcess.test.mjs`）：

- 测试名：`TurnRow memo compares mutation callbacks and injector keeps them stable`。
- 断言 TurnRow 源码匹配：
  - `/prev\.onDeleteMessage === next\.onDeleteMessage/`
  - `/prev\.onEditMessage === next\.onEditMessage/`
- 读取 `SessionRuntimeInjector.tsx` 源码，断言：
  - 匹配 `/latestMessageServicesRef\.current = services;/`；
  - 不匹配 `/\n\s*services\.deleteMessage,\s*\n/`，即依赖数组里不再有 `services.deleteMessage`。

**验证：**

- 运行 `node --test tests/turnRowExecutionProcess.test.mjs tests/sessionRuntimeBindingCoverage.test.mjs tests/sessionMessageCommandBinding.test.mjs tests/sessionSplitEdge.test.mjs`。
- 运行 `npm run typecheck`。

---

## 阶段 4：error 态（进程仍存活）下允许编辑/删除/重发

> 后续修正：可恢复性以「error 来源为轮次级（`turn`）」为准，启动失败 / 进程错误即使进程存活也不恢复，
> 见 `docs/chat-message-ops-review-fix-plan.md` 阶段 A。

**背景：**

- **渲染层**：`src/renderer/src/hooks/useSessionRuntimeController.ts` 第 166–172 行的 `currentSessionLiveAgentId` 排除了 `error`，所以 `canMutateActiveMessages` 为 false，按钮全部隐藏。
- **主进程**：`src/main/sessions/SessionRuntimeCoordinator.ts` 第 152 行的 `isTerminalAgent` 把 `error` 一律视为终止。`getAgentId`（第 241–250 行）一旦被调用，就会解绑该 runtime。之后的 mutation 在 `requireTarget` 失败（`SESSION_RUNTIME_UNAVAILABLE`），下一次激活还会 stop 进程并重建。
- **实际情况**：API 请求失败会置 `error`（`AgentManager.ts` 约 3760、3891、3897 行），但这时 pi 进程仍然存活。只改渲染层是不够的。

**方案：**

- `error` 且进程仍存活时，视为可用 runtime；`closed`，或 `error` 且进程已退出，才视为终止。
- 渲染层同步放开 `error`。

**前提检查：**

- `SessionRuntimeCoordinator.ts` 中 `isTerminalAgent(` 共出现 11 处：1 处定义（约 152 行），10 处调用（约 245、275、330、601、828、933、1015、1042、1125、1133 行）。**全部都在类方法内部**，不能有模块级函数调用它。如果有，停下并询问。
- `SessionAgentGateway` 接口在第 48 行，`createBackend.ts` 约第 258 行把 `agentManager` 直接作为 gateway 传入（结构类型）。
- `AgentManager` 中 `runtime.process.isRunning()` 已存在（约 1522 行有用法）。
- `tests/agentCreateTimeout.test.mjs` 第 40、43 行用正则匹配 `isTerminalAgent\(tab\)` 和 `isTerminalAgent\(mappedTab\)`。

**修改：**

1. `SessionRuntimeCoordinator.ts`：
   - 在 `SessionAgentGateway` 接口中，`isMessageCacheStale?` 之后加：
     ```ts
     /** pi 进程是否仍存活。error 态可能只是一次 API 请求失败（进程仍在），此时 runtime 仍可用。 */
     isRuntimeProcessAlive?(agentId: string): boolean;
     ```
   - 删除模块级函数 `isTerminalAgent`，在类中新增私有方法（放在 `getAgentId` 之前）：
     ```ts
     /**
      * closed 一定终止；error 仅在进程已退出（或 gateway 无法判断）时终止。
      * 为什么：API 请求失败会把 runtime 置为 error 但 pi 进程仍在，若当作终止就会解绑，
      * 导致该会话的编辑/删除/重发全部报「runtime 不可用」，下一次发送还会无谓地重建进程。
      * gateway 未实现存活探测时保持旧语义（error 视为终止）。
      */
     private isTerminalAgent(tab: AgentTab): boolean {
         if (tab.status === "closed") return true;
         if (tab.status !== "error") return false;
         return this.agents.isRuntimeProcessAlive?.(tab.id) !== true;
     }
     ```
   - 10 处调用全部改为 `this.isTerminalAgent(...)`。第 601 行在 `filter` 的箭头函数中，`this` 可用。改完用 `Select-String -Pattern '(?<!this\.)isTerminalAgent\('` 确认只剩方法定义这一处。
2. `AgentManager.ts`：在 `getLocalStreamingFlags`（约 542 行）之后新增公开方法：
   ```ts
   /** 供 SessionRuntimeCoordinator 区分「API 失败的 error」与「进程已退出的 error」。 */
   isRuntimeProcessAlive(agentId: string): boolean {
       return this.agents.get(agentId)?.process.isRunning() === true;
   }
   ```
   如果 `process` 可能为空（看 `AgentRuntime` 类型），就用可选链。
3. `useSessionRuntimeController.ts` 第 166–172 行：
   - 删除 `activeAgent.status !== "error" &&` 这一行。
   - 在上方加注释：error 态可能只是 API 失败、进程仍在，允许变更；进程已退出时由主进程返回 `runtimeUnavailable` 并 toast，不在渲染层猜测。
4. 修改 `tests/agentCreateTimeout.test.mjs` 第 40、43 行的正则：
   - 第 40 行改为 `/if \(tab\.status === "starting" \|\| this\.isTerminalAgent\(tab\)\)/`；
   - 第 43 行改为 `/if \(mappedTab && (?:this\.)?isTerminalAgent\(mappedTab\)/`。
   - 加注释说明原因：改为方法。
5. 修改 `tests/sessionMessageCommandBinding.test.mjs` 第 598–604 行的矩阵用例 5（这是需求变更，要写注释说明）：
   - 注释改为「Agent 状态为 error（如 API 失败，进程仍在） -> canMutateActiveMessages === true」；
   - 断言改为 `true`，消息文案同步修改。
   - 用例 4（closed → false）保持不变。

**新增测试**（`tests/sessionRuntimeCoordinator.test.mjs`）：

- 先改 `createHarness` 的 `agents` 对象，追加一行：
  ```js
  ...(options.isRuntimeProcessAlive ? { isRuntimeProcessAlive: options.isRuntimeProcessAlive } : {}),
  ```
  未传该选项时 gateway 没有这个方法，旧测试语义不变。
- 测试 A `error runtime with a live process stays bound and accepts history mutations`：
  - `createHarness({ isRuntimeProcessAlive: () => true })`；
  - `activateRuntime("session-1")` 得到 target；
  - 把 `harness.tabs[0].status` 设为 `"error"`；
  - 断言 `coordinator.getTarget("session-1")` 的 agentId 仍为 `"agent-1"`；
  - 调 `coordinator.deleteRuntimeMessage(target, "message-1")`，断言 `ok === true` 且 `harness.calls.deleteMessage === 1`；
  - 再调 `activateRuntime("session-1")`，断言 `harness.calls.create === 1`（复用，没有重建）。
- 测试 B `error runtime whose process exited is unbound as before`：
  - 同样流程，但 `isRuntimeProcessAlive: () => false`；
  - 断言 `getTarget("session-1") === undefined`；
  - 断言 `deleteRuntimeMessage` 返回 `ok === false`，`error.code === "SESSION_RUNTIME_UNAVAILABLE"`。
  - 如果实际错误码不同，先读 `commandFailure` 核实，不要硬改。
- 在 `tests/agentNotificationPlatform.test.mjs` 末尾新增测试 C `isRuntimeProcessAlive reflects the pi process`：
  - 用 `createSettledHarness()` + `attachRuntime(manager, "a", { runtimeStatus: "error" })`，断言 `manager.isRuntimeProcessAlive("a") === true`；
  - 把 `manager.agents.get("a").process.isRunning` 改为 `() => false` 后断言为 false；
  - 断言 `manager.isRuntimeProcessAlive("missing") === false`。

**风险说明**（写入最终报告即可，不要扩大改动）：

- API 失败后，用户下一次发送会复用原进程，不再重建。这与 pi 终端行为一致。
- 如果进程卡死，用户仍可手动「重启」。

**验证：**

- 运行 `node --test tests/sessionRuntimeCoordinator.test.mjs tests/agentCreateTimeout.test.mjs tests/sessionMessageCommandBinding.test.mjs tests/agentNotificationPlatform.test.mjs tests/canStopBoundAgent.test.mjs`。
- 运行 `npm run typecheck`。

---

## 阶段 5：error 态 `agent_settled` 也要清理运行期缓存

**背景：**

- `AgentManager.ts` 约 3942–3970 行只在非 error / closed 时执行清理。
- error 态下会残留以下状态：`activeToolCallsByAgent`、`toolExecutingByAgent`（界面显示「工具执行中」）、流式标志、思考通道、`rpcCompactingAgents`，而且不做 `trimRuntimeCache`。

**前提检查：**

- 该分支以 `if (runtime && runtime.tab.status !== "error" && runtime.tab.status !== "closed") {` 开始。
- 分支内依次调用：
  - `finalizeThinkingIntoMessage`
  - `flushMessageEmit`
  - `trimRuntimeCache`
  - `finishThinkingChannel`
  - `activeAssistantMessageIds.delete`
  - `setStreamingAgent(agentId, false)`
  - `toolMessageIds.delete`
  - `textEmitter.cancel`
  - `streamingText.delete`
  - `lastSentTextByAgent.delete`
  - `textPushCountByAgent.delete`
  - `activeToolCallsByAgent.delete`
  - `toolExecutingByAgent.set(agentId, null)`
  - `rpcCompactingAgents.delete`

**修改：**

1. 新增私有方法（放在 `handlePiEvent` 之前的合适位置）：
   ```ts
   /**
    * 一轮真正结束（agent_settled）后的运行期缓存收尾，idle 与 error 共用。
    * 不改 tab.status、不发通知、不 emit：由调用方决定。
    */
   private settleRuntimeCaches(agentId: string): void {
       // 若 message_end 未到（边缘路径），仍先落盘再清 live。
       this.finalizeThinkingIntoMessage(agentId);
       this.flushMessageEmit(agentId);
       // 一轮结束：运行期缓存裁剪到最近 50 轮（含本轮），防止长会话数组无界增长
       this.trimRuntimeCache(agentId);
       // ……（按原顺序搬入上面列出的其余调用，保持原顺序与原注释）
   }
   ```
2. 原 idle 分支改为：
   - `runtime.tab.status = "idle";`
   - `this.settleRuntimeCaches(agentId);`
   - `this.emitState(); void this.emitRuntimeState(agentId);`
   - 后面的通知逻辑不变。
3. 在该 `if` 之后追加：
   ```ts
   else if (runtime && runtime.tab.status === "error") {
       // error 态必须保留（侧栏失败标记、不弹完成通知），但 pi 已 settled：
       // 不清缓存会残留「工具执行中」、live 气泡与压缩标志，后续删除/编辑/重发会被误判为忙碌。
       this.settleRuntimeCaches(agentId);
       this.emitState();
       void this.emitRuntimeState(agentId);
   }
   ```
   `closed` 不处理。

**新增测试**（`tests/agentNotificationPlatform.test.mjs`，放在 `error runtime settled does NOT fire the session-complete notification` 之后）：

- 测试名：`error runtime settled clears tool and streaming caches but keeps error status`。
- 准备：
  - `attachRuntime(manager, "agent-err2", { runtimeStatus: "error" })`；
  - `manager.activeToolCallsByAgent.set("agent-err2", new Map([["call-1", "bash"]]))`；
  - `manager.toolExecutingByAgent.set("agent-err2", "bash")`；
  - `manager.rpcCompactingAgents.add("agent-err2")`。
- 执行：`handlePiEvent("agent-err2", { type: "agent_settled" })`。
- 断言：
  - `activeToolCallsByAgent.has(...) === false`；
  - `manager.getLocalStreamingFlags("agent-err2")` 深等于 `{ isStreaming: false, isExecutingTool: false }`；
  - `rpcCompactingAgents.has(...) === false`；
  - `tab.status === "error"`；
  - `showCalls.length === 0`。

**验证：**

- 运行 `node --test tests/agentNotificationPlatform.test.mjs tests/abortStreamRegression.test.mjs tests/agentManagerRuntimeCache.test.mjs`。
- 运行 `npm run typecheck`。

---

## 阶段 6：按「整轮」删除 + 删除确认文案

**背景：**

- `SessionFileEditor.applyMutation` 的 delete 分支（约 619–675 行）只处理两件事：
  - 墓碑目标本身；
  - 目标上方连续的「纯思考 / toolResult」祖先。
- 由此出现三个问题：
  - 中途带文字的 assistant 片段、它的工具调用、停止后的空回复都会残留，形成悬空的 tool call，pi 下次请求时报错。
  - 删除用户消息时，回复会改挂到上一轮。
  - 确认框文案 `message.deleteReloadPrompt`（「删除后需要重新加载会话才能生效」）有误导性。

**新语义：**

- 设活动分支路径为 `path`（根到叶）。只把 `type === "message"` 的条目视为消息，其他类型（如 `model_change`）保留不删。
- **目标是 user**：删除区间 = 从该 user 起，到 `path` 上下一条 user 消息之前（不含）。
- **目标是 assistant / toolResult**：
  - 锚点 = 目标之前最近的一条 user；
  - 删除区间 = 锚点之后第一条起，到下一条 user 之前（不含）；
  - 没有锚点时，从 `path` 起点开始。
- 只墓碑区间内 `type === "message"` 的条目，墓碑保留原 `parentId`（沿用 `tombstone(id, now, parentIdOf(entry))`）。
- 任何未删除条目（包括下一条 user、区间内被保留的非消息条目、其他分支上的子节点），如果 `parentId` 指向被删条目，就改挂到「沿原父链向上第一个未被删的祖先」；找不到时为 `null`。
- `changedEntryIds` = 被墓碑的 id + 被改挂的 id。

**前提检查：**

- `applyMutation(document, located, kind, newText)` 在 `mutate()` 中被调用（约 568 行），`input.target.activeLeafId` 在 `mutate` 中可用。
- 已有辅助函数：
  - `activeBranchIds(document, activeLeafId)`：返回 Set，插入顺序是叶到根；
  - `parentIdOf`、`entryIdOf`、`inputRole`、`replaceLine`、`tombstone`。

**修改：**

1. `SessionFileEditor.ts`：
   - 给 `applyMutation` 增加第 5 个参数 `activeLeafId: string | undefined`，并在 `mutate()` 调用处传入 `input.target.activeLeafId`。
   - 新增模块级纯函数（放在 `descendantEntryIds` 附近），加中文说明注释：
     ```ts
     /** 整轮删除的消息条目 id（活动分支上、按根→叶顺序）。规则见上方计划「新语义」。 */
     function turnSegmentMessageIds(
         document: JsonlDocument,
         targetEntryId: string,
         activeLeafId: string | undefined,
     ): string[]
     ```
     实现步骤：
     - `const path = [...activeBranchIds(document, activeLeafId)].reverse();`
     - `const at = path.indexOf(targetEntryId)`；如果为 -1，抛出 `SESSION_ENTRY_NOT_FOUND`。
     - 用 `document.entryLineById` 和 `document.lines[i].entry` 取条目。定义 `isUserMessage(id)`：条目 `type === "message"` 且 `inputRole(entry) === "user"`。
     - 按新语义计算 `[start, end)`，返回其中 `type === "message"` 的 id。
   - 把 `kind === "delete"` 分支整体替换为：
     1. `const removeIds = turnSegmentMessageIds(document, located.entryId, activeLeafId);`
     2. **在写墓碑之前**先记录 `originalParent = new Map(removeIds.map(id => [id, parentIdOf(entry)]))`。
     3. 定义 `keptAncestor(id)`：`while (id && removeSet.has(id)) id = originalParent.get(id) ?? null; return id ?? null;`。
     4. 遍历 `document.lines`：对每个未删除、不在 `removeSet` 中、且 `parentIdOf(entry)` 在 `removeSet` 中的条目，设置 `entry.parentId = keptAncestor(parentIdOf(entry))`，调用 `replaceLine`，并把它的 id 记入 changed。
     5. 对 `removeIds` 逐个 `replaceLine(document, lineIndex, tombstone(id, this.now(), originalParent.get(id)))`。
     6. `return [...removeIds, ...reparentedIds];`
   - 删除旧的 `isProcessNode` 相关代码，并在新分支顶部写注释：说明为什么要整轮删除（悬空工具调用会让 pi 请求报错；删 user 时回复不能串到上一轮），以及为什么保留非消息条目（模型切换等设置不能丢）。
   - resend 分支（`truncateForResend`）**不改**。
2. `src/renderer/src/hooks/useSessionMessageCommands.ts` 第 131 行：
   - `message: t("message.deleteReloadPrompt")` 改为 `message: t("message.deleteTurnPrompt")`。
3. i18n：
   - 新增 key：
     - `rendererCopy.zh-CN.ts`：`"message.deleteTurnPrompt": "删除后，这一轮相关的 AI 回复、思考过程和工具调用会一并删除。确定继续？",`
     - `rendererCopy.en-US.ts`：`"message.deleteTurnPrompt": "This also deletes the related AI replies, reasoning and tool calls in this turn. Continue?",`
   - 两个文件都放在 `message.deleteTitle` 附近。
   - 用 `Select-String` 在 `src`、`tests` 中确认 `deleteReloadPrompt` 已无引用后，从两个语言文件中删除该 key。

**修改已有测试**（`tests/sessionFileEditor.test.mjs`，这是有意的需求变更，每处都加注释说明）：

- 第 401 行测试 `delete tombstones the target, reparents direct children...`：
  - 改名为 `deleting a user message removes its whole turn and reparents remaining children to the turn's parent`。
  - 新断言：
    - `u1`、`a1` 的 type 为 `"deleted"`；
    - `a2.parentId === null`；
    - `u2.parentId === null`；
    - `sibling.parentId === null`；
    - `changedEntryIds` 集合为 `{"u1","a1","a2","u2"}`。
- 第 328、373 行的测试应**无需修改**即通过。如果失败，停下报告。

**新增测试**（`tests/sessionFileEditor.test.mjs`）：

1. `deleting the final answer removes the whole reply including interim text and tool calls`：
   - entries：`u1`、`a1a`（parent u1，内容 `[{type:"text",text:"working"},{type:"toolCall",id:"c1",name:"bash",arguments:{}}]`）、`t1`（parent a1a，toolResult `"ok"`）、`a1b`（parent t1，`"done"`）、`u2`（parent a1b，`"next"`）、`a2`（parent u2，`"answer two"`）。
   - 删除 `a1b`（activeLeafId `a2`）。
   - 断言：
     - `a1a`、`t1`、`a1b` 均为 deleted；
     - `u2.parentId === "u1"`；
     - `piActiveMessageTexts(next)` 深等于 `["hello", "next", "answer two"]`（按实际 u1 文本填写）。
2. `deleting an interim assistant fragment removes the same whole reply`：
   - 同样的 entries，删除 `a1a`，断言结果与用例 1 相同。
3. `deleting a user message cascades its replies and joins the next turn to the previous one`：
   - entries：`u1`、`a1`、`u2`、`a2`、`u3`、`a3`（线性）。
   - 删除 `u2`。
   - 断言：
     - `u2`、`a2` 为 deleted；
     - `u3.parentId === "a1"`；
     - 活动文本为 `[u1, a1, u3, a3]`。
4. `non-message entries inside a deleted turn are kept and reparented`：
   - entries：`u1`、`a1`、`{type:"model_change", id:"mc", parentId:"a1", provider:"x", modelId:"y"}`、`u2`（parent mc）、`a2`。
   - 删除 `a1`。
   - 断言：
     - `mc.type === "model_change"` 且 `mc.parentId === "u1"`；
     - `u2.parentId === "mc"`，没有变化。
   - 如果 parser 拒绝这种条目，先读 `parseDocument` 的校验规则，按规则调整这条夹具，并记录下来。
5. `deleting an aborted empty reply removes the dangling tool call before it`：
   - entries：`u1`、`a1`（text + toolCall）、`t1`（toolResult `"Operation aborted"`）、`a1e`（parent t1，content `[]`）。
   - 删除 `a1e`（activeLeafId `a1e`）。
   - 断言：
     - `a1`、`t1`、`a1e` 均为 deleted；
     - 活动文本为 `[u1 文本]`。

**验证：**

- 运行 `node --test tests/sessionFileEditor.test.mjs tests/sessionFileEditorAgentManager.test.mjs tests/sessionMessageCommandBinding.test.mjs`。
- 运行 `npm run typecheck`。
- 反向验证：临时让 `turnSegmentMessageIds` 只返回 `[targetEntryId]`，用例 1、3、5 应变红；然后恢复。

---

## 阶段 7：停止（abort）后的消息定位错位（原因 C）

**背景：**

- 停止后，pi 会往文件里多写一条空的 assistant（`stopReason: "aborted"`），但 PiDeck 的封印闸门丢弃了对应事件，于是文件比缓存多一条 assistant。
- `AgentManager.locateMessageTarget` 第 4 步（约 2662–2708 行）按「从尾部数第几条 user/assistant」映射，因此整体偏移一位。
- 已用真实 `SessionFileEditor` 复现：删除 `a2a` 时实际命中了 `a2b`。

**新映射（按轮锚定）：**

- **user**：只数 user。计算缓存中该 user 之后还有几条 user（记为 k），取文件 user 列表倒数第 k+1 条。
  - 不比较文本，因为缓存里的用户正文可能被 `wrapHostInstruction`、模式或模板改写，和文件不一致。
- **assistant**：
  - 找缓存中它之前最近的 user（锚点）。没有锚点时返回 undefined，走第 5 步兜底。
  - 按同样的「倒数第几条 user」规则找到文件中的锚点 user。
  - 候选 = 文件里该锚点之后、下一条 user 之前的全部 assistant。
  - AgentManager 从最后一个候选往前逐个读正文，取第一条「规范化后与缓存文本相等」的；都不相等时，取最后一条非空候选，再不行取最后一个候选，并记 warn 日志。
  - 最多读 64 个候选。

**前提检查：**

- 第 4 步代码以注释 `// 4. active message sequence 映射得到的 entryId` 开头，以 `// 5. role + exact text，仅最后兼容兜底` 之前结束。
- `this.sessionHistoryReader.readActiveEntryIdentity(sessionPath)` 返回 `activeMessageEntries: Array<{ id; role?; messageId? }>`。
- `readMessageByMessageId(sessionPath, id)` 支持用 entry id 命中，见 `SessionHistoryReader.ts` 约 550 行的 `candidate.id === messageId`。
- `AgentManager.ts` 第 80–90 行从 `"./agentUtils.ts"` 具名导入多个函数。
- 以下 3 个测试文件用对象桩替换 `./agentUtils`：
  - `agentHistoryThinking.test.mjs:172`
  - `agentManagerWslPaths.test.mjs:161`
  - `sessionFileEditorAgentManager.test.mjs:119`

**修改：**

1. `src/main/pi/agentUtils.ts` 末尾新增两个导出纯函数，都要写中文说明注释：
   ```ts
   export type EntryRoleRef = { id: string; role?: string };
   export type MessageEntryMapping =
       | { role: "user"; entryId: string }
       | { role: "assistant"; candidateIds: string[] };

   /** 把运行期缓存中的消息映射到会话文件活动分支条目（按「轮」锚定，容忍 abort 产生的额外 assistant）。 */
   export function mapCachedMessageToEntryCandidates(
       cached: ReadonlyArray<{ id: string; role: string }>,
       entries: ReadonlyArray<EntryRoleRef>,
       messageId: string,
   ): MessageEntryMapping | undefined

   /** 文本比对前的规范化：折叠空白并去首尾空白（缓存与文件的块拼接分隔符可能不同）。 */
   export function normalizeMessageTextForMatch(text: string): string {
       return text.replace(/\s+/g, " ").trim();
   }
   ```
   `mapCachedMessageToEntryCandidates` 的实现：
   - 只考虑 role 为 `user` / `assistant` 的缓存消息和文件条目。
   - 在缓存序列中定位 `messageId`，找不到返回 undefined。
   - 定义 `usersAfter(i)` = 缓存序列中下标大于 i 的 user 数。
   - `fileUsers` = 文件序列中 user 的下标数组。
   - **user**：
     - `k = usersAfter(idx)`，`pos = fileUsers.length - 1 - k`；
     - `pos < 0` 时返回 undefined；
     - 否则返回 `{ role: "user", entryId: fileSeq[fileUsers[pos]].id }`。
   - **assistant**：
     - `p` = idx 之前最近的缓存 user 下标；`p < 0` 时返回 undefined。
     - `k = usersAfter(p)`，`pos = fileUsers.length - 1 - k`；`pos < 0` 时返回 undefined。
     - 从 `fileUsers[pos] + 1` 开始，收集连续条目直到遇到下一条 user；其中 role 为 assistant 的 id 按文件顺序放入 `candidateIds`。
     - 返回 `{ role: "assistant", candidateIds }`，候选可以为空数组。
2. `AgentManager.ts`：
   - 在导入列表中追加 `mapCachedMessageToEntryCandidates` 和 `normalizeMessageTextForMatch`。
   - 替换第 4 步 `try { ... }` 内部的映射逻辑，外层的 `if (cachedMessage && (...))`、`catch` 以及第 5 步都保持不变：
     ```ts
     const identity = await this.sessionHistoryReader.readActiveEntryIdentity(sessionPath);
     const mapping = mapCachedMessageToEntryCandidates(currentMessages ?? [], identity.activeMessageEntries, messageId);
     let mappedEntryId: string | undefined;
     if (mapping?.role === "user") {
         mappedEntryId = mapping.entryId;
     } else if (mapping?.role === "assistant" && mapping.candidateIds.length > 0) {
         // 为什么逐条读正文：abort 后文件会多出空 assistant，同一轮里只有正文相等的那条才是用户点的消息。
         const wanted = normalizeMessageTextForMatch(cachedMessage.text ?? "");
         let lastNonEmpty: string | undefined;
         const limit = Math.max(0, mapping.candidateIds.length - 64);
         for (let i = mapping.candidateIds.length - 1; i >= limit; i -= 1) {
             const id = mapping.candidateIds[i];
             const located = await this.sessionHistoryReader.readMessageByMessageId(sessionPath, id);
             const text = normalizeMessageTextForMatch(located?.text ?? "");
             if (text === wanted) { mappedEntryId = id; break; }
             if (!lastNonEmpty && text) lastNonEmpty = id;
         }
         if (!mappedEntryId) {
             mappedEntryId = lastNonEmpty ?? mapping.candidateIds[mapping.candidateIds.length - 1];
             void this.appLogger?.warn("agent", "Sequence mapping picked assistant without exact text match", { agentId, messageId, entryId: mappedEntryId });
         }
     }
     if (mappedEntryId) {
         // …沿用原来的 info 日志、cachedMessage.meta 回写与 return 结构，把 candidate.id 换成 mappedEntryId
     }
     ```
   - `cachedMessage.text` 的类型以实际为准；如果是必填 string，就去掉 `?? ""`。
3. 三个测试桩文件：在各自的 `./agentUtils` 桩对象中加入两个真实函数。做法：
   - 在文件顶部 `import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";`（如果已有同名导入则复用）；
   - 执行 `const realAgentUtils = loadTsCommonJs("src/main/pi/agentUtils.ts");`；
   - 在桩对象中加 `mapCachedMessageToEntryCandidates: realAgentUtils.mapCachedMessageToEntryCandidates, normalizeMessageTextForMatch: realAgentUtils.normalizeMessageTextForMatch,`；
   - **不要**替换桩里的其他函数。

**新增测试：**

1. 新文件 `tests/messageEntryMapping.test.mjs`，用 `loadTsCommonJs("src/main/pi/agentUtils.ts")` 加载模块。用例：
   - abort 形态：
     - 缓存 `[u1,a1,u2,a2a]`，文件 `[eu1,ea1,eu2,ea2a,ea2b]`（全部 user / assistant）；
     - 映射 `a2a`，结果为 `{role:"assistant", candidateIds:["ea2a","ea2b"]}`。
   - user 不受额外 assistant 影响：
     - 缓存 `[u1,a1,u2,a2]`，文件 `[eu1,ea1,ea1x,eu2,ea2]`；
     - 映射 `u1` 得 `eu1`，映射 `u2` 得 `eu2`。
   - 缓存被裁剪：缓存 `[u2,a2,u3,a3]`，文件含 u1–u3 三轮；映射 `u2` 得 `eu2`。
   - 没有前置 user 的 assistant 返回 undefined。
   - messageId 不存在时返回 undefined。
   - 文件 user 少于缓存（pos < 0）时返回 undefined。
   - `normalizeMessageTextForMatch("a  b\n c ") === "a b c"`。
2. `tests/sessionFileEditorAgentManager.test.mjs` 新增 `abort leaves an extra empty assistant entry -> assistant delete targets the text-matching entry`：
   - 缓存 4 条消息，uuid 的 meta 为空：`u1 "q1"`、`a1 "r1"`、`u2 "q2"`、`a2 "partial"`。
   - `readActiveEntryIdentity` 返回 `e-u1,e-a1,e-u2,e-a2,e-a2x`。
   - `readMessageByMessageId` 桩：按 id 返回文本 `{e-a2:"partial", e-a2x:""}`，其他 id（包括 uuid）返回 undefined。
   - 删除 `a2`，断言 `receivedTarget.entryId === "e-a2"`。
   - 再加一个同结构用例：删除 `u1`，断言 `entryId === "e-u1"`。旧的尾部偏移算法在这里会错位。
3. 已有用例 `same active branch has two identical messages -> sequence mapping resolves canonical entryId`（第 714 行）必须仍然通过。

**验证：**

- 运行 `node --test tests/messageEntryMapping.test.mjs tests/sessionFileEditorAgentManager.test.mjs tests/agentHistoryThinking.test.mjs tests/agentManagerWslPaths.test.mjs tests/agentManagerRuntimeCache.test.mjs tests/sessionResendEntryIds.test.mjs`。
- 运行 `npm run typecheck`。
- 反向验证：临时让 assistant 分支直接取 `candidateIds[candidateIds.length - 1]`，新 AgentManager 用例应变红；然后恢复。

---

## 阶段 8：重发流程修复

**背景：**

问题都在 `src/renderer/src/hooks/useSessionMessageCommands.ts` 的 `resendUserMessage`（约 76–112 行）：

- `resendingIdsRef` 只在 30 秒超时，或状态离开 running / starting 时才清除。prepare 失败后，同一条消息 30 秒内再点**静默无反应**。
- `message.agentId !== expectedTarget.agentId` 时静默 return。
- prepare 已截断文件后，如果 `submitPromptSnapshot` 返回 `false`（它内部已经 toast 了原因），原消息文本就丢了。
- 没有刷新已加载的分页历史，被截断的旧消息可能残留。

**前提检查：**

- `submitPromptSnapshot` 的返回类型是 `Promise<boolean | "unknown">`，失败时 App 已经 toast（`App.tsx` 约 2003–2030 行）。
- `SessionMessageCommandsInput.setPromptForAgent` 当前类型是 `(sessionId: string, text: string) => void`。
- App 的 `setPromptForAgent`（约 745 行）接受 `string | ((current: string) => string)`。

**修改：**

1. `SessionMessageCommandsInput.setPromptForAgent` 类型放宽为：
   ```ts
   setPromptForAgent: (sessionId: string, value: string | ((current: string) => string)) => void;
   ```
   App 的实现已经兼容；fork 路径传 string 也不受影响。
2. 新增 hook 内函数：
   ```ts
   /** prepare 已截断文件但未成功提交时，把原文放回输入框，避免用户消息丢失。
    *  若输入框已有新草稿则前置拼接而不是覆盖。图片无法自动恢复，由提示文案说明。 */
   function restoreResendText(sessionId: string, text: string): void {
       if (!text.trim()) return;
       input.setPromptForAgent(sessionId, (current) => (current.trim() ? `${text}\n\n${current}` : text));
       input.showToast(t("app.resendRestoredToComposer"), 6000);
   }
   ```
3. 重写 `resendUserMessage`，要点如下：
   - `message.agentId` 不匹配时改为 `input.showToast(t("sessionCommand.runtimeChanged"), 5000); return;`，并加注释说明：静默 return 会让用户以为按钮坏了。
   - 「正在重发」锁命中时仍然静默 return，这是防连点，属于预期行为。
   - 加锁后定义 `releaseLock`：`clearTimeout(timer)`、`resendTimersRef.current.delete(timer)`、`resendingIdsRef.current.delete(message.id)`。30 秒定时器保留作兜底。
   - 在调用 prepare **之前**执行 `const refreshSnapshot = input.captureHistoryMutationRefresh?.(currentTarget.sessionId) ?? null;`。
   - 用 `let truncatedText: string | undefined;` 记录已截断的原文。
   - Promise 链结构：
     ```ts
     void api.sessions.prepareRuntimeResend(currentTarget, message.id)
         .then((result) => requireSessionCommand(result).value)
         .then(async (snapshot) => {
             truncatedText = snapshot.text; // 从这里起文件已截断，任何失败都要把原文还给用户
             if (refreshSnapshot && input.refreshHistoryAfterMutation) {
                 await input.refreshHistoryAfterMutation(refreshSnapshot);
             }
             requireCurrentRuntimeTarget(currentTarget);
             return input.submitPromptSnapshot(currentTarget.sessionId, snapshot.text, snapshot.images);
         })
         .then((submitted) => {
             // false：App 已 toast 失败原因，这里补回原文；"unknown"：可能已投递，不回填以免重复发送。
             if (submitted === false && truncatedText !== undefined) {
                 restoreResendText(currentTarget.sessionId, truncatedText);
             }
         })
         .catch((error) => {
             // 保留原有的 RESEND_IMAGE_BUDGET_EXCEEDED / 其他错误 toast 逻辑
             if (truncatedText !== undefined) restoreResendText(currentTarget.sessionId, truncatedText);
         })
         .finally(releaseLock);
     ```
4. i18n 新增 key，放在 `app.resendTitle` 附近：
   - zh：`"app.resendRestoredToComposer": "重新发送未成功，原消息已放回输入框（图片需要重新添加）。",`
   - en：`"app.resendRestoredToComposer": "Resend did not go through. The original message is back in the input box (re-attach any images).",`

**新增测试**（`tests/sessionMessageCommandBinding.test.mjs`，使用现有的 `createHookEnvironment(currentTargetRef, overrides)`；`overrides.desktopApi` 覆盖 API，`overrides.input` 覆盖输入）：

1. `resend releases its lock after prepare fails so an immediate retry reaches the API`：
   - `prepareRuntimeResend` 第一次返回 `{ ok: false, error: { code: "SESSION_COMMAND_FAILED", message: "x" } }`，第二次返回成功。
   - 连续两次 `resendUserMessage`，中间用 `await flushMicrotasks()` 分隔。
   - 断言有 2 次 prepare 调用、1 次 submit。
   - 错误对象字段以 `SessionCommandError` 类型为准。
2. `resend restores the prepared text to the composer when submission fails`：
   - `submitPromptSnapshot` 返回 `false`，`setPromptForAgent` 捕获参数。
   - 断言它被调用一次、sessionId 为 `"session-1"`，且以 `""` 调用 updater 得到 `"resend-text"`。
   - 断言 toast 中包含 `app.resendRestoredToComposer`。
3. `resend does not restore when delivery is unknown`：`submitPromptSnapshot` 返回 `"unknown"`，断言 `setPromptForAgent` 未被调用。
4. `resend of a message from another runtime reports runtimeChanged instead of doing nothing`：
   - `message.agentId = "agent-old"`，target 的 agentId 为 `"agent-1"`。
   - 断言没有 prepare 调用，toast 中包含 `sessionCommand.runtimeChanged`。
5. `resend refreshes loaded history after truncation and before submitting`：
   - 注入 `captureHistoryMutationRefresh` 和 `refreshHistoryAfterMutation`，都往 `commandEvents` 推事件。
   - 断言事件类型顺序为 `capture` → `api:prepareResend` → `refresh` → `submit`。

**验证：**

- 运行 `node --test tests/sessionMessageCommandBinding.test.mjs tests/sessionHistoryMutationRefreshFlow.test.mjs`。
- 运行 `npm run typecheck`。
- 反向验证：临时删掉 `.finally(releaseLock)`，用例 1 应变红；然后恢复。

---

## 阶段 9：全量门禁与报告

1. `npm run typecheck`，限时 600 秒，必须退出码 0。
2. 全量 `npm test`：
   - **上一次全量运行被中途中止，这一次必须跑完**。
   - 用 `Start-Process`，限时至少 1200 秒，输出重定向到临时文件。结束后用 `Select-String -Pattern '^# (tests|pass|fail|skipped)'` 提取汇总，然后删除临时文件。
   - 基线参考：3221 个测试，3218 通过，0 失败，3 跳过；加上本计划新增的测试，总数会增加。
   - 必须 0 fail。出现失败时：
     - 与本计划相关的，回到对应阶段修复；
     - 无关的已有失败，记录下来，不修。
3. `git diff --check`，应无输出。
4. `git status --short`，确认没有残留的 `tests/tmp-*`、临时输出文件或 `.bak` 文件。
5. 用中文输出最终报告，包括：
   - 每个阶段改了哪些文件、函数和行号；
   - 新增 / 修改的测试，以及每条已修改测试对应的需求变更理由；
   - 反向验证结果；
   - typecheck 与全量测试的汇总数字；
   - 风险与未验证项：
     - 阶段 4：API 失败后改为复用进程；
     - 阶段 6：pi 对「连续两条 user 消息」上下文的处理，依赖 provider 行为；
     - 阶段 7：Anthropic 等其他 provider 的 abort 事件顺序未验证；
     - UI 未做人工冒烟。
6. **不要提交**。报告末尾询问用户是否需要提交。
