import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import test from "node:test";
import { createFakePi, resolveBackendExecutable, SseClient, startBackendSession } from "./helpers/native2BackendHarness.mjs";
import { channelEvents, waitFor } from "./helpers/native2RuntimeEvents.mjs";

const executable = resolveBackendExecutable();
const model = { provider: "test", id: "vision", input: ["text", "image"] };
const image = {
	type: "image",
	mimeType: "image/png",
	data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAAGdYAABnWARjRyu0AAAANSURBVBhXY/i/lOE/AAbvAqQmCdQ0AAAAAElFTkSuQmCC",
};

async function startImageSession(t, scenario) {
	let fake;
	const session = await startBackendSession(t, {
		projects: [{ id: "p", path: process.cwd() }],
		prepare(fixture) {
			fake = createFakePi(fixture, { state: { model }, ...scenario });
			return { settings: { customPiPath: fake.shim }, env: { FAKE_PI_SCENARIO: fake.scenarioPath, FAKE_PI_LOG: fake.logPath } };
		},
	});
	const events = new SseClient(`${session.baseUrl}__pideck/events?token=${encodeURIComponent(session.token)}`);
	t.after(() => events.close());
	await events.connect();
	const draft = await session.invoke("sessions:catalog-create-draft", [{ projectId: "p" }]);
	assert.equal(draft.payload.ok, true, JSON.stringify(draft.payload));
	const sessionId = draft.payload.result.id;
	const rows = () => channelEvents(events, sessionId, "agents:message").map(({ messages }) => messages);
	return { ...session, fake, events, rows, sessionId };
}

for (const message of ["Describe this image", ""]) {
	test(`the live timeline retains an uploaded image ${message ? "with a caption" : "without a caption"}`, { skip: !executable }, async (t) => {
		const prompt = { role: "user", content: [...(message ? [{ type: "text", text: message }] : []), image] };
		const answer = { role: "assistant", content: [{ type: "text", text: "I see it." }], stopReason: "stop" };
		const { invoke, fake, rows, sessionId } = await startImageSession(t, {
			responses: { get_messages: [{ data: { messages: [] } }, { data: { messages: [prompt, answer] } }] },
			turns: [{ replyGate: "release", events: [
				{ event: { type: "agent_start" } },
				{ event: { type: "message_start", message: prompt } },
				{ event: { type: "message_end", message: prompt } },
				{ event: { type: "message_start", message: { role: "assistant", content: [] } } },
				{ event: { type: "message_end", message: answer } },
				{ event: { type: "agent_end", messages: [prompt, answer] } },
				{ event: { type: "compaction_end" } },
				{ event: { type: "agent_settled" } },
			] }],
		});
		const requestId = "upload-image";
		const sending = invoke("sessions:send-prompt", [{ sessionId, requestId, message, images: [image] }]);
		const submitted = (messages) => messages.filter((row) => row.role === "user" && row.meta?.optimisticRequestId === requestId);
		try {
			const sent = await waitFor(() => fake.commands().find((entry) => entry.command === "prompt"), 10_000, "image prompt at pi");
			assert.deepEqual(sent.payload.images, [image]);
			const first = await waitFor(() => rows().find((messages) => submitted(messages).length > 0), 10_000, "first timeline confirmation");
			assert.equal(submitted(first).length, 1);
			assert.deepEqual(submitted(first)[0].images, [image], "the first confirmation replaces the renderer's local bubble");
		} finally {
			writeFileSync(`${fake.scenarioPath}.release`, "");
			await sending;
		}
		assert.equal((await sending).payload.result.accepted, true);
		const replied = await waitFor(() => rows().find((messages) => messages.some((row) => row.role === "assistant" && row.text === "I see it.")), 10_000, "timeline with reply");
		assert.equal(replied.filter((row) => row.role === "user").length, 1);
		assert.deepEqual(submitted(replied)[0]?.images, [image]);
		const projected = await waitFor(() => rows().find((messages) => messages.some((row) => row.role === "user" && row.meta?._piDeckMsgSeq === 0)), 10_000, "reprojected timeline");
		assert.equal(projected.filter((row) => row.role === "user").length, 1);
		assert.deepEqual(projected.find((row) => row.role === "user").images, [image]);
	});
}

