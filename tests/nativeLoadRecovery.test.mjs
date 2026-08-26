import assert from "node:assert/strict";
import test from "node:test";
import { nextLoadFailureAction } from "../src/native-node/loadFailureRecovery.ts";

test("renderer load failures retry with bounded backoff then show an error UI", () => {
	assert.deepEqual(nextLoadFailureAction(0), { kind: "retry", delayMs: 500 });
	assert.deepEqual(nextLoadFailureAction(1), { kind: "retry", delayMs: 1_000 });
	assert.deepEqual(nextLoadFailureAction(2), { kind: "retry", delayMs: 2_000 });
	assert.deepEqual(nextLoadFailureAction(3), { kind: "showError" });
	assert.deepEqual(nextLoadFailureAction(-1), { kind: "retry", delayMs: 500 });
});
