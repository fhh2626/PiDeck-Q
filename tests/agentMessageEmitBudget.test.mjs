import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { AgentManager } = loadTsCommonJs("src/main/pi/AgentManager.ts");
const AGENTS_MESSAGE = "agents:message";
const AGENTS_STATE = "agents:state";

/**
 * 回归（Review P1）：sessionRuntimeBridge 按真实 sessions:runtime-event 外包络做 30 MiB
 * 预算判定并返回 false 拒绝时，AgentManager.emit 不得再把同一条超大 agents:message
 * 交给 sendToRenderer（原生 32 MiB 帧会被打满触发整帧丢弃/resync）。
 * 其余 channel（agents:state 等）维持「始终 sendToRenderer」行为不受误伤。
 */

function createManager(sendToRenderer = () => {}) {
	const manager = new AgentManager(
		() => ({ id: "project-1", name: "Project", path: "C:/project" }),
		sendToRenderer,
		{ get: () => ({}) },
		{},
	);
	const runtime = {
		tab: {
			id: "agent-1",
			projectId: "project-1",
			cwd: "C:/project",
			title: "Session",
			status: "running",
			sessionPath: "C:/project/.pi/sessions/xxx.jsonl",
			sessionEnvironment: "native",
			sessionSource: "pi",
			createdAt: 1,
		},
		process: { client: { request: async () => ({ success: true, data: {} }) } },
	};
	manager.agents.set("agent-1", runtime);
	return manager;
}

const seedMessages = (manager, extra = []) => {
	manager.messages.set("agent-1", [
		{ id: "u-1", agentId: "agent-1", role: "user", text: "hi", timestamp: 1 },
		...extra,
	]);
};

const assistantMsg = (id, text) => ({
	id,
	agentId: "agent-1",
	role: "assistant",
	text,
	timestamp: 2,
});

test("listener 拒绝 agents:message 时不再 sendToRenderer 该信封（超大包不进 32 MiB 原生帧）", () => {
	const sent = [];
	const manager = createManager((channel) => sent.push(channel));
	// 模拟 createBackend 的 onOutput：预算阻断时对 agents:message 返回 false
	manager.onOutput((channel) => (channel === AGENTS_MESSAGE ? false : undefined));

	seedMessages(manager, [assistantMsg("a-1", "huge output")]);
	manager.markMessagesDirtyFrom("agent-1", 1);
	manager.flushMessageEmit("agent-1");

	assert.ok(!sent.includes(AGENTS_MESSAGE), "被拒的 agents:message 不得进入 sendToRenderer");
	assert.ok(sent.length === 0 || !sent.includes(AGENTS_MESSAGE));
});

test("listener 返回 false 不影响其它 channel 的 sendToRenderer", () => {
	const sent = [];
	const manager = createManager((channel) => sent.push(channel));
	// 对所有 channel 都返回 false（最严苛场景）：agents:state 仍必须照常下发
	manager.onOutput(() => false);
	manager.emitState();

	assert.ok(sent.includes(AGENTS_STATE), "非 agents:message 通道不受 listener 拒绝影响");
});

test("无 listener / listener 返回 undefined 时照常 sendToRenderer（既有行为不变）", () => {
	const sent = [];
	const manager = createManager((channel) => sent.push(channel));
	seedMessages(manager, [assistantMsg("a-1", "ok")]);
	manager.markMessagesDirtyFrom("agent-1", 1);
	manager.flushMessageEmit("agent-1");

	assert.ok(sent.includes(AGENTS_MESSAGE), "无拒绝时 agents:message 照常下发");
});

test("flush 被拒后 dirty 下标保留：后续 flush 仍从最早 dirty 起补发，不丢中间更新", () => {
	const payloads = [];
	let reject = true;
	const manager = createManager(() => {});
	// 在 listener 层捕获：即使被拒也能拿到本次 flush 的 payload 形状
	manager.onOutput((channel, payload) => {
		if (channel === AGENTS_MESSAGE) payloads.push(payload);
		return channel === AGENTS_MESSAGE && reject ? false : undefined;
	});

	seedMessages(manager, [assistantMsg("a-1", "first"), assistantMsg("a-2", "second")]);

	// 第一次 flush：增量 upsertFrom=1，被拒
	manager.markMessagesDirtyFrom("agent-1", 1);
	manager.flushMessageEmit("agent-1");
	assert.equal(payloads.length, 1);
	assert.equal(payloads[0].upsertFrom, 1);

	// 随后更靠后的下标变脏（markMessagesDirtyFrom 取最小值，不应把 1 吃掉）
	manager.markMessagesDirtyFrom("agent-1", 2);
	reject = false;
	manager.flushMessageEmit("agent-1");

	assert.equal(payloads.length, 2);
	const second = payloads[1];
	// 关键断言：第二次 flush 必须从更早的 dirty（1）开始，而不是只从 2 开始丢掉第一次被拒的更新
	assert.ok(
		second.upsertFrom !== undefined && second.upsertFrom <= 1,
		`第二次 flush upsertFrom=${second.upsertFrom}，必须 <= 1（保留被拒的 dirty）`,
	);
	assert.ok(second.messages.some((m) => m.id === "a-1"), "被拒那条的消息内容必须包含在补发里");
	assert.equal(second.totalLength, 3);
});

