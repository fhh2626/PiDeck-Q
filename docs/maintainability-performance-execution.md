# 可维护性 / 效率修复执行记录

基线：`04152a4a`。用户已授权实现，并在两项后续 review 修复验证后授权统一提交和推送；下方各阶段的「未授权／未提交」为当时的执行记录。

## 已完成阶段 0–E

- 标准基线：typecheck 通过；3593 项 / 3588 通过 / 5 跳过。
- A：Git single-flight / 显式刷新合并 / project epoch / 同值复用；父链 push + reverse；SSE 复用序列化。
- B：HostFrameDecoder 有界 header / payload 一次分配，1 / 4 MiB 分片复制量线性；关闭释放残帧。
- C：四个共享扫描读 slot；排队取消不提前释放仍运行的 slot；异步归属缓存、异步 subagent 快照；backend dispose 配对。
- D：流式 byte-offset 索引、同版本 single-flight / LRU；recent/count/compaction 复用；全文定向读取与短读处理。活动链、物理 compaction 全集、全文物理首次匹配分开处理。
- E：完整 actions 投影拥有稳定、最新 committed callback；每栏按 session 投影 agents / queue / duration；保持共享 chrome。真实 React + linkedom 挂载测试，不冒充 Qt 或浏览器视觉验证。
- E 出口：typecheck 通过；3625 项 / 3620 通过 / 5 跳过 / 0 失败。

### D 的保守取舍

新版本文件增长不证明只追加。首末 ID 探针漏掉同宽中间 parentId 改写，已经有行为红→绿回归。因此复用解析元数据前，以固定大小缓冲计算旧前缀摘要：追加仍少解析，但新版本仍需线性读取旧前缀。稳定版本不重扫。不能宣称所有追加场景为纯 tail I/O。

1 / 10 / 50 MiB 等 fixture 不读取真实会话。约 10.49 / 52.44 MB 的冷组合从三次全读约 31.47 / 157.31 MB 降为一次扫描＋最近正文约 10.67 / 52.60 MB。暖索引单条全文读取约 10,335 bytes，而不是完整文件。

原子替换在打开 descriptor 时的 POSIX 行为通过文件系统 stat 边界替身验证；Windows 打开文件锁阻止真实 rename，不冒充跨平台 smoke。

### 测试隔离修正

旧 Scanner 测试 helper 仅 stub Electron home，而原生 Scanner / summary cache 使用 node:os.homedir。重复测试可能命中真实 home 的摘要缓存。已在 helper 把 os home 限制到独立 fixture 根；没有删除或重写真实用户缓存。保留首次失败日志，隔离后同一 WSL 用例和全量通过。

## F：AgentManager 生命周期对照（保留实施前 parity 表）

不拆所有状态，不强求某个行数；本阶段先完整迁移实时 RPC 日志聚合 owner，再统一 stop 中的重复清理。

