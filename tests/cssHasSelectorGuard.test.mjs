import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * 长会话输入卡顿回归（见 docs/long-session-input-lag-fix.md）。
 * 样式表里的 :has() 会让 Chromium 在元素增删、textarea 内容改写时重算整页样式；长会话有数万个元素，
 * 每次按键（含输入法组字、代码高亮插入节点）都要多花 70ms 以上。参数含属性选择器或 :empty 的最严重，
 * 但只用类名的（如 :root:has(.x)）实测也会拖慢受控 textarea。
 * 因此：手写 CSS 不允许任何 :has()；Tailwind 的 has 系列变体只允许 shadcn Button 的“直接子元素为 svg”。
 * 浏览器侧的兜底断言（含 Tailwind 实际生成结果）见 tests/browser/inputStyleInvalidation.spec.ts。
 */

const RENDERER_ROOT = "src/renderer/src";

function listFiles(dir, extensions) {
	const out = [];
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) out.push(...listFiles(path, extensions));
		else if (extensions.some((ext) => name.endsWith(ext))) out.push(path);
	}
	return out;
}

function hasArguments(selector) {
	const args = [];
	let index = selector.indexOf(":has(");
	while (index >= 0) {
		let depth = 0;
		let end = index + 4;
		for (; end < selector.length; end += 1) {
			if (selector[end] === "(") depth += 1;
			else if (selector[end] === ")") {
				depth -= 1;
				if (depth === 0) break;
			}
		}
		args.push(selector.slice(index + 5, end));
		index = selector.indexOf(":has(", end);
	}
	return args;
}

test("hand-written CSS uses no :has() at all", () => {
	const offenders = [];
	for (const file of listFiles(RENDERER_ROOT, [".css"])) {
		const css = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
		for (const [, selector] of css.matchAll(/([^{};]+)\{/g)) {
			if (hasArguments(selector).length > 0) offenders.push(`${file}: ${selector.trim()}`);
		}
	}
	assert.deepEqual(offenders, []);
});

test("components only use the allowed Tailwind has-variant (shadcn Button icon padding)", () => {
	// 用拼接构造模式，避免本文件自身出现完整变体类名而被 Tailwind 扫描生成规则。
	const has = "has";
	const patterns = [
		// 变体形如 has-<条件>:<工具类>；必须带冒号，避免误伤 "has-runtime" 这类普通类名。
		new RegExp(`(?:^|[\\s"'\`:])(?:group-|peer-)?${has}-(?!\\[>svg\\]:)[\\w-]*(?:\\[[^\\s]*?\\])?(?:/[\\w-]+)?:`),
	];
	const offenders = [];
	for (const file of listFiles(RENDERER_ROOT, [".tsx", ".ts"])) {
		const lines = readFileSync(file, "utf8").split("\n");
		lines.forEach((line, index) => {
			const trimmed = line.trim();
			if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
			// 任意变体（如 [&:has(...)]）或内联选择器里的 :has() 同样会生成/使用 :has() 规则。
			if (patterns.some((pattern) => pattern.test(line)) || line.includes(":has(")) offenders.push(`${file}:${index + 1}`);
		});
	}
	assert.deepEqual(offenders, []);
});

test("replacements keep the original layout intent without :has()", () => {
	const foundation = readFileSync(`${RENDERER_ROOT}/styles/foundation.css`, "utf8");
	assert.match(foundation, /\.session-runtime-ui \{\s*margin-top: var\(--space-3\);\s*padding-bottom: 8px;\s*\}/);
	const streamdown = readFileSync(`${RENDERER_ROOT}/styles/streamdownChrome.css`, "utf8");
	assert.match(streamdown, /\[data-streamdown="code-block"\] > div:not\(\[data-streamdown\]\) \{[\s\S]*?position: absolute;/);
	const workspace = readFileSync(`${RENDERER_ROOT}/styles/workspace.css`, "utf8");
	assert.match(workspace, /\.scratch-pad-md li\.scratch-pad-task-item \{\s*list-style: none;/);
	assert.match(workspace, /\.detail-drawer \.drawer-content-frame--with-rail \{\s*min-width: 0;/);
	const drawerHost = readFileSync(`${RENDERER_ROOT}/components/workspace/WorkspaceDrawerHost.tsx`, "utf8");
	assert.match(drawerHost, /open && props\.rail\s*\?\s*"drawer-content-frame drawer-content-frame--with-rail/);
	const tailwind = readFileSync(`${RENDERER_ROOT}/styles/tailwind.css`, "utf8");
	assert.match(tailwind, /& ul\.contains-task-list \{\s*padding-left: 1\.4em;/);
	assert.match(foundation, /:root\.pideck-custom-titlebar \{/);
	const scratchPad = readFileSync(`${RENDERER_ROOT}/components/scratchPad/ScratchPadPanel.tsx`, "utf8");
	assert.match(scratchPad, /className=\{classes \? `scratch-pad-task-item \$\{classes\}` : "scratch-pad-task-item"\}/);
	// session-runtime-ui 必须保留 empty:hidden，否则为空时也会占位。
	const timeline = readFileSync(`${RENDERER_ROOT}/components/session/SessionMessageTimeline.tsx`, "utf8");
	assert.match(timeline, /className="session-runtime-ui mx-auto w-full min-w-0 empty:hidden"/);
});

test("Web composer textarea is uncontrolled so typing does not rewrite its child text", () => {
	const composer = readFileSync(`${RENDERER_ROOT}/web/WebComposer.tsx`, "utf8");
	assert.match(composer, /defaultValue=""/);
	assert.doesNotMatch(composer, /\bvalue=\{/);
	assert.match(composer, /disabled=\{props\.disabled \|\| !hasText\}/);
	// 浏览器可能恢复表单内容：挂载后按 DOM 实际内容同步一次按钮状态。
	assert.match(composer, /setHasText\(Boolean\(textareaRef\.current\?\.value\.trim\(\)\)\)/);
});

test("shared Textarea never hands value/defaultValue to React (which rewrites the child text every update)", () => {
	const source = readFileSync(`${RENDERER_ROOT}/components/ui-shadcn/textarea.tsx`, "utf8");
	const jsx = source.slice(source.indexOf("<textarea"));
	assert.doesNotMatch(jsx, /\bvalue=\{/);
	assert.doesNotMatch(jsx, /\bdefaultValue=\{/);
	// 值相同不写 DOM（不打断输入法、不移动光标）；首次写入保持 autoFocus 的原生光标位置。
	assert.match(source, /if \(node\.value === text\) return/);
	assert.match(source, /if \(node\.ownerDocument\.activeElement === node\) node\.setSelectionRange\(0, 0\)/);
	assert.match(source, /queueMicrotask\(/);
});
