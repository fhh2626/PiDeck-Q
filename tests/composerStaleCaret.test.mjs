import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { withComposerController } from "./helpers/l5_composerControllerHost.mjs";
import { withHookHost } from "./helpers/l5_hookHost.mjs";
/**
 * 复现：点开一个从未点过的会话（草稿为空），在 composer 输入第一个字/粘贴/
 * 语音输入后，光标被重置到最前面。
 *
 * 本质：caretRef 是「即写即忘」的旁路通道，写方（控制器被动 effect）与读方
 * （编辑器 layout effect，只在 value 变化时重跑）之间没有配对约束。任何没有
 * 伴随对应 value 渲染的写入都会变成过期值，在下一次输入时被误消费——
 * 旧实现里 [sessionId] effect 写 `caretRef.current = draft.length`（本意是
 * 切会话后光标回文末），写入落在 layout pass 之后，等用户第一次输入触发
 * layout effect 时被消费，选区被重置回 draft.length；新会话 draft 为空，
 * 光标直接回到 0。
 *
 * 本质解法：契约升级为带归属的光标请求 { pos, forValue }，编辑器只在
 * forValue === value（光标与其所属文本同一次变更、同一趟 layout pass）时
 * 配对消费，不匹配的一律丢弃；外部同步（无配对请求）兜底恢复文末。
 */
// ── 编辑器侧：真实挂载 useTipTapComposerEditor（仅替身化 TipTap 的 useEditor 与文档编解码） ──

/** 假编辑器：记录 setContent / setTextSelection，供断言“光标最终被放在哪”。 */
function createFakeEditor(host) {
	const calls = [];
	const editor = {
		calls,
		isDestroyed: false,
		isEmpty: true,
		isEditable: true,
		setEditable() {},
		view: { dom: host.window.document.createElement("div") },
		state: { doc: { text: "" }, selection: { from: 0 } },
		commands: {
			setContent(doc) {
				calls.push(["setContent", doc.text]);
				return true;
			},
			setTextSelection(pos) {
				calls.push(["selection", pos]);
				return true;
			},
		},
		selections: () => calls.filter(([kind]) => kind === "selection").map(([, pos]) => pos),
		contentSets: () => calls.filter(([kind]) => kind === "setContent").map(([, text]) => text),
	};
	return editor;
}

async function mountEditor(host, initialValue) {
	const editor = createFakeEditor(host);
	let editorOptions;
	const { useTipTapComposerEditor } = loadTsCommonJs(
		"src/renderer/src/components/session/composer/useTipTapComposerEditor.ts",
		{
			stubs: {
				"@tiptap/react": {
					useEditor: (options) => {
						editorOptions = options;
						return editor;
					},
				},
				"./tiptap/createComposerExtensions": { createComposerExtensions: () => [] },
				"./tiptap/buildComposerEditorProps": { buildComposerEditorProps: () => ({}) },
				// 编解码替身：文档即 { text }，偏移与 ProseMirror pos 一一对应，便于直接断言数值。
				"./tiptap/plainTextCodec": {
					plainTextToComposerDoc: (text) => ({ text }),
					serializeComposerDoc: (doc) => doc.text,
				},
				"./tiptap/caretBridge": {
					plainOffsetToPos: (_editor, offset) => offset,
					posToPlainOffset: (_editor, pos) => pos,
					registerComposerTipTapEditor: () => undefined,
				},
			},
			globals: host.globals,
		},
	);
	const caretRef = { current: null };
	const changes = [];
	const props = (value) => ({
		value,
		hostRef: { current: null },
		caretRef,
		onChange: (next, cursor) => changes.push([next, cursor]),
		onCursorChange: () => undefined,
		onKeyDown: () => undefined,
	});
	const mounted = await host.mount((p) => useTipTapComposerEditor(p), props(initialValue));
	return {
		editor,
		caretRef,
		changes,
		/** 父层把草稿渲染成 value。 */
		render: (value) => mounted.rerender(props(value)),
		/** 用户在编辑器里真实键入：TipTap 的 onUpdate 把纯文本推给父层（lastEmitted 随之更新）。 */
		async typeInEditor(text) {
			editor.state.doc = { text };
			editor.state.selection = { from: text.length };
			await host.act(async () => editorOptions.onUpdate({ editor }));
		},
	};
}

