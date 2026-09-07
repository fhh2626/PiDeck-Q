import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { twMerge } from "tailwind-merge";

// 窄侧栏行操作按钮防重叠契约（2027-01 用户反馈）：
// ProjectTree 的项目选择按钮与 actions 已改为同级 flex item，永不重叠；
// SessionTree/WorktreeTree 仍使用 absolute 浮层，侧栏窄（<256px）时由
// @max-[255px]:group-hover:pr-* 为行文本压出按钮宽度的右侧留白。
// 注意：v1 曾用 opacity-0 整行淡出，用户反馈「文字变白不可读、须点击激活才能看到」，
// 已弃用（见本文件 doesNotMatch 断言防回退）。
// 本测试锁定：容器基准、统一断点、项目 flex 命中区及其余两棵树的浮层兼容路径。

const read = (p) => readFileSync(p, "utf8");

const prVariant = /@max-\[255px\]:group-hover(?:\/row)?:pr-/;

test("sidebar host declares the container query anchor", () => {
	const src = read("src/renderer/src/components/sidebar/SidebarContent.tsx");
	// aside 是容器查询基准：@container → container-type: inline-size，
	// 行文本的 @max-[255px] 变体按侧栏实际宽度生效（不把宽度穿进树组件）
	assert.match(src, /chat-list-pane v3-braun @container flex/);
});

test("project row selection and actions have non-overlapping hit areas", () => {
	const src = read("src/renderer/src/components/sidebar/ProjectTree.tsx");
	assert.match(src, /conversation-body min-w-0 flex-1/);
	assert.match(src, /const dimmedActionsClass =\s*\n\s*"ml-auto shrink-0 flex/);
	assert.doesNotMatch(src, /pointer-events-none absolute top-1\/2 right-1 flex/);
	assert.doesNotMatch(src, /group-hover:pointer-events-auto/);
	// 淡出方案已弃用：文本不得再整行变透明
	assert.doesNotMatch(src, /conversation-body[^\n]*opacity-0/);
});

test("session rows yield to hover actions on narrow sidebar", () => {
	const src = read("src/renderer/src/components/sidebar/SessionTree.tsx");
	// agent 行、运行中会话行、历史会话行、普通会话行共 4 处 conversation-body 全部接入
	// （一个 size-6 更多按钮 → 28px 留白）
	const matches = src.match(
		/conversation-body min-w-0 flex-1 transition-\[padding-right\] @max-\[255px\]:group-hover\/row:pr-7 @max-\[255px\]:group-focus-within\/row:pr-7/g,
	);
	assert.ok(matches && matches.length === 4, `expected 4 row bodies, got ${matches?.length ?? 0}`);
	// 浮层模式不变
	assert.match(src, /row-more-actions pointer-events-none absolute top-1\/2 right-1/);
	assert.doesNotMatch(src, /conversation-body[^\n]*opacity-0/);
});

test("worktree rows yield to hover actions on narrow sidebar", () => {
	const src = read("src/renderer/src/components/sidebar/WorktreeTree.tsx");
	// 主工作区行：2 按钮 → 52px 留白
	assert.match(
		src,
		/conversation-body min-w-0 flex-1 transition-\[padding-right\] @max-\[255px\]:group-hover:pr-\[52px\] @max-\[255px\]:group-focus-within:pr-\[52px\]/,
	);
	// 子工作区行：3 按钮 → 78px 留白，挂在行按钮上（transition-all 与配色过渡共存）
	assert.match(src, /transition-all @max-\[255px\]:group-hover:pr-\[78px\] @max-\[255px\]:group-focus-within:pr-\[78px\]/);
	// 子行文本 span 回归原始形态（不再淡出/不再带过渡）
	assert.match(src, /<span className=\{cn\("min-w-0 flex-1 truncate", isActive/);
	assert.match(src, /workspace-tree-directory max-w-20 shrink-0 truncate text-micro text-muted-foreground\">\{row\.directory\}<\/span>/);
	// 浮层模式不变
	assert.match(src, /workspace-tree-actions pointer-events-none absolute top-1\/2 right-0\.5/);
	// 行文本不得再淡出
	assert.doesNotMatch(src, /group-hover(?:\/row)?:opacity-0/);
});

test("narrow-sidebar variants survive tailwind-merge", () => {
	// 防回归：cn() 的 tailwind-merge 不得吞掉容器查询变体或任意值 pr（未知变体应保留）
	const merged = twMerge(
		"min-w-0 flex-1 truncate transition-[padding-right] @max-[255px]:group-hover:pr-29 @max-[255px]:group-focus-within:pr-29",
	);
	assert.match(merged, prVariant);
	assert.match(merged, /transition-\[padding-right\]/);
	// 子行按钮：transition-all 与 transition-colors 同组冲突，后者应胜出（留 padding 动画）
	const rowMerged = twMerge(
		"flex min-h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-0 transition-colors",
		"transition-all @max-[255px]:group-hover:pr-[78px]",
	);
	assert.match(rowMerged, /transition-all/);
	assert.doesNotMatch(rowMerged, /transition-colors/);
	assert.match(rowMerged, prVariant);
});
