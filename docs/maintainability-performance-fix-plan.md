# 可维护性与执行效率审查修复计划

> 代码基线：`04152a4a`（`native` 分支）；制定计划前工作区干净。
> 用户已授权实现，并在两项后续 review 修复验证后授权将本批变更统一提交并推送。
> 两项后续 review 修复后的门禁：typecheck / renderer+node build 通过；3650 项单测，3645 通过、5 跳过、0 失败。Edge 45 项及原生 HostRpc/GUI 为前批通过记录，本批未重跑。
> 实际实现、首次失败、资源证据与未验收项见 [执行记录](maintainability-performance-execution.md)。下方详细清单保留原计划：勾选项已执行，未勾选项是尚未完整逐项验收的规划，不能据此宣称全部阶段闭环。

## 实施状态

| 阶段/问题 | 本批结果 | 尚未完成的完整规划 |
|---|---|---|
| 0 / A（P4/P5/P7） | 可复用资源 fixture、Git 单飞/后续/epoch/退避、push+reverse、SSE payload 复用 | SSE 单次 stringify 的额外计量、所有多栏 Git 渲染边界联合测量 |
| B（P6） | HostBridge 线性帧解码、边界/复制/关闭行为回归 | 真实长时 native transport RSS profiling |
| C（P2/P3） | 共享四 slot、WSL 批量 metadata/正文、取消/环境隔离、异步父归属和 subagent；根目录快照贯穿父路径解析；超时保留已完成正文、不重试卡住文件，剩余 deadline 内恢复未启动文件；v3 派生缓存一次重建；200ms 命令/18s watchdog 复现红→绿 | 真实 WSL 排队/watchdog 吞吐、并发 force subagent 快照合并、父归属 streaming contains |
| D（P1） | 单一流式元数据索引、同版本复用、range 全文/页读取、物理/活动语义兼容、改写保护；暖 append 完整无尾 LF 记录与冷读一致 | RSS/event-loop 分位；增长版本为安全仍扫描旧前缀，不是纯 tail I/O |
| E（M2） | 最新 committed 稳定 actions 与按 session state 投影；采用生产 inventory 的真实 React 回归，等值 AgentTab 重建不唤醒闲置栏 | App 全部 commands 迁移、兼容 merged services 最终退出 |
| F（M1） | 完整迁移 LiveRpcLogBuffer owner，修复 quiet burst 滞留；stop cleanup 收口 | 其他 AgentManager 职责继续分批拆分，不宣称大文件治理完成 |
| G（M3） | 纯草稿/request/reference/turn 策略收口，同实例兼容导出，重复 cardCount 删除 | reconciliation 主算法与 runtime/ui/cache atoms 域级拆分 |
| H | 本助手公开链复查、资源报告、标准/Edge/原生集成 gate、文档同步 | 外部独立 reviewer、真实大历史 Qt/WSL/模型/Rust/安装包、跨平台内存/事件循环验收 |


## 1. 目标与范围

修复已有行为证据的性能热点，再渐进收敛维护成本。优先减少实际 I/O、进程并发、缓冲复制和无意义更新，而不是单纯追求文件行数。

成功标准：

- 大历史加载不再重复全文件扫描；暖索引全文读取只读取目标条目。
- 会话扫描不在 Sidecar 事件循环上同步读取历史/遍历 subagent 记录；逐文件命令有全局并发边界。
- 慢 Git 请求不会因周期刷新持续被判过期；同值结果不触发无意义状态更新。
- 活动分支构造与宿主帧接收不再产生平方级搬移/复制。
- actions 引用稳定，session 数据订阅隔离；大模块拆分后状态仍有单一 owner、清理路径和可测试规则。
- 会话内容、身份、轮次、历史游标、摘要位置及失败语义保持兼容。

### 不做什么

- 不替代 Pi 的 Agent、工具、压缩、分支或会话写入行为；不新增到 Pi 的通信通道。
- 不改版本、依赖、持久化设置格式、session catalog UUID 或 UI 外观。
- 不删 runtimeGeneration / dispatch lease / 迟到结果校验 / 消息预算 / 背压。
- 不将所有历史放进新全局缓存，不新增第二套状态管理，不引入通用任务平台。
- 不把文件树全量索引、GitPanel 的整套交互、真实运行时未验证的问题混入本批。
- 不因文档写着某个数字就修改当前常量；代码与行为测试为准。

## 2. 证据与任务映射