| 状态 / 资源 | 初始化 / 写入 | 终止 / 清理 | 本阶段规则 |
|---|---|---|---|
| agents / messages / errorOriginByAgent | create、runtime、错误分类 | stop / closed / stopAll，调用方处理 | 留在 Manager |
| creatingSessionAgents | session-key single-flight create | create finally | 不因 stop 删除 pending promise |
| streamingThinking / thinkingSegmentByAgent / streamingAgents / streamingText / activeAssistantMessageIds | 流式事件 | done / abort / clearAgentState | 留在 Manager，保留 generation gate |
| toolMessageIds / retryStatusMessageIds / toolStateSequenceByAgent / activeToolCallsByAgent / toolExecutingByAgent | tool/retry 事件 | 回合结束 / clearAgentState | 留在 Manager，不更改槽位 |
| lastSentTextByAgent / textPushCountByAgent / lastSentThinkingByAgent / thinkingPushCountByAgent / thinkingEmitter / textEmitter | 50ms 流式发送 | flush / cancel / clearStreamGate | 保留原节流与清理 |
| messageFlushTimers / pendingMessageAgents / messageDirtyFromByAgent / pendingFullMessageEmitAgents | 增量或全量发送 | 成功 flush / cancelMessageEmit / clearAgentState | 保留背压拒绝后的 dirty/full 意图 |
| displayWindowStartByAgent / messageHeadOffsetByAgent / pendingSlideOutByAgent | 加载 / 裁窗 | flush / clearAgentState | 保留文件下标与 entryId 空间 |
| preserveHistoryOnNextFlush / preserveHistoryExplicitOnNextFlush / stickyHistoryOnNextFlush / staleMessageCacheAgents | 历史 mutation / 压缩 | 成功投递 / clearAgentState | 不合并不同语义 |
| sessionFileVersionByAgent / messageLoadSequenceByAgent / entrySourceByAgent | 加载、RPC 能力 | invalidation / clearAgentState | 保留每 await 迟到保护与降级 |
| toolFullTextByAgent | 超长工具结果 | 单 agent clearAgentState | 留在 Manager，保持每 agent LRU |
| rpcLoggingAgents | 用户开关 | 关闭 runtime / clearAgentState | 用户意图仍归 Manager |
| pendingLiveRpcLogs / liveRpcLogFlushTimer | 已开启日志后的 RPC 事件 | flush、drop agent、stopAll | 完整移交 LiveRpcLogBuffer；80ms / 100条 batch / 1000条 pending 不变 |
| compactingAgents | 手动 compact await | compact finally | **不能**通用 clearAgentState 删除，catch 需判重连 |
| manualCompactionFollowUpAgents / manualCompactionEventAgents / manualCompactionReloadClaims / rpcCompactingAgents | compact RPC 与事件 | consume / completion / clearAgentState / stopAll | 保持手动 / 自动、RPC / 事件分别语义 |
| userInitiatedStop / autoRestartAttempted / rustRuntimeAgents | stop / 重连 / 协议事件 | exit handler / ready / clearAgentState | userInitiatedStop 不能提前删除 |
| recentlyAborted / streamGates / abortSettledFallbackTimers | abort 封印 | settled / fallback / clearStreamGate | 保留超时和 Rust / TS settled 分支 |
| pendingUIRequests / abortedDuringAsk / notifiedAskAgents | 扩展 UI / ask | 回应 / abort / clearAgentState | 不混进信任请求 |
| pendingTrustRequests | 启动等待用户 | respond / timeout resolve | **不能**stop 时仅删键，否则 create 挂死 |
| messagePerfByAgent / promptRequestedAtByAgent / lastPerfByAgent | TTFT / TPS 统计 | 回合结算 / clearAgentState | 不修改采样口径 |
| localEventListeners / outputListeners | subscribe | 返回 unsubscribe | 保留 caller 所有权；stopAll 不吞掉外部订阅 |
| PiProcess listeners / child | start 前挂接 | current-process 隔离 / stop / process close | 不迁移、不开第二通信渠道 |

### F 结果

- `LiveRpcLogBuffer` 完整迁移 pending queue 与唯一 timer，Manager 仍拥有用户 logging gate、持久化和进程/runtime 身份。不另建流式状态 owner。
- 保留 80 ms / 100 条 batch / 1000 条每-agent pending；超过 pending 上限丢最旧日志。stop 只 drop 本 agent，stopAll clear 后旧 timer 不发送。
- 公开 `AgentManager.create` + FakePiProcess 的安静 205 条 burst 先红后绿，最终输出 `[100,100,5]`：旧代码一次发送 100 后没有继续排 timer，余量可能永久不送。修复不是单纯文件搬迁。
- `stop()` 重复清理由既有 `clearAgentState()` 收口，刻意保留状态如上表，不机械删除 trust/compacting/user-stop 标记。
- F 出口：typecheck 通过；3628 项 / 3623 通过 / 5 跳过 / 0 失败。
- 首次 F harness 的 PiProcess stub 少了无后缀 import，误启动真实 Pi fixture 子进程；这次失败**不属于隔离行为证据**，也不宣称它未触及用户配置。随后两种 import 都 stub，封闭 child_process spawn/exec 并限制 os home；有效证据为 TEMP 的 `pideck-perf-F-red-isolated.log` 和后续 green gate。对应测试进程已退出，只移除本批 `pideck-log-owner-*` 临时目录，不删除真实用户配置或缓存。

## G 结果与增量范围

- `composerPolicies.ts` 提取草稿 mutation guard、latest-request epoch 和有序 session reference selection；controller 兼容 re-export 同一实现，保留图片、发送和 DOM owner。
- `historyTurnWindow.ts` 提取纯 count/tail-turn 策略；`session-atoms.ts` 导入并兼容导出，不复制 atom 实例；删除重复 cardCount spreads。
- G 首次全量失败原因是旧 VM loader 从测试目录解析新相对 TS import。11 个 loader 显式加载真实 helper，未放宽任何行为断言；修复后 3628 项 / 3623 通过 / 5 跳过 / 0 失败。
- 未一次性拆完 App 的 command wiring、runtime/ui/cache atoms 或 reconciliation 主算法；兼容 merged services 消费入口暂时保留。是单 owner 的增量收口，不宣称大模块维护成本全部解决，也未延迟 fingerprint 构建。

