/** Outgoing children retain cancellation ownership without appearing in the next session. */
import assert from "node:assert/strict";
import test from "node:test";
import { createFixture } from "./helpers/subagentResumeHarness.mjs";

await import("./helpers/piFixtureResolver.mjs");
const { interruptForegroundControls } = await import("../resources/extensions/pideck-q-subagents/src/runs/foreground/foreground-control.ts");
const { resolveSubagentRunId } = await import("../resources/extensions/pideck-q-subagents/src/runs/background/run-id-resolver.ts");
const { inspectSubagentFleet } = await import("../resources/extensions/pideck-q-subagents/src/runs/background/fleet-view.ts");
const { collectFleetSnapshot } = await import("../resources/extensions/pideck-q-subagents/src/tui/fleet.ts");
const { collectFleetStatusEntries } = await import("../resources/extensions/pideck-q-subagents/src/tui/fleet-status.ts");

function control(runId, sessionId, agent, children = []) {
	return {
		runId, sessionId, mode: "single", cwd: "/project", currentAgent: agent, currentIndex: 0, startedAt: Date.now(), updatedAt: Date.now(),
		activeChildren: new Map(children.length ? children.map((child, index) => [index, { index, agent, startedAt: Date.now(), updatedAt: Date.now(), ...child }])
			: [[0, { index: 0, agent, startedAt: Date.now(), updatedAt: Date.now() }]]),
	};
}

test("outgoing cleanup cancels every sibling after one interrupt fails and retains authoritative ownership", (t) => {
	const cancelled = [];
	const errors = [];
	t.mock.method(console, "error", (...args) => errors.push(args));
	const outgoing = control("outgoing-run", "previous-parent", "old-worker", [
		{ interrupt() { cancelled.push("first"); throw new Error("child cancellation failed"); } },
		{ interrupt() { cancelled.push("second"); return true; } },
	]);
	const current = control("current-run", "current-parent", "current-worker", [{ interrupt() { cancelled.push("current"); return true; } }]);
	const state = { foregroundControls: new Map([[outgoing.runId, outgoing], [current.runId, current]]) };
	interruptForegroundControls(state, "current-parent");
	assert.deepEqual(cancelled, ["first", "second"]);
	assert.equal(errors.length, 1);
	assert.equal(state.foregroundControls.get(outgoing.runId), outgoing, "cancellation cannot release a child before its authoritative exit");
	assert.equal(outgoing.activeChildren.size, 2);
	assert.equal(state.foregroundControls.get(current.runId), current);
	interruptForegroundControls(state);
	assert.deepEqual(cancelled, ["first", "second", "first", "second", "current"], "extension replacement must cancel every owning session");
});

test("retained controls from an outgoing parent stay out of run lookup and fleet surfaces", () => {
	const fixture = createFixture({}, "control-ownership");
	const state = fixture.state;
	state.currentSessionId = fixture.parentSessionFile;
	const current = control("review-prefix-current", state.currentSessionId, "current-worker");
	const outgoing = control("review-prefix-outgoing", "another-session", "PRIVATE-OLD-WORKER");
	state.foregroundControls.set(current.runId, current);
	state.foregroundControls.set(outgoing.runId, outgoing);
	assert.deepEqual(resolveSubagentRunId("review-prefix-", { state }), { kind: "foreground", id: current.runId });
	assert.equal(resolveSubagentRunId(outgoing.runId, { state }), undefined);
	assert.deepEqual(collectFleetSnapshot(state).items.map((item) => item.agent), ["current-worker"]);
	assert.deepEqual(collectFleetStatusEntries(state).map((entry) => entry.agent), ["current-worker"]);
	const fleet = inspectSubagentFleet({}, { state });
	const text = fleet.content.map((part) => part.text ?? "").join("\n");
	assert.match(text, /current-worker/);
	assert.doesNotMatch(text, /PRIVATE-OLD-WORKER|review-prefix-outgoing/);
	assert.equal(state.foregroundControls.get(outgoing.runId), outgoing, "filtering must preserve the outgoing child's ownership");
});