test("editor applies a caret request only together with the value it belongs to, then consumes it", async () => {
	await withHookHost(async (host) => {
		const h = await mountEditor(host, "a");
		h.caretRef.current = { pos: 1, forValue: "ab" };
		await h.render("ab");
		assert.deepEqual(h.editor.selections(), [1], "配对请求落在请求的位置，而不是兜底的文末(2)");
		assert.equal(h.caretRef.current, null);
	});
});

test("editor drops a caret request that belongs to a different value instead of applying it", async () => {
	await withHookHost(async (host) => {
		const h = await mountEditor(host, "");
		h.caretRef.current = { pos: 0, forValue: "old" };
		await h.render("new");
		assert.deepEqual(h.editor.selections(), [3], "过期请求(pos 0)不得生效；外部同步兜底到文末");
		assert.equal(h.caretRef.current, null, "过期请求必须丢弃而非保留");
	});
});

test("a stale caret request cannot reset the selection on the next keystroke", async () => {
	await withHookHost(async (host) => {
		// 复现：新会话草稿为空，旧实现的 [sessionId] effect 留下 { pos: 0 } 的待消费光标；
		// 用户键入第一个字后它被误消费，光标回到最前面。
		const h = await mountEditor(host, "");
		h.caretRef.current = { pos: 0, forValue: "" };
		await h.typeInEditor("h");
		await h.render("h");
		assert.deepEqual(h.editor.selections(), [], "键入路径上不得有任何光标重置");
		assert.equal(h.caretRef.current, null, "过期请求在下一次渲染被丢弃");
	});
});

test("external content sync without a paired request restores the caret to the end", async () => {
	await withHookHost(async (host) => {
		const h = await mountEditor(host, "");
		await h.render("restored draft");
		assert.deepEqual(h.editor.contentSets(), ["restored draft"]);
		assert.deepEqual(h.editor.selections(), ["restored draft".length]);
	});
});

test("text the editor itself emitted is not written back as external content", async () => {
	await withHookHost(async (host) => {
		const h = await mountEditor(host, "");
		await h.typeInEditor("hello");
		await h.render("hello");
		assert.deepEqual(h.editor.contentSets(), [], "自己发出的文本回流不得触发 setContent");
		assert.deepEqual(h.editor.selections(), []);
		assert.deepEqual(h.changes, [["hello", 5]]);
	});
});

test("a paired request for typed text is consumed without a content sync", async () => {
	await withHookHost(async (host) => {
		const h = await mountEditor(host, "");
		await h.typeInEditor("x");
		h.caretRef.current = { pos: 1, forValue: "x" };
		await h.render("x");
		assert.deepEqual(h.editor.contentSets(), []);
		assert.deepEqual(h.editor.selections(), [1]);
		assert.equal(h.caretRef.current, null);
	});
});

test("a caret request beyond the text length is clamped to the end", async () => {
	await withHookHost(async (host) => {
		const h = await mountEditor(host, "");
		h.caretRef.current = { pos: 99, forValue: "ab" };
		await h.render("ab");
		assert.deepEqual(h.editor.selections(), [2]);
	});
});

// ── 控制器侧：真实挂载 useSessionComposerController，观察程序化写入的光标请求 ──

test("history navigation writes a caret request tagged with the draft it set", async () => {
	await withComposerController(
		async (c) => {
			const event = await c.press("ArrowUp");
			assert.equal(event.prevented, true);
			assert.equal(c.storedDraft(), "old question");
			assert.deepEqual({ ...c.caret() }, { pos: "old question".length, forValue: "old question" });
			assert.equal(c.caret().forValue, c.storedDraft(), "光标请求必须与同 tick 的 setDraft 文本一致");
		},
		{
			seed: (store, atoms) =>
				store.set(atoms.sessionMessagesCacheAtom, {
					s1: { messages: [{ role: "user", id: "u1", text: "old question" }] },
				}),
		},
	);
});

