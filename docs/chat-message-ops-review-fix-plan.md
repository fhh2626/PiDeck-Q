# 聊天消息操作修复 · Review 问题修复计划（执行者：Implementor LLM）

> 来源：对 `docs/chat-message-ops-fix-plan.md`（9 阶段，已执行）的 review 结论。
> 基线：当前未提交工作区，全量门禁为 3254 条用例：3251 通过 / 0 失败 / 3 跳过。
> 行号取自 2026-09-30 的工作区快照，**动手前先用 `Select-String` 复核**；行号对不上时，以文中引用的代码片段为准。

## 0. 执行总规则（每个阶段都适用）

1. **不提交**：禁止 `git add` / `git commit` / `git push` / 建分支。
2. **前提不成立就停**：每个阶段开头都有「前提检查」。任何一条不符合，就停止该阶段，用 `ask_question` 说明实际看到的代码；不要自行发明替代方案。
3. **编码规范**：
   - 禁止 `any`，禁止 `as` 断言，禁止新增非空断言 `!`。
   - 新增或修改的逻辑都要写中文注释，说明**为什么**这样做。
   - 用户可见文案走 i18n，zh-CN / en-US 同步添加。
   - 不新增 npm 依赖。
4. **文件编辑**：
   - 只用 edit 工具做精确替换。
   - **禁止**用 `Set-Content` / `Out-File` / `Get-Content | Set-Content` 重写文件，否则会破坏 UTF-8 中文和缩进。
   - 缩进要先看清：`src/` 下多为 tab，`tests/*.test.mjs` 多为 2 空格，`agentNotificationPlatform.test.mjs` 为 tab。
   - 一次 edit 调用内的多处替换是「全成或全败」，改完用 `read` 核对。
5. **Shell**：环境是 PowerShell，没有 `rg`，用 `Select-String` 代替。
6. **测试运行**：一律限时执行，模板如下：
   ```powershell
   $p = Start-Process -FilePath node -ArgumentList '--test','tests/xxx.test.mjs' -RedirectStandardOutput "$env:TEMP\t.out" -RedirectStandardError "$env:TEMP\t.err" -NoNewWindow -PassThru
   if (-not (Wait-Process -Id $p.Id -Timeout 300 -ErrorAction SilentlyContinue)) { }
   if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force }
   Select-String -Path "$env:TEMP\t.out" -Pattern 'tests \d|pass \d|fail \d|✖ '
   Remove-Item "$env:TEMP\t.out","$env:TEMP\t.err" -ErrorAction SilentlyContinue
   ```
   - 模板结尾总会多打一行 `TIMEOUT`，这是误报，以 `ℹ tests / pass / fail` 计数为准。
   - `npm` 命令用 `cmd.exe /c "npm run typecheck 2>&1"` 跑。`Start-Process npm` 在本机会报「不是有效的 Win32 应用程序」。
7. **vm 沙箱测试的坑**：
   - 用 `loadTsCommonJs` / `vm` 加载出来的对象属于另一个 realm，`assert.deepEqual` 会因原型不同而失败，请逐字段断言。
   - 跨 realm 时 `error instanceof Error` 为 false，toast 文本会是 `"Error: xxx"` 这种形式。
8. **反向验证**：
   - 每个新测试都要做一次：临时破坏被测逻辑 → 确认变红 → 恢复 → 用 `Select-String` 确认破坏代码已不存在。
   - 临时探针文件（`tests/tmp-*`）用完即删。
9. **阶段门禁**：每个阶段结束都要跑本阶段列出的定向测试和 `npm run typecheck`，全绿后才进入下一阶段。
10. **不修无关失败**：遇到与本计划无关的既有失败，只记录、只报告。

## 阶段总览

| 阶段 | 级别 | 问题 | 主要文件 |
|---|---|---|---|
| A | 🔴 必须 | 启动失败（`get_state` 失败但进程仍在）被当成「可用 error runtime」，不再判为启动失败、不再清理 | `AgentManager.ts`、`SessionRuntimeCoordinator.ts` |
| B | 🟠 | 重发在 prepare 失败（文件未截断）时也把正文塞回输入框，导致重复 | `useSessionMessageCommands.ts` |
| C | 🟠 | WSL 模式下 `PIDECK_UI_LANGUAGE` 传不进 Linux 侧；语言注入链路没有测试 | `PiProcess.ts`、`AgentManager.ts` 相关测试 |
| D | 🟡 | 注释理由不准确、非空断言、compaction 引用未覆盖、文档数字/限制说明 | 多处 |
| E | — | 全量门禁与报告 | — |