以下测量是本机隔离实验或替身调用观测，不是 Qt GUI / 真实 WSL benchmark。实施前重跑基线并保存 fixture 参数。

| ID | 审查发现与证据 | 主要落点 | 阶段 |
|---|---|---|---|
| P1 | 约 9.98 MB 文件的冷读取组合扫描全文 3 次、约 29.95 MB；8 KiB 单条全文也先读完整文件 | `SessionHistoryReader`、`AgentManager.loadMessages` | D |
| P2 | 3 个父 cwd 会话暖摘要扫描仍同步全文读取 3 次；subagent 记录刷新使用同步目录遍历 | `SessionScanner` | C |
| P3 | 200 个 WSL 文件：冷缓存 200 stat + 200 正文 cat，最大并发命令请求 200；热缓存仍 200 stat | `SessionScanner` | C |
| P4 | 同项目连续重叠 Git 请求，前两次完成但写入为 0；相同结果仍重复更新 branch map | `useProjectSync`、App 轮询装配 | A |
| P5 | 活动分支使用 unshift；1万/3万/6万条的本机中位数约 6.5/53.7/241.3 ms | `sessionEntryIds` | A |
| P6 | HostBridge 以 64 KiB 分片收 4 MiB 帧，累积 concat 复制约 134 MiB | `HostBridge` | B |
| P7 | 正常 broadcast 序列化相同 SSE payload 两次 | `NativeRendererServer` | A |
| M1 | 按 agent 分散的 Map/Set、多职责与部分重复清理 | `AgentManager` | F |
| M2 | 大 services 袋、actions 引用不稳定、消费者合并订阅两组 Context | App、`SessionPaneServices`、pane/injector | E |
| M3 | Composer 和 session atoms 混合独立业务规则；局部有重复对象组装 | composer controller、session atoms | G |

P1–P7 是资源/时序问题；M1–M3 是维护性改进，不宣称已证明泄漏、所有栏逐 token 重渲染或全部复杂度多余。

## 3. 行为 parity 表（不可省略）

| 能力 | 必须保留的行为 | 回归入口 |
|---|---|---|
| 稳定身份 | session UUID 跨重启稳定，agentId 只标识当前进程；旧 runtime/load/页响应不回写新状态 | runtime coordinator、replacement、target boundaries、history mutation 测试 |
| 活动分支 | leaf 沿 parentId 回溯，保留 cycle/缺父节点处理；不按物理尾部代替活动链 | history reader、resend entryIds 测试 |
| get_messages 对齐 | 最近 compaction 的 firstKeptEntryId 决定模型上下文 entryId；锚点缺失保持保守降级；空 assistant/toolResult 槽位不偏移 | `sessionResendEntryIds.test.mjs`、projector/trim 测试 |
| 展示历史 | 离线分页包含活动链的压缩前历史；轮次不拆断；保留摘要插入位置和去重 | reader、runtime cache、history merge 测试 |
| compaction 扫描 | 当前 scanCompactions 按文件顺序收集全部有效压缩记录，包括非活动分支及无 id 记录；不得静默改成仅活动分支 | 新的范围/顺序测试＋现有 compaction 测试 |
| 完整文本 | 明确 entryId 优先且不误匹配其他分支的 message.id；无 entryId 时保留当前首个物理匹配语义；旧格式/无 entry id 的兼容读取不丢失 | clean review、tool full text、reader 测试 |
| 数值与 entry 游标 | entryId 优先；文件与 runtime 下标空间不混淆，摘要卡片不消费角色 slot；保留无 entryId fallback | runtime cache、history version drift 测试 |
| 文件变化 | append 增量与 rewrite 重建均可用；暖缓存不返回旧正文；外部编辑/删除/截断导致失效 | reader、clean review、version drift 测试 |
| 项目归属 | 父 cwd 内容匹配、自定义 sessionDir、共享目录、父子会话归组和归档保持现有结果 | scanner custom dir/subagent/archive 测试 |
| 运行时/环境 | TypeScript Pi 与 Rust 的事件、get_entries 降级不变；本地/WSL distro/user/home 隔离 | compatibility、scanner WSL、runtime 测试 |
| Git | 项目切换和 A→B→A 后迟到结果仍拒绝；普通轮询可合并，显式操作后的刷新最终必须执行 | inventory race＋新 Git 刷新行为测试 |
| 宿主与 SSE | token hello、帧上限、写队列背压、请求匹配、seq/replay/gap/recovery、关闭清理不变 | native host bridge、renderer transport/recovery 测试 |
| 多栏与输入 | 非聚焦栏消息不串栏；会话切换不覆盖草稿；发送、队列、停止、重启、图片和引用展开保持行为 | runtime atoms、composer、browser 测试 |

