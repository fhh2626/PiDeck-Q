import assert from "node:assert/strict";
import test from "node:test";
import { deferred, withFileEditorDom } from "./helpers/fileEditorDomHost.mjs";

/** Only optional preview chrome is replaced. Loading, saving and the editor are production code. */
function loadViewer(host, loadLanguage = () => Promise.resolve(null)) {
	let nextTimer = 0;
	const timers = new Map();
	const createdUrls = [];
	const revokedUrls = [];
	class TestUrl extends URL {
		static createObjectURL(blob) { const url = URL.createObjectURL(blob); createdUrls.push(url); return url; }
		static revokeObjectURL(url) { revokedUrls.push(url); URL.revokeObjectURL(url); }
	}
	const { FileDiffViewer } = host.load("src/renderer/src/components/app/FileDiffViewer.tsx", {
		stubs: {
			"./CodeMirrorEditor": { CodeMirrorEditor: host.loadEditor(loadLanguage) },
			"../../utils/codemirrorSetup": { loadEditorLanguage: loadLanguage },
			"../../i18n": { t: (key) => key },
			"../../utils/notice": { showNotice() {} },
			"../../desktopApi": { desktopApi: { files: { open: async () => {} }, app: { openExternal: async () => {} } } },
			"../session/MarkdownStream": { MarkdownStream: () => null },
			"../session/composer/chips": { formatFilePathRef: (path) => path },
			"../ui-shadcn/button": { Button: ({ children, variant: _variant, size: _size, ...props }) => host.React.createElement("button", props, children) },
			"../../lib/utils": { cn: (...values) => values.filter(Boolean).join(" ") },
			"../../fileIcons": { getFileIconColor: () => "", getFileIconSeti: () => "" },
		},
		globals: {
			Blob, atob, URL: TestUrl,
			setTimeout: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
			clearTimeout: (id) => timers.delete(id),
		},
	});
	return {
		FileDiffViewer, createdUrls, revokedUrls,
		async autosave() {
			await host.act(async () => {
				const due = [...timers.values()];
				timers.clear();
				for (const { callback, delay } of due) { assert.equal(delay, 500); callback(); }
			});
		},
	};
}

const props = (extra = {}) => ({ filePath: "/project/a.txt", displayMode: "split", readContent: async () => "disk", onClose() {}, ...extra });

async function edit(host, text) {
	await host.act(async () => {
		const view = host.view();
		view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
	});
}

function saveShortcut(host) {
	const event = new host.window.Event("keydown", { cancelable: true });
	Object.assign(event, { key: "s", ctrlKey: true });
	host.window.dispatchEvent(event);
}

test("file reading and language loading overlap, while readable content does not wait for the parser", async () => {
	await withFileEditorDom(async (host) => {
		const read = deferred();
		const language = deferred();
		let languageStarted = false;
		const { FileDiffViewer } = loadViewer(host, () => { languageStarted = true; return language.promise; });
		await host.mountComponent(FileDiffViewer, props({ filePath: "/project/a.json", readContent: () => read.promise }));
		assert.equal(languageStarted, true, "the parser request can run during file I/O");
		assert.equal(host.view(), null, "unread data must not become an editable document");
		await host.act(async () => read.resolve('{"ready":true}'));
		assert.equal(host.view().state.doc.toString(), '{"ready":true}');
		await host.act(async () => language.resolve(host.require("@codemirror/lang-json").json()));
		assert.equal(host.view().state.doc.toString(), '{"ready":true}');
	});
});

test("a cancelled text read cannot replace the newly selected file", async () => {
	await withFileEditorDom(async (host) => {
		const first = deferred();
		const { FileDiffViewer } = loadViewer(host);
		const readContent = (path) => path.endsWith("a.txt") ? first.promise : Promise.resolve("second file");
		const mounted = await host.mountComponent(FileDiffViewer, props({ readContent }));
		await mounted.rerender(props({ filePath: "/project/b.txt", readContent }));
		assert.equal(host.view().state.doc.toString(), "second file");
		await host.act(async () => first.resolve("stale first file"));
		assert.equal(host.view().state.doc.toString(), "second file");
	});
});