执行顺序为 A → B → C → D → E。A 必须最先做。

---

## 阶段 A：只有「轮次级 API 失败」才算可恢复的 error（🔴 必须）

### 问题

- 原阶段 4 的做法是：让 `SessionRuntimeCoordinator.isTerminalAgent` 在 `error` 且 `isRuntimeProcessAlive === true` 时返回 false。
- 但 `AgentManager.create` 在 `this.agents.set(id, runtime)`（约 1233 行）之后才请求 `get_state`（约 1281 行）。如果 `get_state` 超时或失败，约 1406 行的 catch 只会置 `tab.status = "error"`，**不会停止进程**。
- 此时 `process.isRunning()`（`PiProcess.ts` 约 474 行，判断的是 `proc !== undefined && rpc !== undefined`）仍为 true，于是协调器里下面这些「启动失败」判断全部失效：
  - 约 1055 行：`if (this.isTerminalAgent(tab)) { stop; throw startupFailure }`
  - 约 1146 行：`if (tab.status === "starting" || this.isTerminalAgent(tab))` 超时清理
  - 约 841 行：restart 后的终止判断
- 后果：半启动的 runtime 会被绑定，并继续走 `applyPreferences`。

### 设计

- **目标**：用「error 的来源」取代「进程是否存活」作为判断依据。
- AgentManager 为每个 agent 记录最近一次进入 error 的来源：`"turn" | "startup" | "process"`。
- 只有来源为 `"turn"` 且进程存活时，error 才算可恢复。
- 不变式：**所有**把 status 设为 `"error"` 的位置都必须同时写入来源。这样只要状态是 error，来源就一定对应最近一次失败，不需要在变成 running / idle 时再去清理。

### 前提检查（任一不符就停）

1. 运行 `Select-String -Path src/main -Recurse -Pattern 'status = "error"'`：
   - 命中必须**只在** `src/main/pi/AgentManager.ts` 内，且恰好是下面 8 处（行号可能漂移）：
   - 约 1251：`tab.status = "error";`（`process.start()` 抛错，create 路径）
   - 约 1406：`tab.status = "error";`（create 的 catch，包括 `get_state` 失败）
   - 约 1542：`runtime.tab.status = "error";`（prompt 前发现进程已停）
   - 约 1701：`runtime.tab.status = "error";`（command 前发现进程已停）
   - 约 3469：`if (runtime) runtime.tab.status = "error";`（`piProcess.on("error")`）
   - 约 3799：`runtime.tab.status = "error";`（`auto_retry_end` 最终失败）
   - 约 3930：`if (runtime) runtime.tab.status = "error";`（`agent_end` 带 errorMsg）
   - 约 3936：`if (runtime) runtime.tab.status = "error";`（`agent_end` 的 `stopReason === "error"`）
   - 如果还有别的文件或别的位置在置 error，停下报告。
2. 约 1251 与约 1406 两处所在函数内，agent id 的变量名是 `id`（例如约 1233 行的 `this.agents.set(id, runtime)`）。
3. `this.agents.delete(agentId)` 恰好出现两处（约 3047 行在 restart 内，约 3296 行在 stop 内）。
4. 全仓只有以下位置引用 `isRuntimeProcessAlive`：
   - `src/main/pi/AgentManager.ts`（定义）
   - `src/main/sessions/SessionRuntimeCoordinator.ts`（约 56 行接口、约 251 行调用）
   - `tests/agentNotificationPlatform.test.mjs`（约 410–420 行）
   - `tests/sessionRuntimeCoordinator.test.mjs`（约 237、389、419 行）

### 修改

