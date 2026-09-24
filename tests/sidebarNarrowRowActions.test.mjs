import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { twMerge } from "tailwind-merge";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const {
	buildSidebarSessionDeleteConfirm,
	buildDraftSessionDeleteConfirm,
} = loadTsCommonJs("src/renderer/src/components/sidebar/sidebarDeleteConfirm.ts");

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
	// agent 行与历史/普通会话行有双操作按钮（关闭/删除 + 更多）→ 52px 留白
	const doubleMatches = src.match(
		/conversation-body min-w-0 flex-1 transition-\[padding-right\] @max-\[255px\]:group-hover\/row:pr-\[52px\] @max-\[255px\]:group-focus-within\/row:pr-\[52px\]/g,
	);
	assert.ok(doubleMatches && doubleMatches.length === 2, `expected 2 double action row bodies, got ${doubleMatches?.length ?? 0}`);

	// 子 Agent 行与草稿行有单操作按钮 → 28px (pr-7) 留白
	const singleMatches = src.match(
		/conversation-body min-w-0 flex-1 transition-\[padding-right\] @max-\[255px\]:group-hover\/row:pr-7 @max-\[255px\]:group-focus-within\/row:pr-7/g,
	);
	assert.ok(singleMatches && singleMatches.length === 2, `expected 2 single action row bodies, got ${singleMatches?.length ?? 0}`);

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

test("SessionTree delegates confirmation to App overlays.showConfirm without duplicate window.confirm", () => {
	const src = read("src/renderer/src/components/sidebar/SessionTree.tsx");
	// 确认弹窗统一收口在 App.tsx 的 overlays.showConfirm，SessionTree 中不得再有 window.confirm
	assert.doesNotMatch(src, /window\.confirm/, "SessionTree must not invoke window.confirm");
	assert.match(src, /props\.actions\.sessions\.delete\(props\.project\.id, child\.session\)/);
	assert.match(src, /props\.actions\.sessions\.deleteDraft\(session\)/);
});

test("App handles session delete confirmation with child count awareness and single prompt", () => {
	const appSrc = read("src/renderer/src/App.tsx");
	// 验证 App.tsx 实际调用了抽出的生产确认函数
	assert.match(appSrc, /buildSidebarSessionDeleteConfirm/);
	assert.match(appSrc, /buildDraftSessionDeleteConfirm/);
	assert.match(appSrc, /overlays\.showConfirm\(/);
});

test("buildSidebarSessionDeleteConfirm 生产函数：无子会话、有子会话与确认执行语义", () => {
	let executed = false;
	let cleared = false;
	const mockT = (key, params) => `${key}:${JSON.stringify(params ?? {})}`;

	// 1. 无子会话
	const cfgNoChild = buildSidebarSessionDeleteConfirm({
		session: { name: "主会话", filePath: "/path/to/main.jsonl" },
		childCount: 0,
		t: mockT,
		clearConfirm: () => { cleared = true; },
		onExecuteDelete: () => { executed = true; },
	});
	assert.equal(cfgNoChild.danger, true);
	assert.match(cfgNoChild.message, /drawer\.sessionDeleteBody/);
	assert.doesNotMatch(cfgNoChild.message, /drawer\.sessionDeleteBodyWithChildren/);
	assert.equal(executed, false, "unconfirmed must not execute delete");

	// 执行确认
	cfgNoChild.onConfirm();
	assert.equal(cleared, true, "onConfirm must clear confirmation overlay");
	assert.equal(executed, true, "onConfirm must execute deletion");

	// 2. 有 3 个子会话
	const cfgWithChildren = buildSidebarSessionDeleteConfirm({
		session: { name: "带子会话的主会话", filePath: "/path/to/parent.jsonl" },
		childCount: 3,
		t: mockT,
		clearConfirm: () => {},
		onExecuteDelete: () => {},
	});
	assert.match(cfgWithChildren.message, /drawer\.sessionDeleteBodyWithChildren/);
	assert.match(cfgWithChildren.message, /"count":3/);
});

test("buildDraftSessionDeleteConfirm 生产函数：草稿确认文案与确认执行语义", () => {
	let executed = false;
	let cleared = false;
	const mockT = (key, params) => `${key}:${JSON.stringify(params ?? {})}`;

	const cfgDraft = buildDraftSessionDeleteConfirm({
		session: { title: "未命名草稿" },
		t: mockT,
		clearConfirm: () => { cleared = true; },
		onExecuteDelete: () => { executed = true; },
	});
	assert.equal(cfgDraft.danger, true);
	assert.match(cfgDraft.message, /drawer\.sessionDeleteBody/);
	assert.match(cfgDraft.message, /未命名草稿/);

	assert.equal(executed, false);
	cfgDraft.onConfirm();
	assert.equal(cleared, true);
	assert.equal(executed, true);
});