test("committing a completion writes a caret request tagged with the resulting text", async () => {
	await withComposerController(async (c) => {
		await c.typeChar("/", "/");
		await c.press("Tab");
		assert.ok(c.storedDraft().length > 1);
		assert.deepEqual(
			{ ...c.caret() },
			{ pos: c.storedDraft().length, forValue: c.storedDraft() },
		);
	});
});

test("inserting file references writes a caret request tagged with the resulting text", async () => {
	await withComposerController(async (c) => {
		await c.host.act(async () => c.controller().editor.onNativeFileDrop(["C:/work/notes.txt"]));
		const draft = c.storedDraft();
		assert.match(draft, /notes\.txt/);
		assert.deepEqual({ ...c.caret() }, { pos: draft.length, forValue: draft });
	});
});

test("history navigation back down restores the saved draft with a paired caret request", async () => {
	await withComposerController(
		async (c) => {
			await c.changeTo("my draft");
			await c.press("ArrowUp");
			assert.equal(c.storedDraft(), "old question");

			const event = await c.press("ArrowDown");

			assert.equal(event.prevented, true);
			assert.equal(c.storedDraft(), "my draft");
			assert.deepEqual({ ...c.caret() }, { pos: "my draft".length, forValue: "my draft" });
		},
		{
			seed: (store, atoms) =>
				store.set(atoms.sessionMessagesCacheAtom, {
					s1: { messages: [{ role: "user", id: "u1", text: "old question" }] },
				}),
		},
	);
});

test("the /compact shortcut without a running Agent writes a paired caret request and sends it", async () => {
	await withComposerController(async (c) => {
		await c.host.act(async () => c.controller().delivery.compact());

		assert.deepEqual({ ...c.caret() }, { pos: "/compact".length, forValue: "/compact" });
		assert.equal(c.calls.sendPrompt[0].message, "/compact");
	});
});

test("inserting a prompt template writes a caret request tagged with the resulting text", async () => {
	await withComposerController(async (c) => {
		await c.changeTo("hello");

		await c.host.act(async () => c.controller().pickers.insertTemplate({ name: "review" }));

		assert.equal(c.storedDraft(), "hello /review ");
		assert.deepEqual({ ...c.caret() }, { pos: "hello /review ".length, forValue: "hello /review " });
	});
});

test("pasting plain text from the native clipboard writes a caret request tagged with the resulting text", async () => {
	await withComposerController(
		async (c) => {
			await c.host.act(async () => c.controller().editor.onPasteClipboard());

			assert.equal(c.storedDraft(), "pasted text");
			assert.deepEqual({ ...c.caret() }, { pos: "pasted text".length, forValue: "pasted text" });
		},
		{ native: true, clipboardSnapshot: { filePaths: [], text: "pasted text", html: "", hasImage: false } },
	);
});
test("mounting with an existing draft does not leave a pending caret request", async () => {
	await withComposerController(
		async (c) => {
			assert.equal(c.caret(), null);
		},
		{ seed: (store, atoms) => store.set(atoms.sessionDraftByIdAtom, { s1: "existing draft" }) },
	);
});

test("switching sessions does not write a stale pending caret request", async () => {
	// 旧实现：[sessionId] effect 写 caretRef = draft.length，落在 layout pass 之后，
	// 被用户第一次输入误消费。光标恢复由编辑器的内容同步兜底完成，控制器不得再写。
	await withComposerController(
		async (c) => {
			assert.equal(c.caret(), null);
			await c.rerender({ sessionId: "s2" });
			assert.equal(c.controller().sessionId, "s2");
			assert.equal(c.caret(), null);
			await c.rerender({ sessionId: "s1" });
			assert.equal(c.caret(), null);
		},
		{
			seed: (store, atoms) =>
				store.set(atoms.sessionDraftByIdAtom, { s1: "first draft", s2: "second draft" }),
		},
	);
});