1. **`src/main/pi/AgentManager.ts`**
   - 在类字段区（与 `recentlyAborted` 等 Set/Map 放在一起）新增：
     ```ts
     /**
      * 最近一次进入 error 的来源。只有 "turn"（一轮对话里的 API/模型失败）且进程仍在时，
      * 协调器才把 error runtime 视为可继续使用；启动失败（get_state 超时等）虽然进程也可能还在，
      * 但 runtime 从未就绪，必须仍按启动失败处理（停止 + 不绑定）。
      */
     private readonly errorOriginByAgent = new Map<string, "turn" | "startup" | "process">();
     ```
   - 新增私有方法（放在 `settleRuntimeCaches` 附近）：
     ```ts
     /** 置 error 必须同时记录来源：保证 status === "error" 时来源总是最近一次失败的原因。 */
     private markAgentError(agentId: string, tab: AgentTab, origin: "turn" | "startup" | "process"): void {
     	tab.status = "error";
     	this.errorOriginByAgent.set(agentId, origin);
     }
     ```
     `AgentTab` 类型已在本文件导入；如果没有，停下报告。
   - 把前提 1 中的 8 处逐一替换：

     | 位置 | 替换为 |
     |---|---|
     | ~1251 | `this.markAgentError(id, tab, "startup");` |
     | ~1406 | `this.markAgentError(id, tab, "startup");` |
     | ~1542 | `this.markAgentError(input.agentId, runtime.tab, "process");`（先确认该函数里 agentId 的变量名，按实际使用） |
     | ~1701 | `this.markAgentError(agentId, runtime.tab, "process");` |
     | ~3469 | `if (runtime) this.markAgentError(agentId, runtime.tab, "process");` |
     | ~3799 | `this.markAgentError(agentId, runtime.tab, "turn");` |
     | ~3930 | `if (runtime) this.markAgentError(agentId, runtime.tab, "turn");` |
     | ~3936 | `if (runtime) this.markAgentError(agentId, runtime.tab, "turn");` |

     - 每处原有注释保留。
   - 在两处 `this.agents.delete(agentId);` 之后各加一行 `this.errorOriginByAgent.delete(agentId);`，并写注释说明这是配对清理，防止 Map 无界增长。
   - 把 `isRuntimeProcessAlive` **整体替换**为：
     ```ts
     /**
      * 供 SessionRuntimeCoordinator 判断 error runtime 能否继续使用（编辑/删除/重发/复用进程）。
      * 必须同时满足：当前是 error、来源是轮次级失败、pi 进程仍在。
      * 为什么不只看进程存活：create 阶段 get_state 失败也会留下存活进程 + error 状态，
      * 那是从未就绪的 runtime，按可用处理会跳过启动失败清理并把半启动进程绑定到会话。
      */
     isRecoverableErrorRuntime(agentId: string): boolean {
     	const runtime = this.agents.get(agentId);
     	if (!runtime || runtime.tab.status !== "error") return false;
     	return this.errorOriginByAgent.get(agentId) === "turn" && runtime.process.isRunning();
     }
     ```
2. **`src/main/sessions/SessionRuntimeCoordinator.ts`**
   - 约 52–56 行，接口方法改名并更新注释：
     ```ts
     /**
      * error runtime 是否仍可使用：仅当 error 来自一轮对话内的 API 失败且 pi 进程仍在时为 true。
      * 启动失败 / 进程错误均为 false；未实现时 error 保持终止语义（fail-closed）。
      */
     isRecoverableErrorRuntime?(agentId: string): boolean;
     ```
   - 约 251 行改为 `return this.agents.isRecoverableErrorRuntime?.(tab.id) !== true;`，同步更新 `isTerminalAgent` 上方的注释，把「进程已退出」改为「非轮次级错误或进程已退出」。
   - **不要**改 `!== true` 这个 fail-closed 写法。
3. 运行 `Select-String -Recurse -Path src -Pattern 'isRuntimeProcessAlive'`，结果应为 0 条。

### 测试

