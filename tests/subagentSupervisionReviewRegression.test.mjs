import "./helpers/piFixtureResolver.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const tempRoot = mkdtempSync(join(tmpdir(), "pideck-supervision-review-"));
const previousTempRoot = process.env.PI_SUBAGENTS_TEMP_ROOT;
process.env.PI_SUBAGENTS_TEMP_ROOT = tempRoot;
after(() => {
	if (previousTempRoot === undefined) delete process.env.PI_SUBAGENTS_TEMP_ROOT;
	else process.env.PI_SUBAGENTS_TEMP_ROOT = previousTempRoot;
	rmSync(tempRoot, { recursive: true, force: true });
});

const native = await import("../resources/extensions/pideck-q-subagents/src/intercom/native-supervisor-channel.ts");

/** Model a runner that publishes its terminal status before its ask files are removed. */
function channelFixture(t) {
	const runId = `review-${randomUUID()}`;
	const owner = { channelDir: native.resolveSupervisorChannelDir(runId, "worker", 0), runId,
		agent: "worker", childIndex: 0, orchestratorSessionId: `owner-${randomUUID()}` };
	const job = { status: "running", steps: [{ agent: "worker", status: "running" }] };
	const tools = new Map();
	const messages = [];
	const state = { currentSessionId: owner.orchestratorSessionId, supervisorOwnerSessionId: owner.orchestratorSessionId,
		foregroundControls: new Map(), foregroundRuns: new Map(), asyncJobs: new Map([[runId, job]]) };
	const idleHandle = { unref() {} };
	const channel = native.createNativeSupervisorChannel({ events: { emit() {} },
		registerTool(tool) { tools.set(tool.name, tool); }, getAllTools: () => [...tools.values()],
		sendMessage(message) { messages.push(message); },
	}, state, { platform: "win32",
		timers: { setInterval: () => idleHandle, clearInterval() {}, setImmediate: () => idleHandle, clearImmediate() {} },
	});
	channel.start();
	const controller = new AbortController();
	const completion = native.requestRunSupervision(owner, "The child is still running a build.", controller.signal);
	const closed = completion.catch(() => undefined);
	t.after(async () => { controller.abort(); await closed; channel.dispose(); });
	return { owner, job, channel, messages, supervisor: tools.get("subagent_supervisor") };
}

for (const scope of ["run", "step"]) {
	for (const status of ["stopped", "rejected", "partial"]) {
		test(`${scope} status ${status} revokes a pending runtime review and rejects its stale reply`, async (t) => {
			const f = channelFixture(t);
			const first = await f.supervisor.execute("pending", { action: "pending" });
			assert.equal(first.details.pending.length, 1);
			const requestId = first.details.pending[0].id;
			if (scope === "run") f.job.status = status;
			else f.job.steps[0].status = status;
			assert.deepEqual(f.channel.findPendingAsks(f.owner), [], "waits must not surface a decision for a terminated child");
			const reply = await f.supervisor.execute("late-reply", { action: "reply", replyTo: requestId, message: "CONTINUE" });
			assert.equal(reply.isError, true);
			assert.equal(reply.details.delivered, false);
			assert.deepEqual((await f.supervisor.execute("pending-again", { action: "pending" })).details.pending, []);
			assert.deepEqual(readdirSync(join(f.owner.channelDir, "requests")), []);
			assert.deepEqual(readdirSync(join(f.owner.channelDir, "replies")), []);
		});
	}
}

test("a stopped runner's undiscovered runtime review cannot trigger a new parent turn", async (t) => {
	const f = channelFixture(t);
	f.job.status = "stopped";
	f.channel.activateTransport();
	assert.equal(f.messages.length, 0);
	assert.deepEqual((await f.supervisor.execute("pending", { action: "pending" })).details.pending, []);
	assert.deepEqual(readdirSync(join(f.owner.channelDir, "requests")), []);
});
