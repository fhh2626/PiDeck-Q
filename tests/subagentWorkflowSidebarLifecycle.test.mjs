import assert from "node:assert/strict";
import test from "node:test";

import {
	completedResult,
	createFixture,
	loadSubagentResumeGraph,
	resetDoubles,
	runSyncCalls,
	seedCompletedForegroundRun,
	setRunSyncBehavior,
} from "./helpers/subagentResumeHarness.mjs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const graph = await loadSubagentResumeGraph();
const { SubagentRunTracker, extractSubagentRunUpdates } = loadTsCommonJs("src/main/pi/SubagentRunTracker.ts");
const { parseSubagentStatusSnapshot } = loadTsCommonJs("src/main/pi/subagentStatusSnapshot.ts");

// 侧栏状态灯的端到端契约：真实 executor 发出 tool_execution_update，真实 tracker 消费。
// 这里不启动模型/子进程，runSync 边界由可控替身替代，其余（workflow VM、launch observer、
// summary builder、状态合并）都是生产实现。
//
// 覆盖用户可见的三种用法：同时派出多个、先后执行、恢复旧子会话继续工作；
// 以及失败/停止这类没有 result 行的收尾。

const TOOL_CALL_ID = "call-workflow";

function framesFrom(tracker, agentId = "agent-1") {
	return (result) => {
		tracker.observe(agentId, {
			type: "tool_execution_update",
			toolName: "subagent",
			toolCallId: TOOL_CALL_ID,
			partialResult: result,
		}, Date.now());
	};
}

/** 工具结束时的终态帧：必须和流式帧一样不会把已收的灯重新点亮。 */
function endFrame(tracker, result, agentId = "agent-1") {
	tracker.observe(agentId, {
		type: "tool_execution_end",
		toolName: "subagent",
		toolCallId: TOOL_CALL_ID,
		result,
	}, Date.now());
}

function lights(tracker, agentId = "agent-1") {
	// snapshot 返回的是 TS 模块 realm 的数组；用 Array.from 回到测试 realm，
	// 否则 deepStrictEqual 会因原型不同而报「结构相同但引用不等」。
	return Array.from(
		tracker.snapshot(agentId, Date.now()),
		(run) => `${run.sessionFile.split(/[\\/]/).slice(-2).join("/")}|${run.status}`,
	).sort();
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, message, timeoutMs = 3000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await pause(5);
	}
	assert.fail(message);
}

/** 恢复执行的任务文本是拼好的 revival prompt，按包含关系找到对应挂起项。 */
function pendingFor(pending, needle) {
	for (const [task, entry] of pending) if (task.includes(needle)) return entry;
	return undefined;
}

/** 每个子代理的 runSync 替身：记录启动参数并挂起，直到测试显式放行。 */
function gatedRunSync() {
	const pending = new Map();
	setRunSyncBehavior(({ task, options }) => new Promise((resolve) => {
		pending.set(task, {
			resolve,
			sessionFile: options.sessionFile,
		});
	}));
	return pending;
}

function launch(executor, fixture, onUpdate, script, signal) {
	return executor.executePublic("workflow-run", {
		workflowScript: script,
		async: false,
		output: false,
		timeoutMs: 5000,
	}, signal, onUpdate, fixture.ctx);
}