test("rejected immediate full flush remains full after a later tail update", () => {
	const emittedPayloads = [];
	const rendererPayloads = [];
	let reject = true;

	const manager = createManager((channel, payload) => {
		if (channel === AGENTS_MESSAGE) rendererPayloads.push(payload);
	});

	manager.onOutput((channel, payload) => {
		if (channel === AGENTS_MESSAGE) emittedPayloads.push(payload);
		return channel === AGENTS_MESSAGE && reject ? false : undefined;
	});

	// 1. 构造消息数组：0=user, 1=assistant A, 2=assistant B
	seedMessages(manager, [
		assistantMsg("a-1", "assistant A"),
		assistantMsg("a-2", "assistant B initial"),
	]);

	// 5. 增量 flush：从下标 1 开始，被拒
	manager.markMessagesDirtyFrom("agent-1", 1);
	manager.flushMessageEmit("agent-1");
	assert.equal(emittedPayloads.length, 1);
	assert.equal(emittedPayloads[0].upsertFrom, 1);
	assert.equal(rendererPayloads.length, 0, "第一次增量被拒，不得进入 renderer");

	// 7. immediate 调度：强制全量校准，被拒
	manager.scheduleMessageEmit("agent-1", true);
	assert.equal(emittedPayloads.length, 2);
	assert.equal(emittedPayloads[1].upsertFrom, undefined, "第二次必须为全量窗口 payload");
	assert.equal(rendererPayloads.length, 0, "第二次全量被拒，仍不得进入 renderer");

	// 9. 修改下标 2 的文本，并标记下标 2 dirty
	const currentList = manager.messages.get("agent-1");
	currentList[2].text = "assistant B updated";
	manager.markMessagesDirtyFrom("agent-1", 2);

	// 10. 允许投递成功并再次 flush
	reject = false;
	manager.flushMessageEmit("agent-1");
	assert.equal(emittedPayloads.length, 3);
	const third = emittedPayloads[2];

	// 12. 关键断言：第三次必须仍为全量，且携带 A 与最新 B
	assert.equal(third.upsertFrom, undefined, "被拒的全量校准不能被后续更晚的增量尾段降级");
	assert.ok(third.messages.some((m) => m.id === "a-1"), "全量窗口必须包含 assistant A");
	const bMsg = third.messages.find((m) => m.id === "a-2");
	assert.ok(bMsg, "全量窗口必须包含 assistant B");
	assert.equal(bMsg.text, "assistant B updated", "assistant B 必须为最新文本");
	assert.equal(rendererPayloads.length, 1, "真正进入 renderer 的只有第三次成功的全量 payload");
	assert.equal(rendererPayloads[0].upsertFrom, undefined);
});

test("rejected full flush preserves pending slideOut and history flags until accepted", () => {
	const emittedPayloads = [];
	let reject = true;

	const manager = createManager();
	manager.onOutput((channel, payload) => {
		if (channel === AGENTS_MESSAGE) emittedPayloads.push(payload);
		return channel === AGENTS_MESSAGE && reject ? false : undefined;
	});

	seedMessages(manager, [assistantMsg("a-1", "msg 1"), assistantMsg("a-2", "msg 2")]);
	manager.pendingSlideOutByAgent.set("agent-1", [
		{ id: "s-1", agentId: "agent-1", role: "assistant", text: "slide out", timestamp: 0 },
	]);
	manager.preserveHistoryOnNextFlush.set("agent-1", false);
	manager.stickyHistoryOnNextFlush.add("agent-1");

	// 1. immediate 全量被拒
	manager.scheduleMessageEmit("agent-1", true);
	assert.equal(emittedPayloads.length, 1);
	assert.equal(emittedPayloads[0].upsertFrom, undefined);
	assert.ok(emittedPayloads[0].slideOut?.some((m) => m.id === "s-1"));
	assert.equal(emittedPayloads[0].preserveHistory, undefined);
	assert.equal(emittedPayloads[0].stickyHistory, true);

	// 2. 期间发生后续末尾消息更新
	manager.markMessagesDirtyFrom("agent-1", 2);

	// 3. 再次 flush 成功
	reject = false;
	manager.flushMessageEmit("agent-1");
	assert.equal(emittedPayloads.length, 2);
	const second = emittedPayloads[1];
	assert.equal(second.upsertFrom, undefined, "仍必须为全量窗口");
	assert.ok(second.slideOut?.some((m) => m.id === "s-1"), "被拒保留的 slideOut 必须在本次成功全量中带出");
	assert.equal(second.preserveHistory, undefined, "preserveHistory 必须保持为预期值");
	assert.equal(second.stickyHistory, true, "stickyHistory 必须保持为预期值");

	// 4. 再次触发新的全量投递，确认已经成功消耗的旧 slideOut 不会重复附带
	manager.scheduleMessageEmit("agent-1", true);
	assert.equal(emittedPayloads.length, 3);
	assert.equal(emittedPayloads[2].slideOut, undefined, "已成功消耗的 slideOut 不得重复附带");
});