1. **`tests/sessionRuntimeCoordinator.test.mjs`**
   - 约 237 行，把 harness 选项 `isRuntimeProcessAlive` 全部改名为 `isRecoverableErrorRuntime`（包括展开写法里的键名）。
   - 约 389、419 行的两个测试：同步改名；测试名改为：
     - `recoverable (turn-level) error runtime stays bound and accepts history mutations`
     - `non-recoverable error runtime is unbound as before`
   - 断言内容不变。
   - 新增测试 `startup error stays a startup failure even when the gateway reports recoverability`：
     - 复制约 684 行 `keeps a draft unbound when Agent startup fails` 的全部内容。
     - 在 `createHarness({...})` 中额外传入 `isRecoverableErrorRuntime: () => false`。
     - 断言与原测试完全相同：`accepted === false`、`delivery === "rejected"`、`entry.status === "draft"`、`calls.stop === 1`。
     - 意义：确认存在该 gateway 方法时，启动失败路径仍然停进程、不绑定。
2. **`tests/agentNotificationPlatform.test.mjs`**（tab 缩进）
   - 删除 `isRuntimeProcessAlive reflects the pi process` 测试，改为下面 3 个。均使用已有的 `createSettledHarness` / `attachRuntime`：
     - **a.** `turn-level agent_end error is recoverable while the process lives`：
       - `attachRuntime(manager, "agent-turn", { runtimeStatus: "running" })`。
       - `manager.handlePiEvent("agent-turn", { type: "agent_end", messages: [], errorMessage: "503 upstream" })`。
       - 断言 `tab.status === "error"`，`manager.isRecoverableErrorRuntime("agent-turn") === true`。
       - 再执行 `manager.agents.get("agent-turn").process.isRunning = () => false`，断言结果变为 false。
       - 若 `agent_end` 的 `messages` 字段结构不对导致没有进入 error，先 `read` 约 3880–3940 行，按实际的字段构造事件；不要改源码。
     - **b.** `error status without a turn-level origin is not recoverable`：
       - `attachRuntime(manager, "agent-raw", { runtimeStatus: "error" })`，这样 tab 是 error 但没有来源，模拟启动失败路径。
       - 断言 `manager.isRecoverableErrorRuntime("agent-raw") === false`，`manager.isRecoverableErrorRuntime("missing") === false`。
     - **c.** `a later process error overrides an earlier turn-level origin`：
       - 先按 a 的方式触发 turn error。
       - 再 `manager.handlePiEvent` 无法触发 process error，因此改为直接调用私有方法：`manager.markAgentError("agent-turn2", tab, "process")`。vm 加载后私有方法可以直接调用，现有测试已有访问 `manager.agents` 等私有成员的先例。
       - 断言结果为 false。
3. **新文件 `tests/agentStartupErrorRecoverability.test.mjs`**（2 空格缩进）——这是回归测试的核心。
   - 以 `tests/agentManagerSecurityRecovery.test.mjs` 为模板：包括 `MockPiProcess`、`loadTsCommonJs` 以及 `node:fs` / `node:fs/promises` / `./SessionHistoryReader` 的 stubs，还有 AgentManager 构造参数的顺序。
   - `MockPiProcess` 的差异：
     - `client.request` 对 `get_state` 抛 `new Error("get_state timeout")`。
     - 新增 `isRunning() { return this.started; }`。
   - 调用 `const tab = await manager.create({ projectId, sessionPath })`，`securityStore` 这个构造参数传 `undefined`。
   - 断言：
     - `tab.status === "error"`；
     - `processes[0].isRunning() === true`，确认进程确实还活着，这正是 bug 的前提；
     - `manager.isRecoverableErrorRuntime(tab.id) === false`。
   - 如果 `create` 在这种情况下是 reject 而不是返回 error tab，停下报告（说明前提与分析不符）。
   - 用 `t.after(() => manager.stopAll())` 清理。
4. **`tests/agentCreateTimeout.test.mjs`**：这是静态正则测试。确认它不引用 `isRuntimeProcessAlive`；如有引用，同步改名。

### 反向验证

- 把 `isRecoverableErrorRuntime` 中的 `this.errorOriginByAgent.get(agentId) === "turn" &&` 临时删掉：新文件测试和 2b 应变红。恢复后确认。
- 把 ~3930 处临时改回 `runtime.tab.status = "error"`：2a 应变红。恢复后确认。

### 验证