test("three parallel children keep independent lights while they run out of order", async () => {
	const fixture = createFixture(graph, "parallel-lights");
	resetDoubles();
	const pending = gatedRunSync();
	const tracker = new SubagentRunTracker();
	const executor = graph.createSubagentExecutor(fixture.deps);
	const controller = new AbortController();
	const run = launch(executor, fixture, framesFrom(tracker), `
		return runs.all([
			{ key: "alpha", agent: "worker", task: "alpha task", async: false, acceptance: false },
			{ key: "beta", agent: "worker", task: "beta task", async: false, acceptance: false },
			{ key: "gamma", agent: "worker", task: "gamma task", async: false, acceptance: false },
		]);
	`, controller.signal);

	try {
		await waitFor(() => pending.size === 3, "all three children must reach the runSync boundary");
		// 同时派出的三个子代理各自亮灯，而不是只有第一条。
		assert.deepEqual(lights(tracker), [
			"run-0/session.jsonl|running",
			"run-0/session.jsonl|running",
			"run-0/session.jsonl|running",
		]);
		assert.equal(new Set(Array.from(tracker.snapshot("agent-1"), (entry) => entry.sessionFile)).size, 3);

		// 中间那个先结束：只有它灭灯，其余继续。
		pending.get("beta task").resolve(completedResult(fixture, {
			sessionFile: pending.get("beta task").sessionFile,
			finalOutput: "beta done",
		}));
		await waitFor(() => tracker.snapshot("agent-1").length === 2, "the finished child must clear its light");
		const remaining = Array.from(tracker.snapshot("agent-1"), (entry) => entry.sessionFile).sort();
		assert.deepEqual(remaining, [
			pending.get("alpha task").sessionFile,
			pending.get("gamma task").sessionFile,
		].sort());

		// 一个失败不影响还在工作的另一个。
		pending.get("gamma task").resolve(completedResult(fixture, {
			sessionFile: pending.get("gamma task").sessionFile,
			exitCode: 1,
			error: "gamma exploded",
			finalOutput: "gamma failed",
		}));
		await waitFor(() => tracker.snapshot("agent-1").some((entry) => entry.status === "error"), "a failed child must turn red");
		assert.deepEqual(
			Array.from(tracker.snapshot("agent-1"), (entry) => `${entry.sessionFile}|${entry.status}`).sort(),
			[
				`${pending.get("alpha task").sessionFile}|running`,
				`${pending.get("gamma task").sessionFile}|error`,
			].sort(),
		);

		pending.get("alpha task").resolve(completedResult(fixture, {
			sessionFile: pending.get("alpha task").sessionFile,
			finalOutput: "alpha done",
		}));
		const final = await run;
		// 终态帧不能把已收的灯重新点亮。
		endFrame(tracker, final);
		// 全部结束后只剩失败记录，没有残留黄灯。
		assert.deepEqual(
			Array.from(tracker.snapshot("agent-1"), (entry) => entry.status),
			["error"],
		);
	} finally {
		controller.abort();
		await run.catch(() => undefined);
	}
});

test("sequential stages hand the light from one session to the next", async () => {
	const fixture = createFixture(graph, "sequential-lights");
	resetDoubles();
	const pending = gatedRunSync();
	const tracker = new SubagentRunTracker();
	const executor = graph.createSubagentExecutor(fixture.deps);
	const controller = new AbortController();
	const run = launch(executor, fixture, framesFrom(tracker), `
		const first = await runs.run("first", { agent: "worker", task: "first stage", async: false, acceptance: false });
		return runs.run("second", { agent: "worker", task: "second stage", async: false, acceptance: false });
	`, controller.signal);

	try {
		await waitFor(() => pending.has("first stage"), "the first stage must start");
		assert.equal(tracker.snapshot("agent-1").length, 1);
		const firstFile = pending.get("first stage").sessionFile;
		assert.deepEqual(lights(tracker), ["run-0/session.jsonl|running"]);

		// 第一阶段结束、第二阶段启动之间，不能出现「两个都亮」或「两个都不亮」。
		pending.get("first stage").resolve(completedResult(fixture, {
			sessionFile: firstFile,
			finalOutput: "first done",
		}));
		await waitFor(() => pending.has("second stage"), "the second stage must start after the first settles");
		const secondFile = pending.get("second stage").sessionFile;
		assert.notEqual(secondFile, firstFile);
		await waitFor(
			() => tracker.snapshot("agent-1").length === 1 && tracker.snapshot("agent-1")[0].sessionFile === secondFile,
			"the finished stage must clear and the next stage must light",
		);

		pending.get("second stage").resolve(completedResult(fixture, {
			sessionFile: secondFile,
			finalOutput: "second done",
		}));
		const final = await run;
		endFrame(tracker, final);
		assert.equal(tracker.snapshot("agent-1").length, 0);
	} finally {
		controller.abort();
		await run.catch(() => undefined);
	}
});

