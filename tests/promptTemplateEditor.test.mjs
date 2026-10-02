import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}
function template(overrides = {}) {
	return { name: "editable", path: "/prompts/editable.md", description: "Description", content: "Body", userCreated: true, ...overrides };
}

/** Minimal deterministic hook scheduler; browser tests also exercise the actual React hosts. */
function harness(options) {
	const slots = [];
	const cleanups = [];
	let cursor = 0;
	let commits = 0;
	const { usePromptTemplateEditor } = loadTsCommonJs("src/renderer/src/hooks/usePromptTemplateEditor.ts", {
		stubs: { react: {
			useRef: (initial) => { const index = cursor++; slots[index] ??= { current: initial }; return slots[index]; },
			useState: (initial) => {
				const index = cursor++;
				if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
				return [slots[index], (value) => { commits++; slots[index] = typeof value === "function" ? value(slots[index]) : value; }];
			},
			useCallback: (callback) => callback,
			useEffect: (effect) => { const index = cursor++; if (!(index in slots)) { slots[index] = true; cleanups.push(effect()); } },
		} },
	});
	return {
		get editor() { cursor = 0; return usePromptTemplateEditor(options); },
		get commits() { return commits; },
		unmount: () => { for (const cleanup of cleanups) cleanup?.(); },
	};
}

function storage(overrides = {}) {
	return { read: async () => "Body", write: async () => {}, ...overrides };
}

test("a successful read/save establishes the draft baseline and reverting becomes clean", async () => {
	const writes = [];
	const dirty = [];
	const h = harness({ storage: storage({ write: async (target, content) => writes.push({ target, content }) }), onDirtyChange: (value) => dirty.push(value) });
	await h.editor.open(template());
	assert.equal(h.editor.dirty, false);
	h.editor.change("Changed");
	assert.equal(h.editor.dirty, true);
	h.editor.change("Body");
	assert.equal(h.editor.dirty, false);
	h.editor.change("Saved draft");
	assert.equal(await h.editor.save(), true);
	assert.equal(h.editor.state.template.path, "/prompts/editable.md");
	assert.equal(h.editor.state.content, "Saved draft");
	assert.equal(h.editor.state.saved, true);
	assert.equal(h.editor.dirty, false);
	assert.equal(await h.editor.save(), false, "a clean draft is not sent twice");
	assert.equal(writes.length, 1);
	assert.equal(dirty.at(-1), false);
});

test("a failed write preserves the dirty draft and a successful retry clears the error", async () => {
	let fail = true;
	const h = harness({ storage: storage({ write: async () => { if (fail) throw new Error("disk-full"); } }) });
	await h.editor.open(template());
	h.editor.change("Keep draft");
	assert.equal(await h.editor.save(), false);
	assert.equal(h.editor.state.content, "Keep draft");
	assert.equal(h.editor.state.savedContent, "Body");
	assert.equal(h.editor.dirty, true);
	assert.equal(h.editor.state.saved, false);
	assert.match(h.editor.state.error, /disk-full/);
	fail = false;
	assert.equal(await h.editor.save(), true);
	assert.equal(h.editor.state.error, null);
	assert.equal(h.editor.dirty, false);
});

test("busy lock prevents same-frame duplicate saves, draft changes, opens and closes", async () => {
	const pending = deferred();
	let writes = 0;
	const h = harness({ storage: storage({ write: async () => { writes++; await pending.promise; } }) });
	await h.editor.open(template());
	h.editor.change("Snapshot");
	const command = h.editor.save();
	assert.equal(h.editor.state.saving, true);
	assert.equal(await h.editor.save(), false);
	assert.equal(h.editor.close(), false);
	assert.equal(await h.editor.open(template({ name: "other" })), false);
	h.editor.change("Must not overwrite the in-flight snapshot");
	assert.equal(h.editor.state.content, "Snapshot");
	pending.resolve();
	assert.equal(await command, true);
	assert.equal(writes, 1);
	assert.equal(h.editor.state.saving, false);
});

test("loading blocks writes and closing rejects the late read", async () => {
	const pending = deferred();
	let writes = 0;
	const h = harness({ storage: storage({ read: () => pending.promise, write: async () => { writes++; } }) });
	const command = h.editor.open(template());
	assert.equal(h.editor.state.loading, true);
	h.editor.change("Cannot save before reading");
	assert.equal(await h.editor.save(), false);
	assert.equal(h.editor.close(), true);
	pending.resolve("Late content");
	assert.equal(await command, false);
	assert.equal(h.editor.state.template, null);
	assert.equal(writes, 0);
});

test("a late read from the previous template cannot overwrite the new editor", async () => {
	const old = deferred();
	const h = harness({ storage: storage({ read: (target) => target.name === "old" ? old.promise : Promise.resolve("New body") }) });
	const previous = h.editor.open(template({ name: "old" }));
	await h.editor.open(template({ name: "new", path: "/prompts/new.md" }));
	old.resolve("Old body");
	assert.equal(await previous, false);
	assert.equal(h.editor.state.template.name, "new");
	assert.equal(h.editor.state.content, "New body");
});