- 定向运行：`tests/sessionRuntimeCoordinator.test.mjs`、`tests/agentNotificationPlatform.test.mjs`、`tests/agentStartupErrorRecoverability.test.mjs`、`tests/agentCreateTimeout.test.mjs`、`tests/sessionRuntimeBindingCoverage.test.mjs`、`tests/agentManagerSecurityRecovery.test.mjs`。
- `npm run typecheck`：AgentManager 作为 gateway 按结构类型传入，接口改名后 typecheck 必须仍然通过。

---

## 阶段 B：只有文件已截断时才恢复重发正文（🟠）

### 问题

`src/renderer/src/hooks/useSessionMessageCommands.ts` 的 `resendUserMessage` 在 catch 中**无条件**调用 `restoreResendText`。

- 当 `prepareRuntimeResend` 本身失败（busy、`RESEND_IMAGE_BUDGET_EXCEEDED`、runtime 不可用）时，文件并未截断，原消息仍在时间线上。
- 这时再把正文塞进输入框，用户一发送就会重复。

### 前提检查

1. 约 116 行：`let truncatedText = message.text;`。
2. catch 块内最后一行是 `restoreResendText(currentTarget.sessionId, truncatedText);`。
3. `tests/sessionHistoryMutationRefreshFlow.test.mjs` 约 332 行存在测试 `resend restores the message text into the composer and releases the lock on failure`，其 `prepareRuntimeResend` 直接抛 `"prepare boom"`，并断言 `toasts` 深等于 `["Error: prepare boom", "app.resendRestoredToComposer"]`。

### 修改

1. 把 `let truncatedText = message.text;` 改为：
   ```ts
   // 只有 prepare 成功（文件已截断、原消息已从时间线消失）才需要把正文还给用户；
   // prepare 自身失败时原消息仍在，恢复会造成重复发送。
   let preparedText: string | undefined;
   ```
2. prepare 成功后，把 `truncatedText = snapshot.text;` 改为 `preparedText = snapshot.text;`。
3. `submitted === false` 分支改为 `if (submitted === false && preparedText !== undefined) restoreResendText(currentTarget.sessionId, preparedText);`。
   - 此处 `preparedText` 必然已赋值，但显式判断能让类型收窄，而且不需要 `!`。
4. catch 块最后一行改为 `if (preparedText !== undefined) restoreResendText(currentTarget.sessionId, preparedText);`。
5. `restoreResendText` 本身不改。

### 测试（`tests/sessionHistoryMutationRefreshFlow.test.mjs`，2 空格缩进）

1. **修改**约 332 行的测试（需求变更，属于有意修改）：
   - 改名为 `resend does not restore text when prepare fails before truncating, but releases the lock`。
   - 断言改为：
     - `toasts` 仅含 `"Error: prepare boom"`，可以用 `assert.equal(toasts.length, 1)` 加 `assert.match`；
     - `prompts.length === 0`；
     - 锁释放部分（第二次调用后 `prepareCalls === 2`）保留。
   - 删除原来对 `restored.value` 的 updater 断言，这部分由第 2 条的新测试接手。
2. **新增** `resend restores the truncated text when the runtime changes after prepare`：
   - 已有的 `loadMessageCommands` 把 `requireSessionCommand` stub 成恒等函数，所以 `prepareRuntimeResend` 必须返回 `{ value: { text: "truncated text", images: [] } }`。先 `read` 约 394–435 行的 unknown 测试，确认该文件现有 stub 的返回形状，然后照抄。
   - 让 `getRuntimeTargetForSession` 在 prepare 返回后改为返回新 generation（用一个可变变量 `currentTarget`，在 `prepareRuntimeResend` 内部把它改掉），使 `requireCurrentRuntimeTarget` 抛错。
   - 断言：
     - `submitPromptSnapshot` 未被调用；
     - `prompts` 恰好 1 条，`typeof value === "function"`，`value("") === "truncated text"`，`value("typed later") === "truncated text\n\ntyped later"`；
     - toasts 包含 `app.resendRestoredToComposer`。
3. 约 394 行的 unknown 测试和 `submitted === false` 路径的断言应无需修改，跑一遍确认。
4. `tests/sessionMessageCommandBinding.test.mjs` 约 726 行的测试（prepare 期间 runtime 变化）：该场景 prepare 已成功，仍应恢复。跑一遍确认它保持绿。

### 反向验证

