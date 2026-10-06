# 长会话输入卡顿修复

## 现象

空闲时，在长会话里输入（尤其是中文输入法）明显卡顿；短会话正常；桌面端与 Web 端都有。

## 原因

渲染层每次输入后，Chromium 都会重算整页样式。长会话页面有数万个元素，实测每次约 70～80ms，几乎全部是样式重算（`UpdateLayoutTree`，约 5,000 个元素），布局和 JavaScript 很少。

触发条件需要同时满足：

1. 样式表里存在 `:has()`。其中参数含属性选择器或 `:empty` 的规则（共 9 条，来自 Streamdown 代码块操作栏、草稿本任务项、时间线 runtime UI 间距，以及 shadcn 卡片/警告对话框按子元素 slot 切换布局的 Tailwind 变体），会让页面任意位置插入或删除元素时都触发整页重算。
2. 输入时有 DOM 结构变化：
   - 受控 textarea（Web 端输入框，以及桌面端共享 `Textarea` 组件：Ask 回答框、编辑消息、草稿本、设置页等）：React 每次更新都会改写 `defaultValue`（即 textarea 的子文本节点）。在样式表还含 `:root:has(...)`、`.detail-drawer:has(...)` 等只用类名的规则时，这一步同样触发整页重算。
   - 桌面端（TipTap/ProseMirror）在输入框清空后的第一次按键或输入法组字时，会删除占位 `<br>`；时间线代码高亮也会在后台成批插入节点。

## 修复

| 位置 | 原写法 | 新写法 |
| --- | --- | --- |
| `streamdownChrome.css` 代码块操作栏外壳 | `:has([data-streamdown="code-block-actions"])` | `[data-streamdown="code-block"] > div:not([data-streamdown])`（header/body 都带 data-streamdown，只有操作栏外壳不带） |
| `workspace.css` 草稿本任务项 | `li:has(> input[type="checkbox"])` | `li.scratch-pad-task-item`，由 `ScratchPadPanel` 按源码行判定后加类 |
| `foundation.css` runtime UI 间距 | `.message-timeline:has(.session-runtime-ui:not(:empty))` | 间距直接写在 `.session-runtime-ui` 上；它带 `empty:hidden`，为空时不占位 |
| shadcn `card.tsx` | Tailwind has-data 变体按 card-action slot 切换两列 | 调用方在 `CardHeader` 上加 `data-has-action="true"`（当前代码未使用 CardAction） |
| shadcn `alert-dialog.tsx` | Tailwind has-data / group-has-data 变体按 media slot 切换布局 | 调用方在 `AlertDialogContent` 上加 `data-has-media`（当前代码未使用 AlertDialogMedia） |
| `WebComposer.tsx` | 受控 textarea | 非受控 textarea，React 只记录“是否有内容”，发送后直接清空 DOM 值 |

第二轮（review 后）补充：

| 位置 | 原写法 | 新写法 |
| --- | --- | --- |
| `foundation.css` 根元素拖拽区变量 | `:root:has(.wechat-shell.custom-titlebar-enabled)` | `:root.pideck-custom-titlebar`，由 `AppShell` 随 `useNativeTitleBar` 同步；类名刻意不同，避免误命中 `.custom-titlebar-enabled` 的后代规则 |
| `workspace.css` 抽屉内容区 | `.detail-drawer:has(.drawer-activity-rail) .drawer-content-frame` | `WorkspaceDrawerHost` 在显示 rail 时加 `drawer-content-frame--with-rail` |
| `tailwind.css` Markdown 预览任务列表 | `ul:has(> li.task-list-item)` | `ul.contains-task-list`（remark-gfm 自带） |
| shadcn `calendar.tsx` | Tailwind has-focus 变体 | `focus-within:`（容器本身不可聚焦，语义相同） |
| shadcn `textarea.tsx` | React 受控 textarea | 对调用方仍是受控用法；内部不把 value/defaultValue 交给 React，挂载和外部改值时直接写 `node.value`，onChange 后按 React 受控语义恢复被拒绝的输入 |
| `WebComposer.tsx` | 挂载时按空内容初始化 | 挂载后按 DOM 实际内容同步发送按钮状态（浏览器可能恢复表单内容） |

修完后样式表只剩 shadcn Button 的 6 条“直接子元素为 svg”规则（参数只有标签，实测不触发整页重算）。共享 `Textarea` 的改动是额外防线：即使以后再引入 `:has()`，受控输入框也不会改写子节点。挂载时带初始内容且 autoFocus 的输入框（如编辑消息），写入后把光标放回开头，与原生受控 textarea 一致。非受控用法（`defaultValue`）只在挂载时写入，表单 reset 会清空而不是回到默认值（项目内没有对 textarea 使用表单 reset）。

注意：Tailwind 会扫描源码和注释里的类名候选，注释和文档中也不要写出完整的 has 变体类名，否则仍会生成对应的 `:has()` 规则。

保留的 `:has()` 规则（参数只含类名、标签或 `:focus`）在元素增删时不会触发整页重算，未改动。

## 诊断

新增 `inputLatencyMonitor.ts`：用 Event Timing API 观察键盘、输入法和输入事件，从事件发生到下一帧绘制超过 100ms 时，按 10 秒窗口汇总一次，内容包括慢事件数量与类型、最慢一次的拆分（输入延迟、处理、绘制）、窗口内的长任务和当前页面元素数。不记录按键或输入内容。

- 桌面端写入应用日志：`Slow input detected`（warn）。
- Web 端没有日志通道，写到浏览器控制台。

## 验证

隔离 Chromium 复现：使用真实渲染层组件（WebTimeline、WebComposer、桌面 ComposerArea/TipTap）和完全合成的数据，长会话为 50 轮、约 6.4 MB 消息、约 27,000 个元素。

| 场景 | 修复前 | 修复后 |
| --- | ---: | ---: |
| Web 输入框，长会话，每次按键 | 约 83 ms | 约 17 ms |
| 长会话中任意位置插入一个元素 | 约 83 ms | 约 16 ms |
| 桌面输入框，长会话，首个按键 | 113 ms | 39 ms |
| 桌面输入法，长会话，首次组字 | 85 ms | 14 ms |
| 共享 `Textarea`（受控）/ 改写子节点的 textarea，长会话，每次按键 | 约 83 ms | 约 17 ms |

短会话修复前后均约 17 ms。

回归测试：

- `tests/cssHasSelectorGuard.test.mjs`：源码层禁止手写 CSS 中的任何 `:has()`，Tailwind has 系列变体只允许 Button 的 svg 规则，并锁定各替代写法与共享 `Textarea` 的实现约束。
- `tests/browser/inputStyleInvalidation.spec.ts`：浏览器中检查实际加载（含 Tailwind 生成）的样式表只剩已知安全的规则，并确认 Web 输入框打字不改写 textarea 子节点。修复前两项均失败。
- `tests/browser/controlledTextarea.spec.ts`：共享 `Textarea` 打字、中间插入、过滤、拒绝、外部回填、转发 ref、输入法组字都与 React 受控语义一致，且全程不改写子节点。旧实现下三项失败。
- `tests/inputLatencyMonitor.test.mjs`：诊断的聚合、窗口、静默降级和不记录内容。

未在用户的 Windows/WebView2 实机上验证；需要重新构建后在真实长会话中确认，并留意日志中的 `Slow input detected`。
