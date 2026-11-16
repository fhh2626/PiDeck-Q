import assert from "node:assert/strict";
import test from "node:test";
import { withComposerController } from "./helpers/l5_composerControllerHost.mjs";

/** Busy sessions must queue ordinary submissions until the current task settles. */
function busySession(store, atoms) {
	store.set(atoms.sessionRecordsAtom, { s1: { id: "s1", projectId: "project", cwd: "/project", title: "Session", createdAt: 1, updatedAt: 1 } });
	store.set(atoms.sessionRuntimeByIdAtom, { s1: { agentId: "agent", runtimeGeneration: 1, status: "running", updatedAt: 1,
		state: { isStreaming: true } } });
}

for (const action of ["button", "enter"]) {
	test(`ordinary ${action} submissions queue as followUp while busy`, async () => {
		await withComposerController(async (c) => {
			const queued = [];
			await c.rerender({ enqueue: (sessionId, snapshot) => { queued.push({ sessionId, ...snapshot }); return true; } });
			await c.changeTo("Complete the next task");
			if (action === "enter") await c.press("Enter");
			else await c.host.act(async () => c.controller().delivery.send());
			assert.equal(queued.length, 1);
			assert.equal(queued[0].behavior, "followUp");
			assert.equal(c.calls.sendPrompt.length, 0, "a queued task must stay retractable until the active run finishes");
		}, { seed: busySession });
	});
}

test("explicit interrupt remains available as steer", async () => {
	await withComposerController(async (c) => {
		const queued = [];
		await c.rerender({ enqueue: (_sessionId, snapshot) => { queued.push(snapshot); return true; } });
		await c.changeTo("Use the other approach now");
		await c.host.act(async () => c.controller().delivery.steer());
		assert.equal(queued.length, 1);
		assert.equal(queued[0].behavior, "steer");
	}, { seed: busySession });
});

test("a full local queue keeps the later task in the editor instead of bypassing earlier work", async () => {
	await withComposerController(async (c) => {
		await c.rerender({ enqueue: () => false });
		await c.changeTo("The eleventh task");
		await c.host.act(async () => c.controller().delivery.send());
		assert.equal(c.calls.sendPrompt.length, 0);
		assert.equal(c.storedDraft(), "The eleventh task");
		assert.ok(c.calls.notices.includes("app.queuedFull"));
	}, { seed: busySession });
});