test("a resumed child lights its original session file while it works", async () => {
	const fixture = createFixture(graph, "resume-lights");
	resetDoubles();
	const sourceRunId = "0b2c80e6-4ca2-4025-9850-10cdfd000042";
	seedCompletedForegroundRun(fixture, { runId: sourceRunId });
	const pending = gatedRunSync();
	const tracker = new SubagentRunTracker();
	const executor = graph.createSubagentExecutor(fixture.deps);
	const controller = new AbortController();
	const run = launch(executor, fixture, framesFrom(tracker), `
		return runs.run("follow-up", { resume: "${sourceRunId}", task: "continue the review", async: false, acceptance: false });
	`, controller.signal);

	try {
		await waitFor(() => pendingFor(pending, "continue the review") !== undefined, "the resumed child must reach runSync");
		// 恢复执行沿用原子会话文件；侧栏点亮的必须是这一行。
		assert.deepEqual(
			Array.from(tracker.snapshot("agent-1"), (entry) => `${entry.sessionFile}|${entry.status}`),
			[`${fixture.childSessionFile}|running`],
		);

		pendingFor(pending, "continue the review").resolve(completedResult(fixture, { finalOutput: "resumed done" }));
		const final = await run;
		endFrame(tracker, final);
		assert.equal(tracker.snapshot("agent-1").length, 0);
	} finally {
		controller.abort();
		await run.catch(() => undefined);
	}
});

test("a throwing progress callback never changes the workflow outcome", async () => {
	const fixture = createFixture(graph, "throwing-update");
	resetDoubles();
	setRunSyncBehavior(() => completedResult(fixture, { finalOutput: "child done" }));
	const executor = graph.createSubagentExecutor(fixture.deps);
	const controller = new AbortController();
	// 宿主状态上报失败不能把子代理/工作流判失败，也不能变成未捕获异常。
	const result = await launch(executor, fixture, () => { throw new Error("host update failed"); }, `
		return runs.run("child", { agent: "worker", task: "do work", async: false, acceptance: false });
	`, controller.signal);
	assert.notEqual(result.isError, true);
	assert.match(result.content.map((part) => part.text ?? "").join("\n"), /child done/);
	controller.abort();
});

test("continuing the same child session keeps the light on across both stages", async () => {
	const fixture = createFixture(graph, "same-session-stages");
	resetDoubles();
	const sourceRunId = "0b2c80e6-4ca2-4025-9850-10cdfd000043";
	seedCompletedForegroundRun(fixture, { runId: sourceRunId });
	const pending = gatedRunSync();
	const tracker = new SubagentRunTracker();
	const executor = graph.createSubagentExecutor(fixture.deps);
	const controller = new AbortController();
	// 两步都恢复同一条子会话：会话文件相同，第一步已完成不能把第二步的运行态盖掉。
	const run = launch(executor, fixture, framesFrom(tracker), `
		const first = await runs.all([{ key: "first", resume: "${sourceRunId}", task: "first stage", async: false, acceptance: false }]);
		return runs.run("second", { resume: first[0].runId, task: "second stage", async: false, acceptance: false });
	`, controller.signal);

	try {
		await waitFor(() => pendingFor(pending, "first stage") !== undefined, "the first stage must start");
		pendingFor(pending, "first stage").resolve(completedResult(fixture, { finalOutput: "first done" }));
		await waitFor(() => pendingFor(pending, "second stage") !== undefined, "the second stage must start on the same session");
		// 第二步在跑：必须黄灯，而不是因为第一步已完成就不亮。
		assert.deepEqual(
			Array.from(tracker.snapshot("agent-1"), (entry) => `${entry.sessionFile}|${entry.status}`),
			[`${fixture.childSessionFile}|running`],
		);

		pendingFor(pending, "second stage").resolve(completedResult(fixture, { finalOutput: "second done" }));
		const final = await run;
		endFrame(tracker, final);
		assert.equal(tracker.snapshot("agent-1").length, 0);
	} finally {
		controller.abort();
		await run.catch(() => undefined);
	}
});

