import assert from "node:assert/strict";
import React from "react";
import test from "node:test";
import { collectSessionFileChanges, collectRunFileChanges, fileChangeToDiffLines } from "../src/renderer/src/components/session/TimelineFormat.ts";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { mountReact } from "./helpers/mountReact.mjs";

/**
 * 会话文件修改汇总收集逻辑测试：
 * write/edit 工具消息 → 文件列表（去重 + 次数累计 + 最后一次 diff 内容）。
 */
function toolMessage(overrides = {}) {
	return {
		id: overrides.id ?? `m-${Math.random().toString(36).slice(2)}`,
		agentId: "a",
		role: "assistant",
		text: "",
		timestamp: Date.now(),
		meta: {
			toolName: overrides.toolName ?? "write",
			args: overrides.args ?? {},
		},
	};
}

test("collectSessionFileChanges: write tool yields the file with full content", () => {
	const messages = [
		toolMessage({ path: "src/a.ts", args: { file_path: "src/a.ts", content: "export const a = 1;" } }),
	];
	const files = collectSessionFileChanges(messages);
	assert.equal(files.length, 1);
	assert.equal(files[0].path, "src/a.ts");
	assert.equal(files[0].content, "export const a = 1;");
	assert.equal(files[0].count, 1);
});

test("collectSessionFileChanges: same file written twice counts twice and keeps the last content", () => {
	const messages = [
		toolMessage({ path: "src/a.ts", args: { file_path: "src/a.ts", content: "v1" } }),
		toolMessage({ path: "src/a.ts", args: { file_path: "src/a.ts", content: "v2" } }),
	];
	const files = collectSessionFileChanges(messages);
	assert.equal(files.length, 1);
	assert.equal(files[0].count, 2);
	assert.equal(files[0].content, "v2");
});

test("collectSessionFileChanges: edit tool captures the changed region", () => {
	const messages = [
		toolMessage({
			path: "src/b.ts",
			toolName: "edit",
			args: {
				file_path: "src/b.ts",
				old_string: "const x = 1;",
				new_string: "const x = 2;",
			},
		}),
	];
	const files = collectSessionFileChanges(messages);
	assert.equal(files.length, 1);
	assert.equal(files[0].path, "src/b.ts");
	assert.equal(files[0].originalContent, "const x = 1;");
	assert.equal(files[0].content, "const x = 2;");
});

test("collectSessionFileChanges: non-file tools and file-less args are ignored", () => {
	const messages = [
		toolMessage({ toolName: "bash", args: { command: "ls" } }),
		toolMessage({ toolName: "read", args: { file_path: "README.md" } }),
		toolMessage({ toolName: "write", args: {} }),
	];
	assert.deepEqual(collectSessionFileChanges(messages), []);
});

test("collectSessionFileChanges: different files are kept separately", () => {
	const messages = [
		toolMessage({ path: "src/a.ts", args: { file_path: "src/a.ts", content: "a" } }),
		toolMessage({ path: "src/b.ts", args: { file_path: "src/b.ts", content: "b" } }),
	];
	const files = collectSessionFileChanges(messages);
	assert.equal(files.length, 2);
	assert.deepEqual(
		files.map((f) => f.path).sort(),
		["src/a.ts", "src/b.ts"],
	);
});

test("collectRunFileChanges: gathers file changes from one run only", () => {
	const run = {
		kind: "agent-run",
		id: "run-1",
		startedAt: 1000,
		endedAt: 2000,
		items: [
			{ kind: "message", message: { role: "user", id: "u1", text: "hi", timestamp: 1100 } },
			{
				kind: "tool-group",
				id: "tg-1",
				messages: [
					toolMessage({ path: "src/a.ts", args: { file_path: "src/a.ts", content: "v1" } }),
					toolMessage({ toolName: "bash", args: { command: "ls" } }),
				],
			},
			{ kind: "thinking-group", id: "th-1", text: "", startedAt: 1200, endedAt: 1300, messages: [] },
			{ kind: "message", message: { role: "assistant", id: "a1", text: "done", timestamp: 1900 } },
		],
	};
	const files = collectRunFileChanges(run);
	assert.equal(files.length, 1);
	assert.equal(files[0].path, "src/a.ts");
	assert.equal(files[0].count, 1);
});

test("fileChangeToDiffLines: write yields all-added lines, edit yields removed+added", () => {
	const writeLines = fileChangeToDiffLines({ originalContent: "", content: "a\nb" });
	assert.deepEqual(writeLines, [
		{ id: "added-0", type: "added", content: "a" },
		{ id: "added-1", type: "added", content: "b" },
	]);
	const editLines = fileChangeToDiffLines({ originalContent: "old1\nold2", content: "new1" });
	assert.deepEqual(editLines, [
		{ id: "removed-0", type: "removed", content: "old1" },
		{ id: "removed-1", type: "removed", content: "old2" },
		{ id: "added-0", type: "added", content: "new1" },
	]);
});

test("TurnFileChanges lists the run's files and collapses them without dropping the toggle", async () => {
	const run = {
		kind: "agent-run",
		id: "run-1",
		startedAt: 1000,
		endedAt: 2000,
		items: [{
			kind: "tool-group",
			id: "tg-1",
			messages: [
				toolMessage({ path: "src/a.ts", args: { file_path: "src/a.ts", content: "v1" } }),
			],
		}],
	};
	await mountReact(async ({ act, root, document, click }) => {
		const { TurnFileChanges } = loadTsCommonJs(
			"src/renderer/src/components/session/turn/TurnFileChanges.tsx",
			{
				stubs: {
					"../../../i18n": { t: (key) => key },
					"../../ui-shadcn/button": {
						Button: (props) => React.createElement("button", {
							type: "button",
							"aria-label": props["aria-label"],
							onClick: props.onClick,
						}, props.children),
					},
					"./TurnFileChangeRow": {
						TurnFileChangeRow: (props) => React.createElement("div", { "data-path": props.path }, props.path),
					},
					"lucide-react": {
						ChevronDown: () => null,
						ChevronUp: () => null,
						Files: () => null,
					},
				},
			},
		);
		await act(() => {
			root.render(React.createElement(TurnFileChanges, { run }));
		});
		assert.equal(document.querySelector("[data-path='src/a.ts']")?.textContent, "src/a.ts");
		await click(document.querySelector("button[aria-label='common.collapse']"));
		assert.equal(document.querySelector("[data-path='src/a.ts']"), null);
		await click(document.querySelector("button[aria-label='common.expand']"));
		assert.equal(document.querySelector("[data-path='src/a.ts']")?.textContent, "src/a.ts");

		await act(() => {
			root.render(React.createElement(TurnFileChanges, {
				run: { ...run, items: [] },
			}));
		});
		assert.equal(document.querySelector("[data-path]"), null);
		assert.equal(document.querySelector("button"), null);
	});
});