`docs/长会话内存治理方案.md` 已同步当前 50 轮常量、索引 owner、压缩分页与复杂度；本次只纠正文档，不修改运行期轮数/预算。

## 4. 执行纪律与验收方法

1. 每阶段开始核对 HEAD、工作区、真实入口和相邻路径。发现行为口径或范围与计划不同，先更新计划并报告，不猜测。
2. 时序/正确性 Bug 必须先加行为复现看到红灯，再修到绿。纯性能等价优化先固定语义和资源基线；不伪造会在旧代码失败的功能测试。
3. 使用公开服务/IPC/hook 行为验收。I/O 字节、在途进程数、复制字节等可在依赖边界计量；不以源码正则或私有方法调用次数代替正确性。
4. 不将绝对毫秒阈值放进 CI。性能回归优先断言资源上界、无重扫、无重复更新、并发限制；耗时/峰值 RSS/事件循环延迟作为独立对比报告。
5. fixture 在临时目录，使用替身或独立子进程，显式 try/finally 清 socket/child/timer/file handle；不读取用户会话、设置、凭据或真实 provider。
6. TypeScript strict，无新增 any/绕过类型的强转；共享契约仍放 shared，领域逻辑不塞 App/装配层。新模块目标不超过 400 行，超过 600 行需说明和拆分评估。
7. 不新增 npm 依赖。用户可感知新增错误文案须同时走 zh-CN/en-US i18n。
8. 每阶段跑定向行为测试、`npm run typecheck` 和 `npm test`，全绿才进入下一阶段。失败不得放宽断言；疑似环境/并发干扰单独及串行重跑、保留首次结果。
9. 标准命令包含 prepare 步骤，检查是否意外改动依赖/lockfile；不把 raw 命令结果写成标准门禁。
10. 每阶段记录改动范围、红/绿结果、资源指标、parity 与限制。只有文档本身不改运行行为，但也要检查 diff/链接。

## 5. 阶段与依赖

- 0 → A → B → C → D → E → F → G → H。
- A/B/C/D 是第一批效率修复；E 是稳定引用与订阅收敛；F/G 是有对照表的小步维护性改造。
- 不将 F/G 与 D 一起实施；性能指标先落地，再拆大型 owner，便于定位回归。
- 后续收到实现授权时，以明确授权范围为准；不得因本计划列了后续阶段就自动扩大本轮改动。

### 阶段 0：建立可复用基线

- [ ] 将本轮临时实验转成可复用的 fixture/harness：生产模块公开入口＋可计量 I/O/命令替身，补齐 cleanup。
- [ ] 准备 10/50 MiB 多轮历史、60k 条父链、200 文件 WSL、父 cwd/子项目、1/4 MiB 分片帧样本。
- [ ] 记录 Node 版本、fixture 行数/最大行长度/分支/compaction 参数、暖冷状态；微基准至少多次取中位数。
- [ ] 建立慢 Git 的 deferred/fake-clock 行为复现；已有 scanner/history/native 测试入口优先复用。
- [ ] 运行标准基线门禁，记录日志在 TEMP。确认现有浏览器测试设施与本机浏览器可用性。

产出：永久回归测试或可重复的 benchmark harness、基线结果。暂不增加生产 profiling 日志。

### 阶段 A：低风险算法、Git 调度与 SSE 去重

#### A1. 活动分支

- [x] `buildActiveBranchEntryIds` 改为 push 收集后一次 reverse，保持其余规则不变。
- [ ] 用无压缩、多压缩、锚点缺失/等于压缩点、乱序输入、重复 id、缺父节点、cycle 和空 leaf 固定输出。
- [ ] 对比 10k/30k/60k 微基准，确认大规模增长不再由头插搬移主导；不增加通用分支框架。

#### A2. Git 刷新