test("changing files clears the earlier document's undo history even when reads resolve immediately", async () => {
	await withFileEditorDom(async (host) => {
		const { FileDiffViewer } = loadViewer(host);
		const readContent = async (path) => path.endsWith("a.txt") ? "first file" : "second file";
		// act flushes the loading=true effect before the resolved read. Normal React
		// scheduling can batch both loading states and keep the existing editor alive.
		const previousActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
		globalThis.IS_REACT_ACT_ENVIRONMENT = false;
		const container = host.window.document.createElement("div");
		host.window.document.body.append(container);
		const root = host.require("react-dom/client").createRoot(container);
		const waitForDocument = (content) => new Promise((resolve, reject) => {
			let timeout;
			const observer = new host.window.MutationObserver(check);
			function check() {
				if (host.view()?.state.doc.toString() !== content) return;
				observer.disconnect();
				clearTimeout(timeout);
				resolve();
			}
			observer.observe(container, { childList: true, subtree: true, characterData: true });
			timeout = setTimeout(() => {
				observer.disconnect();
				reject(new Error(`Editor never displayed ${JSON.stringify(content)}`));
			}, 5000);
			check();
		});
		try {
			root.render(host.React.createElement(FileDiffViewer, props({ readContent })));
			await waitForDocument("first file");
			const firstView = host.view();
			firstView.dispatch({ changes: { from: 0, to: firstView.state.doc.length, insert: "edited first file" } });
			await waitForDocument("edited first file");
			root.render(host.React.createElement(FileDiffViewer, props({ filePath: "/project/b.txt", readContent })));
			await waitForDocument("second file");
			assert.equal(host.require("@codemirror/commands").undo(host.view()), false);
			assert.equal(host.view().state.doc.toString(), "second file");
		} finally {
			root.unmount();
			container.remove();
			globalThis.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
		}
	});
});

test("automatic save writes the latest edit instead of the prior render's content", async () => {
	await withFileEditorDom(async (host) => {
		const fixture = loadViewer(host);
		const writes = [];
		await host.mountComponent(fixture.FileDiffViewer, props({ saveContent: async (path, content) => { writes.push({ path, content }); } }));
		await edit(host, "latest typed text");
		await fixture.autosave();
		assert.deepEqual(writes, [{ path: "/project/a.txt", content: "latest typed text" }]);
	});
});

test("a save completion cannot overwrite edits made while its write was pending", async () => {
	await withFileEditorDom(async (host) => {
		const fixture = loadViewer(host);
		const saved = deferred();
		const writes = [];
		await host.mountComponent(fixture.FileDiffViewer, props({ saveContent: async (path, content) => { writes.push({ path, content }); await saved.promise; } }));
		await edit(host, "first edit");
		await host.act(async () => saveShortcut(host));
		await edit(host, "second edit");
		await host.act(async () => saved.resolve());
		assert.equal(host.view().state.doc.toString(), "second edit");
		await fixture.autosave();
		assert.deepEqual(writes.map((entry) => entry.content), ["first edit", "second edit"]);
	});
});

test("the old file's completed save cannot replace the currently open document", async () => {
	await withFileEditorDom(async (host) => {
		const fixture = loadViewer(host);
		const saved = deferred();
		const writes = [];
		const input = props({
			readContent: async (path) => path.endsWith("a.txt") ? "first file" : "second file",
			saveContent: async (path, content) => { writes.push({ path, content }); if (path.endsWith("a.txt")) await saved.promise; },
		});
		const mounted = await host.mountComponent(fixture.FileDiffViewer, input);
		await edit(host, "edited first file");
		await host.act(async () => saveShortcut(host));
		await mounted.rerender({ ...input, filePath: "/project/b.txt" });
		await edit(host, "edited second file");
		await host.act(async () => saved.resolve());
		assert.equal(host.view().state.doc.toString(), "edited second file");
		await fixture.autosave();
		assert.deepEqual(writes, [
			{ path: "/project/a.txt", content: "edited first file" },
			{ path: "/project/b.txt", content: "edited second file" },
		]);
	});
});

test("overlapping save requests leave the newest edit on disk", async () => {
	await withFileEditorDom(async (host) => {
		const fixture = loadViewer(host);
		const first = deferred();
		let disk = "disk";
		await host.mountComponent(fixture.FileDiffViewer, props({ saveContent: async (_path, content) => {
			if (content === "first edit") await first.promise;
			disk = content;
		} }));
		await edit(host, "first edit");
		await host.act(async () => saveShortcut(host));
		await edit(host, "newest edit");
		await host.act(async () => saveShortcut(host));
		await host.act(async () => first.resolve());
		assert.equal(disk, "newest edit");
		assert.equal(host.view().state.doc.toString(), "newest edit");
	});
});

