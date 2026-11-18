import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import "./helpers/piFixtureResolver.mjs";

// Fake clocks from concurrently running suites must not expire each other's transport directories.
const tempRoot = mkdtempSync(join(tmpdir(), "pideck-review-channel-"));
const previousTempRoot = process.env.PI_SUBAGENTS_TEMP_ROOT;
process.env.PI_SUBAGENTS_TEMP_ROOT = tempRoot;
after(() => {
	if (previousTempRoot === undefined) delete process.env.PI_SUBAGENTS_TEMP_ROOT;
	else process.env.PI_SUBAGENTS_TEMP_ROOT = previousTempRoot;
	rmSync(tempRoot, { recursive: true, force: true });
});

const { createRunSupervision, createRunSupervisionState, RUN_SUPERVISION_INTERVAL_MS } = await import("../resources/extensions/pideck-q-subagents/src/runs/shared/run-supervision.ts");
const native = await import("../resources/extensions/pideck-q-subagents/src/intercom/native-supervisor-channel.ts");

/** A deterministic clock exposes timer behavior without waiting ten minutes. */
function clock() {
	let now = 0;
	const active = new Map();
	return {
		now: () => now,
		timers: {
			setTimeout(callback, delay) {
				const handle = { unref() {} };
				active.set(handle, { callback, at: now + delay });
				return handle;
			},
			clearTimeout(handle) { active.delete(handle); },
		},
		advance(ms) {
			now += ms;
			for (const [handle, pending] of [...active]) {
				if (pending.at > now) continue;
				active.delete(handle);
				pending.callback();
			}
		},
		get pending() { return active.size; },
	};
}