- [ ] 将 Git 刷新状态/调度收拢到窄 hook 或同域 helper；App 只装配，不新增业务 if/else。
- [ ] 明确三种意图：项目激活、普通周期刷新、Git mutation 后显式刷新；普通轮询遇到在途请求合并/跳过，显式刷新可排队一次后续执行。
- [ ] 周期触发不递增一个必然使所有慢响应失效的序号。项目 epoch 与请求身份继续拒绝切换前响应，包括 A→B→A。
- [ ] 同值 gitInfo 与 branchByProject 均返回原 state；成功结果即使耗时超过 4 秒也能应用。
- [ ] 失败后的退避与显式刷新唤醒由同一 owner 管理；失败不能挂死 in-flight，旧失败不清空新项目。
- [ ] 后续刷新在慢请求结束后调度，不形成无限 pending 链。unmount/project switch 清定时器；不能取消的旧 IPC 仅隔离结果，不伪称已取消底层进程。
- [ ] 保留侧栏分支信息刷新；不简单改成仅 GitPanel 可见时刷新。可见性策略若扩大范围需另列产品规则。

行为测试：慢响应与多次 tick、正常同值、失败后恢复、显式刷新、快速项目切换、unmount。通过现有 `projectInventoryRace`，不能只用模拟 React setter 声称完成重渲染验证。

#### A3. SSE

- [x] `broadcast()` 的已序列化 payload 传给 event append；常规事件只序列化一次。
- [x] 不改 oversized-event 的 gap/resync 事件、seq、frame 字节计量、history 上限及每客户端背压。
- [ ] 从实际 HTTP/SSE 接口确认常规事件、超限、重放、慢客户端和重连结果；序列化成本测量是附加证据。

阶段出口：旧 Git 重叠用例红→绿，分支语义等价，transport 行为不变，全量门禁绿。

### 阶段 B：宿主分片帧线性解码

- [ ] 选择最小解码方案：4-byte header 的小缓冲＋已校验长度的 payload 缓冲/写游标；若抽 decoder，限定于长度前缀帧，不建设通用网络框架。
- [x] header 完整后先验证 32 MiB 帧上限，再分配；不能先按未验证长度分配内存。
- [x] 每个 payload 字节最多有限次复制；支持任意 header 分片、UTF-8 分片、粘包与多帧混合。
- [ ] 零长度/坏 JSON/超限/中途 EOF 的失败语义保持；hello timeout、pending RPC settle、fatal 通知与 close 幂等性保持。
- [ ] close 清残帧引用；不让小尾巴持有整个大缓冲。不新增 socket/timer 泄漏。
- [ ] 保留 8 MiB 出站背压预算，不顺手修改 Qt 端或全局限额。

测试：真实 loopback Node socket 测公开 HostBridge，受控分片替身测最坏接收顺序。1-byte header 分片、64 KiB payload 分片、粘包、32 MiB 边界、未认证关闭、带 pending 请求关闭均覆盖。

资源验收：1/4 MiB 帧解码复制量受固定线性倍数约束，分片变细不导致平方增长；用 allocator/copy 边界计量，不只计 concat 调用。Qt 原生工具不可用时记录未完成原生联调，不能用 Node socket 测试代替。

### 阶段 C：扫描有界并发、异步归属检查及快照

#### C1. 任务边界与 WSL

- [x] Scanner 内建立共享的有界扫描读取 I/O/WSL 命令入口；限制必须覆盖并发项目 list，而非每轮各开一套限额。写入/删除/恢复不混入后台读取队列，保持既有事务时序。
- [x] 排查 summary/stat/cat/head/归属校验/subagent 命令是否能绕过限额；不要外层任务占 slot 后再 await 同一队列内层任务，避免死锁。相邻 custom-root test -d 漏点已先红后绿修复。
- [ ] 大文件 cat 的 64 MiB maxBuffer、现有单命令超时和整体 watchdog 保留；并发降低不能造成大批有效会话因为排队超时被静默清空。
- [ ] 测量有界后排队耗时与 watchdog，若出现吞吐退化，先评估批量 metadata 获取；不直接放宽全局超时或上限掩盖问题。
- [ ] 队列任务捕获 distro/user/home 和环境 generation；取消时移除 queued 任务、按 signal 停在途子进程，旧环境结果不得污染新环境缓存。
- [ ] 失败释放 slot，队列可恢复。新增 dispose 若必要，scanner 自己持有/清理资源，backend 仅接一条清理装配。

验收：200 文件冷/热扫描，1/2 个并发项目，max active 命令受同一限制；排序/结果不因完成顺序变化；abort、环境切换、命令失败均 settle。真实 WSL 上总耗时需另测，不能由替身延迟推算。

