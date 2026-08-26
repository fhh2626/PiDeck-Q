import assert from "node:assert/strict";
import test from "node:test";
import { NativeDesktopSyncHost } from "../src/renderer/src/native/NativeDesktopSyncHost.ts";

test("native sync host never maps browser Files by basename", () => {
	const sync = new NativeDesktopSyncHost({
		filePaths: ["C:\\one\\same.txt", "D:\\two\\same.txt"],
	});
	const file = new File(["content"], "same.txt");
	assert.equal(sync.getPathForFile(file), "");
	assert.deepEqual(sync.getClipboardPaths(), ["C:\\one\\same.txt", "D:\\two\\same.txt"]);
});

test("native OS drop paths are consumed as an explicit batch, not cached globally", () => {
	const sync = new NativeDesktopSyncHost();
	sync.update({ filePaths: ["C:\\one\\same.txt"] });
	sync.update({ filePaths: ["D:\\two\\same.txt"] });
	assert.deepEqual(sync.getClipboardPaths(), ["D:\\two\\same.txt"]);
	assert.equal(sync.getPathForFile(new File([], "same.txt")), "");
});