test("a failed read stays visible but never enables writing an empty placeholder", async () => {
	let writes = 0;
	const h = harness({ storage: storage({ read: async () => { throw new Error("unreadable"); }, write: async () => { writes++; } }) });
	assert.equal(await h.editor.open(template()), false);
	assert.match(h.editor.state.error, /unreadable/);
	assert.equal(h.editor.state.ready, false);
	h.editor.change("Cannot replace the unread file");
	assert.equal(await h.editor.save(), false);
	assert.equal(writes, 0);
});

test("builtin user copy is retained after a failed write and reused for every later save", async () => {
	let creates = 0;
	const targets = [];
	const h = harness({ storage: storage({
		createCopy: async () => { creates++; return template({ name: "copy", path: "/prompts/copy.md", content: "---\ndescription: Description\n---\n" }); },
		write: async (target) => { targets.push(target.path); if (targets.length === 1) throw new Error("first write fails"); },
	}) });
	await h.editor.open(template({ userCreated: false }));
	h.editor.change("First");
	assert.equal(await h.editor.save(), false);
	assert.equal(h.editor.state.template.path, "/prompts/copy.md");
	assert.equal(await h.editor.save(), true);
	h.editor.change("Second");
	assert.equal(await h.editor.save(), true);
	assert.equal(creates, 1);
	assert.deepEqual(targets, ["/prompts/copy.md", "/prompts/copy.md", "/prompts/copy.md"]);
});

test("reverting to builtin body after a failed copy write stays dirty and can retry against the real file", async () => {
	const { PromptManager } = loadTsCommonJs("src/main/prompts/PromptManager.ts");
	const { createGlobalPromptEditorStorage } = loadTsCommonJs("src/renderer/src/config/promptEditorStorage.ts");
	const home = await mkdtemp(join(tmpdir(), "pideck-prompt-baseline-"));
	try {
		const manager = new PromptManager(home);
		const builtin = (await manager.list()).templates.find((item) => !item.userCreated);
		assert.ok(builtin, "use an actual builtin rather than a fake copy contract");
		let creates = 0;
		let writes = 0;
		const h = harness({ storage: createGlobalPromptEditorStorage({
			create: async (input) => { creates++; return manager.create(input); },
			edit: async (path, content) => {
				if (content === undefined) return manager.readContent(path);
				if (++writes === 1) throw new Error("temporary file lock");
				await manager.writeContent(path, content);
			},
		}) });
		await h.editor.open(builtin);
		h.editor.change(`${builtin.content}\nChanged body`);
		assert.equal(await h.editor.save(), false);
		const copyPath = h.editor.state.template.path;
		const persistedCopy = await manager.readContent(copyPath);
		assert.notEqual(persistedCopy, builtin.content, "create writes only frontmatter, not the builtin body");
		assert.equal(h.editor.state.savedContent, persistedCopy);
		h.editor.change(persistedCopy);
		assert.equal(h.editor.dirty, false, "matching the actual new file is clean");
		h.editor.change(builtin.content);
		assert.equal(h.editor.dirty, true, "the builtin body still has not been saved into the user copy");
		assert.equal(await h.editor.save(), true);
		assert.equal(await manager.readContent(copyPath), builtin.content);
		assert.equal(h.editor.dirty, false);
		assert.equal(creates, 1);
		assert.equal(writes, 2);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("refresh failure reports saved-with-warning, not a failed write or dirty draft", async () => {
	const h = harness({ storage: storage(), onSaved: async () => { throw new Error("list unavailable"); } });
	await h.editor.open(template());
	h.editor.change("Saved");
	assert.equal(await h.editor.save(), true);
	assert.equal(h.editor.state.saved, true);
	assert.equal(h.editor.dirty, false);
	assert.equal(h.editor.state.savedContent, "Saved");
	assert.match(h.editor.state.error, /list unavailable/);
});

test("unmount invalidates a pending read without committing its late result", async () => {
	const pending = deferred();
	const h = harness({ storage: storage({ read: () => pending.promise }) });
	const command = h.editor.open(template());
	const commits = h.commits;
	h.unmount();
	pending.resolve("Late body");
	assert.equal(await command, false);
	assert.equal(h.commits, commits);
});

test("global storage omits the write argument on reads and rejects missing content", async () => {
	const { createGlobalPromptEditorStorage } = loadTsCommonJs("src/renderer/src/config/promptEditorStorage.ts");
	const calls = [];
	const adapter = createGlobalPromptEditorStorage({ edit: async (...args) => { calls.push(args); return args.length === 1 ? "File body" : undefined; }, create: async () => template() });
	assert.equal(await adapter.read(template({ userCreated: false })), "Body");
	assert.equal(calls.length, 0, "builtins use their in-memory body");
	assert.equal(await adapter.read(template()), "File body");
	await adapter.write(template(), "Write body");
	assert.deepEqual(calls, [["/prompts/editable.md"], ["/prompts/editable.md", "Write body"]]);
	const invalid = createGlobalPromptEditorStorage({ edit: async () => undefined, create: async () => template() });
	await assert.rejects(invalid.read(template()));
});
