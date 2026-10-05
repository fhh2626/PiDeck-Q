# Composer 输入热路径修复

## 范围与边界

本次修复源码审查和隔离浏览器复现确认的三个问题：普通按键扫描消息历史、草稿 render 重复同步测量附属区域、每次输入重新应用 TipTap 配置。

不修改会话文件、缓存格式、设置、runtime 身份或 IPC；不减少 50 轮历史限制，不改变视觉设计，不引入依赖。没有清缓存、停止 Agent、替换安装包或重启正在运行的应用。

这三个问题的资源回归已经修复；它们并不等价于“已证明现场全部高 CPU／私有内存占用的唯一原因”。隔离 Edge 用例不是运行数小时后的 QtWebView2 实测。

## 原因与修复

### 1. 普通按键扫描输入历史

`useSessionComposerController.onKeyDown()` 原来在辨别按键前读取 DOM 光标、扫描会话消息并合并提示词历史。`extractUserPrompts()` 又先读取/trim 正文才过滤角色，因此工具和助手正文也进入普通输入热路径。

现在只有上下键真正需要历史导航时才读取光标和历史；多行草稿中的行内移动不读取历史，ArrowDown 退出导航恢复草稿时也无需扫描。提取函数先判断 user 角色，再处理正文。IME 候选导航不抢走方向键或读取历史。

保留提示词顺序、去重和 50 条上限，以及草稿快照、Escape/ArrowDown 恢复和带 value 归属的 caret 请求。

### 2. 草稿 render 重复测量附属区域

原来的 `ComposerMeasuredExtras` 在无依赖的 `useLayoutEffect` 中读取高度/样式。ComposerArea 每次草稿 render 都重新创建附属 ReactNode，即使没有实际尺寸变化也触发同步测量。

测量 owner 移到 `composer/ComposerMeasuredExtras.tsx`。后续高度报告只由真实尺寸变化的 ResizeObserver 驱动，在 paint 前直接报告，不额外等待一帧。首测仍延迟到面板注册后的首个 rAF。observer 与首测 rAF 在同一模块清理，StrictMode 重放和首帧前卸载有测试。

保留 widget/队列/通知与附件的分层布局、shrink-0、实际 rowGap、增长/回缩以及原面板高度预算。普通输入不再同步读取 extras 布局；编辑器自身必要的光标和布局读取没有被禁用。

### 3. 每次输入重新应用 TipTap 配置

原来的 hook 每次 render 都创建扩展、初始化文档和 editorProps，当前 TipTap 的 useEditor 将这些不同引用识别为配置变化并调用 setOptions 更新视图。

现在初始化扩展/文档由一次性 ref 持有；DOM 配置只随 className、placeholder、disabled 变化。事件委托继续读取最新 callback ref。移除重复设置 editorProps 的 effect，仅在权限变化时显式同步 editable。外部草稿回填继续由既有受控 layout effect 和白名单 ref 处理，不把每次输入当成重新初始化。

## 红 → 绿证据

使用完全合成数据，运行真实 ComposerArea/controller、TipTap 与时间线。桌面 API 是替身；禁止激活 Agent/发送 prompt，浏览器不访问外部 origin。20 次真实按键的资源对照：

| 指标 | 修复前 | 修复后 |
|---|---:|---:|
| 非 user 的工具正文读取 | 22,680 | 0 |
| extras 测量 | 20 | 0 |
| TipTap setOptions | 20 | 0 |

初始普通输入/非 user 正文测试失败；真实 React extras 测试在 20 次父级 render 后仍测量而失败；editor options 引用稳定性测试失败。断言保留，修复后转绿。自动化键盘往返耗时不作为现场输入延迟或提升比例。

临时整链路脚本/日志保留在仓库外 `R:/Temp/pideck-input-source-review.mjs`、`pideck-input-source-review-red.log`、`pideck-input-final-diagnostic.log`；长期回归覆盖在仓库中：

- `tests/composerInputHotPath.test.mjs`：实际 controller 的输入事件入口、消息 getter 资源边界、历史导航/恢复、多行与 IME。
- `tests/composerExtrasMeasurement.behavior.test.mjs`：真实 React、尺寸替身，覆盖无关 render 零测量、增长/回缩、最新 callback、StrictMode/资源清理。
- `tests/composerEditorOptions.behavior.test.mjs`：真实 React，观察交给编辑器库的配置在草稿/callback 更新时稳定、在权限/外观变化时更新。
- `tests/browser/composerInput.spec.ts`：真实 Edge/TipTap DOM，验证输入配置预算、外部草稿/配对 caret、清空后首字、禁用/placeholder/新 callback、合成中文 composition、真实 ResizeObserver。

原 `composerAutoGrow.test.mjs` 中锁定无依赖 layout effect 的结构断言迁移到独立测量 owner 和尺寸观察路径；面板预算、shrink-0、顺序、gap、增长/回缩及最小尺寸断言保留，并补公开行为测试。

## 验证

- 类型检查通过（`npm run build` 也执行完整 `npm run typecheck`）。
- `npm test`：3699 项，3694 通过、5 跳过、0 失败。
- `npm run test:browser`：50 项通过，包含新增 5 项输入回归。
- `npm run build`：通过；既有 Vite 大 chunk 提示仍在。
- 隔离整链路输入资源断言：3 项全部转绿。

全量测试的第一次运行发现新多行 fixture 写成了字面量反斜杠+n；已改为实际换行，保留原断言并重新跑全量测试。没有放宽预算、断言或超时。

构建产物不会自动更新已经安装或已运行的 PiDeck-Q。安装替换、运行数小时后的实机验证和提交/推送不属于本次已执行操作。