function metadata() {
	const runId = `run-review-${randomUUID()}`;
	return { channelDir: native.resolveSupervisorChannelDir(runId, "worker", 0), runId, agent: "worker", childIndex: 0, orchestratorSessionId: `owner-${randomUUID()}` };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("run review waits 600 seconds, uses the latest snapshot, and has only one outstanding decision", async () => {
	const time = clock();
	const calls = [];
	let snapshot = "Starting work.";
	let stopped = 0;
	const review = createRunSupervision({ metadata: metadata(), timers: time.timers, now: time.now, getSnapshot: () => snapshot,
		onStop() { stopped++; },
		requestDecision(owner, current, signal) { return new Promise((resolve) => calls.push({ owner, current, signal, resolve })); },
	});
	try {
		time.advance(RUN_SUPERVISION_INTERVAL_MS - 1);
		await flush();
		assert.equal(calls.length, 0);
		snapshot = "Still running the original build.";
		time.advance(1);
		await flush();
		assert.equal(calls.length, 1);
		assert.equal(calls[0].current, snapshot);
		time.advance(RUN_SUPERVISION_INTERVAL_MS * 3);
		await flush();
		assert.equal(calls.length, 1, "a slow parent must not receive duplicate pending requests");
		assert.equal(stopped, 0, "reporting leaves the original work running");
		calls[0].resolve("continue");
		await flush();
		time.advance(RUN_SUPERVISION_INTERVAL_MS - 1);
		await flush();
		assert.equal(calls.length, 1);
		time.advance(1);
		await flush();
		assert.equal(calls.length, 2, "continue schedules a fresh full interval");
		calls[1].resolve("stop");
		await flush();
		assert.equal(stopped, 1);
		assert.equal(time.pending, 0, "a stop decision must not schedule another review");
	} finally { review.dispose(); }
});

test("disposing a pending review aborts transport and ignores a late stop reply", async () => {
	const time = clock();
	let resolveReply;
	let requestSignal;
	let stopped = 0;
	const review = createRunSupervision({ metadata: metadata(), timers: time.timers, now: time.now, getSnapshot: () => "Working.", onStop() { stopped++; },
		requestDecision(_owner, _snapshot, signal) { requestSignal = signal; return new Promise((resolve) => { resolveReply = resolve; }); },
	});
	time.advance(RUN_SUPERVISION_INTERVAL_MS);
	await flush();
	review.dispose();
	review.dispose();
	assert.equal(requestSignal.aborted, true);
	resolveReply("stop");
	await flush();
	assert.equal(stopped, 0);
	assert.equal(time.pending, 0);
});

test("expiry or a failed snapshot preserves the run and retries only after the next interval", async () => {
	const time = clock();
	const errors = [];
	let failSnapshot = true;
	let calls = 0;
	let stopped = 0;
	const review = createRunSupervision({ metadata: metadata(), timers: time.timers, now: time.now,
		getSnapshot() { if (failSnapshot) throw new Error("Snapshot unavailable"); return "Working."; },
		onStop() { stopped++; },
		onError(error) { errors.push(error.message); throw new Error("Reporter unavailable"); },
		async requestDecision() { calls++; throw new Error("Timed out waiting for supervisor reply."); },
	});
	try {
		time.advance(RUN_SUPERVISION_INTERVAL_MS);
		await flush();
		assert.equal(calls, 0);
		assert.deepEqual(errors, ["Snapshot unavailable"]);
		failSnapshot = false;
		time.advance(RUN_SUPERVISION_INTERVAL_MS);
		await flush();
		assert.equal(calls, 1);
		assert.match(errors[1], /Timed out/);
		assert.equal(stopped, 0);
		assert.equal(time.pending, 1);
	} finally { review.dispose(); }
	assert.equal(time.pending, 0);
});

test("unowned child sessions never create orphan run reviews", async () => {
	for (const owner of [undefined, { ...metadata(), orchestratorSessionId: " " }]) {
		const time = clock();
		const review = createRunSupervision({ metadata: owner, timers: time.timers, now: time.now,
			getSnapshot() { assert.fail("unowned child snapshot should not be requested"); }, onStop() { assert.fail("unowned child should not be stopped"); },
		});
		time.advance(RUN_SUPERVISION_INTERVAL_MS * 10);
		await flush();
		assert.equal(time.pending, 0);
		review.dispose();
	}
});

test("a model attempt change preserves the logical child's next review deadline", async () => {
	const time = clock();
	const state = createRunSupervisionState(0);
	const requests = [];
	const input = { metadata: metadata(), state, timers: time.timers, now: time.now,
		getSnapshot: () => "Logical child is still working.", onStop() {},
		requestDecision(_metadata, _snapshot, signal) { return new Promise((resolve) => requests.push({ signal, resolve })); },
	};
	const first = createRunSupervision(input);
	time.advance(RUN_SUPERVISION_INTERVAL_MS - 1);
	await flush();
	assert.equal(requests.length, 0);
	first.dispose();
	const replacement = createRunSupervision(input);
	try {
		time.advance(1);
		await flush();
		assert.equal(requests.length, 1, "retrying a model must not renew the logical child's 600-second allowance");
		assert.equal(state.startedAt, 0);
	} finally { replacement.dispose(); }
});

test("a new attempt immediately replaces an overdue cancelled review without accepting its late reply", async () => {
	const time = clock();
	const state = createRunSupervisionState(0);
	const requests = [];
	let stopped = 0;
	const input = { metadata: metadata(), state, timers: time.timers, now: time.now,
		getSnapshot: () => "Still working.", onStop() { stopped++; },
		requestDecision(_metadata, _snapshot, signal) { return new Promise((resolve) => requests.push({ signal, resolve })); },
	};
	const first = createRunSupervision(input);
	time.advance(RUN_SUPERVISION_INTERVAL_MS);
	await flush();
	assert.equal(requests.length, 1);
	first.dispose();
	assert.equal(requests[0].signal.aborted, true);
	const replacement = createRunSupervision(input);
	try {
		time.advance(0);
		await flush();
		assert.equal(requests.length, 2, "an overdue review belongs to the replacement attempt immediately");
		time.advance(100);
		requests[1].resolve("continue");
		await flush();
		const expectedDeadline = RUN_SUPERVISION_INTERVAL_MS * 2 + 100;
		assert.equal(state.nextReviewAt, expectedDeadline);
		time.advance(50);
		requests[0].resolve("stop");
		await flush();
		assert.equal(stopped, 0);
		assert.equal(state.nextReviewAt, expectedDeadline, "the disposed attempt must not change the new attempt's schedule");
	} finally { replacement.dispose(); }
});

/** Real request/reply files and public parent tools, with transport discovery driven explicitly. */
function channelFixture(t) {
	const owner = metadata();
	const tools = new Map();
	const messages = [];
	const child = { index: 0, agent: "worker", status: "detached", currentTool: "bash", currentToolStartedAt: 1, lastActivityAt: 2 };
	const state = { currentSessionId: owner.orchestratorSessionId, supervisorOwnerSessionId: owner.orchestratorSessionId,
		foregroundControls: new Map([[owner.runId, {}]]), foregroundRuns: new Map([[owner.runId, { children: [child] }]]), asyncJobs: new Map(),
	};
	const pi = { events: { emit() {} }, registerTool(tool) { tools.set(tool.name, tool); }, getAllTools: () => [...tools.values()], sendMessage(message) { messages.push(message); } };
	const idleHandle = { unref() {} };
	const channel = native.createNativeSupervisorChannel(pi, state, { platform: "win32",
		timers: { setInterval: () => idleHandle, clearInterval() {}, setImmediate: () => idleHandle, clearImmediate() {} },
	});
	channel.start();
	t.after(() => { channel.dispose(); rmSync(owner.channelDir, { recursive: true, force: true }); });
	return { owner, channel, child, state, messages, supervisor: tools.get("subagent_supervisor") };
}

for (const decision of ["continue", "stop"]) {
	test(`runtime review accepts ${decision}, preserves the real active tool, and cleans its files`, async (t) => {
		const fixture = channelFixture(t);
		let handle;
		const completion = native.requestRunSupervision(fixture.owner, "Tool: bash\nElapsed: 600 seconds", undefined, (request) => { handle = request; });
		fixture.channel.activateTransport();
		const pending = await fixture.supervisor.execute("pending", { action: "pending" });
		assert.equal(pending.details.pending.length, 1);
		const request = pending.details.pending[0];
		assert.equal(request.replyFormat, "run_decision");
		assert.match(request.message, /original child continues running/);
		assert.match(request.message, /exactly CONTINUE/);
		assert.equal(fixture.child.currentTool, "bash");
		assert.equal(fixture.child.currentToolStartedAt, 1);
		assert.equal(fixture.child.lastActivityAt, 2);
		await assert.rejects(fixture.supervisor.execute("invalid", { action: "reply", replyTo: request.id, message: "Please continue for a while" }), /exactly CONTINUE or STOP/);
		assert.equal((await fixture.supervisor.execute("pending-again", { action: "pending" })).details.pending.length, 1);
		await fixture.supervisor.execute("valid", { action: "reply", replyTo: request.id, message: ` ${decision.toUpperCase()} ` });
		assert.equal(handle.readDecision(), decision, "shutdown can consume the acknowledged reply before polling");
		assert.equal(await completion, decision);
		assert.equal(fixture.child.currentTool, "bash");
		assert.equal(fixture.child.currentToolStartedAt, 1);
		assert.equal(fixture.child.lastActivityAt, 2);
		assert.deepEqual(readdirSync(join(fixture.owner.channelDir, "requests")), []);
		assert.deepEqual(readdirSync(join(fixture.owner.channelDir, "replies")), []);
		assert.equal(handle.readDecision(), decision, "the consumed reply survives file cleanup until its owner settles");
	});
}

test("ordinary contact_supervisor replies remain free form", async (t) => {
	const fixture = channelFixture(t);
	let contact;
	native.registerNativeSupervisorClient({ getAllTools: () => [], registerTool(tool) { contact = tool; } }, fixture.owner);
	const completion = contact.execute("ordinary-call", { reason: "need_decision", message: "Which file should I update?" });
	fixture.channel.activateTransport();
	const pending = await fixture.supervisor.execute("pending", { action: "pending" });
	assert.equal(pending.details.pending[0].replyFormat, undefined);
	await fixture.supervisor.execute("reply", { action: "reply", replyTo: pending.details.pending[0].id, message: "Update the selected configuration file." });
	assert.match((await completion).content[0].text, /selected configuration file/);
});

test("cancelled runtime reviews reject stale replies and clean both mailboxes", async (t) => {
	const fixture = channelFixture(t);
	const controller = new AbortController();
	const completion = native.requestRunSupervision(fixture.owner, "Still working.", controller.signal);
	fixture.channel.activateTransport();
	const pending = await fixture.supervisor.execute("pending", { action: "pending" });
	controller.abort();
	assert.deepEqual(readdirSync(join(fixture.owner.channelDir, "requests")), [], "abort must revoke the public ask before any asynchronous cleanup");
	await assert.rejects(completion, /cancelled/);
	const late = await fixture.supervisor.execute("late", { action: "reply", replyTo: pending.details.pending[0].id, message: "STOP" });
	assert.equal(late.isError, true);
	assert.equal(late.details.delivered, false);
	assert.deepEqual(readdirSync(join(fixture.owner.channelDir, "requests")), []);
	assert.deepEqual(readdirSync(join(fixture.owner.channelDir, "replies")), []);
	assert.equal(fixture.child.activityState, undefined, "cancelled review must release its attention state");
	assert.equal(fixture.child.currentTool, "bash");
	assert.equal(fixture.child.currentToolStartedAt, 1);
	assert.equal(fixture.child.lastActivityAt, 2);
});

test("another parent session cannot reply to an owned run review", async (t) => {
	const fixture = channelFixture(t);
	const controller = new AbortController();
	const completion = native.requestRunSupervision(fixture.owner, "Still working.", controller.signal);
	fixture.channel.activateTransport();
	const pending = await fixture.supervisor.execute("pending", { action: "pending" });
	fixture.state.supervisorOwnerSessionId = "another-owner";
	const foreign = await fixture.supervisor.execute("foreign-reply", { action: "reply", replyTo: pending.details.pending[0].id, message: "STOP" });
	assert.equal(foreign.isError, true);
	assert.equal(foreign.details.delivered, false);
	assert.deepEqual(readdirSync(join(fixture.owner.channelDir, "replies")), []);
	controller.abort();
	await assert.rejects(completion, /cancelled/);
});

test("already cancelled and unowned runtime reviews do not write requests", async () => {
	const owner = metadata();
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(native.requestRunSupervision(owner, "Working.", controller.signal), /cancelled/);
	await assert.rejects(native.requestRunSupervision({ ...owner, orchestratorSessionId: "" }, "Working."), /owning parent/);
	assert.equal(existsSync(owner.channelDir), false);
});

test("expired runtime review asks clean up without a stop decision", async (t) => {
	const previous = process.env.PI_INTERCOM_ASK_TIMEOUT_MS;
	process.env.PI_INTERCOM_ASK_TIMEOUT_MS = "20";
	t.after(() => { if (previous === undefined) delete process.env.PI_INTERCOM_ASK_TIMEOUT_MS; else process.env.PI_INTERCOM_ASK_TIMEOUT_MS = previous; });
	const fixture = channelFixture(t);
	const completion = native.requestRunSupervision(fixture.owner, "Still working.");
	fixture.channel.activateTransport();
	await assert.rejects(completion, /Timed out waiting/);
	assert.equal((await fixture.supervisor.execute("pending", { action: "pending" })).details.pending.length, 0);
	assert.deepEqual(readdirSync(join(fixture.owner.channelDir, "requests")), []);
	assert.deepEqual(readdirSync(join(fixture.owner.channelDir, "replies")), []);
	assert.equal(fixture.child.activityState, undefined, "expired review must release its attention state");
	assert.equal(fixture.child.currentTool, "bash");
	assert.equal(fixture.child.currentToolStartedAt, 1);
	assert.equal(fixture.child.lastActivityAt, 2);
});

test("a timely acknowledged STOP remains valid when the next reply poll runs after expiry", async (t) => {
	const previous = process.env.PI_INTERCOM_ASK_TIMEOUT_MS;
	process.env.PI_INTERCOM_ASK_TIMEOUT_MS = "20";
	t.after(() => { if (previous === undefined) delete process.env.PI_INTERCOM_ASK_TIMEOUT_MS; else process.env.PI_INTERCOM_ASK_TIMEOUT_MS = previous; });
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
	const fixture = channelFixture(t);
	const completion = native.requestRunSupervision(fixture.owner, "Still working.");
	const pending = await fixture.supervisor.execute("pending", { action: "pending" });
	const reply = await fixture.supervisor.execute("reply", { action: "reply", replyTo: pending.details.pending[0].id, message: "STOP" });
	assert.equal(reply.isError, undefined);
	t.mock.timers.tick(250);
	assert.equal(await completion, "stop");
	assert.deepEqual(readdirSync(join(fixture.owner.channelDir, "requests")), []);
	assert.deepEqual(readdirSync(join(fixture.owner.channelDir, "replies")), []);
});

test("attention remains until the last pending request for the same child is cancelled", async (t) => {
	const fixture = channelFixture(t);
	const controllers = [new AbortController(), new AbortController()];
	const completions = controllers.map((controller) => native.requestRunSupervision(fixture.owner, "Still working.", controller.signal));
	t.after(() => { for (const controller of controllers) controller.abort(); });
	fixture.channel.activateTransport();
	assert.equal(fixture.channel.pending.size, 2);
	controllers[0].abort();
	await assert.rejects(completions[0], /cancelled/);
	fixture.channel.activateTransport();
	assert.equal(fixture.channel.pending.size, 1);
	assert.equal(fixture.child.activityState, "needs_attention");
	controllers[1].abort();
	await assert.rejects(completions[1], /cancelled/);
	fixture.channel.activateTransport();
	assert.equal(fixture.channel.pending.size, 0);
	assert.equal(fixture.child.activityState, undefined);
	assert.equal(fixture.child.currentTool, "bash");
	assert.equal(fixture.child.currentToolStartedAt, 1);
	assert.equal(fixture.child.lastActivityAt, 2);
});

test("discarding an old owner request cannot clear attention on another session's child", async (t) => {
	const fixture = channelFixture(t);
	const controller = new AbortController();
	const completion = native.requestRunSupervision(fixture.owner, "Still working.", controller.signal);
	fixture.channel.activateTransport();
	const otherChild = { ...fixture.child };
	fixture.state.foregroundRuns.set(fixture.owner.runId, { sessionId: "another-owner", children: [otherChild] });
	fixture.state.supervisorOwnerSessionId = "another-owner";
	fixture.state.currentSessionId = "another-owner";
	fixture.channel.activateTransport();
	assert.equal(fixture.channel.pending.size, 0);
	assert.equal(otherChild.activityState, "needs_attention");
	assert.equal(otherChild.currentTool, "bash");
	controller.abort();
	await assert.rejects(completion, /cancelled/);
});

test("returning to the owning session rediscovers its still-live runtime review", async (t) => {
	const fixture = channelFixture(t);
	const controller = new AbortController();
	const completion = native.requestRunSupervision(fixture.owner, "Still working.", controller.signal);
	const settled = completion.catch(() => undefined);
	t.after(async () => { controller.abort(); await settled; });
	fixture.channel.activateTransport();
	const requestId = [...fixture.channel.pending.keys()][0];
	assert.ok(requestId);
	fixture.state.supervisorOwnerSessionId = "another-owner";
	fixture.state.currentSessionId = "another-owner";
	assert.equal((await fixture.supervisor.execute("foreign", { action: "pending" })).details.pending.length, 0);
	fixture.state.supervisorOwnerSessionId = fixture.owner.orchestratorSessionId;
	fixture.state.currentSessionId = fixture.owner.orchestratorSessionId;
	const returned = await fixture.supervisor.execute("returned", { action: "pending" });
	assert.deepEqual(returned.details.pending.map((request) => request.id), [requestId]);
	await fixture.supervisor.execute("reply", { action: "reply", replyTo: requestId, message: "CONTINUE" });
	assert.equal(await completion, "continue");
});