- 把 catch 中的 `if (preparedText !== undefined)` 临时去掉，改成用 `message.text` 恢复：修改后的第 1 条测试应变红。恢复后确认。

### 验证

- 定向运行 `tests/sessionHistoryMutationRefreshFlow.test.mjs`、`tests/sessionMessageCommandBinding.test.mjs`。
- `npm run typecheck`。

---

## 阶段 C：WSL 传递 UI 语言 + 注入链路测试（🟠）

### 问题

1. WSL 模式下 PiDeck 通过 `wsl.exe -d <distro> ... pi` 启动（`PiLocator.createInvocation`，约 207 行）。Windows 环境变量只有列在 `WSLENV` 中才会传进 Linux 进程。
   - 全仓没有 `WSLENV`，所以扩展读不到 `PIDECK_UI_LANGUAGE`，英文界面用户在 WSL 下看到的仍是中文。
2. 没有测试断言 `PiProcess` 会写 `env.PIDECK_UI_LANGUAGE`，也没有测试断言 `AgentManager` 会把 `getLocale()` 作为 `uiLocale` 传给它。

### 范围决定（不得擅自扩大）

- **只**把 `PIDECK_UI_LANGUAGE` 加入 `WSLENV`。
- `PIDECK_SECURITY_CONFIG` / `PIDECK_SESSION_ID` / `PIDECK_SECURITY_GATE_EXTENSION` 在 WSL 下同样传不进去。但把它们加进去会**改变**安全门在 WSL 下的实际生效行为，需要所有者单独决策。
  - 本阶段不动它们，只在最终报告的「遗留问题」中列出。

### 前提检查

1. `src/main/pi/PiProcess.ts` 约 367 行：`const env = this.locator.createProcessEnv(this.settings, invocation.pathPrefix, invocation.wsl);`。
2. 约 385–388 行存在 `if (this.options.uiLocale) { env.PIDECK_UI_LANGUAGE = this.options.uiLocale; }`。
3. `invocation.wsl` 在 WSL 模式下为非空对象，原生模式下为 `undefined`（见 `PiLocator.createInvocation`）。
4. `tests/piProcessWsl.test.mjs` 中的 `loadPiProcess(spawnCalls)` 会记录 `spawn` 的 `options`；`createLocator` 的 `createProcessEnv` 返回 `{}`。

### 修改（`src/main/pi/PiProcess.ts`）

1. 在文件顶部的纯函数区（类定义之前）新增并导出（便于单测）：
   ```ts
   /**
    * 把变量名追加进 WSLENV（冒号分隔、去重、保留已有项）。
    * 为什么：wsl.exe 只把 WSLENV 列出的 Windows 环境变量传进 Linux 进程，
    * 否则扩展在 WSL 内读不到宿主注入的值（如界面语言）。值是纯字符串，不加 /p 路径转换标志。
    */
   export function appendWslEnvName(current: string | undefined, name: string): string {
   	const names = (current ?? "").split(":").map((item) => item.trim()).filter(Boolean);
   	const exists = names.some((item) => item.split("/")[0] === name);
   	return exists ? names.join(":") : [...names, name].join(":");
   }
   ```
2. 把 `uiLocale` 注入块改为：
   ```ts
   if (this.options.uiLocale) {
   	env.PIDECK_UI_LANGUAGE = this.options.uiLocale;
   	// WSL：必须登记到 WSLENV，否则 Linux 侧的 pi 扩展读不到界面语言而回退中文。
   	if (invocation.wsl) env.WSLENV = appendWslEnvName(env.WSLENV, "PIDECK_UI_LANGUAGE");
   }
   ```
   - 原来那句「WSL 模式无需路径转换」的注释保留，并补充说明：不需要路径转换，但需要登记到 WSLENV。

### 测试

