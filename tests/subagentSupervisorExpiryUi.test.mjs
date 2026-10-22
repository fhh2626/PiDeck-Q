import assert from "node:assert/strict";
import test from "node:test";
import { renderSupervisorRequest } from "../resources/extensions/pideck-q-subagents/src/intercom/supervisor-ui.ts";

/** A journal card may be rendered much later than the request that originally created it. */
test("a supervisor card rechecks expiry on render and hides obsolete reply commands", () => {
	const details = { requestId: "ask-1", reason: "need_decision", expectsReply: true, expiresAt: Date.now() + 60_000, requestBody: "Approve scoped work", runId: "run-1", agent: "readonly", childIndex: 0 };
	const card = renderSupervisorRequest({ content: "original", details }, { expanded: true }, { fg: (_tone, value) => value });
	assert.match(card.render(120).join("\n"), /If still pending, reply/);
	details.expiresAt = Date.now() - 1000;
	const expired = card.render(120).join("\n");
	assert.match(expired, /Expired request/);
	assert.doesNotMatch(expired, /action: "reply"/);
	assert.match(expired, /Approve scoped work/, "history remains inspectable without presenting stale authority");
});