## H 收尾复查与资源报告

本助手重新沿公开入口检查，不是第二位独立审查者签核：

- Git：poll 合并与 explicit 后续、project epoch、dispose；不能取消的旧 IPC 仅拒绝结果。
- transport：32 MiB 帧上限先于 payload allocation；close 重置残帧；SSE 共用原 payload，不改 seq/replay/gap 或背压。
- Scanner：list watchdog / environment generation / queued 与 in-flight 取消；parent membership 失败不缓存；每轮 roots/subagent 快照避免 summary worker 逐个刷新。
- 找到相邻漏点：WSL 自定义 `sessionDir` 的 `test -d` 绕过队列。8 并发项目公开 list 测试先红（max active=8），修复后≤4。根配置和存在性检查也传入本轮 signal，避免旧扫描从本地 I/O 恢复后发起新环境命令。保留单命令/整体超时，不以放宽超时通过。
- history：物理首次全文/全部 compaction 与活动链三种范围、prefix hash、fstat + path stat、短读、同版本 single-flight、legacy 无 ID 兼容；range API 的显式全历史调用不冒充小页。
- React/F/G：latest committed delegates、optional capability、session state 投影、安静日志余量及 stop cleanup、兼容导出的同一纯规则；没有第二套全局状态。

同一 Node v24.19.0、一次性本地 fixture 的最终 benchmark：

| 项目 | 修复前 | 修复后 |
|---|---|---|
| 10.49 MB recent + count + compaction 冷组合 | ~31.47 MB 全读 | 10,674,962 bytes，0 次 full readFile |
| 52.44 MB 同组合 | ~157.31 MB 全读 | 52,601,691 bytes，0 次 full readFile |
| 同版本单条全文，10/50 MiB 文件 | 重读整个文件 | 10,335 bytes，1 次 range open |
| 10k / 30k / 60k 父链 | ~6.5 / 53.7 / 241.3 ms | 中位数 ~1.66 / 4.60 / 10.84 ms（诊断，不设 CI 阈值） |
| 4 MiB / 64 KiB 分片 HostBridge | ~134 MiB concat 复制 | allocator/copy 边界测试验证固定线性搬移 |
| 200 文件假 WSL，双项目 | 最大请求并发 200 | 初版同一池≤4、暖 stat=200；四项修复后批量 stat=4 / 暖 cat=0，见追加记录 |
| 父 cwd 暖归属 | 3 次同步历史全读 | 同步/异步正文重读均为 0 |
| 双 pane action/state | 不稳定 actions、全域 agent 投影 | 真实 React/linkedom 消费边界验证身份稳定与闲置 pane 隔离 |

### 最终门禁

- `npm run typecheck`：通过。
- `npm test`：**3629 项，3624 通过、5 跳过、0 失败**。
- `npm run build`：renderer + node 构建通过；Vite 仍有 >500 kB chunk 提示，不改预算掩盖它。
- `npx playwright test --config tests/browser/playwright.config.ts`：本机真实 Edge，**45 通过**。这些是既有功能 fixture，不是 Qt 大历史 profiling。
- `node scripts/test-native-host-rpc.mjs`：实际 xmake 构建及 HostRpc 集成测试通过。
- `node scripts/test-native-gui.mjs`：实际 xmake 构建及原生 GUI 集成测试通过。
- 最后标准 gate 日志：TEMP 的 `pideck-perf-H-{typecheck,tests,build}-final.log`；其他日志 `pideck-perf-H-{browser,native-rpc,native-gui,benchmark,root-red,root-green}.log`。
- `git diff --check` 通过；package.json/lockfile 未改，版本/持久化格式不变，HEAD 仍为 `04152a4a`，无 add/commit/push。

### 未验证与下一批边界

