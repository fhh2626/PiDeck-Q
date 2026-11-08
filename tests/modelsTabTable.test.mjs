import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync("src/renderer/src/config/ModelsTab.tsx", "utf8");
const surfaces = readFileSync("src/renderer/src/styles/surfaces.css", "utf8");

test("ModelsTab renders model list as shadcn Table (header + body)", () => {
  assert.match(source, /<Table>/);
  assert.match(source, /<TableHeader>/);
  assert.match(source, /<TableBody>/);
  // 表头 7 列：id/name/context/maxTokens/thinkingLevels/capabilities/actions（能力列在操作列前）
  assert.match(source, /<TableHead className="w-48 min-w-0">\{t\("config\.modelId"\)\}/);
  assert.match(source, /<TableHead className="w-32">\{t\("config\.thinkingLevels"\)\}/);
  assert.match(source, /<TableHead className="w-24">\{t\("config\.capabilities"\)\}/);
  assert.match(source, /<TableHead className="w-20 text-right pr-3">\{t\("config\.actions"\)\}<\/TableHead>/);
  // 表头顺序：thinkingLevels 必须在 capabilities 之前
  const headOrder = source.indexOf('t("config.thinkingLevels")');
  const capOrder = source.indexOf('t("config.capabilities")');
  assert.ok(headOrder > -1 && capOrder > -1 && headOrder < capOrder, "thinkingLevels head must precede capabilities head");
  // 旧 CSS grid 布局已移除
  assert.doesNotMatch(source, /config-models-grid-header/);
  assert.doesNotMatch(source, /config-models-grid-row/);
  assert.doesNotMatch(source, /config-checkbox-cell/);
  assert.doesNotMatch(source, /config-input-cell/);
});

test("model row uses TableRow/TableCell with edit controls", () => {
  assert.match(source, /<TableRow key=\{`\$\{name\}-\$\{i\}`\} className="align-middle">/);
  // 7 个数据单元格 + 空态行 = 8
  const cellCount = (source.match(/<TableCell/g) ?? []).length;
  assert.ok(cellCount >= 8, `expected >= 8 TableCells, got ${cellCount}`);
  assert.match(source, /<Input[\s\S]*?placeholder="model-id"[\s\S]*?className="h-8 min-w-0"/);
  assert.match(source, /placeholder="1000000"[\s\S]*?className="h-8 min-w-0"/);
  assert.match(source, /placeholder="128000"[\s\S]*?className="h-8 min-w-0"/);
  // 删除按钮在操作列
  assert.match(source, /onDeleteModel\(name, i\)/);
});

test("reasoning and image checkboxes share one capabilities column", () => {
  // 同列堆叠（flex flex-col），不再各占一列
  assert.match(source, /<div className="flex flex-col gap-1">/);
  assert.match(source, /<span>\{t\("config\.reasoning"\)\}<\/span>/);
  assert.match(source, /<span>\{t\("config\.inputTypeImage"\)\}<\/span>/);
  assert.doesNotMatch(source, /<TableCell className="p-2 text-center">[\s\S]*?config\.reasoning/);
  // 图片勾选逻辑保留（input 数组 text/image 切换）
  assert.match(source, /const base = m\.input \?\? \["text", "image"\]/);
});

