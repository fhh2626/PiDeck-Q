import assert from "node:assert/strict";
import test from "node:test";
import { hasLiveSubagentWork, registerPiWebSessionLiveness, PI_WEB_SESSION_LIVENESS_REGISTRY_KEY } from "../resources/extensions/pideck-q-subagents/src/integrations/pi-web-session-liveness.ts";

/** The retained VM can be waiting on a host step after its last model child has exited. */
function fixture() {
	const workflow = { runId: "workflow", sessionId: "parent", result: undefined };
	const state = { currentSessionId: "parent", asyncJobs: new Map(), foregroundControls: new Map(), foregroundWorkflows: new Map([[workflow.runId, workflow]]) };
	return { workflow, state };
}

test("a retained foreground VM keeps the host session live without a foreground child control", () => {
	const { workflow, state } = fixture();
	assert.equal(hasLiveSubagentWork(state), true);
	workflow.result = { content: [], details: { mode: "workflow", results: [] } };
	assert.equal(hasLiveSubagentWork(state), false, "terminal history must not keep the host alive");
});

test("a continuation from a different session does not pin the current host session", () => {
	const { workflow, state } = fixture();
	workflow.sessionId = "old-parent";
	assert.equal(hasLiveSubagentWork(state), false);
	state.currentSessionId = "old-parent";
	assert.equal(hasLiveSubagentWork(state), true);
});

test("the registered host provider follows retained VM completion", (t) => {
	const { workflow, state } = fixture();
	const key = Symbol.for(PI_WEB_SESSION_LIVENESS_REGISTRY_KEY);
	const previous = globalThis[key];
	t.after(() => { if (previous === undefined) delete globalThis[key]; else globalThis[key] = previous; });
	let provider;
	let released = false;
	globalThis[key] = { version: 1, register(value) { provider = value; return () => { released = true; }; } };
	const handle = registerPiWebSessionLiveness({ sessionId: "parent", isActive: () => hasLiveSubagentWork(state) });
	assert.equal(handle.registered, true);
	assert.equal(provider.isActive(), true);
	workflow.result = { content: [], isError: true, details: { mode: "workflow", results: [] } };
	assert.equal(provider.isActive(), false);
	handle.release();
	assert.equal(released, true);
});
