import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { ExternalFileCapabilityError, ExternalFileCapabilityStore } = loadTsCommonJs(
	"src/main/fs/ExternalFileCapabilityStore.ts",
);

test("drop capabilities redeem exact paths once for reads", () => {
	const store = new ExternalFileCapabilityStore();
	const capabilityId = store.issueDrop(["C:\\outside\\passport.png", "C:\\outside\\notes.txt"]);
	assert.ok(capabilityId);
	assert.equal(store.consumeRead(capabilityId, "c:/outside/passport.png"), "C:\\outside\\passport.png");
	assert.throws(
		() => store.consumeRead(capabilityId, "C:\\outside\\passport.png"),
		(error) => error instanceof ExternalFileCapabilityError,
	);
	assert.equal(store.consumeRead(capabilityId, "C:\\outside\\notes.txt"), "C:\\outside\\notes.txt");
	assert.throws(
		() => store.consumeRead(capabilityId, "C:\\outside\\notes.txt"),
		(error) => error instanceof ExternalFileCapabilityError,
	);
});

test("clipboard capabilities can be reused until the clipboard sequence changes", () => {
	const store = new ExternalFileCapabilityStore();
	const capabilityId = store.issueClipboard(["C:\\outside\\a.txt"], 42);
	assert.ok(capabilityId);
	assert.deepEqual(Array.from(store.consumeCopy(capabilityId)), ["C:\\outside\\a.txt"]);
	assert.deepEqual(Array.from(store.consumeCopy(capabilityId)), ["C:\\outside\\a.txt"]);
	assert.equal(store.issueClipboard(["C:\\outside\\a.txt"], 42), capabilityId);

	const replacementId = store.issueClipboard(["C:\\outside\\b.txt"], 43);
	assert.ok(replacementId);
	assert.notEqual(replacementId, capabilityId);
	assert.throws(
		() => store.consumeCopy(capabilityId),
		(error) => error instanceof ExternalFileCapabilityError,
	);
	assert.deepEqual(Array.from(store.consumeCopy(replacementId)), ["C:\\outside\\b.txt"]);
});

test("clipboard capabilities do not expire while their sequence stays unchanged", () => {
	let now = 1_000_000;
	const { ExternalFileCapabilityStore: ClockedExternalFileCapabilityStore } = loadTsCommonJs(
		"src/main/fs/ExternalFileCapabilityStore.ts",
		{ globals: { Date: { now: () => now } } },
	);
	const store = new ClockedExternalFileCapabilityStore();
	const capabilityId = store.issueClipboard(["C:\\outside\\long-lived.txt"], 7);
	assert.ok(capabilityId);
	now += 11 * 60_000;
	assert.deepEqual(Array.from(store.consumeCopy(capabilityId)), ["C:\\outside\\long-lived.txt"]);
	assert.equal(store.issueClipboard(["C:\\outside\\long-lived.txt"], 7), capabilityId);
});

test("drop capabilities return trusted paths once and never accept renderer paths", () => {
	const store = new ExternalFileCapabilityStore();
	const capabilityId = store.issueDrop(["C:\\outside\\id_rsa"]);
	assert.ok(capabilityId);
	assert.deepEqual(Array.from(store.consumeCopy(capabilityId)), ["C:\\outside\\id_rsa"]);
	assert.throws(
		() => store.consumeCopy(capabilityId),
		(error) => error instanceof ExternalFileCapabilityError,
	);
});
