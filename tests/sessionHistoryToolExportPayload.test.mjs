import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { SessionHistoryReader } = loadTsCommonJs("src/main/pi/SessionHistoryReader.ts");

test("步骤8测试: SessionHistoryReader.readToolExportPayload 正常读取完整未截断参数与结果", async () => {
	const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pideck-tool-payload-"));
	const sessionFile = path.join(tmpDir, "session.jsonl");

	const longArgs = JSON.stringify({ command: "git status --porcelain", cwd: "/very/long/nested/path/to/project" });
	const longResult = "M  src/renderer/src/components/session/timeline/imageExportModel.ts\n".repeat(50);

	const lines = [
		JSON.stringify({
			id: "entry-1",
			parentId: null,
			type: "message",
			message: {
				role: "user",
				content: [{ type: "text", text: "Run git status" }],
				timestamp: 1000,
			},
		}),
		JSON.stringify({
			id: "entry-2",
			parentId: "entry-1",
			type: "message",
			message: {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "call-git-1",
						name: "bash",
						arguments: { command: "git status --porcelain", cwd: "/very/long/nested/path/to/project" },
					},
				],
				timestamp: 1001,
			},
		}),
		JSON.stringify({
			id: "entry-3",
			parentId: "entry-2",
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: "call-git-1",
				toolName: "bash",
				content: [{ type: "text", text: longResult }],
				details: { exitCode: 0, durationMs: 42 },
				timestamp: 1002,
			},
		}),
	];

	await fs.writeFile(sessionFile, lines.join("\n"), "utf8");

	const reader = new SessionHistoryReader({
		toHostPath: (p) => p,
		translate: (k) => k,
		convertMessages: () => [],
	});

	// 1. 读取 entry-3 的完整工具载荷
	const payload = await reader.readToolExportPayload(sessionFile, "entry-3");
	assert.ok(payload, "载荷不可为空");
	assert.ok(payload.argsText?.includes("git status --porcelain"), "必须包含完整参数");
	assert.ok(payload.resultText?.includes("M  src/renderer/src/components/session/timeline/imageExportModel.ts"), "必须包含完整结果");
	assert.ok(payload.detailsText?.includes('"exitCode": 0'), "必须包含详情");

	// 2. 找不到的 messageId 返回 null
	const missing = await reader.readToolExportPayload(sessionFile, "entry-non-existent");
	assert.equal(missing, null, "不存在的消息返回 null");

	// 3. 空路径/空 ID 返回 null
	const empty = await reader.readToolExportPayload("", "");
	assert.equal(empty, null, "空路径返回 null");

	await fs.rm(tmpDir, { recursive: true, force: true });
});

