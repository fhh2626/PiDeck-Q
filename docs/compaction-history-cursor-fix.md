# 压缩后历史入口与摘要接缝修复

## 原因与范围

- 压缩后不足 50 轮的 runtime 窗口从摘要卡片开始，`windowStart = 0`。
  原游标换算扣除所有摘要卡片，得到负偏移而省略 `windowStartFilePos`。
  无有效历史前缀游标时，renderer 判定没有更早历史，按钮和自动补历史均不触发。
- 恢复分页后，真实 session IPC 用稳定 `sessionId` 投影文件页，runtime 则用
  transient `agentId` 投影消息。同一摘要的消息 id 不同，只按消息 id 去重会留下两张卡片。
  最初的测试直接用 agentId 读取文件页，掩盖了这个生产接缝。

## 修复规则

1. 文件游标只扣除窗口之前已跳过的摘要卡片；可见摘要不消耗文件消息下标。
   未知 headOffset 仍不提供数值游标，entryId 锚点优先级不变。
2. 文件摘要及 projector 保留 canonical `compactionId`、`firstKeptEntryId` 和 token 元信息。
   普通 prepend 和版本漂移重建共用摘要事件匹配规则：
   - 两端都有 canonical id 时只认同类型、同 id；不同事件即使正文相同也保留。
   - 旧投影缺 id 时，严格匹配类型、正文、时间与 token；已知接缝/分支来源冲突时不匹配。
   - 不以“窗口已有摘要”为由删除页内所有摘要，压缩与分支摘要不能互相替代。
3. 不改写真实 JSONL、catalog、settings 或缓存格式，不改变 50 轮上限、版本/游标/revision
   守卫、runtime generation、消息下发预算或 Pi stdio 协议。

## 验证与边界

- 新的 IPC 回归使用临时七轮会话与假 Pi RPC，从真实注册 handler 读取页，再经过生产
  Jotai prepend、消息分组及渲染窗口策略，检查完整轮次、摘要去重和到顶状态。
- 摘要回归覆盖 prepend、重建、旧投影、不同 canonical 事件、重复正文、token 冲突和分支卡片。
  原有重建测试的断言不变，将两份摘要 fixture 标注为同一 canonical 事件，而非假设所有摘要都重复。
- 原游标计算：新增 11 条测试中 7 条失败；游标修复后全通过。
  真实 IPC 接缝及保留不同事件的回归：修复前 24 条中 9 条失败，修复后全通过。
- 全量门禁恢复：`npm run typecheck` 通过；`npm test` 共 3680 条，3675 通过、5 跳过、0 失败。
  `npm run build` 通过；Vite 既有的 >500 kB chunk 警告仍保留。
- WebFetch 原有两个测试硬编码嵌套依赖目录，npm hoisting 后模块无法加载。
  仅调整测试依赖解析，从安装的 Pi fixture 寻找真实模块；原有 schema/执行断言保持不变。
  临时依赖布局测试验证 nested 优先和 hoisted 路径，不新增依赖、不改变 package/lock。
- 这些证据不代表已更新正在运行的安装版，也不替代 QtWebView/真实 Pi 的安装包 smoke。
  需要更新包含修复的构建后，当前桌面界面才能获得修复；不通过清缓存或重写历史“修复”。
