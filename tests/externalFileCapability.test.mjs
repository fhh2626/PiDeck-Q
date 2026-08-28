import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { ExternalFileCapabilityError, ExternalFileCapabilityStore } = loadTsCommonJs(
	"src/main/fs/ExternalFileCapabilityStore.ts",
);

test("external file capabilities redeem exact paths once for reads", () => {
	const store = new ExternalFileCapabilityStore();
	const capabilityId = store.issue(["C:\\outside\\passport.png", "C:\\outside\\notes.txt"]);
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

test("external file copy capabilities return trusted paths once and never accept renderer paths", () => {
	const store = new ExternalFileCapabilityStore();
	const capabilityId = store.issue(["C:\\outside\\id_rsa"]);
	assert.ok(capabilityId);
	assert.deepEqual(Array.from(store.consumeCopy(capabilityId)), ["C:\\outside\\id_rsa"]);
	assert.throws(
		() => store.consumeCopy(capabilityId),
		(error) => error instanceof ExternalFileCapabilityError,
	);
});
