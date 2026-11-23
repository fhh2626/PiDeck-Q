import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { canStopBoundAgent } = loadTsCommonJs("src/renderer/src/utils/canStopBoundAgent.ts");

test("interrupted error agents stay stoppable from the session chrome", () => {
	assert.equal(canStopBoundAgent("running"), true);
	assert.equal(canStopBoundAgent("idle"), true);
	assert.equal(canStopBoundAgent("error"), true);
	assert.equal(canStopBoundAgent("starting"), false);
	assert.equal(canStopBoundAgent("closed"), false);
	assert.equal(canStopBoundAgent(""), false);
	assert.equal(canStopBoundAgent(undefined), false);
});
