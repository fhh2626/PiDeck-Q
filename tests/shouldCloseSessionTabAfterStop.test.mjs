import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { shouldCloseSessionTabAfterStop } = loadTsCommonJs(
	"src/renderer/src/utils/canStopBoundAgent.ts",
);

test("session chrome only closes the tab after a real stop", () => {
	assert.equal(shouldCloseSessionTabAfterStop({
		pending: false,
		hasRuntimeTarget: true,
		stopSucceeded: true,
	}), true);
	assert.equal(shouldCloseSessionTabAfterStop({
		pending: true,
		hasRuntimeTarget: true,
		stopSucceeded: true,
	}), false);
	assert.equal(shouldCloseSessionTabAfterStop({
		pending: false,
		hasRuntimeTarget: false,
		stopSucceeded: true,
	}), false);
	assert.equal(shouldCloseSessionTabAfterStop({
		pending: false,
		hasRuntimeTarget: true,
		stopSucceeded: false,
	}), false);
});