test("a resume rejected by launch validation never lights the old session", async () => {
	const fixture = createFixture(graph, "resume-validation");
	resetDoubles();
	const sourceRunId = "0b2c80e6-4ca2-4025-9850-10cdfd000044";
	seedCompletedForegroundRun(fixture, { runId: sourceRunId });
	setRunSyncBehavior(() => completedResult(fixture));
	const tracker = new SubagentRunTracker();
	const executor = graph.createSubagentExecutor(fixture.deps);
	const controller = new AbortController();
	// toolBudget 非法：子代理根本不会启动，旧会话不能被上报成运行中/失败。
	const result = await launch(executor, fixture, framesFrom(tracker), `
		return runs.run("retry", { resume: "${sourceRunId}", task: "continue", toolBudget: -1, async: false, acceptance: false });
	`, controller.signal);

	assert.equal(result.isError, true);
	assert.equal(runSyncCalls.length, 0, "validation must fail before the child starts");
	assert.equal(tracker.snapshot("agent-1").length, 0, "an unstarted child must not light the old session");
	controller.abort();
});

test("a handoff light is closed by turn end and by the retained final status", async () => {
	const fixture = createFixture(graph, "handoff-lights");
	resetDoubles();
	// 交接后不会再有任何实时帧（工具调用已返回），所以侧栏只能靠回合结束
	// 或后续 status 结果收灯；这里把这两条收尾路径固定成契约。
	const listeners = new Map();
	const bus = {
		on(name, callback) { const set = listeners.get(name) ?? new Set(); set.add(callback); listeners.set(name, set); return () => set.delete(callback); },
		emit(name, value) { for (const callback of listeners.get(name) ?? []) callback(value); },
	};
	fixture.deps.pi.events = bus;
	let notify;
	const completed = new Promise((resolve) => { notify = resolve; });
	fixture.deps.pi.sendMessage = (message) => notify(message);
	let childOptions;
	let request;
	setRunSyncBehavior(({ task, options }) => {
		if (task.includes("second stage")) return completedResult(fixture, { sessionFile: options.sessionFile, finalOutput: "second done" });
		childOptions = options;
		request = { requestId: "ask-1", runId: options.runId, agent: "worker", childIndex: 0, source: "native" };
		bus.emit("pi-intercom:detach-request", request);
		return completedResult(fixture, { sessionFile: options.sessionFile, detached: true, detachedReason: "intercom coordination", exitCode: undefined, finalOutput: undefined });
	});
	const tracker = new SubagentRunTracker();
	const executor = graph.createSubagentExecutor(fixture.deps);
	const controller = new AbortController();
	let frames = 0;
	const observe = (result) => { frames += 1; framesFrom(tracker)(result); };
	const run = launch(executor, fixture, observe, `
		const first = await runs.run("first", { agent: "worker", task: "first stage", async: false, acceptance: false });
		return runs.run("second", { agent: "worker", task: "second stage", async: false, acceptance: false });
	`, controller.signal);

	try {
		const handoff = await run;
		endFrame(tracker, handoff);
		// 等待回答期间子代理确实还活着，黄灯是准确的。
		assert.equal(tracker.snapshot("agent-1").length, 1);
		const framesAtHandoff = frames;

		// 回合结束（AgentManager 在 agent_end 调 clearRunning）：收灯。
		tracker.clearRunning("agent-1");
		assert.equal(tracker.snapshot("agent-1").length, 0);

		bus.emit("pi-subagents:supervisor-request-settled", { ...request, lifecycle: "resolved" });
		await childOptions.onDetachedExit(completedResult(fixture, { sessionFile: childOptions.sessionFile, finalOutput: "first done" }));
		const notification = await completed;
		assert.equal(notification.customType, "subagent-workflow-complete");
		// 交接后的实时帧确实停了（现有设计：工具已返回，不能再发更新）。
		assert.equal(frames, framesAtHandoff, "no live frames after the handoff");

		const status = await executor.executePublic("status", { action: "status", id: handoff.details.runId }, controller.signal, undefined, fixture.ctx);
		assert.deepEqual(
			Array.from(status.details.workflowChildren?.children ?? [], (child) => child.state),
			["completed", "completed"],
		);
		// 父会话按通知去查 status 时，终态会顺手把残留的运行态收掉。
		const statusUpdates = extractSubagentRunUpdates(status.details);
		assert.equal(statusUpdates.length, 2, "the retained status must expose every child");
		assert.ok(statusUpdates.every((update) => update.status === "completed"));
		endFrame(tracker, status);
		assert.equal(tracker.snapshot("agent-1").length, 0);
	} finally {
		controller.abort();
		await run.catch(() => undefined);
	}
});