#### C2. 父 cwd 归属

- [x] 去掉 `readCachedText` 的同步全文读，保留标准化后文本包含目标路径的现有匹配语义，不顺手改路径大小写政策。
- [ ] 缓存的是归属结果，不是全文；key 包含环境身份、文件版本、目标项目。限制条目数，失效涵盖改写/删除/append/环境切换。
- [ ] 首次可采用有界异步读；为大文件采用保留跨 chunk 匹配的流式方案时须覆盖 UTF-8、反斜杠替换和匹配跨边界，不使用文件头匹配冒充全文匹配。
- [x] 两次稳定版本的相同项目扫描，第二次归属正文读取为 0；文件变化后重新判断。读取失败保持现有过滤语义，但不永久缓存瞬时失败成 false。
- [ ] 当前扫描各自保留 roots/环境快照，检查共享 `activeScanRoots` 在多项目并发下的结果一致性；若需要修正，限定在本扫描上下文，不扩展 catalog 策略。

#### C3. subagent 运行记录

- [ ] 同步 readdir/readFile 递归改为有界异步，保留深度、目录规则、自定义临时根和损坏记录容忍。
- [ ] 每轮使用明确的已加载快照，summary workers 不因排队超过 TTL 又逐个触发刷新；并行快照读取可合并。
- [ ] 不直接删除 forceRefresh 或延长 TTL 压低成本，避免新 subagent 被错显示为顶层会话。需要更新时最多合并一次后续刷新。
- [ ] 环境切换/失败不发布旧快照；缓存只保留已提取的 sessionFile 集合，不保留完整运行记录。

测试入口：`backgroundScanCoordinator`、`sessionScannerSubagents`、WSL timeout/maxBuffer/archive/custom-dir 及新资源/缓存测试。临时目录依赖注入，绝不遍历用户真实 tmp 作为测试 fixture。

### 阶段 D：历史读取同版本索引复用

分 D1/D2 单独过门禁；这是最高语义风险阶段。不得把文件分页索引与 get_messages 的压缩后上下文混为一谈。

#### D1. 流式索引与冷/暖读取

- [ ] 提取同域 JSONL byte-offset reader/index helper，`SessionHistoryReader` 保留业务入口和缓存 owner；不引入新持久化索引。
- [ ] 冷建索引只完整扫描一次，逐行 parse 后丢弃消息正文，保留条目 metadata/offset、物理顺序 compaction 元信息以及所需兼容定位信息。
- [ ] 正确计算 UTF-8 byte offset，覆盖 LF/CRLF、无尾部换行、跨 chunk 多字节、空行、坏行、无 id 条目和重复 id。
- [ ] 缓冲按 chunk/最大单行/所选消息增长，不同时保存全文字符串＋全部 raw messages。索引 metadata 仍是 O(entries)，不得声称内存对历史长度完全常数。
- [ ] 不用正则扫描 JSON 的 type/id 代替解析；不擅自设很小单行限制让旧会话无法打开。极大单行 parse 仍有不可消除成本，需如实记录。
- [ ] 按处理批次让出事件循环，避免小行文件一次长循环；这是可测公平性边界，不保证单个巨型 JSON parse 无阻塞。
- [x] 同文件同版本冷构建 single-flight；缓存失效/失败不留下 rejected promise。LRU 被淘汰时释放相关定位信息。
- [ ] 保留并强化现有 append 探针/rewritten-file 重建；内部可用 dev/ino/ctime 加强识别，但不静默改变公开 `indexVersion` 协议。
- [ ] 句柄 fstat 与 offset read 绑定同一快照；检测短读/文件替换后有限重建重试，不将错位字节投影为合法消息，不无限循环重试。

验收：冷索引＋recent/count/compactions 组合只有一次完整扫描，加所选消息读取；暖索引分页与 count/compactions 不再全扫。**实施修正**：append 的元数据解析仅追加尾部，但必须先哈希验证旧前缀；等宽中间 parentId 改写已证明能绕过旧首/末探针，不能把增长当作纯追加。原子替换/截断正确重建；并发加载只构建一个有效快照。

#### D2. recent、全文、compaction 与 runtime 装配