for (const exits of [false, true]) test(exits
	? "completed tool results reach the image timeline before pi exits"
	: "a burst of completed tools sends one image-bearing snapshot and retains every result", { skip: !executable }, async (t) => {
	const toolIds = ["first", "second", "third"];
	const burst = [
		{ type: "agent_start" },
		...toolIds.map((toolCallId) => ({ type: "tool_execution_end", toolName: "read", toolCallId,
			result: { content: [{ type: "text", text: toolCallId }] }, isError: false })),
		...(exits ? [] : [{ type: "agent_settled" }]),
	].map((event) => JSON.stringify(event)).join("\n");
	const { invoke, events, sessionId } = await startImageSession(t, {
		turns: [{ events: [{ raw: burst }, ...(exits ? [{ exitWithCode: 7 }] : [])] }],
	});
	const sent = await invoke("sessions:send-prompt", [{ sessionId, requestId: "burst-with-image", message: "Read these files", images: [image] }]);
	assert.equal(sent.payload.result.accepted, true);
	const runtimeFrame = (frame, channel) => frame.payload.channel === "sessions:runtime-event"
		&& frame.payload.args[0]?.sessionId === sessionId && frame.payload.args[0].sourceChannel === channel;
	const statusFrame = (frame, status) => frame.payload.channel === "agents:state"
		&& frame.payload.args[0].some?.((tab) => tab.deckSessionId === sessionId && tab.status === status);
	const running = await events.waitFor((frame) => statusFrame(frame, "running"));
	const final = await events.waitFor((frame) => frame.id > running.id && (exits
		? runtimeFrame(frame, "sessions:runtime-detach") : statusFrame(frame, "idle")));
	const replies = events.frames.filter((frame) => runtimeFrame(frame, "agents:message")
		&& frame.payload.args[0].payload.messages.some((row) => row.role === "tool"));
	assert.equal(replies.length, 1, "the same image body must not be sent once per tool result");
	assert.ok(replies[0].id < final.id, "completed results must arrive before idle or detach");
	const messages = replies[0].payload.args[0].payload.messages;
	const tools = messages.filter((row) => row.role === "tool");
	assert.deepEqual(tools.map((row) => [row.meta?.toolCallId, row.meta?.status]), toolIds.map((id) => [id, "done"]));
	tools.forEach((row, index) => assert.ok(row.meta?.detailText?.includes(toolIds[index])));
	assert.deepEqual(messages.find((row) => row.role === "user").images, [image]);
});

for (const variant of ["identical", "correction", "reasoning", "snapshot reasoning"]) test(`paired assistant terminal events preserve the image timeline (${variant})`, { skip: !executable }, async (t) => {
	const snapshotOnly = variant === "snapshot reasoning";
	const thinking = variant === "reasoning" || snapshotOnly ? [{ type: "thinking", thinking: "Checking the image." }] : [];
	const answer = { role: "assistant", content: [...thinking, { type: "text", text: "Visible answer." }] };
	const finalAnswer = variant === "correction" ? { ...answer, content: [{ type: "text", text: "Corrected answer." }] } : answer;
	const burst = [
		{ type: "agent_start" },
		{ type: "message_start", message: { role: "assistant", content: [] } },
		...(snapshotOnly ? [] : [
			...thinking.map((block) => ({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: block.thinking } })),
			{ type: "message_update", message: answer, assistantMessageEvent: { type: "text_delta", delta: "Visible answer." } },
		]),
		{ type: "message_update", message: answer, assistantMessageEvent: { type: "done" } },
		...(thinking.length ? [] : [{ type: "message_end", message: finalAnswer }, { type: "agent_settled" }]),
	].map((event) => JSON.stringify(event)).join("\n");
	// Pause the repeated reasoning terminal edge so synthesizing new timestamps
	// cannot accidentally produce the same millisecond as the measured phase.
	const terminal = [JSON.stringify({ type: "message_end", message: finalAnswer }), JSON.stringify({ type: "agent_settled" })].join("\n");
	const { invoke, events, sessionId } = await startImageSession(t, {
		turns: [{ events: [{ raw: burst }, ...(thinking.length ? [{ raw: terminal, delayMs: 25 }] : [])] }],
	});
	assert.equal((await invoke("sessions:send-prompt", [{ sessionId, requestId: "burst-reply", message: "Describe this", images: [image] }])).payload.result.accepted, true);
	const runtimeFrame = (frame, channel) => frame.payload.channel === "sessions:runtime-event"
		&& frame.payload.args[0]?.sessionId === sessionId && frame.payload.args[0].sourceChannel === channel;
	const firstAnswer = await events.waitFor((frame) => runtimeFrame(frame, "agents:message")
		&& frame.payload.args[0].payload.messages.some((row) => row.role === "assistant" && row.text === "Visible answer."));
	const idle = await events.waitFor((frame) => frame.id > firstAnswer.id && frame.payload.channel === "agents:state"
		&& frame.payload.args[0].some?.((tab) => tab.deckSessionId === sessionId && tab.status === "idle"));
	const history = events.frames.filter((frame) => frame.id < idle.id && runtimeFrame(frame, "agents:message"))
		.map((frame) => ({ id: frame.id, messages: frame.payload.args[0].payload.messages }))
		.filter(({ messages }) => messages.some((row) => row.role === "assistant"));
	if (!snapshotOnly) {
		const done = await events.waitFor((frame) => runtimeFrame(frame, "agents:text-stream") && frame.payload.args[0].payload.done);
		assert.ok(history[0]?.id < done.id, "the answer snapshot must arrive before the terminal live frame");
	}
	assert.deepEqual(history.map(({ messages }) => messages.find((row) => row.role === "assistant").text),
		variant === "correction" ? ["Visible answer.", "Corrected answer."] : ["Visible answer."]);
	history.forEach(({ messages }) => assert.deepEqual(messages.find((row) => row.role === "user").images, [image]));
	if (thinking.length > 0) {
		const reply = history[0].messages.find((row) => row.role === "assistant");
		assert.equal(reply.thinking, "Checking the image.");
		assert.ok(reply.thinkingStartedAt > 0 && reply.thinkingEndedAt >= reply.thinkingStartedAt);
	}
});