test("thinking levels open in a Popover from a single button", () => {
  // 一个按钮（勾/叉摘要 + Brain 图标），点击弹 Popover 内两个 Checkbox
  assert.match(source, /<Popover>/);
  assert.match(source, /<PopoverTrigger asChild>/);
  assert.match(source, /<Brain className="size-3\.5 shrink-0 opacity-60"/);
  assert.match(source, /t\("config\.xhighOff"\)/);
  assert.match(source, /<PopoverContent align="start" className="w-44 p-2">/);
  // xhigh/max 改为勾选框；勾选=声明支持（值固定为级别名），不再有下拉
  const thinkingBlockStart = source.indexOf("思考级别列");
  const thinkingBlockEnd = source.indexOf("能力列", thinkingBlockStart);
  assert.ok(thinkingBlockStart > -1 && thinkingBlockEnd > thinkingBlockStart, "thinking block must exist");
  const thinkingBlock = source.slice(thinkingBlockStart, thinkingBlockEnd);
  assert.match(thinkingBlock, /<Checkbox/);
  assert.match(thinkingBlock, /checked=\{Boolean\(value\)\}/);
  assert.match(thinkingBlock, /checked === true \? key : ""/);
  assert.doesNotMatch(thinkingBlock, /<ConfigSelect/);
  // 未勾选时触发框显示关闭；勾选状态用 Check/X 图标
  assert.match(thinkingBlock, /\{enabled\s*\? <Check className="size-3"/);
  assert.match(thinkingBlock, /: <X className="size-3"/);
  // 不再有行内两组三按钮
  assert.doesNotMatch(source, /config-thinking-levels-segmented/);
  assert.doesNotMatch(source, /config-thinking-level-option/);
  assert.doesNotMatch(source, /aria-pressed=\{value === option\}/);
});

test("cost config opens in a Dialog per model", () => {
  // 计费按钮（Coins 图标）触发受控 Dialog，不再占整行子行
  assert.match(source, /costDialogKey === `\$\{name\}-\$\{i\}`/);
  assert.match(source, /<Coins className="size-3\.5" aria-hidden="true" \/>/);
  assert.match(source, /<Dialog open=\{costDialogKey ===/);
  // 计费弹窗加宽（sm:max-w-2xl）以容纳梯度计费表格，Dialog 内两列排布
  assert.match(source, /<DialogContent className="sm:max-w-3xl">/);
  assert.match(source, /config\.modelCost/);
  assert.match(source, /config\.advancedPreservedModel/);
  // 计费输入框保持原 field 布局 class（CSS 保留），Dialog 内两列排布
  assert.match(source, /<div className="grid grid-cols-2 gap-2">/);
  assert.match(source, /config-model-cost-field/);
  // 不再有 colSpan 子行
  assert.doesNotMatch(source, /-cost`\} className="hover:bg-transparent">/);
  assert.doesNotMatch(source, /<TableCell colSpan=\{8\} className="p-0 px-3 pb-2">/);
});

test("popover z-index follows project variable so it stays above ConfigModal Dialog", () => {
  // 项目弹层体系：--z-dialog 950（Dialog overlay/content）、--z-popover 960（Select/Dropdown/Tooltip）。
  // Popover 曾写死 z-50 被 Dialog 盖住（思考级别下拉“跑弹框后面”），现统一走 --z-popover。
  const popover = readFileSync("src/renderer/src/components/ui-shadcn/popover.tsx", "utf8");
  assert.match(popover, /z-\(--z-popover\) w-72/);
  assert.doesNotMatch(popover, /"z-50 w-72/);
  const foundation = readFileSync("src/renderer/src/styles/foundation.css", "utf8");
  assert.match(foundation, /--z-dialog: 950;/);
  assert.match(foundation, /--z-popover: 960;/);
});

test("empty state is a colSpan row inside TableBody", () => {
  assert.match(source, /provider\.models\.length === 0 && \(/);
  assert.match(source, /<TableRow className="hover:bg-transparent">[\s\S]*?colSpan=\{8\}[\s\S]*?config\.emptyModels/);
});

test("dead CSS rules removed, kept rules intact", () => {
  assert.doesNotMatch(surfaces, /\.config-models-grid-header/);
  assert.doesNotMatch(surfaces, /\.config-models-grid-row/);
  assert.doesNotMatch(surfaces, /\.config-checkbox-cell/);
  assert.doesNotMatch(surfaces, /\.config-input-cell/);
  assert.doesNotMatch(surfaces, /\.config-xhigh-cell/);
  assert.doesNotMatch(surfaces, /\.config-thinking-levels-segmented/);
  assert.doesNotMatch(surfaces, /\.config-thinking-level-option/);
  assert.doesNotMatch(surfaces, /\.config-cost-cell/);
  // 保留：计费字段布局 / 图片 label；思考级别下拉的旧 CSS 已随 Checkbox 改造删除
  assert.doesNotMatch(surfaces, /\.config-model-cost \{/);
  assert.match(surfaces, /\.config-model-cost-field \{/);
  assert.match(surfaces, /\.config-input-option \{/);
  assert.doesNotMatch(surfaces, /\.config-thinking-levels-cell \{/);
  assert.doesNotMatch(surfaces, /\.config-thinking-levels-row/);
});