- [x] `readRecentMessages` 在活动索引上选完整尾部 N 轮，再读取所选正文；结果与现有 `deps.trimMessages` 等价，不能直接套分页字节预算而少取轮次。
- [ ] 空/全损坏文件的失败语义、合法无消息条目文件的返回语义分别测试；不把无法构建活动链当成功空历史。
- [ ] `getActiveEntryCount`、runtime compaction 元信息复用已建立快照；文件仍在变化时可以重建，但稳定版本不得重复全扫。
- [x] `scanCompactions(sessionPath, sessionContent?)` 保留显式 content 调用与物理顺序范围。索引不能仅按 activeBranch 返回，也不能漏掉无 id 的有效 compaction。
- [ ] `readMessageFullText` 暖索引优先 offset；明确 entryId、无 anchor 首个物理 message.id、无 id 旧记录各自保留定位规则。索引无法表达的旧形态允许有界流式早停 fallback，而非改为全文件 readFile。
- [ ] 保留全文缓存版本/entry anchor 校验，以及 content string/text blocks 的提取；空文本错误与 message-not-found 错误不混淆。
- [ ] AgentManager 只消费窄 reader 接口，不持有解析细节；仍在每个 await 后校验当前 load，最后一次性发布 runtime 状态。
- [ ] 不同时重写 Viewer 的全量兼容 API、renderer prefix 合并或公共游标协议；新私有 helper 优先复用，旧显式全量 API 不冒充常数预算。

重点测试：50 MiB 多分支/多压缩、锚点缺失、首尾巨大工具结果、相同 message.id 不同 entry、无 id/重复 id、改写同大小、尾残行继续 append、两次并发加载期间 restart。

资源验收：稳定文件单次冷激活读取量接近一份文件＋所选条目/探针，不再三份全文；暖 8 KiB 正文读取约为目标条目及版本验证，不随整份文件线性增长。峰值内存和事件循环延迟与基线对比，不设未经实测的百分比承诺。

### 阶段 E：稳定 services 与按 session 订阅

- [ ] 建立 field 清单：身份/chrome、稳定命令、按 session 数据、跨工作区数据；为每类标注真实 owner 和消费者。
- [ ] 先稳定 showToast/abort/restart 等 actions；默认目标必须在调用时解析或显式传 session runtime target，禁止 useCallback 空依赖捕获旧 activeAgentId。
- [ ] 将 App 中命令逻辑迁至已存在或新窄域 hook；services provider 不成为第二个 AgentManager，不复制 runtime 状态。
- [ ] 将 pane/injector 迁移到真正需要的 actions 或 state 入口；本栏 messages/runtime/sendState 用 atom family，不把 `currentSession*` 引入非聚焦栏。
- [ ] 队列和终端等变化数据按所属域读取；仅在测到实际跨域唤醒时继续缩小 Context，不为每字段制造新 Provider。
- [ ] 若保留兼容 merged services 入口，列出剩余消费者并限定退出路径；本批不能出现一套新 owner＋一套旧 owner并存。

React 验收必须用真实组件渲染（复用现有浏览器/React harness）：隔离其他轮询后，无变化 Git tick 不产生可观察的状态变化或多栏重渲染；App 无关变化不改变 actions identity；S1 流式更新不唤醒 S2 的消息订阅边界。测消费者边界的有效更新，排除 StrictMode/React 内部尝试渲染的噪声，不把 hook stub 当浏览器 profiling。

功能验收：非聚焦栏停止/重启、项目切换后默认动作、queue 发送、terminal 开关、toast 和 provider unmount 均正确。

### 阶段 F：AgentManager 按职责收拢生命周期

- [ ] 先列所有 agent-keyed Map/Set、timer、listener 和延迟回调的生命周期表：create/restart/stop/process error/process exit/stopAll。
- [ ] 表中标记刻意跨清理保留的状态，如 userInitiatedStop、pendingTrustRequests、compactingAgents；不机械清空所有集合。
- [x] 本阶段优先抽一个可独立测试的 owner（例如实时 RPC 日志缓冲或流式投递的一组完整状态），迁移所有相关读写及 cleanup 后再评估下一组。
- [ ] 对原清理重复项，仅在确认 ownership 和事件顺序后删除；不盲目合并具有不同语义的状态。
- [ ] 保留 AgentManager 公共接口与 output 事件契约；模块依赖窄接口，禁止子模块互调 AgentManager 私有方法或持有全部内部对象。
- [ ] 不同步更改错误来源、stream gate、自动重启或 Rust settled 判定。复杂度归职责，不等于删安全状态机。