test("restart publishes a completed tool on the original binding before detaching it", { skip: !executable }, async (t) => {
	const burst = [
		{ type: "agent_start" },
		{ type: "tool_execution_end", toolName: "read", toolCallId: "completed-before-restart",
			result: { content: [{ type: "text", text: "Result before restart." }] }, isError: false },
	].map((event) => JSON.stringify(event)).join("\n");
	const { invoke, events, sessionId } = await startImageSession(t, { turns: [{ events: [{ raw: burst }] }] });
	const activated = await invoke("sessions:runtime-activate", [sessionId]);
	assert.equal(activated.payload.result.ok, true);
	const target = activated.payload.result.value;
	const runtimeFrame = (frame, channel) => frame.payload.channel === "sessions:runtime-event"
		&& frame.payload.args[0]?.agentId === target.agentId && frame.payload.args[0].sourceChannel === channel;
	const sent = invoke("sessions:send-prompt", [{ sessionId, requestId: "restart-with-image", message: "Read this", images: [image] }]);
	await events.waitFor((frame) => runtimeFrame(frame, "agents:runtime-state")
		&& frame.payload.args[0].payload.state?.toolStateSequence > 0);
	assert.equal((await sent).payload.result.accepted, true);
	const restarted = await invoke("sessions:runtime-restart", [target]);
	assert.equal(restarted.payload.result.ok, true, JSON.stringify(restarted.payload));
	const detached = await events.waitFor((frame) => runtimeFrame(frame, "sessions:runtime-detach"));
	const completed = events.frames.find((frame) => frame.id < detached.id && runtimeFrame(frame, "agents:message")
		&& frame.payload.args[0].payload.messages.some((row) => row.meta?.toolCallId === "completed-before-restart"
			&& row.meta.status === "done"));
	assert.ok(completed, "the tool result must reach the old binding before it is detached");
	assert.deepEqual(completed.payload.args[0].payload.messages.find((row) => row.role === "user").images, [image]);
});

test("settle publishes a completed text segment when pi omits both terminal reply frames", { skip: !executable }, async (t) => {
	const answer = { role: "assistant", content: [{ type: "text", text: "Answer without message_end." }] };
	const burst = [
		{ type: "agent_start" },
		{ type: "message_start", message: { role: "assistant", content: [] } },
		{ type: "message_update", message: answer, assistantMessageEvent: { type: "text_end" } },
		{ type: "agent_settled" },
	].map((event) => JSON.stringify(event)).join("\n");
	const { invoke, events, sessionId } = await startImageSession(t, { turns: [{ events: [{ raw: burst }] }] });
	assert.equal((await invoke("sessions:send-prompt", [{ sessionId, requestId: "settle-fallback", message: "Describe this", images: [image] }])).payload.result.accepted, true);
	const status = (frame, value) => frame.payload.channel === "agents:state"
		&& frame.payload.args[0].some?.((tab) => tab.deckSessionId === sessionId && tab.status === value);
	const running = await events.waitFor((frame) => status(frame, "running"));
	const idle = await events.waitFor((frame) => frame.id > running.id && status(frame, "idle"));
	const completed = events.frames.filter((frame) => frame.id < idle.id && frame.payload.channel === "sessions:runtime-event")
		.map((frame) => frame.payload.args[0]).filter((frame) => frame.sessionId === sessionId && frame.sourceChannel === "agents:message")
		.map((frame) => frame.payload.messages).find((messages) => messages.some((row) => row.text === "Answer without message_end."));
	assert.ok(completed, "the completed text must reach the timeline before idle");
	assert.deepEqual(completed.find((row) => row.role === "user").images, [image]);
});
