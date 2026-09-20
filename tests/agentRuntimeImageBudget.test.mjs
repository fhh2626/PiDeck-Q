import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const {
	computeTurnImageUsedBytes,
	applyRuntimeMessageImageBudget,
	enforceRuntimeImageEviction,
} = loadTsCommonJs("src/main/pi/runtimeImageBudget.ts");
const { AgentManager } = loadTsCommonJs("src/main/pi/AgentManager.ts");

const B64_1M = "A".repeat(1024 * 1024);
const B64_4M = "A".repeat(4 * 1024 * 1024);
const B64_5M = "A".repeat(5 * 1024 * 1024);

function createManager() {
	const manager = new AgentManager(
		() => ({ id: "project-1", name: "Project", path: "C:/project" }),
		() => null,
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

test("1. 单张恰好 4 MiB 保留，超过 4 MiB 被省略 (applyRuntimeMessageImageBudget)", () => {
	const res4M = applyRuntimeMessageImageBudget([{ type: "image", data: B64_4M, mimeType: "image/png" }], 0);
	assert.equal(res4M.images.length, 1);
	assert.equal(res4M.notice, undefined);

	const res5M = applyRuntimeMessageImageBudget([{ type: "image", data: B64_5M, mimeType: "image/png" }], 0);
	assert.equal(res5M.images.length, 0);
	assert.equal(res5M.notice?.kind, "too-large");
	assert.equal(res5M.notice?.omitted, 1);
});

test("2. 8 张保留，第 9 张被省略 (applyRuntimeMessageImageBudget)", () => {
	const smallImg = "A".repeat(1024);
	const imgs = Array.from({ length: 9 }, () => ({ type: "image", data: smallImg, mimeType: "image/png" }));
	const res = applyRuntimeMessageImageBudget(imgs, 0);
	assert.equal(res.images.length, 8);
	assert.equal(res.notice?.kind, "too-many");
	assert.equal(res.notice?.omitted, 1);
});

test("3 & 4. tool 与 assistant 在同一轮共享 8 MiB 预算（先后顺序互不影响）", () => {
	const manager = createManager();
	manager.messages.set("agent-1", [
		{ id: "u-1", agentId: "agent-1", role: "user", text: "draw two images", timestamp: 1 },
	]);

	// tool 先输出 4 MiB
	manager.upsertToolMessage("agent-1", {
		toolCallId: "call-1",
		toolName: "draw",
		status: "done",
		result: {
			content: [
				{ type: "text", text: "tool output" },
				{ type: "image", data: B64_4M, mimeType: "image/png" },
			],
		},
	});

	// assistant 后输出 5 MiB（单图超限）+ 4 MiB（累加达 8 MiB）+ 1 MiB（超 8 MiB 限额）
	manager.upsertAssistantMessage(
		"agent-1",
		{
			role: "assistant",
			content: [
				{ type: "text", text: "here you go" },
				{ type: "image", data: B64_4M, mimeType: "image/png" }, // 4M + 4M = 8M (OK)
				{ type: "image", data: B64_1M, mimeType: "image/png" }, // 8M + 1M = 9M (超 8M 预算)
			],
		},
	);

	const msgs = manager.messages.get("agent-1");
	const toolMsg = msgs.find((m) => m.role === "tool");
	const astMsg = msgs.find((m) => m.role === "assistant");

	assert.equal(toolMsg.images?.length, 1);
	assert.equal(astMsg.images?.length, 1);
	assert.equal(astMsg.images[0].data, B64_4M);
	assert.equal(astMsg.imageDisplayNotice?.kind, "too-many");
	assert.equal(astMsg.imageDisplayNotice?.omitted, 1);
});

test("5. 重复 partial/final 不重复扣减", () => {
	const manager = createManager();
	manager.messages.set("agent-1", [
		{ id: "u-1", agentId: "agent-1", role: "user", text: "hi", timestamp: 1 },
	]);

	// partial
	manager.upsertAssistantMessage(
		"agent-1",
		{
			role: "assistant",
			content: [
				{ type: "text", text: "drawing" },
				{ type: "image", data: B64_4M, mimeType: "image/png" },
			],
		},
	);

	// final 带相同图片（若重复扣减，4M + 4M = 8M，再加 1M 就会超限）
	manager.upsertAssistantMessage(
		"agent-1",
		{
			role: "assistant",
			content: [
				{ type: "text", text: "done" },
				{ type: "image", data: B64_4M, mimeType: "image/png" },
				{ type: "image", data: B64_1M, mimeType: "image/png" }, // 4M + 1M = 5M <= 8M
			],
			stopReason: "stop",
		},
	);

	const astMsg = manager.messages.get("agent-1").find((m) => m.role === "assistant");
	assert.equal(astMsg.images?.length, 2);
	assert.equal(astMsg.imageDisplayNotice, undefined);
});

test("6. text-only final 清除 partial 图片与提示", () => {
	const manager = createManager();
	manager.messages.set("agent-1", [
		{ id: "u-1", agentId: "agent-1", role: "user", text: "hi", timestamp: 1 },
	]);

	// partial 带图片
	manager.upsertAssistantMessage(
		"agent-1",
		{
			role: "assistant",
			content: [
				{ type: "text", text: "draft" },
				{ type: "image", data: B64_1M, mimeType: "image/png" },
			],
		},
	);
	assert.equal(manager.messages.get("agent-1")[1].images?.length, 1);

	// final 为纯文本快照
	manager.upsertAssistantMessage(
		"agent-1",
		{
			role: "assistant",
			content: [{ type: "text", text: "final text only" }],
			stopReason: "stop",
		},
	);

	const finalMsg = manager.messages.get("agent-1")[1];
	assert.equal(finalMsg.images, undefined);
	assert.equal(finalMsg.imageDisplayNotice, undefined);
	assert.equal(finalMsg.text, "final text only");
});

test("7. 无快照 delta 不清除已有图片", () => {
	const manager = createManager();
	manager.messages.set("agent-1", [
		{ id: "u-1", agentId: "agent-1", role: "user", text: "hi", timestamp: 1 },
	]);

	manager.upsertAssistantMessage(
		"agent-1",
		{
			role: "assistant",
			content: [
				{ type: "text", text: "start" },
				{ type: "image", data: B64_1M, mimeType: "image/png" },
			],
		},
	);

	// 仅传 fallbackDelta，没有 partialMessage content 快照
	manager.upsertAssistantMessage("agent-1", undefined, " more text");

	const msg = manager.messages.get("agent-1")[1];
	assert.equal(msg.images?.length, 1);
	assert.equal(msg.text, "start more text");
});

test("8 & 9. 新 user 开启新轮次，更新旧轮次消息不影响新轮次计算", () => {
	const manager = createManager();
	// Round 1
	manager.messages.set("agent-1", [
		{ id: "u-1", agentId: "agent-1", role: "user", text: "round 1", timestamp: 1 },
		{
			id: "a-1",
			agentId: "agent-1",
			role: "assistant",
			text: "r1 ans",
			images: [{ type: "image", data: B64_4M, mimeType: "image/png" }],
			timestamp: 2,
		},
		// Round 2
		{ id: "u-2", agentId: "agent-1", role: "user", text: "round 2", timestamp: 3 },
	]);

	// Round 2 输出 4 MiB 图片（Round 1 的 4 MiB 不应占用 Round 2 预算）
	manager.upsertAssistantMessage(
		"agent-1",
		{
			role: "assistant",
			content: [
				{ type: "text", text: "r2 ans" },
				{ type: "image", data: B64_4M, mimeType: "image/png" },
			],
		},
	);

	const a2 = manager.messages.get("agent-1").find((m) => m.text === "r2 ans");
	assert.equal(a2.images?.length, 1);
	assert.equal(a2.imageDisplayNotice, undefined);

	// 回头更新 Round 1 的 a-1，计算它的轮次占用应为 0（排除自身后，Round 1 无其他图片）
	const usedForA1 = computeTurnImageUsedBytes(manager.messages.get("agent-1"), "a-1");
	assert.equal(usedForA1, 0);
});

test("10. 两个 agent 的预算互不影响", () => {
	const manager = createManager();
	manager.messages.set("agent-1", [
		{ id: "u-1", agentId: "agent-1", role: "user", text: "hi", timestamp: 1 },
	]);
	manager.messages.set("agent-2", [
		{ id: "u-2", agentId: "agent-2", role: "user", text: "hi", timestamp: 1 },
	]);

	manager.upsertAssistantMessage(
		"agent-1",
		{
			role: "assistant",
			content: [{ type: "image", data: B64_4M, mimeType: "image/png" }],
		},
	);

	manager.upsertAssistantMessage(
		"agent-2",
		{
			role: "assistant",
			content: [{ type: "image", data: B64_4M, mimeType: "image/png" }],
		},
	);

	assert.equal(manager.messages.get("agent-1")[1].images?.length, 1);
	assert.equal(manager.messages.get("agent-2")[1].images?.length, 1);
});

test("11 & 12. assistant 与 tool 合计超 runtime 限额 (32 MiB) 时淘汰旧输出，不残留于 slide-out", () => {
	const slideOut = [
		{
			id: "old-tool",
			agentId: "agent-1",
			role: "tool",
			text: "tool old",
			images: [{ type: "image", data: B64_4M, mimeType: "image/png" }],
			timestamp: 1,
		},
	];

	// 构造 9 条 4 MiB 消息（总计 36 MiB），加上 slideOut(4M) 一共 40 MiB > 32 MiB
	const list = Array.from({ length: 9 }, (_, i) => ({
		id: `msg-${i}`,
		agentId: "agent-1",
		role: i % 2 === 0 ? "tool" : "assistant",
		text: `msg ${i}`,
		images: [{ type: "image", data: B64_4M, mimeType: "image/png" }],
		timestamp: 10 + i,
	}));

	// 40M - 4M (slideOut) = 36M > 32M; 36M - 4M (list[0]) = 32M <= 32M
	const dirtyIdx = enforceRuntimeImageEviction(list, slideOut, 32 * 1024 * 1024);

	// slideOut 的旧图片应被淘汰
	assert.equal(slideOut[0].images, undefined);
	assert.equal(slideOut[0].imageDisplayNotice?.kind, "runtime-budget-exceeded");

	// list 的第 0 条也应被淘汰
	assert.equal(list[0].images, undefined);
	assert.equal(list[0].imageDisplayNotice?.kind, "runtime-budget-exceeded");
	assert.equal(dirtyIdx, 0);

	// 其余消息图片仍保留
	assert.equal(list[1].images?.length, 1);
});
