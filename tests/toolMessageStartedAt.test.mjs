import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { AgentManager } = loadTsCommonJs("src/main/pi/AgentManager.ts");

/**
 * 工具卡运行秒表依赖的契约：`meta.startedAt` 在首次 tool_execution_start 后保持稳定，
 * 而 `ChatMessage.timestamp` 会在每次 tool_execution_update 被刷新为“最后更新时间”。
 *
 * 回归背景：渲染层曾用 `message.timestamp` 当秒表起点，powershell 流式输出与 subagent
 * 进度更新（高频 tool_execution_update）会让显示耗时反复归零。
 */
function createManager() {
	const manager = new AgentManager(
		() => ({ id: "project-1", name: "Project", path: "C:/project" }),
		() => null,
		{ get: () => ({}) },
		{},
	);
	manager.agents.set("agent-1", {
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
	});
	return manager;
}

function onlyToolMessage(manager) {
	const list = manager.messages.get("agent-1") ?? [];
	const tools = list.filter((message) => message.role === "tool");
	assert.equal(tools.length, 1, "一次工具调用只应产生一条工具消息");
	return tools[0];
}

test("tool_execution_update 复用同一工具消息并保留 meta.startedAt", async () => {
	const manager = createManager();
	const call = { toolName: "powershell", toolCallId: "ps-1", args: { command: "Get-ChildItem" } };

	manager.upsertToolMessage("agent-1", call, "running");
	const created = onlyToolMessage(manager);
	const startedAt = created.meta.startedAt;
	assert.equal(typeof startedAt, "number");
	assert.equal(created.meta.durationMs, undefined, "运行中不写 durationMs");

	// 模拟流式输出期间的高频进度更新（powershell / subagent 的 tool_execution_update）
	await new Promise((resolve) => setTimeout(resolve, 25));
	manager.upsertToolMessage("agent-1", { ...call, partialResult: "partial output" }, "running");
	const updated = onlyToolMessage(manager);
	assert.equal(updated.id, created.id, "进度更新不得新建工具消息");
	assert.equal(updated.meta.startedAt, startedAt, "startedAt 必须保持首次 start 时间");
	assert.ok(
		updated.timestamp > startedAt,
		"timestamp 是最后更新时间（因此不能作为秒表起点）",
	);

	// 终态耗时以 startedAt 结算，与运行中显示同源
	await new Promise((resolve) => setTimeout(resolve, 25));
	manager.upsertToolMessage("agent-1", call, "done");
	const done = onlyToolMessage(manager);
	assert.equal(done.meta.startedAt, startedAt);
	assert.ok(
		typeof done.meta.durationMs === "number" && done.meta.durationMs >= 25,
		"终态 durationMs 以 startedAt 为起点累计",
	);
});