test("步骤8测试(加强): 40条 assistant 消息后长分支多工具批量读取单次 I/O 与 AgentManager 检索验证", async () => {
	const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pideck-tool-payload-40-"));
	const sessionFile = path.join(tmpDir, "session.jsonl");

	const lines = [];
	lines.push(
		JSON.stringify({
			id: "entry-0",
			parentId: null,
			type: "message",
			message: {
				role: "user",
				content: [{ type: "text", text: "Start conversation" }],
				timestamp: 1000,
			},
		}),
	);

	// 添加一个早期工具
	lines.push(
		JSON.stringify({
			id: "entry-early-ast",
			parentId: "entry-0",
			type: "message",
			message: {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "call-early",
						name: "read",
						arguments: { path: "early.txt" },
					},
				],
				timestamp: 1001,
			},
		}),
	);
	lines.push(
		JSON.stringify({
			id: "entry-early-res",
			parentId: "entry-early-ast",
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: "call-early",
				toolName: "read",
				content: "EARLY_RESULT",
				timestamp: 1002,
			},
		}),
	);

	let lastId = "entry-early-res";
	// 插入 40 条普通的 assistant 消息（无 toolCall）
	for (let i = 1; i <= 40; i++) {
		const astId = `entry-ast-${i}`;
		lines.push(
			JSON.stringify({
				id: astId,
				parentId: lastId,
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: `Assistant thoughts #${i}` }],
					timestamp: 1002 + i,
				},
			}),
		);
		lastId = astId;
	}

	// 在末尾插入包含 toolCall 的 assistant 和 toolResult
	const lateAstId = "entry-late-ast";
	lines.push(
		JSON.stringify({
			id: lateAstId,
			parentId: lastId,
			type: "message",
			message: {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "call-late",
						name: "bash",
						arguments: { command: "npm test -- --reporter=spec", timeout: 60000 },
					},
				],
				timestamp: 2000,
			},
		}),
	);
	const lateResId = "entry-late-res";
	lines.push(
		JSON.stringify({
			id: lateResId,
			parentId: lateAstId,
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: "call-late",
				toolName: "bash",
				content: [{ type: "text", text: "LATE_RESULT: all tests passed" }],
				details: { exitCode: 0 },
				timestamp: 2001,
			},
		}),
	);

	await fs.writeFile(sessionFile, lines.join("\n"), "utf8");

	const reader = new SessionHistoryReader({
		toHostPath: (p) => p,
		translate: (k) => k,
		convertMessages: () => [],
	});

	// 1. 通过渲染层合成消息 ID 读取末尾工具，必须穿透前面的 40 条 assistant
	const latePayload = await reader.readToolExportPayload(sessionFile, `agent-1-history-${lateResId}`);
	assert.ok(latePayload, "末尾工具载荷必须存在");
	assert.ok(latePayload.argsText?.includes("npm test -- --reporter=spec"), "必须包含末尾工具参数");
	assert.ok(latePayload.resultText?.includes("LATE_RESULT"), "必须包含末尾工具执行结果");

	// 2. 批量读取：同时读取末尾工具与早期工具
	const batch = await reader.readToolExportPayloads(sessionFile, [
		`agent-1-history-${lateResId}`,
		"entry-early-res",
		"non-existent-entry",
	]);
	assert.equal(batch.size, 2, "只应返回存在的2条消息载荷");
	assert.ok(batch.get(`agent-1-history-${lateResId}`)?.resultText?.includes("LATE_RESULT"));
	assert.ok(batch.get("entry-early-res")?.resultText?.includes("EARLY_RESULT"));
	assert.ok(batch.get("entry-early-res")?.argsText?.includes("early.txt"));
	assert.equal(batch.get("non-existent-entry"), undefined);

	// 3. 源码级静态验证：readToolExportPayloads 内部 readIndexedSessionMessages 只能出现一次且不能在循环中
	const readerSrc = await fs.readFile("src/main/pi/SessionHistoryReader.ts", "utf8");
	const startIdx = readerSrc.indexOf("async readToolExportPayloads(");
	const endIdx = readerSrc.indexOf("async readToolExportPayload(", startIdx);
	assert.ok(startIdx > 0 && endIdx > startIdx, "必须找到 readToolExportPayloads 方法体");
	const methodBody = readerSrc.slice(startIdx, endIdx);
	const readCalls = methodBody.match(/readIndexedSessionMessages/g);
	assert.equal(readCalls?.length, 1, "readIndexedSessionMessages 在批量方法中必须且只能出现 1 次");
	// 验证在循环体内部不调用 readIndexedSessionMessages
	const linesInBody = methodBody.split("\n");
	let insideLoop = 0;
	let callInsideLoop = false;
	for (const line of linesInBody) {
		if (/\b(for|while)\s*\(/.test(line)) insideLoop++;
		if (insideLoop > 0 && line.includes("readIndexedSessionMessages")) {
			callInsideLoop = true;
		}
		if (line.includes("}") && insideLoop > 0) insideLoop--;
	}
	assert.equal(callInsideLoop, false, "禁止在 for 或 while 循环体内部调用 readIndexedSessionMessages");

	// 4. 源码级静态验证：AgentManager.ts 中从 readToolExportPayload 到 readSessionDisplayMessages 必须使用 deckSessionId，禁止 tab.sessionId === sessionId
	const agentMgrSrc = await fs.readFile("src/main/pi/AgentManager.ts", "utf8");
	const amStart = agentMgrSrc.indexOf("async readToolExportPayload(");
	const amEnd = agentMgrSrc.indexOf("async readSessionDisplayMessages(", amStart);
	assert.ok(amStart > 0 && amEnd > amStart, "必须找到 AgentManager 载荷读取方法体段");
	const amSegment = agentMgrSrc.slice(amStart, amEnd);
	assert.ok(amSegment.includes("deckSessionId === sessionId"), "必须使用 deckSessionId 进行匹配");
	assert.equal(amSegment.includes("tab.sessionId === sessionId"), false, "严禁使用 tab.sessionId === sessionId");

	await fs.rm(tmpDir, { recursive: true, force: true });
});