- 当前已具备 xmake、系统 Edge，不能再列为缺工具。缺少 Playwright 自带 Chromium 不阻挡已有 Edge 配置。
- 原生 GUI/协议 smoke 不等于真实大历史 QtWebView 体验、安装包 smoke、真实模型/Rust Pi 或真实 WSL 的排队时延/超时验证；这些仍未完成。
- 未测跨平台 RSS、GC 或 event-loop 延迟分位；固定块/yield/复制/I/O 资源证据不能替代这些数字，也没有编造百分比承诺。
- 索引 O(entries)、最大行/完整轮次、增长文件 prefix I/O 等限制保留；Scanner 的父归属冷读仍是有界异步全文，而非 streaming contains。
- subagent 每轮固定快照且遍历异步化，但并发 list 的 force snapshot 未跨轮 single-flight；保留 forceRefresh 的新身份可见性。四项 review 后已引入批量 metadata/正文，真实 WSL 的命令执行与端到端测量仍未验收。
- App command 迁移、atom 域级进一步拆分不属于已完成能力；继续推进必须沿现有 parity 表，不借机改 UI、Pi 行为或加入全局缓存。

## 四项 review 问题修复（追加，不覆盖前批门禁）

用户授权修复四项，仍未授权 add/commit/push。永久复现先红后绿：

1. **WSL 队列/watchdog**：新增 `WslScanBatchReader`，metadata 每批最多 64 文件，正文每批最多 16 文件，参数预算 12 KiB、已知正文总量不超过 64 MiB；每轮最多四批正文同时消费，底层仍使用共享四路命令池。未知大小保守单文件组；正文不形成跨轮缓存。使用固定 shell 代码＋位置参数＋NUL 身份/状态边界，校验失败回退逐文件读，单个缺失/失败不丢可读兄弟。保留 18s 整体 watchdog、5/10s 单命令超时及单文件 64 MiB budget；批量输出仅增加受参数长度约束的 framing allowance。父 cwd 校验复用本批正文和版本，避免再逐文件 stat/cat。
   - 同一虚拟 200ms/命令、200 文件、两个并发项目 fixture：旧实现 18s watchdog 报错；新实现冷双项目＋暖扫描共 3200ms 虚拟时间，最大在途 4，metadata 命令共 12。另一资源回归验证暖扫描 4 次批量 stat、0 正文命令。
   - 这是确定性替身验证，不是现实 WSL 的延迟承诺；真实 GNU stat/sh/WSL 执行仍需环境 smoke。没有延长 watchdog、提高并发或降低正文预算。
2. **无尾 LF 的暖 append**：增量和冷构建共用 `addRow`，接受完整 JSON；损坏残行仍跳过，`endsWithNewline=false` 强制下一次增长时重建。测试验证全文/recent/count、不重复补 LF，以及残行补齐后恢复。
3. **并发根目录**：`list → readSummary → local/WSL parent inference → header root guard` 全链传递本轮 roots。本地 fixture 故意阻塞 path/header 两类子会话读，让 B 扫描覆盖共享 roots 后再恢复 A；A 的首次和暖扫描父归组均正确。另有 WSL 命令替身覆盖同一交叉时序。
4. **生产 Pane 隔离**：对 AgentTab 完整标量字段作等价比较，同时检查新增/移除字段，复用等值数组。测试使用实际 `agentInventoryAtom` 派生对象和真实 React mounting，而非手工保留 agentA 引用：B 状态变化不唤醒 A，A 改名/关闭仍可观察。

新增 batch reader 单测覆盖 UTF-8/空格/引号路径、stat/body 独立失败、损坏 NUL framing 的隔离回退、64 MiB 分组/预算、暖读和取消后不再启动正文命令。生产命令不把路径插入 shell 字符串。另以本机 Git Bash 的真实 GNU stat/sh 做 disposable 双文件协议 smoke（空格/引号及中文 emoji 路径），2 次命令正文逐字一致；这只验证真实命令 framing，不能替代 WSL。首次 inline smoke 被 PowerShell→Node 管道编码转换为 `????` 路径并失败，改用 Unicode escape 后成功；两次临时目录均在 finally 清理。

本批最终门禁：
- `npm run typecheck` / `npm run build`：通过。
- `npm test`：**3641 项 / 3636 通过 / 5 跳过 / 0 失败**。
- 真实 Edge 既有 browser suite：**45 通过**，不冒充 Qt profiling。
- 原生 HostRpc/GUI 未在这次纯 Node/renderer 修复中重跑，保留前批记录。
- 首次复现日志：TEMP 的 `pideck-four-red.log`、`pideck-four-wsl-red.log`；最终日志 `pideck-four-{typecheck-final2,tests-final,build,browser}.log`。第一次 targeted 因资源 fixture 尚未支持新 stat framing 报 204 vs 200，随后 fixture实现真实 batch framing，改为断言更严格的 4 次批量 stat / 0 正文读取，未放宽并发/行为断言。
- 未改版本、依赖、持久化格式或 Pi 通信边界；真实 WSL、跨平台 RSS/事件循环及 Qt 大历史性能仍是明确的未验证项。