test("accepted saves finish in order after switching files without changing the new document's dirty state", async () => {
	await withFileEditorDom(async (host) => {
		const fixture = loadViewer(host);
		const firstWrite = deferred();
		const writes = [];
		const input = props({
			readContent: async (path) => path.endsWith("a.txt") ? "first file" : "second file",
			saveContent: async (path, content) => {
				writes.push({ path, content });
				if (content === "first edit") await firstWrite.promise;
			},
		});
		const mounted = await host.mountComponent(fixture.FileDiffViewer, input);
		await edit(host, "first edit");
		await host.act(async () => saveShortcut(host));
		// Deliberately equal B's baseline: A's queued write must use A's own baseline.
		await edit(host, "second file");
		await host.act(async () => saveShortcut(host));
		await mounted.rerender({ ...input, filePath: "/project/b.txt" });
		await edit(host, "unsaved second-file edit");
		await host.act(async () => firstWrite.resolve());
		assert.deepEqual(writes, [
			{ path: "/project/a.txt", content: "first edit" },
			{ path: "/project/a.txt", content: "second file" },
		]);
		assert.equal(host.view().state.doc.toString(), "unsaved second-file edit");
		assert.match(host.window.document.querySelector(".file-diff-title").textContent, /editor\.unsavedMarker/);
		await fixture.autosave();
		assert.deepEqual(writes.at(-1), { path: "/project/b.txt", content: "unsaved second-file edit" });
		assert.doesNotMatch(host.window.document.querySelector(".file-diff-title").textContent, /editor\.unsavedMarker/);
	});
});

test("closing the viewer still completes every accepted save request in order", async () => {
	await withFileEditorDom(async (host) => {
		const fixture = loadViewer(host);
		const firstWrite = deferred();
		const writes = [];
		const mounted = await host.mountComponent(fixture.FileDiffViewer, props({ saveContent: async (path, content) => {
			writes.push({ path, content });
			if (content === "first edit") await firstWrite.promise;
		} }));
		await edit(host, "first edit");
		await host.act(async () => saveShortcut(host));
		await edit(host, "newest edit before closing");
		await host.act(async () => saveShortcut(host));
		await mounted.unmount();
		await host.act(async () => firstWrite.resolve());
		assert.deepEqual(writes, [
			{ path: "/project/a.txt", content: "first edit" },
			{ path: "/project/a.txt", content: "newest edit before closing" },
		]);
		assert.equal(host.view(), null);
	});
});

for (const [restoreReadBaseline, finishOldSavesBeforeSaving] of [[false, false], [true, false], [true, true]]) {
	test(`reopening a file preserves accepted save order when the final edit ${restoreReadBaseline ? "returns to its read baseline" : "contains newer text"}${finishOldSavesBeforeSaving ? " after the old queue completes" : ""}`, async () => {
		await withFileEditorDom(async (host) => {
			const fixture = loadViewer(host);
			const firstWrite = deferred();
			const writes = [];
			let disk = "initial";
			const input = props({
				readContent: async () => disk,
				saveContent: async (path, content) => {
					writes.push({ path, content });
					if (content === "first edit before close") await firstWrite.promise;
					disk = content;
				},
			});
			const beforeClose = await host.mountComponent(fixture.FileDiffViewer, input);
			await edit(host, "first edit before close");
			await host.act(async () => saveShortcut(host));
			await edit(host, "queued second edit before close");
			await host.act(async () => saveShortcut(host));
			await beforeClose.unmount();
			await host.mountComponent(fixture.FileDiffViewer, input);
			assert.equal(host.view().state.doc.toString(), "initial");
			await edit(host, "newest edit after reopening");
			const finalContent = restoreReadBaseline ? "initial" : "newest edit after reopening";
			if (restoreReadBaseline) await edit(host, finalContent);
			if (finishOldSavesBeforeSaving) await host.act(async () => firstWrite.resolve());
			await host.act(async () => saveShortcut(host));
			await host.act(async () => firstWrite.resolve());
			assert.deepEqual(writes.map((write) => write.content), [
				"first edit before close", "queued second edit before close", finalContent,
			]);
			assert.ok(writes.every((write) => write.path === input.filePath));
			assert.equal(disk, finalContent);
			assert.equal(host.view().state.doc.toString(), finalContent);
			assert.doesNotMatch(host.window.document.querySelector(".file-diff-title").textContent, /editor\.unsavedMarker/);
		});
	});
}

for (const separateStore of [false, true]) {
	test(`a pending file save does not block ${separateStore ? "the same path in another Jotai store" : "another path in the same Jotai store"}`, async () => {
		await withFileEditorDom(async (host) => {
			const fixture = loadViewer(host);
			const { Provider, createStore } = host.require("jotai");
			const firstStore = createStore();
			const secondStore = separateStore ? createStore() : firstStore;
			const firstWrite = deferred();
			const writes = [];
			const disk = new Map([["first", "initial first"], ["second", "initial second"]]);
			const firstInput = props({
				readContent: async () => disk.get("first"),
				saveContent: async (path, content) => {
					writes.push({ owner: "first", path, content });
					if (content === "first pending edit") await firstWrite.promise;
					disk.set("first", content);
				},
			});
			const secondInput = props({
				filePath: separateStore ? firstInput.filePath : "/project/b.txt",
				readContent: async () => disk.get("second"),
				saveContent: async (path, content) => {
					writes.push({ owner: "second", path, content });
					disk.set("second", content);
				},
			});
			function Viewer({ store, ...input }) {
				return host.React.createElement(Provider, { store }, host.React.createElement(fixture.FileDiffViewer, input));
			}
			const mounted = await host.mountComponent(Viewer, { ...firstInput, store: firstStore });
			try {
				await edit(host, "first pending edit");
				await host.act(async () => saveShortcut(host));
				await edit(host, "latest first edit");
				await host.act(async () => saveShortcut(host));
				if (separateStore) await mounted.unmount();
				await mounted.rerender({ ...secondInput, store: secondStore });
				await edit(host, "latest second edit");
				await host.act(async () => saveShortcut(host));
				assert.equal(disk.get("second"), "latest second edit", "the independent owner must finish while the first write remains gated");
				assert.equal(disk.get("first"), "initial first");
				assert.doesNotMatch(host.window.document.querySelector(".file-diff-title").textContent, /editor\.unsavedMarker/);
			} finally {
				await host.act(async () => firstWrite.resolve());
			}
			assert.deepEqual(writes.filter((write) => write.owner === "first").map((write) => write.content), ["first pending edit", "latest first edit"]);
			assert.equal(disk.get("first"), "latest first edit");
			assert.equal(host.view().state.doc.toString(), "latest second edit");
		});
	});
}

