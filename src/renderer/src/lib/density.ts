/**
 * Density Contract —— Native 与 Web 共用的视觉 recipe 真源。
 *
 * 背景：UI Density & Desktop-feel Unification。相同语义的视觉表面（用户气泡、
 * Thinking/Tool 卡、代码/表格 chrome）必须在两端共用同一份 class recipe，
 * 避免"Native 一处改、Web 忘了跟"的漂移。
 *
 * 约定：
 * - recipe 只描述「视觉表面」（radius / padding / border / 文字基线），
 *   不包含业务逻辑（复制/编辑/删除、流式扫光等仍由各端组件实现）。
 * - 数值必须与 styles/foundation.css 的 --density-* token 对齐；
 *   这里写 Tailwind utility，token 供 legacy CSS 与测试引用。
 * - 修改 recipe 必须同步 tests/sharedDensity.test.mjs 的契约断言。
 */

/** 用户消息气泡（右对齐、自适应宽、64ch 上限）。
 * 两端差异：Native 在此之上叠操作栏/时间行/附件；Web 是纯展示。 */
export const USER_TURN_BUBBLE =
	"user-turn-bubble w-fit min-w-0 max-w-[min(82%,64ch)] rounded-lg border border-border bg-muted/60 px-2.5 py-1.5 text-sm text-foreground [overflow-wrap:anywhere] break-words";

/** Thinking / Compaction 虚线框容器（两端共用同一 surface）。 */
export const DASHED_SURFACE =
	"rounded-md border border-dashed border-border-subtle bg-[color:color-mix(in_srgb,var(--color-bg-muted)_45%,transparent)]";

/** 卡片展开区内容 padding（Thinking/Compaction 的 markdown body）。 */
export const CARD_BODY_PADDING = "px-2 py-0.5";

/** Thinking/Compaction 折叠态单行预览 padding。 */
export const CARD_PREVIEW_PADDING = "px-2 py-0.5 font-mono text-caption text-text-tertiary";

/** Thinking/Compaction 标题行（两端共用同一节奏）：24px 行高、6px gap、4px 内边距。
 * Native 在此之上叠 `group relative`（扫光锚点）；Web 保持纯展示。 */
export const THINKING_HEADER =
	"flex min-h-6 w-full cursor-pointer items-center gap-1.5 rounded-md px-1 py-0.5 text-left transition-[background-color,transform] duration-150 motion-reduce:transition-none active:scale-[0.99] focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]";