test("a handoff keeps publishing status until the workflow really ends", async () => {
	const fixture = createFixture(graph, "handoff-status-slot");
	resetDoubles();
	// 交接后工具调用已经返回，但状态槽必须继续上报；这里同时跑真实 publisher、
	// 真实 tracker 与真实 workflow，只把 runSync（模型执行边界）换成替身。
	const listeners = new Map();
	const bus = {
		on(name, callback) { const set = listeners.get(name) ?? new Set(); set.add(callback); listeners.set(name, set); return () => set.delete(callback); },
		emit(name, value) { for (const callback of listeners.get(name) ?? []) callback(value); },
	};
	fixture.deps.pi.events = bus;
	fixture.ctx.hasUI = true;
	const slot = [];
	fixture.ctx.ui = { setStatus: (key, text) => slot.push({ key, text }) };
	process.env.PIDECK_DESKTOP = "1";

	let notify;
	const completed = new Promise((resolve) => { notify = resolve; });
	fixture.deps.pi.sendMessage = (message) => notify(message);
	let childOptions;
	let request;
	setRunSyncBehavior(({ task, options }) => {
		if (task.includes("second stage")) return completedResult(fixture, { sessionFile: options.sessionFile, finalOutput: "second done" });
		childOptions = options;
		request = { requestId: "ask-1", runId: options.runId, agent: "worker", childIndex: 0, source: "native" };
		bus.emit("pi-intercom:detach-request", request);
		return completedResult(fixture, { sessionFile: options.sessionFile, detached: true, detachedReason: "intercom coordination", exitCode: undefined, finalOutput: undefined });
	});
	const tracker = new SubagentRunTracker();
	const executor = graph.createSubagentExecutor(fixture.deps);
	const controller = new AbortController();
	const run = launch(executor, fixture, framesFrom(tracker), `
		const first = await runs.run("first", { agent: "worker", task: "first stage", async: false, acceptance: false });
		return runs.run("second", { agent: "worker", task: "second stage", async: false, acceptance: false });
	`, controller.signal);

	const frames = () => slot.map((entry) => parseSubagentStatusSnapshot(entry.text)).filter(Boolean);

	try {
		const handoff = await run;
		const atHandoff = frames();
		assert.ok(atHandoff.length > 0, "the workflow must publish a status frame");
		assert.ok(atHandoff.every((frame) => frame.workflowRunId === handoff.details.runId));
		assert.ok(atHandoff.flatMap((frame) => frame.children).every((child) => child.executionId === childOptions.runId), "every path-bearing launch frame identifies its actual child execution");
		const latest = atHandoff.at(-1);
		assert.equal(latest.complete, false);
		assert.equal(latest.children.length, 1);
		assert.equal(latest.children[0].state, "running");

		tracker.observeStatusSnapshot("agent-1", latest, Date.now());
		assert.equal(tracker.snapshot("agent-1").length, 1);
		// 回合结束：状态槽还活着，不能灭灯。
		assert.equal(tracker.clearRunning("agent-1"), false, "agent_end must not close a live handoff");
		assert.equal(tracker.snapshot("agent-1").length, 1);

		const framesAtHandoff = slot.length;
		bus.emit("pi-subagents:supervisor-request-settled", { ...request, lifecycle: "resolved" });
		await childOptions.onDetachedExit(completedResult(fixture, { sessionFile: childOptions.sessionFile, finalOutput: "first done" }));
		await completed;

		// 交接后仍有新的状态帧（第二段启动与收尾），不再依赖工具进度帧。
		assert.ok(slot.length > framesAtHandoff, "the status slot must keep updating after the handoff");
		const afterHandoff = frames();
		assert.ok(afterHandoff.some((frame) => frame.children.some((child) => child.state === "completed")));
		const final = afterHandoff.at(-1);
		assert.equal(final.complete, true);
		tracker.observeStatusSnapshot("agent-1", final, Date.now());
		assert.equal(tracker.snapshot("agent-1").length, 0);
		assert.equal(slot.at(-1).text, undefined, "the slot is cleared after the workflow ends");
	} finally {
		delete process.env.PIDECK_DESKTOP;
		controller.abort();
		await run.catch(() => undefined);
	}
});

