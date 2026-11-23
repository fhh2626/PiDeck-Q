import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import { backendTestAvailability, SseClient } from "./helpers/native2BackendHarness.mjs";
import {
	createSuiteProject, removeSuiteProject, sleep, startRuntimeBackend, statusFrames, waitFor,
} from "./helpers/native2RuntimeEvents.mjs";

/** Extension commands can finish without opening an agent run or emitting agent_settled. */
describe("native2 extension command settlement", { skip: backendTestAvailability().skip }, () => {
	let root;
	let projectPath;
	before(() => { ({ root, projectPath } = createSuiteProject("pideck-extension-settlement-")); });
	after(() => removeSuiteProject(root));

	async function start(t, scenario = {}) {
		const session = await startRuntimeBackend(t, {
			projectPath, projectId: "extension-settlement",
			// Each fixture owns an isolated profile. Its long sandbox path can exceed
			// the POSIX socket-name limit, and this suite does not exercise instance claims.
			settings: { singleInstance: false },
			scenario: { commands: [{ name: "todo-resume", source: "extension" }], ...scenario },
		});
		const { record, target } = await session.activate("saved");
		const sse = new SseClient(`${session.baseUrl}__pideck/events?token=${encodeURIComponent(session.token)}`);
		await sse.connect();
		t.after(() => sse.close());
		// Initial activation frames may still be replayed after connect completes.
		const runStatuses = () => {
			const statuses = statusFrames(sse, record.id);
			const index = statuses.indexOf("running");
			return index < 0 ? [] : statuses.slice(index);
		};
		return { ...session, record, target, runStatuses };
	}

	for (const [label, text, scenario] of [
		["ordinary text", "Please work on this", {}],
		["a shell prefix", "! echo local", {}],
		["an excluded shell prefix", "!! echo local", {}],
		["an unregistered command", "/unknown", {}],
		["a prompt template", "/todo-resume", { commands: [{ name: "todo-resume", source: "prompt" }] }],
		["a failed command lookup", "/todo-resume", { responses: { get_commands: { error: "lookup failed" } } }],
	]) {
		test(`silent dispatch rejects ${label} before writing a prompt`, async (t) => {
			const session = await start(t, scenario);
			const sent = await session.invoke("sessions:send-prompt", [{
				sessionId: session.record.id, requestId: `silent-${label}`,
				message: text.startsWith("!") ? text : "", agentMessage: text, silent: true,
			}]);
			assert.equal(sent.payload.ok, true, JSON.stringify(sent.payload));
			assert.equal(sent.payload.result.accepted, false, JSON.stringify(sent.payload));
			assert.equal(sent.payload.result.i18nKey, "sessionCommand.silentUnavailable");
			assert.notEqual(sent.payload.result.delivery, "unknown");
			assert.equal(session.fake.commands().filter((row) => row.command === "prompt").length, 0);
			assert.deepEqual(session.runStatuses(), []);
		});
	}

	test("silent dispatch accepts a registered extension command while idle", async (t) => {
		const session = await start(t);
		const sent = await session.invoke("sessions:send-prompt", [{
			sessionId: session.record.id, requestId: "silent-valid", message: "", agentMessage: "/todo-resume", silent: true,
		}]);
		assert.equal(sent.payload.result.accepted, true, JSON.stringify(sent.payload));
		const prompts = session.fake.commands().filter((row) => row.command === "prompt");
		assert.equal(prompts.length, 1);
		assert.equal(prompts[0].payload.message, "/todo-resume");
		assert.deepEqual(session.runStatuses(), []);
	});

	test("silent dispatch refuses a registered command while the runtime is busy", async (t) => {
		const session = await start(t);
		assert.equal((await session.prompt(session.record, "Work in progress", "busy-task")).payload.result.accepted, true);
		const sent = await session.invoke("sessions:send-prompt", [{
			sessionId: session.record.id, requestId: "silent-busy", message: "", agentMessage: "/todo-resume", silent: true,
		}]);
		assert.equal(sent.payload.result.accepted, false, JSON.stringify(sent.payload));
		assert.equal(sent.payload.result.i18nKey, "sessionCommand.silentBusy");
		assert.equal(session.fake.commands().filter((row) => row.command === "prompt").length, 1);
		const runtimes = await session.invoke("sessions:runtime-list", []);
		assert.equal(runtimes.payload.result.find((runtime) => runtime.sessionId === session.record.id)?.status, "running");
	});

	test("a failed command lookup keeps ordinary slash prompts available", async (t) => {
		const session = await start(t, { responses: { get_commands: { error: "lookup failed" } } });
		const sent = await session.prompt(session.record, "/unregistered", "ordinary-slash");
		assert.equal(sent.payload.result.accepted, true, JSON.stringify(sent.payload));
		assert.equal(session.fake.commands().filter((row) => row.command === "prompt").length, 1);
	});

	test("silent dispatch rechecks busy state after command lookup", async (t) => {
		const session = await start(t, { responses: { get_commands: { replyGate: "silent-lookup" } } });
		const pending = session.invoke("sessions:send-prompt", [{
			sessionId: session.record.id, requestId: "silent-pending", message: "", agentMessage: "/todo-resume", silent: true,
		}]);
		let sent;
		try {
			await waitFor(() => session.fake.commands().some((row) => row.command === "get_commands"));
			assert.equal((await session.prompt(session.record, "New task", "new-task")).payload.result.accepted, true);
		} finally {
			writeFileSync(`${session.fake.scenarioPath}.silent-lookup`, "open");
			sent = await pending;
		}
		assert.equal(sent.payload.result.accepted, false, JSON.stringify(sent.payload));
		assert.equal(sent.payload.result.i18nKey, "sessionCommand.silentBusy");
		assert.equal(session.fake.commands().filter((row) => row.command === "prompt").length, 1);
	});

	test("silent dispatch cannot enter while an ordinary prompt still awaits its ACK", async (t) => {
		const session = await start(t, { turns: [{ replyGate: "foreground-ack" }] });
		const pending = session.prompt(session.record, "New task", "foreground-pending");
		try {
			await waitFor(() => session.fake.commands().some((row) => row.command === "prompt"));
			const sent = await session.invoke("sessions:send-prompt", [{
				sessionId: session.record.id, requestId: "silent-during-ack", message: "", agentMessage: "/todo-resume", silent: true,
			}]);
			assert.equal(sent.payload.result.accepted, false, JSON.stringify(sent.payload));
			assert.equal(sent.payload.result.i18nKey, "sessionCommand.silentBusy");
			assert.equal(session.fake.commands().filter((row) => row.command === "prompt").length, 1);
		} finally {
			writeFileSync(`${session.fake.scenarioPath}.foreground-ack`, "open");
			assert.equal((await pending).payload.result.accepted, true);
		}
	});

	test("a rejected silent command leaves the previous completion probe valid", async (t) => {
		const session = await start(t);
		assert.equal((await session.prompt(session.record, "/todo-resume", "previous-task")).payload.result.accepted, true);
		const sent = await session.invoke("sessions:send-prompt", [{
			sessionId: session.record.id, requestId: "silent-invalid", message: "", agentMessage: "/unknown", silent: true,
		}]);
		assert.equal(sent.payload.result.accepted, false, JSON.stringify(sent.payload));
		await waitFor(() => session.runStatuses().includes("idle"), 3_000, "previous command idle");
		assert.equal(session.fake.commands().filter((row) => row.command === "prompt").length, 1);
	});

	test("a completed extension command returns to idle without agent lifecycle events", async (t) => {
		const session = await start(t);
		const initialPolls = session.fake.commands().filter((row) => row.command === "get_state").length;
		const sent = await session.prompt(session.record, "/todo-resume", "resume-unavailable");
		assert.equal(sent.payload.result.accepted, true, JSON.stringify(sent.payload));
		await waitFor(() => session.runStatuses().includes("idle"), 3_000, "completed extension idle");
		assert.deepEqual(session.runStatuses().filter((status, index, values) => status !== values[index - 1]), ["running", "idle"]);
		assert.ok(session.fake.commands().filter((row) => row.command === "get_state").length > initialPolls,
			"only pi's idle confirmation may release the next queued prompt");
		assert.equal(session.fake.readLog().some((row) => row.kind === "event"
			&& ["agent_start", "agent_end", "agent_settled"].includes(row.event?.type)), false);
	});

	test("a rejected idle probe cannot settle an accepted extension command", async (t) => {
		const session = await start(t, {
			// Activation and its published snapshots have valid state. The later
			// command-completion probe receives an explicit failure from pi.
			responses: { get_state: [{}, {}, {}, { error: "state probe failed" }] },
		});
		const sent = await session.prompt(session.record, "/todo-resume", "resume-state-unknown");
		assert.equal(sent.payload.result.accepted, true, JSON.stringify(sent.payload));
		await waitFor(() => session.fake.commands().filter((row) => row.command === "get_state").length >= 4,
			3_000, "command-completion state probe");
		await sleep(150);
		assert.equal(session.runStatuses().includes("idle"), false,
			"a failed get_state response cannot authorize the next queued task");
	});

	test("a late idle probe cannot settle a newer prompt before its agent_start", async (t) => {
		const session = await start(t, {
			responses: { get_state: [{}, {}, {}, { replyGate: "old-command-idle" }] },
		});
		const first = await session.prompt(session.record, "/todo-resume", "old-command");
		assert.equal(first.payload.result.accepted, true, JSON.stringify(first.payload));
		await waitFor(() => session.fake.commands().filter((row) => row.command === "get_state").length >= 4,
			3_000, "old command idle probe");
		const next = await session.prompt(session.record, "Continue with the next task", "new-prompt");
		assert.equal(next.payload.result.accepted, true, JSON.stringify(next.payload));
		assert.equal(session.fake.commands().filter((row) => row.command === "prompt").length, 2);
		writeFileSync(`${session.fake.scenarioPath}.old-command-idle`, "open");
		await sleep(250);
		assert.equal(session.runStatuses().includes("idle"), false,
			"an idle snapshot requested before the new prompt cannot release its queue wait");
	});

	for (const [label, event] of [
		["ask", { type: "extension_ui_request", id: "late-ask", method: "input", title: "Still waiting" }],
		["assistant", { type: "message_start", message: { role: "assistant", content: [] } }],
		["tool", { type: "tool_execution_start", toolCallId: "late-tool", toolName: "read", args: { path: "file.txt" } }],
	]) {
		test(`an idle probe rechecks a new ${label} event before settling the command`, async (t) => {
			const session = await start(t, {
				responses: { get_state: [{}, {}, {}, { eventsBeforeReply: [event] }] },
			});
			const sent = await session.prompt(session.record, "/todo-resume", `pending-${label}`);
			assert.equal(sent.payload.result.accepted, true, JSON.stringify(sent.payload));
			await waitFor(() => session.fake.readLog().some((row) => row.kind === "event"
				&& row.event?.type === event.type), 3_000, `new ${label} before idle reply`);
			await sleep(150);
			const runtimes = await session.invoke("sessions:runtime-list", []);
			assert.equal(runtimes.payload.result.find((runtime) => runtime.sessionId === session.record.id)?.status, "running");
			assert.equal(session.runStatuses().includes("idle"), false,
				"the newer local work must survive the older no-work snapshot");
		});
	}

	test("an old command timer cannot settle a newer prompt during command lookup", async (t) => {
		const session = await start(t, {
			responses: { get_commands: [{}, { replyGate: "new-command-lookup" }] },
		});
		const first = await session.prompt(session.record, "/todo-resume", "finished-command");
		assert.equal(first.payload.result.accepted, true, JSON.stringify(first.payload));
		const next = session.prompt(session.record, "/todo-resume", "waiting-command");
		await waitFor(() => session.fake.commands().filter((row) => row.command === "get_commands").length >= 2,
			3_000, "new command lookup");
		await sleep(250);
		try {
			assert.equal(session.runStatuses().includes("idle"), false,
				"queued work is still in preflight and must retain its running state");
		} finally {
			writeFileSync(`${session.fake.scenarioPath}.new-command-lookup`, "open");
			await next;
		}
	});

	for (const accepted of [true, false]) {
		test(`a late ${accepted ? "accepted" : "rejected"} command ACK cannot settle a newer prompt`, async (t) => {
			const session = await start(t, {
				turns: [{ ack: accepted, replyGate: "old-command-ack" }, { ack: true }],
			});
			const first = session.prompt(session.record, "/todo-resume", "late-command-ack");
			await waitFor(() => session.fake.commands().some((row) => row.command === "prompt"));
			const next = await session.prompt(session.record, "Continue with the next task", "newer-task");
			assert.equal(next.payload.result.accepted, true, JSON.stringify(next.payload));
			writeFileSync(`${session.fake.scenarioPath}.old-command-ack`, "open");
			const old = await first;
			assert.equal(old.payload.result.accepted, accepted, JSON.stringify(old.payload));
			await sleep(250);
			assert.equal(session.runStatuses().includes("idle"), false,
				"an old command reply cannot update the status or arm a watchdog for newer work");
		});
	}

	test("a rejected newer input can still settle a completed prior command", async (t) => {
		const session = await start(t, { turns: [{ ack: true }, { ack: false }] });
		assert.equal((await session.prompt(session.record, "/todo-resume", "completed-prior")).payload.result.accepted, true);
		assert.equal((await session.prompt(session.record, "Rejected next task", "rejected-next")).payload.result.accepted, false);
		await waitFor(() => session.runStatuses().includes("idle"), 3_000, "completed prior command idle");
	});

	for (const stage of ["lookup", "ACK"]) {
		test(`overlapping commands wait for the earlier ${stage} before confirming idle`, async (t) => {
			const session = await start(t, stage === "lookup"
				? { responses: { get_commands: [{ replyGate: "earlier-command" }, {}] } }
				: { turns: [{ replyGate: "earlier-command" }, { ack: true }] });
			const first = session.prompt(session.record, "/todo-resume", "earlier-command");
			const boundary = stage === "lookup" ? "get_commands" : "prompt";
			await waitFor(() => session.fake.commands().some((row) => row.command === boundary));
			assert.equal((await session.prompt(session.record, "/todo-resume", "later-command")).payload.result.accepted, true);
			await sleep(250);
			try {
				assert.equal(session.runStatuses().includes("idle"), false,
					"a completed command cannot release the queue while another dispatch is unfinished");
			} finally {
				writeFileSync(`${session.fake.scenarioPath}.earlier-command`, "open");
				await first;
			}
			await waitFor(() => session.runStatuses().includes("idle"), 3_000, "both commands complete");
		});
	}

	test("stopping during command lookup prevents dispatch into the old process", async (t) => {
		const session = await start(t, {
			responses: { get_commands: { replyGate: "pending-command-lookup" } },
		});
		const pending = session.prompt(session.record, "/todo-resume", "stop-before-dispatch");
		await waitFor(() => session.fake.commands().some((row) => row.command === "get_commands"));
		const stopped = await session.invoke("sessions:runtime-stop", [{
			sessionId: session.record.id, agentId: session.target.agentId,
			runtimeGeneration: session.target.runtimeGeneration,
		}]);
		assert.equal(stopped.payload.result.ok, true, JSON.stringify(stopped.payload));
		const sent = await pending;
		assert.equal(sent.payload.result.accepted, false, JSON.stringify(sent.payload));
		assert.notEqual(sent.payload.result.delivery, "unknown", "the prompt never left preflight");
		assert.equal(session.fake.commands().some((row) => row.command === "prompt"), false);
	});

	for (const source of ["prompt", "unknown"]) {
		const label = source === "prompt" ? "a prompt template" : "an unregistered slash input";
		test(`${label} keeps waiting for its agent run`, async (t) => {
			const session = await start(t, {
				commands: source === "unknown" ? [] : [{ name: "todo-resume", source }],
			});
			const sent = await session.prompt(session.record, "/todo-resume", `slash-${source}`);
			assert.equal(sent.payload.result.accepted, true, JSON.stringify(sent.payload));
			await waitFor(() => session.runStatuses().includes("running"));
			await sleep(350);
			assert.equal(session.runStatuses().includes("idle"), false,
				"a slash prefix alone does not prove that the input completed without a model turn");
		});
	}
});