验收：从公开 start/stop/restart/output 行为测循环生命周期、待处理请求拒绝、timer 不再发出消息、旧进程事件隔离、多 agent 互不影响。检查状态生命周期表每项都有 owner/cleanup；不以私有 Map.size 全为零证明正确性。

本阶段出口为明确边界的一次完整迁移，而不是强制将 5000+ 行压到任意数字。更大拆分若无法保持窄接口，先补设计和 parity，停止扩张。

### 阶段 G：Composer 与 atoms 的增量收口

- [ ] 先盘点已有 `useComposerImagePicker`、`useImagePaste`、图片预览等模块；优先复用，不能再造第二个图片 owner。
- [ ] 按草稿/补全/图片剪贴板/引用展开/发送适配列输入输出与异步 session 快照要求，优先抽纯引用解析、补全或消息协调策略，不一次搬走全部交互。
- [ ] `session-atoms` 将复杂 reconciliation 策略移到同域纯 helper，并按 runtime/ui/cache 等域拆 atoms；兼容入口只 re-export，必须共用同一 atom 实例。
- [ ] 不形成 atoms↔helper 循环依赖，不改变 atom family key/缓存失效与 reducer 顺序。
- [x] 删除已确认的重复 cardCount 组装；纯整理和语义变化分开验证。本批未改变 fingerprint 的构建时机。
- [ ] 不借本阶段迁移 Tiptap、重写 DOM 选择区/拖放、变更输入框 UI 或扩展通用状态系统。

验收：草稿保存/恢复、快速 session 切换期间 paste/引用展开、图片快照失败、IME Enter、模式与队列发送、补全选择、消息接缝/删除/compaction 保留全绿；纯策略单测与真实浏览器交互分别标注。

### 阶段 H：独立复审、性能报告与文档同步

- [ ] 从公开调用链复审全部 parity 项和相邻路径；审查者不要只阅读新增 helper。
- [ ] 重跑同参数的冷/暖/并发 benchmark，报告 I/O 字节、命令数/最大在途、复制量、状态更新/React 边界渲染、峰值 RSS、事件循环延迟与耗时分位。
- [x] 运行 typecheck、全量测试、renderer/node build；45 项真实 Edge 测试、xmake 实际构建及 native-host-rpc/GUI 通过。真实 WSL 未验收。
- [ ] 原生工具/浏览器/真实运行时缺失的项目列为“未验证”，不能把替身通过或缺工具退出当通过。
- [ ] 检查 `git diff --check`、工作区无临时产物和调试日志；确认未改依赖、版本和用户数据。
- [x] 按实际代码更新长会话治理文档的常量/复杂度/限制，明确 O(entries) 索引与极大单行局限；不要将计划目标写成已实现。
- [ ] 本计划逐项更新状态和证据；原七项 clean review 修复及追加迁移回归仍必须通过。
- [x] 汇总剩余限制与是否需要下一批工作，等待用户明确授权提交/推送。

## 6. 停止条件与回退纪律

- 新优化改变 branch、compaction 范围、entry 锚点、轮次或 runtime 身份：立即停止，先补明确产品决策，不降低测试要求。
- 新队列让有效 WSL 会话因 watchdog 排队超时消失，或跨环境缓存污染：阶段 C 不通过，不以限流达标宣称完成。
- 索引复用引入陈旧/错位正文或峰值内存显著上升：阶段 D 不通过；保留先前已验证阶段，重新收敛数据结构。
- 服务抽取新增重复 owner、循环依赖、宽 props/context 袋或错误默认目标：E/F/G 不通过。
- 无关基线失败需定位、复测并报告；全量不绿不得进入下一阶段/交付合并。
- 回退只针对本阶段助手改动，使用精确编辑；禁止 reset/checkout 等方式吞掉用户并行修改。无新持久化格式，所以不需要以旧数据不可读换回滚便利。

## 7. 状态记录模板

每阶段完成后追加：

```text
阶段：
实际修改范围：
行为 parity 与红→绿证据（纯性能项说明为何不要求功能红灯）：
资源基线→修复后（注明 fixture、冷/暖、环境）：
定向测试 / typecheck / npm test / browser/native：
异常、首次失败与复跑结果：
未验证项、限制与计划偏差：
工作区检查：
```

当前状态：本批性能热点实现及维护性增量收口已通过标准、Edge 和原生集成 gate；完整规划中的未完成项见顶部状态表及执行记录。变更未提交，不把未测真实环境、外部独立审查或后续大模块拆分标记为完成。