test("a child that fails before producing a result row still clears its light", async () => {
	const fixture = createFixture(graph, "failure-lights");
	resetDoubles();
	// runSync 直接抛错：子代理没有任何 result 行，只有 launch 解析出的路径。
	setRunSyncBehavior(() => {
		throw new Error("child setup failed");
	});
	const tracker = new SubagentRunTracker();
	const executor = graph.createSubagentExecutor(fixture.deps);
	const controller = new AbortController();
	const run = launch(executor, fixture, framesFrom(tracker), `
		return runs.run("broken", { agent: "worker", task: "will fail", async: false, acceptance: false });
	`, controller.signal);

	const result = await run;
	assert.equal(result.isError, true);
	// 不能留下永久黄灯：已知路径必须以失败态收敛。
	const snapshot = tracker.snapshot("agent-1");
	assert.equal(snapshot.length, 1);
	assert.equal(snapshot[0].status, "error");
	controller.abort();
});

test("a single subagent keeps its light after it detaches to ask", async () => {
	const fixture = createFixture(graph, "single-detach-status");
	resetDoubles();
	// 单个子代理也会在提问后 detach：工具调用返回后，状态槽必须继续上报，
	// 否则侧栏在「回答后继续跑」的整段时间里都没有灯。
	fixture.ctx.hasUI = true;
	const slot = [];
	fixture.ctx.ui = { setStatus: (key, text) => slot.push({ key, text }) };
	process.env.PIDECK_DESKTOP = "1";
	let childOptions;
	setRunSyncBehavior(({ options }) => {
		childOptions = options;
		return completedResult(fixture, {
			sessionFile: options.sessionFile,
			detached: true,
			detachedReason: "intercom coordination",
			exitCode: undefined,
			finalOutput: undefined,
		});
	});
	const tracker = new SubagentRunTracker();
	const executor = graph.createSubagentExecutor(fixture.deps);
	const controller = new AbortController();
	const run = executor.executePublic("single-call", {
		agent: "worker",
		task: "single task",
		async: false,
		acceptance: false,
	}, controller.signal, undefined, fixture.ctx);

	const frames = () => slot.map((entry) => parseSubagentStatusSnapshot(entry.text)).filter(Boolean);

	try {
		const receipt = await run;
		assert.equal(receipt.details.results[0].detached, true);
		const running = frames().at(-1);
		assert.equal(running.complete, false);
		assert.equal(running.children.length, 1);
		assert.equal(running.children[0].state, "running");
		assert.equal(running.children[0].sessionFile, childOptions.sessionFile);
		assert.equal(running.children[0].executionId, childOptions.runId, "single snapshots and tool details share an execution identity");

		tracker.observeStatusSnapshot("agent-1", running, Date.now());
		assert.equal(tracker.snapshot("agent-1").length, 1);
		// 提问返回的工具结果会把这次执行记成已结束。状态槽还说在跑时，灯必须留着。
		tracker.observe("agent-1", {
			type: "tool_execution_end",
			toolName: "subagent",
			toolCallId: "single-call",
			result: receipt,
		}, Date.now());
		assert.equal(tracker.snapshot("agent-1").length, 1);
		// 回合结束：状态槽还活着，不能灭灯。
		assert.equal(tracker.clearRunning("agent-1"), false);
		assert.equal(tracker.snapshot("agent-1").length, 1);

		await childOptions.onDetachedExit(completedResult(fixture, {
			sessionFile: childOptions.sessionFile,
			finalOutput: "single done",
		}));
		const final = frames().at(-1);
		assert.equal(final.complete, true);
		assert.equal(final.children[0].state, "completed");
		tracker.observeStatusSnapshot("agent-1", final, Date.now());
		assert.equal(tracker.snapshot("agent-1").length, 0);
		assert.equal(slot.at(-1).text, undefined, "the slot is cleared after the detached child settles");
	} finally {
		delete process.env.PIDECK_DESKTOP;
		controller.abort();
		await run.catch(() => undefined);
	}
});
