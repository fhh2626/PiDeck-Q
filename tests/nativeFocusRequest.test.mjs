import assert from "node:assert/strict";
import test from "node:test";
import { resolveSecondaryFocusSessionId } from "../src/native-node/focusRequest.ts";

const sessionId = "session-1";
const agentId = "agent-1";

test("secondary focus resolves a stable session target directly", () => {
	let resolvedAgent = false;
	assert.equal(resolveSecondaryFocusSessionId({ sessionId }, () => {
		resolvedAgent = true;
		return "unexpected";
	}), sessionId);
	assert.equal(resolvedAgent, false);
});

test("secondary focus resolves legacy agent targets through the live backend", () => {
	assert.equal(resolveSecondaryFocusSessionId({ agentId }, (value) => {
		assert.equal(value, agentId);
		return sessionId;
	}), sessionId);
});

test("focus-only secondary launches remain focus requests without a target", () => {
	assert.equal(resolveSecondaryFocusSessionId(undefined, () => sessionId), undefined);
});
