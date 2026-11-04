import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { withHookHost } from "./helpers/l5_hookHost.mjs";

// 文件查看器的 IO 回调必须在 App 重渲染间保持引用稳定：
// 若退回到 JSX 里的内联箭头（readContent={(path) => api.files.readContent(path)}），
// 每次 App 渲染都会换新函数，FileDiffViewer 的加载 effect 随之反复重跑。
// 这里真实挂载 useFileEditor，断言「引用稳定」+「确实委托给传入的 API」。

const nodeRequire = createRequire(import.meta.url);
const { Provider, createStore } = nodeRequire("jotai");
const { atom } = nodeRequire("jotai/vanilla");

function createInput(overrides = {}) {
	const calls = [];
	const input = {
		activeProjectId: "proj",
		activeProjectIdRef: { current: "proj" },
		activeAgent: null,
		activeProject: null,
		drawer: null,
		setDrawer: () => undefined,
		setDrawerCollapsed: () => undefined,
		contentOpenMode: "split",
		showToast: () => undefined,
		readFileContent: async (path, maxBytes) => {
			calls.push(["read", path, maxBytes]);
			return "file-content";
		},
		readGitOriginalContent: async (path) => {
			calls.push(["original", path]);
			return "original-content";
		},
		writeFileContent: async (path, content) => {
			calls.push(["write", path, content]);
		},
		openFile: async () => undefined,
		workspaceFileDiff: async () => null,
		commitFileDiff: async () => null,
		t: (key) => key,
		...overrides,
	};
	return { input, calls };
}

async function mountEditor(host, input) {
	const store = createStore();
	const { useFileEditor } = host.load("src/renderer/src/hooks/useFileEditor.ts", {
		stubs: { "../atoms": { modifiedFilesAtom: atom([]) } },
	});
	const wrap = (node) => host.React.createElement(Provider, { store }, node);
	return host.mount(useFileEditor, input, wrap);
}

test("file viewer IO callbacks keep their identity when App re-renders with the same API functions", async () => {
	await withHookHost(async (host) => {
		const { input } = createInput();
		const mounted = await mountEditor(host, input);
		const first = mounted.result();

		// App 重渲染：input 对象是新的，但底层 API 函数引用不变
		await mounted.rerender({ ...input });
		const second = mounted.result();

		assert.strictEqual(second.readEditorFileContent, first.readEditorFileContent);
		assert.strictEqual(second.readEditorOriginalContent, first.readEditorOriginalContent);
		assert.strictEqual(second.saveEditorFileContent, first.saveEditorFileContent);
	});
});

test("file viewer IO callbacks delegate to the injected file and git APIs", async () => {
	await withHookHost(async (host) => {
		const { input, calls } = createInput();
		const mounted = await mountEditor(host, input);
		const editor = mounted.result();

		assert.equal(await editor.readEditorFileContent("a.ts", 1024), "file-content");
		assert.equal(await editor.readEditorOriginalContent("a.ts"), "original-content");
		await editor.saveEditorFileContent("a.ts", "new body");

		assert.deepEqual(calls, [
			["read", "a.ts", 1024],
			["original", "a.ts"],
			["write", "a.ts", "new body"],
		]);
	});
});

test("file viewer IO callbacks follow the API when the injected function actually changes", async () => {
	await withHookHost(async (host) => {
		const first = createInput();
		const mounted = await mountEditor(host, first.input);
		const before = mounted.result().readEditorFileContent;

		const second = createInput();
		await mounted.rerender(second.input);
		const after = mounted.result().readEditorFileContent;

		assert.notStrictEqual(after, before);
		await after("b.ts");
		assert.deepEqual(second.calls, [["read", "b.ts", undefined]]);
		assert.deepEqual(first.calls, []);
	});
});