1. **`tests/piProcessWsl.test.mjs`**（tab 缩进，以文件实际为准）
   - 新增测试 `WSL spawn forwards the UI language through WSLENV`：
     - 参照首个测试，构造 `new PiProcess(cwd, settings, createLocator([]), { uiLocale: "en-US" })`，然后 `await process.start(...)`。
     - 断言 `spawnCalls[0].options.env.PIDECK_UI_LANGUAGE === "en-US"`，且 `spawnCalls[0].options.env.WSLENV.split(":")` 包含 `"PIDECK_UI_LANGUAGE"`。
   - 新增测试 `WSLENV merge keeps existing entries and does not duplicate`：
     - 从 `loadPiProcess([])` 的导出中取 `appendWslEnvName`。
     - 断言：
       - `appendWslEnvName(undefined, "A") === "A"`
       - `appendWslEnvName("USERPROFILE/p:A", "A") === "USERPROFILE/p:A"`
       - `appendWslEnvName("USERPROFILE/p", "A") === "USERPROFILE/p:A"`
2. **原生模式**：在同一文件新增 `native spawn sets PIDECK_UI_LANGUAGE without WSLENV`：
   - 写一个内联 locator：`resolveCommand` 返回 `"pi"`；`createInvocation` 返回 `{ command: "pi", args, shell: false }`，**不带 wsl**；`createProcessEnv` 返回 `{}`。
   - 用普通本地目录作为 cwd，例如 `process.cwd()`。
   - 断言 `env.PIDECK_UI_LANGUAGE === "en-US"`，且 `env.WSLENV === undefined`。
   - 如果 PiProcess 原生路径依赖了该 harness 未 stub 的模块而无法启动，改为只保留 WSL 测试，并在报告中说明。
3. **AgentManager → PiProcess 传递**：在阶段 A 新建的 `tests/agentStartupErrorRecoverability.test.mjs` 中追加测试 `create passes platform locale to PiProcess as uiLocale`：
   - 同一模板，`get_state` 正常返回。
   - AgentManager 构造时通过 `platformDeps` 参数传 `{ getLocale: () => "en-US" }`。先 `read` AgentManager 构造函数确认 `platformDeps` 是第几个位置参数，以及其余必填字段；按 `tests/agentNotificationPlatform.test.mjs` 中 `createSettledHarness` 的 `platformDeps` 构造补齐。
   - 断言 `processes[0].options.uiLocale === "en-US"`。

### 反向验证

- 临时删掉 `if (invocation.wsl) env.WSLENV = ...` 这一行：WSL 测试应变红。恢复。
- 临时把 AgentManager 中的 `uiLocale: this.platformDeps?.getLocale?.()` 改成 `uiLocale: undefined`：第 3 条测试应变红。恢复。

### 验证

- 定向运行 `tests/piProcessWsl.test.mjs`、`tests/agentStartupErrorRecoverability.test.mjs`、`tests/piProcessErrorSafety.test.mjs`、`tests/securityGateContract.test.mjs`。
- `npm run typecheck`。
- 本机没有 WSL 实机验证条件，报告中标注「未在真实 WSL 发行版验证」。

---

## 阶段 D：小问题收尾（🟡）

### D1. 修正错误的注释理由（仅改注释）

- `src/main/pi/AgentManager.ts` 中 `agent_settled` 的 error 分支注释（约 3997–3999 行），以及 `settleRuntimeCaches` 的 JSDoc（约 4602–4607 行），都写了「会被 `ensureAgentIdle` 误判为忙碌」。
  - 这不对：`ensureAgentIdle`（约 2601 行）只在 `status === "running"` 时检查，error 态根本走不到那里。
- 改为（两处措辞保持一致）：
  > 不清理会残留流式/工具执行/压缩标志，渲染层据此把会话视为运行中（isStreaming / agentRunning），隐藏编辑/删除/重发按钮，且 live 气泡残留。
- `tests/agentNotificationPlatform.test.mjs` 中 `error runtime settled clears tool and streaming caches but keeps error status` 上方的注释也按同样口径修改。

### D2. 去掉非空断言（`resources/extensions/pideck-q-change-pi-prompt/copy.ts`）

把 `resolveExtensionLocale` 前两行改为：
```ts
const raw = env?.[UI_LANGUAGE_ENV_NAME];
const injected = typeof raw === 'string' ? raw.trim() : '';
```
行为不变，然后运行 `node --test resources/extensions/pideck-q-change-pi-prompt/tests/copy.test.mjs`。

### D3. compaction 引用的回归测试（`tests/sessionFileEditor.test.mjs`）