## 两项后续 review 修复（追加）

本轮用户授权修复 WSL 超时降级和旧摘要缓存，不包含提交授权。

### 1. WSL 超时降级的有限读取结果

- `WslScanFileRead.body` 明确区分 `not-requested` / `success` / `failed`，空正文仍是成功；本轮已经失败的读取不再由 `readSummary` 或父 cwd membership 重复 cat，且不会写成永久负缓存。下轮扫描可重试。
- 仅内部 batch 命令用 `WslScanCommandError` 保留 partial stdout 和 timeout 信号；不打印正文，不改变其他公开读取命令的原始异常。对 execFile 的 killed/SIGTERM 与 ETIMEDOUT 做识别。
- 正文按路径→内容→退出状态 framing 校验：超时保留完整前缀；有完整路径头的残行表示该文件已开始并卡住，不重试它；只恢复尚未开始的文件。恰好停在完整记录边界时也恢复其后的未启动文件。无法可信识别的超时输出保守标记失败，不重新花费一个完整 timeout；普通 framing 错误仍做隔离读取。
- 降级恢复接收本轮 18s watchdog 的同一绝对 deadline，另有本域 AbortController 限制包括排队在内的剩余时间，预留 100ms 清理/解析 margin。域 deadline 只结束未完成的正文读取、保留已完成兄弟；真正的扫描取消/环境切换仍拒绝本轮。timer 和 parent abort listener 在 finally 配对清理。
- 不增加并发、不延长 watchdog、不减少 64 MiB 正文预算；正常 batch 仍允许完整 10s，9s 成功命令回归证明没有用降低 timeout 掩盖问题。晚启动的降级读取只使用当前扫描剩余时间。
- 公共 `list()` 的确定性复现覆盖卡住文件在 batch 首/尾两种顺序：修复前均耗尽 18s；修复后分别约 11000/10800ms 虚拟时间返回正常兄弟，不再对卡住文件发 cat。单文件预读失败与父 cwd 预读失败也均不重复读取，I/O 恢复后下一轮可正常出现。
- unit 回归覆盖恢复阶段另一文件继续卡住：17900ms 域 deadline 收束未完成读取，保留已经成功的兄弟，不触发 parent signal。另验证不完整/空超时 framing 不启动第二轮读、记录间超时恢复正确。

### 2. 旧摘要缓存一次性重建

- 摘要派生缓存版本从 **3 → 4**；v3 中可能持久化了并发 roots 串用后的错误 parent，mtime/size 命中无法自修。旧缓存按现有不兼容版本冷启动策略忽略并从真实 JSONL 重建，成功扫描经现有原子写盘落为 v4；不删除用户文件，不改 settings、session catalog 或原始会话格式。
- 永久回归先用生产 Scanner 创建完整 fixture 摘要，再构造真实旧 v3 格式的缺失 parent，重启生产 Scanner 并校验恢复和写盘结果；原 JSONL 的大小/mtime 不变，再重启仍为正确父归组且正文 readFile=0。
- 本轮**确实改变派生缓存 generation**，不能沿用上一批“所有持久化格式未变”的表述；设置/会话/catalog 契约保持不变。

### 验证与限制

- 先红日志 `TEMP/pideck-two-red.log`：两个卡住顺序均超时、单文件失败重复读 2 次、旧缓存 parent 缺失；timeout fixture 随后补充真实 execFile 的 killed/SIGTERM 与 partial stdout，同时收紧到不得再次 cat 卡住文件，没有放宽时间/资源断言。
- 记录间超时边界先红再绿：`pideck-two-boundary-red.log`。
- 最终 `npm run typecheck` / `npm run build` / `git diff --check`：通过。
- `npm test`：**3650 项 / 3645 通过 / 5 跳过 / 0 失败**；针对性扫描/batch/recovery 共 **22 项全绿**。日志 `pideck-two-{targeted-final,typecheck-final,tests-final,build}.log`。
- 额外用隔离的短命 Node 子进程检查本机 execFile timeout 确实报告 killed=true、signal=SIGTERM；无真实 WSL/模型服务访问。Edge/原生集成未在这次纯扫描/缓存修复中重跑。
- 真实 WSL、安装包、RSS/事件循环及 Qt 大历史 profiling 仍未完成。没有声称所有异常/平台都由替身验证覆盖。
- package.json/lockfile、应用版本、Pi 通信边界未变；未 add/commit/push。
