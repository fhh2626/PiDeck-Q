import assert from "node:assert/strict";
import test from "node:test";
import { deferred, withFileEditorDom } from "./helpers/fileEditorDomHost.mjs";

test("editor displays and edits plain text before its language finishes loading", async () => {
	await withFileEditorDom(async (host) => {
		const language = deferred();
		const changed = [];
		const Editor = host.loadEditor(() => language.promise);
		await host.mountComponent(Editor, { value: "ready from disk", language: "json", onChange: (text) => changed.push(text) });
		assert.equal(host.window.document.querySelector(".cm-content")?.textContent, "ready from disk");
		const view = host.view();
		await host.act(async () => view.dispatch({ changes: { from: view.state.doc.length, insert: " + edit" } }));
		assert.deepEqual(changed, ["ready from disk + edit"]);
		await host.act(async () => language.resolve(host.require("@codemirror/lang-json").json()));
		assert.equal(host.view().state.doc.toString(), "ready from disk + edit");
	});
});

test("a value received while the language is pending replaces the earlier snapshot", async () => {
	await withFileEditorDom(async (host) => {
		const language = deferred();
		const changed = [];
		const Editor = host.loadEditor(() => language.promise);
		const mounted = await host.mountComponent(Editor, { value: "old", language: "json", onChange: (text) => changed.push(text) });
		await mounted.rerender({ value: "latest", language: "json", onChange: (text) => changed.push(text) });
		await host.act(async () => language.resolve(host.require("@codemirror/lang-json").json()));
		assert.equal(host.view().state.doc.toString(), "latest");
		assert.deepEqual(changed, [], "prop synchronization is not a user edit");
	});
});

test("loading another language preserves the current text, caret and undo history", async () => {
	await withFileEditorDom(async (host) => {
		const nextLanguage = deferred();
		const Editor = host.loadEditor((name) => name === "json" ? nextLanguage.promise : Promise.resolve(null));
		const mounted = await host.mountComponent(Editor, { value: "abc", language: "txt" });
		await host.act(async () => host.view().dispatch({ changes: { from: 3, insert: "d" }, selection: { anchor: 2 } }));
		await mounted.rerender({ value: "abcd", language: "json" });
		assert.equal(host.view()?.state.doc.toString(), "abcd");
		assert.equal(host.view().state.selection.main.anchor, 2);
		await host.act(async () => nextLanguage.resolve(host.require("@codemirror/lang-json").json()));
		assert.equal(host.view().state.selection.main.anchor, 2);
		await host.act(async () => assert.equal(host.require("@codemirror/commands").undo(host.view()), true));
		assert.equal(host.view().state.doc.toString(), "abc");
	});
});

test("an older language completion cannot replace the current language", async () => {
	await withFileEditorDom(async (host) => {
		const json = deferred();
		const js = deferred();
		const Editor = host.loadEditor((name) => name === "json" ? json.promise : js.promise);
		const mounted = await host.mountComponent(Editor, { value: "value", language: "json" });
		await mounted.rerender({ value: "value", language: "js" });
		const javascript = host.require("@codemirror/lang-javascript").javascript();
		await host.act(async () => js.resolve(javascript));
		await host.act(async () => json.resolve(host.require("@codemirror/lang-json").json()));
		assert.equal(host.view().state.facet(host.require("@codemirror/language").language), javascript.language);
		assert.equal(host.window.document.querySelectorAll(".cm-editor").length, 1);
	});
});

test("failed language loading leaves the document editable", async () => {
	await withFileEditorDom(async (host) => {
		const language = deferred();
		const Editor = host.loadEditor(() => language.promise);
		await host.mountComponent(Editor, { value: "plain fallback", language: "json" });
		await host.act(async () => language.reject(new Error("language unavailable")));
		assert.equal(host.view().state.doc.toString(), "plain fallback");
		await host.act(async () => host.view().dispatch({ changes: { from: 0, insert: "edited " } }));
		assert.equal(host.view().state.doc.toString(), "edited plain fallback");
	});
});

test("unmount cancels late language installation and removes the editor DOM", async () => {
	await withFileEditorDom(async (host) => {
		const language = deferred();
		const changed = [];
		const Editor = host.loadEditor(() => language.promise);
		const mounted = await host.mountComponent(Editor, { value: "closed", language: "json", onChange: (text) => changed.push(text) });
		await mounted.unmount();
		await host.act(async () => language.resolve(host.require("@codemirror/lang-json").json()));
		assert.equal(host.window.document.querySelectorAll(".cm-editor").length, 0);
		assert.deepEqual(changed, []);
	});
});

test("JSON diagnostics attach asynchronously and disappear when switching to plain text", async () => {
	await withFileEditorDom(async (host) => {
		const language = deferred();
		const Editor = host.loadEditor((name) => name === "json" ? language.promise : Promise.resolve(null));
		const props = { value: '{"broken": }', language: "json" };
		const mounted = await host.mountComponent(Editor, props);
		assert.ok(host.view(), "the JSON parser must not delay the editable document");
		const { diagnosticCount, forceLinting } = host.require("@codemirror/lint");
		assert.equal(diagnosticCount(host.view().state), 0);
		await host.act(async () => language.resolve(host.require("@codemirror/lang-json").json()));
		await host.act(async () => forceLinting(host.view()));
		assert.ok(diagnosticCount(host.view().state) > 0);
		await mounted.rerender({ ...props, language: "txt" });
		assert.equal(diagnosticCount(host.view().state), 0);
	});
});

test("read-only changes during language loading keep the latest editor policy", async () => {
	await withFileEditorDom(async (host) => {
		const language = deferred();
		const Editor = host.loadEditor(() => language.promise);
		const mounted = await host.mountComponent(Editor, { value: "locked", language: "json", readOnly: false });
		await mounted.rerender({ value: "locked", language: "json", readOnly: true });
		await host.act(async () => language.resolve(host.require("@codemirror/lang-json").json()));
		assert.equal(host.view().state.facet(host.require("@codemirror/state").EditorState.readOnly), true);
	});
});
