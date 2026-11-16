import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const require = createRequire(import.meta.url);
const { createStore } = require("jotai");
const { enqueueFileEditorSaveAtom, fileEditorSaveQueuesAtom } = loadTsCommonJs("src/renderer/src/atoms/file-editor-saves.ts");

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
	return { promise, resolve, reject };
}

test("the file save owner preserves pending tails and releases completed queue entries", async () => {
	const store = createStore();
	const firstWrite = deferred();
	const secondWrite = deferred();
	const writes = [];
	const input = {
		filePath: "/project/document.txt", readBaseline: "initial",
		saveContent: async (_path, content) => {
			writes.push(content);
			await (content === "first" ? firstWrite.promise : secondWrite.promise);
		},
	};
	const emptySnapshot = store.get(fileEditorSaveQueuesAtom);
	const first = store.set(enqueueFileEditorSaveAtom, { ...input, content: "first" });
	const firstSnapshot = store.get(fileEditorSaveQueuesAtom);
	const firstTail = firstSnapshot.get(input.filePath);
	const second = store.set(enqueueFileEditorSaveAtom, { ...input, content: "second" });
	assert.equal(emptySnapshot.size, 0, "prior Jotai snapshots stay immutable");
	assert.equal(firstSnapshot.get(input.filePath), firstTail);
	assert.notEqual(store.get(fileEditorSaveQueuesAtom).get(input.filePath), firstTail);
	firstWrite.resolve();
	await first;
	assert.equal(store.get(fileEditorSaveQueuesAtom).size, 1, "an earlier completion cannot remove a later pending tail");
	secondWrite.resolve();
	await second;
	assert.deepEqual(writes, ["first", "second"]);
	assert.equal(store.get(fileEditorSaveQueuesAtom).size, 0, "settled queues must not retain promises or document content");
});

test("a failed file save leaves an unknown baseline and allows the following accepted save", async () => {
	const store = createStore();
	const firstWrite = deferred();
	const failure = new Error("disk write failed");
	const writes = [];
	const input = {
		filePath: "/project/document.txt", readBaseline: "initial",
		saveContent: async (_path, content) => {
			writes.push(content);
			if (content === "failed content") await firstWrite.promise;
		},
	};
	const first = store.set(enqueueFileEditorSaveAtom, { ...input, content: "failed content" });
	const rejected = assert.rejects(first, (error) => error === failure);
	const second = store.set(enqueueFileEditorSaveAtom, { ...input, content: "initial" });
	firstWrite.reject(failure);
	await Promise.all([rejected, second]);
	assert.deepEqual(writes, ["failed content", "initial"], "a failure cannot make the next snapshot appear already saved");
	assert.equal(store.get(fileEditorSaveQueuesAtom).size, 0);
});