**背景**：整轮删除会墓碑更多条目。pi 的 `compaction` 条目通过 `firstKeptEntryId` 引用一条消息。墓碑会保留原 id 和 parentId，所以这个引用在理论上仍能解析。这里补一个测试把这一不变式固定下来，**不改源码**。

- 先 `read` 约 520 行的 `non-message entries inside a deleted turn are kept and reparented`，复用它的文件构造与读回方式。
- 新增测试 `whole-turn delete keeps a compaction whose firstKeptEntryId points into the deleted turn`。活动分支构造为：
  - `u1`（user）→ `a1`（assistant）→ `c1`（`type: "compaction"`，`firstKeptEntryId: "u2"`）→ `u2`（user）→ `a2`（assistant）→ `u3`（user）→ `a3`（assistant），叶节点为 `a3`。
  - 删除目标：`a2`（整轮删除 `u2` + `a2`）。
- 断言：
  - `c1` 仍为 `type: "compaction"` 且 `firstKeptEntryId` 仍是 `"u2"`；
  - 文件中存在 `id === "u2"` 的墓碑行（`type === "deleted"`），且其 `parentId === "c1"`；
  - `u3.parentId === "c1"`。
- 如果构造出的 JSONL 被 parser 拒绝（例如 compaction 字段校验），先读 `SessionFileEditor.ts` 的解析逻辑，按最小合法结构补字段；仍不行就停下报告。
- 此测试预期**直接通过**。如果失败，说明整轮删除破坏了 compaction 引用，停下报告，不要自行改算法。

### D4. 文档修正（`docs/chat-message-ops-fix-plan.md`）

1. 顶部状态块中的「3250 通过」改为「3251 通过」。
2. 在阶段 1 的「状态：已实现」列表末尾追加两条限制说明：
   - 界面语言在 pi 进程 spawn 时确定；运行中切换语言，需等该会话 runtime 重启后才会生效。
   - WSL 下依赖 WSLENV 传递（见 `docs/chat-message-ops-review-fix-plan.md` 阶段 C）。
3. 在阶段 4 的描述中追加一句：可恢复性以「error 来源为轮次级」为准，见本计划阶段 A。

### D5. 不做的项（在报告中注明即可）

- `SessionRuntimeInjector` 在 render 期间写 `latestMessageServicesRef.current`：这是 React 社区常见写法，当前没有问题，本次不改。

### 验证

- 定向运行 `tests/sessionFileEditor.test.mjs`、`tests/agentNotificationPlatform.test.mjs` 以及 copy 测试。
- `npm run typecheck`。

---

## 阶段 E：全量门禁与报告

1. `cmd.exe /c "npm run typecheck 2>&1"`，退出码必须为 0。
2. 全量 `npm test`：
   - 用 `Start-Job` 执行，输出写到**仓库内的绝对路径**临时文件。Job 的 `$env:TEMP` 与当前会话不同。
   - 超时设为至少 2400 秒。
   - 用 `Get-Content -Encoding UTF8 | Select-String '^ℹ (tests|pass|fail|skipped)'` 提取计数，然后删除临时文件。
   - 预期：`fail 0`，用例总数约为 3254 加本计划新增的 10 条左右。
   - 如有失败，先判断是否由本计划引起：只修本计划引起的；无关的既有失败只报告。
3. `git diff --check`，应无输出。
4. `git status --short`：确认没有 `tests/tmp-*`、临时输出或 `.bak` 文件；新增文件应只有 `tests/agentStartupErrorRecoverability.test.mjs` 和本计划文档。
5. 用中文写最终报告，包括：
   - 各阶段的改动、测试数量、反向验证结果；
   - 有意修改的既有测试：
     - `sessionRuntimeCoordinator` 两个测试的改名与 harness 选项改名；
     - `agentNotificationPlatform` 删除 `isRuntimeProcessAlive` 测试；
     - `sessionHistoryMutationRefreshFlow` 约 332 行的测试；
   - 遗留问题：
     - WSL 下安全门变量未进入 WSLENV，需要所有者决策；
     - 未做 WSL 实机验证；
     - 未做 UI 冒烟测试；
     - 其他 provider 的 abort 顺序未验证；
     - 连续 user 消息的上下文行为依赖 provider。
6. 不提交；完成后询问用户是否需要提交。