test("unchanged documents and duplicate queued snapshots do not write again", async () => {
	await withFileEditorDom(async (host) => {
		const fixture = loadViewer(host);
		const firstWrite = deferred();
		const writes = [];
		await host.mountComponent(fixture.FileDiffViewer, props({ saveContent: async (path, content) => {
			writes.push({ path, content });
			await firstWrite.promise;
		} }));
		await host.act(async () => saveShortcut(host));
		assert.deepEqual(writes, []);
		await edit(host, "edited once");
		await host.act(async () => saveShortcut(host));
		await host.act(async () => saveShortcut(host));
		await host.act(async () => firstWrite.resolve());
		await host.act(async () => saveShortcut(host));
		assert.deepEqual(writes, [{ path: "/project/a.txt", content: "edited once" }]);
	});
});

test("a save shortcut during a replacement read cannot write the old contents into the new file", async () => {
	await withFileEditorDom(async (host) => {
		const fixture = loadViewer(host);
		const nextRead = deferred();
		const writes = [];
		const input = props({
			readContent: (path) => path.endsWith("a.txt") ? Promise.resolve("first file") : nextRead.promise,
			saveContent: async (...args) => { writes.push(args); },
		});
		const mounted = await host.mountComponent(fixture.FileDiffViewer, input);
		await edit(host, "first edit");
		await mounted.rerender({ ...input, filePath: "/project/b.txt" });
		await host.act(async () => saveShortcut(host));
		await fixture.autosave();
		assert.deepEqual(writes, []);
		await host.act(async () => nextRead.resolve("second file"));
		assert.equal(host.view().state.doc.toString(), "second file");
	});
});

test("unmount cancels an automatic save that has not started", async () => {
	await withFileEditorDom(async (host) => {
		const fixture = loadViewer(host);
		const writes = [];
		const mounted = await host.mountComponent(fixture.FileDiffViewer, props({ saveContent: async (...args) => { writes.push(args); } }));
		await edit(host, "unsaved edit");
		await mounted.unmount();
		await fixture.autosave();
		assert.deepEqual(writes, []);
	});
});

test("a cancelled binary read cannot replace the current image or allocate a late Blob URL", async () => {
	await withFileEditorDom(async (host) => {
		const first = deferred();
		host.window.piDesktop = { files: { readBase64: (path) => path.endsWith("a.png") ? first.promise : Promise.resolve("Qg==") } };
		const fixture = loadViewer(host);
		const input = props({ filePath: "/project/a.png" });
		const mounted = await host.mountComponent(fixture.FileDiffViewer, input);
		await mounted.rerender({ ...input, filePath: "/project/b.png" });
		const current = host.window.document.querySelector(".file-diff-media-preview img")?.getAttribute("src");
		assert.ok(current);
		await host.act(async () => first.resolve("QQ=="));
		assert.equal(host.window.document.querySelector(".file-diff-media-preview img")?.getAttribute("src"), current);
		assert.deepEqual(fixture.createdUrls, [current]);
		await mounted.unmount();
		assert.deepEqual(fixture.revokedUrls, [current]);
	});
});

test("closing the viewer before a binary read completes leaves no Blob URL behind", async () => {
	await withFileEditorDom(async (host) => {
		const read = deferred();
		host.window.piDesktop = { files: { readBase64: () => read.promise } };
		const fixture = loadViewer(host);
		const mounted = await host.mountComponent(fixture.FileDiffViewer, props({ filePath: "/project/a.png" }));
		await mounted.unmount();
		await host.act(async () => read.resolve("QQ=="));
		assert.deepEqual(fixture.createdUrls, []);
		assert.deepEqual(fixture.revokedUrls, []);
	});
});