test("successful full flush restores subsequent incremental flushes", () => {
	const emittedPayloads = [];
	let reject = true;

	const manager = createManager();
	manager.onOutput((channel, payload) => {
		if (channel === AGENTS_MESSAGE) emittedPayloads.push(payload);
		return channel === AGENTS_MESSAGE && reject ? false : undefined;
	});

	seedMessages(manager, [assistantMsg("a-1", "msg 1"), assistantMsg("a-2", "msg 2")]);

	// 1. immediate 全量被拒
	manager.scheduleMessageEmit("agent-1", true);
	assert.equal(emittedPayloads.length, 1);
	assert.equal(emittedPayloads[0].upsertFrom, undefined);

	// 2. 下一次全量成功
	reject = false;
	manager.flushMessageEmit("agent-1");
	assert.equal(emittedPayloads.length, 2);
	assert.equal(emittedPayloads[1].upsertFrom, undefined);

	// 3. 仅修改最后一条消息
	const list = manager.messages.get("agent-1");
	list[2].text = "msg 2 updated";
	manager.markMessagesDirtyFrom("agent-1", 2);

	// 4. flush 应恢复为普通增量
	manager.flushMessageEmit("agent-1");
	assert.equal(emittedPayloads.length, 3);
	assert.equal(emittedPayloads[2].upsertFrom, 2, "成功全量后应恢复普通增量");
	assert.equal(emittedPayloads[2].messages.length, 1);
	assert.equal(emittedPayloads[2].messages[0].text, "msg 2 updated");
});

test("non-immediate full flush rejection also preserves pending full state", () => {
	const emittedPayloads = [];
	let reject = true;

	const manager = createManager();
	manager.onOutput((channel, payload) => {
		if (channel === AGENTS_MESSAGE) emittedPayloads.push(payload);
		return channel === AGENTS_MESSAGE && reject ? false : undefined;
	});

	seedMessages(manager, [assistantMsg("a-1", "msg 1"), assistantMsg("a-2", "msg 2")]);

	// 1. 不设置 dirty 直接调用 flush，得到全量
	manager.flushMessageEmit("agent-1");
	assert.equal(emittedPayloads.length, 1);
	assert.equal(emittedPayloads[0].upsertFrom, undefined, "初次无 dirty 必须为全量");

	// 2. 后续只标记尾部 dirty
	manager.markMessagesDirtyFrom("agent-1", 2);

	// 3. 再次 flush 仍应为全量
	reject = false;
	manager.flushMessageEmit("agent-1");
	assert.equal(emittedPayloads.length, 2);
	assert.equal(emittedPayloads[1].upsertFrom, undefined, "非 immediate 来源的全量失败也必须保留全量要求");
	assert.ok(emittedPayloads[1].messages.some((m) => m.id === "a-1"));
});

test("flush 成功后 dirty 清除：下次无新变更时为窗口化全量（upsertFrom 缺失）", () => {
	const payloads = [];
	const manager = createManager((channel, payload) => {
		if (channel === AGENTS_MESSAGE) payloads.push(payload);
	});
	seedMessages(manager, [assistantMsg("a-1", "done")]);

	manager.markMessagesDirtyFrom("agent-1", 1);
	manager.flushMessageEmit("agent-1");
	assert.equal(payloads.length, 1);
	assert.equal(payloads[0].upsertFrom, 1);

	// 无新 mark：dirty 已清，第二次 flush 走全量分支
	manager.flushMessageEmit("agent-1");
	assert.equal(payloads.length, 2);
	assert.equal(payloads[1].upsertFrom, undefined);
});

// 契约断言（防回归）：flushMessageEmit 不得在构建 payload 之前删除 dirty 下标；
// emit 的 skip 规则必须只针对 agents:message。
test("AgentManager flush/emit 契约：dirty 先快照后清除，emit 按通道跳过", () => {
	const source = readFileSync("src/main/pi/AgentManager.ts", "utf8");
	const flushStart = source.indexOf("private flushMessageEmit");
	assert.ok(flushStart >= 0, "flushMessageEmit 必须存在");
	const flushEnd = source.indexOf("private setStreamingAgent", flushStart);
	const body = source.slice(flushStart, flushEnd);
	const buildPos = body.indexOf("buildMessageFlushPayload");
	const deletePos = body.indexOf("messageDirtyFromByAgent.delete");
	assert.ok(buildPos >= 0, "flushMessageEmit 内必须构建 payload");
	assert.ok(deletePos < 0 || deletePos > buildPos, "dirty 下标不得在 buildMessageFlushPayload 之前删除");
	// 失败分支提前 return；后续成功处理仅在 accepted !== false 时执行
	assert.match(body, /if \(accepted === false\)/);
	// emit 的 renderer 跳过只针对 agents:message
	const emitStart = source.indexOf("private emit(channel: string");
	const emitEnd = source.indexOf("private emitLocalEvent", emitStart);
	const emitBody = source.slice(emitStart, emitEnd);
	assert.match(emitBody, /accepted === false && channel === ipcChannels\.agentsMessage/);
});
