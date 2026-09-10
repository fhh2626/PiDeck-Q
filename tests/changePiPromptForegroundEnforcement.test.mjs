import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	inspectNativeAsyncByDefault,
	rewriteUpstreamAsyncDefault,
	SUBAGENT_SCHEMA_ASYNC_SENTENCE,
} from "../resources/extensions/pideck-q-change-pi-prompt/config.ts";
import { registerPromptExtension } from "../resources/extensions/pideck-q-change-pi-prompt/runtime.ts";

test("inspectNativeAsyncByDefault enforces asyncByDefault:false and rejects forceTopLevelAsync:true", () => {
	const configPath = "dummy/config.json";

	// 1. 配置文件不存在
	const missing = inspectNativeAsyncByDefault(undefined, configPath);
	assert.equal(missing.ok, false);
	assert.equal(missing.asyncByDefault, undefined);
	assert.match(missing.message, /未找到/);

	// 2. asyncByDefault: false 且未设 forceTopLevelAsync -> 安全
	const safeDefault = inspectNativeAsyncByDefault(JSON.stringify({ asyncByDefault: false }), configPath);
	assert.equal(safeDefault.ok, true);
	assert.equal(safeDefault.asyncByDefault, false);
	assert.equal(safeDefault.forceTopLevelAsync, undefined);
	assert.match(safeDefault.message, /foreground-safe/);

	// 3. asyncByDefault: false 且 forceTopLevelAsync: false -> 安全
	const safeExplicit = inspectNativeAsyncByDefault(JSON.stringify({ asyncByDefault: false, forceTopLevelAsync: false }), configPath);
	assert.equal(safeExplicit.ok, true);
	assert.equal(safeExplicit.asyncByDefault, false);
	assert.equal(safeExplicit.forceTopLevelAsync, false);
	assert.match(safeExplicit.message, /forceTopLevelAsync=false/);

	// 4. asyncByDefault: false 但 forceTopLevelAsync: true -> 必须判定为 unsafe
	const unsafeForced = inspectNativeAsyncByDefault(JSON.stringify({ asyncByDefault: false, forceTopLevelAsync: true }), configPath);
	assert.equal(unsafeForced.ok, false);
	assert.equal(unsafeForced.asyncByDefault, false);
	assert.equal(unsafeForced.forceTopLevelAsync, true);
	assert.match(unsafeForced.message, /forceTopLevelAsync!=true/);

	// 5. asyncByDefault: true -> 判定为 unsafe
	const unsafeAsync = inspectNativeAsyncByDefault(JSON.stringify({ asyncByDefault: true }), configPath);
	assert.equal(unsafeAsync.ok, false);
	assert.equal(unsafeAsync.asyncByDefault, true);
	assert.match(unsafeAsync.message, /asyncByDefault=true/);

	// 6. 缺少 asyncByDefault (上游默认 true) -> 判定为 unsafe
	const missingAsync = inspectNativeAsyncByDefault(JSON.stringify({}), configPath);
	assert.equal(missingAsync.ok, false);
	assert.equal(missingAsync.asyncByDefault, undefined);
	assert.match(missingAsync.message, /asyncByDefault=false 且 forceTopLevelAsync!=true/);

	// 7. 类型错误断言
	assert.throws(() => inspectNativeAsyncByDefault("invalid json", configPath), /Invalid native subagent config JSON/);
	assert.throws(() => inspectNativeAsyncByDefault('"string"', configPath), /must be an object/);
	assert.throws(() => inspectNativeAsyncByDefault(JSON.stringify({ asyncByDefault: "no" }), configPath), /must be boolean/);
	assert.throws(() => inspectNativeAsyncByDefault(JSON.stringify({ asyncByDefault: false, forceTopLevelAsync: "yes" }), configPath), /must be boolean/);
});

test("rewriteUpstreamAsyncDefault rewrites subagent schema descriptions to foreground-only guidance", () => {
	// 1. subagent input.async 参数说明
	const schemaParam = "Run in background unless asyncByDefault:false. Set false only when the parent must block until completion.";
	const r1 = rewriteUpstreamAsyncDefault(schemaParam);
	assert.equal(r1.changed, true);
	assert.equal(r1.text, SUBAGENT_SCHEMA_ASYNC_SENTENCE);

	// 2. workflowScript 参数说明
	const workflowParam = "Inline JavaScript statement body with unknown resource provenance. Normally async unless asyncByDefault:false; set async:true for async workflows and async:false only when the parent must block. Use explicit return, top-level await, plain helper functions, or explicit Promise chains.";
	const r2 = rewriteUpstreamAsyncDefault(workflowParam);
	assert.equal(r2.changed, true);
	assert.ok(r2.text.includes(SUBAGENT_SCHEMA_ASYNC_SENTENCE));
	assert.ok(!r2.text.includes("Normally async"));

	// 3. 孤立的 Set false only when the parent must block
	const standalone = "Set false only when the parent must block until completion.";
	const r3 = rewriteUpstreamAsyncDefault(standalone);
	assert.equal(r3.changed, true);
	assert.equal(r3.text, SUBAGENT_SCHEMA_ASYNC_SENTENCE);

	// 4. 普通用户消息涉及 async:true 时不受影响
	const userMsg = "Can you explain why some tools take an async:true configuration parameter in TypeScript?";
	const r4 = rewriteUpstreamAsyncDefault(userMsg);
	assert.equal(r4.changed, false);
	assert.equal(r4.text, userMsg);
});

test("runtime tool_call handler locks async:false and fail-closes unsafe configs", async () => {
	const tempDir = mkdtempSync(join(tmpdir(), "pideck-prompt-toolcall-"));
	const subagentConfigDir = join(tempDir, "extensions", "subagent");
	mkdirSync(subagentConfigDir, { recursive: true });

	const writeSubagentConfig = (cfg) => {
		writeFileSync(join(subagentConfigDir, "config.json"), JSON.stringify(cfg, null, 2), "utf8");
	};

	try {
		const handlers = new Map();
		const tools = [
			{
				name: "subagent",
				description: "Official subagent",
				sourceInfo: { source: "npm:pi-subagents", path: "C:/node_modules/pi-subagents/index.js" },
			},
			{
				name: "custom_subagent",
				description: "Rogue subagent",
				sourceInfo: { source: "npm:other-subagents", path: "C:/node_modules/other/index.js" },
			},
			{
				name: "bash",
				description: "Bash tool",
				sourceInfo: { source: "builtin" },
			},
		];

		const mockPi = {
			on: (event, fn) => { handlers.set(event, fn); },
			getAllTools: () => tools,
			getActiveTools: () => ["subagent", "custom_subagent", "bash"],
			setActiveTools: () => {},
			registerCommand: () => {},
		};

		const probeHost = {
			hasCommand: () => true,
			hasPowerShell: () => true,
		};

		registerPromptExtension(mockPi, tempDir, probeHost);
		const toolCallHandler = handlers.get("tool_call");
		assert.ok(typeof toolCallHandler === "function", "tool_call handler must be registered");

		// ── 场景 A: 配置不安全 (缺少 asyncByDefault 或 asyncByDefault: true) ──
		writeSubagentConfig({ asyncByDefault: true });
		const unsafeCall = {
			toolName: "subagent",
			input: { agent: "worker", task: "do something", async: true },
		};
		const blocked = await toolCallHandler(unsafeCall);
		assert.ok(blocked && blocked.block === true, "Must block when subagent config is unsafe");
		assert.match(blocked.reason, /asyncByDefault=false 且 forceTopLevelAsync!=true/);

		// ── 场景 B: 配置不安全 (forceTopLevelAsync: true) ──
		writeSubagentConfig({ asyncByDefault: false, forceTopLevelAsync: true });
		const blockedForced = await toolCallHandler({
			toolName: "subagent",
			input: { agent: "worker", task: "do something" },
		});
		assert.ok(blockedForced && blockedForced.block === true, "Must block when forceTopLevelAsync is true");
		assert.match(blockedForced.reason, /forceTopLevelAsync!=true/);

		// ── 场景 C: 配置安全 (asyncByDefault: false, forceTopLevelAsync absent) ──
		writeSubagentConfig({ asyncByDefault: false });

		// C1: 模型传入 async: true -> 强制转为 async: false
		const inputWithAsyncTrue = { agent: "worker", task: "do something", async: true };
		const res1 = await toolCallHandler({ toolName: "subagent", input: inputWithAsyncTrue });
		assert.equal(res1, undefined, "Safe call must not be blocked");
		assert.equal(inputWithAsyncTrue.async, false, "Input async must be mutated to false");

		// C2: 模型未传 async -> 强制设为 async: false
		const inputWithoutAsync = { agent: "worker", task: "do something" };
		const res2 = await toolCallHandler({ toolName: "subagent", input: inputWithoutAsync });
		assert.equal(res2, undefined);
		assert.equal(inputWithoutAsync.async, false, "Omitted async must be set to false");

		// C3: 模型传入 workflowScript -> 强制设为 async: false
		const workflowInput = { workflowScript: "return await runs.run('a', { agent: 'worker', task: 'hi' });" };
		const res3 = await toolCallHandler({ toolName: "subagent", input: workflowInput });
		assert.equal(res3, undefined);
		assert.equal(workflowInput.async, false, "WorkflowScript call must have async: false");

		// ── 场景 D: 管理类 action 命令不拦截，不改 async ──
		const listActionInput = { action: "list", capabilities: true };
		const resList = await toolCallHandler({ toolName: "subagent", input: listActionInput });
		assert.equal(resList, undefined);
		assert.equal(listActionInput.async, undefined, "Management actions must not have async injected");

		// ── 场景 E: 非确认来源的第三方 subagent 工具不被拦截或修改 ──
		const thirdPartyInput = { agent: "worker", task: "do something", async: true };
		const resThirdParty = await toolCallHandler({ toolName: "custom_subagent", input: thirdPartyInput });
		assert.equal(resThirdParty, undefined);
		assert.equal(thirdPartyInput.async, true, "Unconfirmed subagent tool must not be modified");

		// ── 场景 F: bash 工具不被拦截 ──
		const bashInput = { command: "ls -la" };
		const resBash = await toolCallHandler({ toolName: "bash", input: bashInput });
		assert.equal(resBash, undefined);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});
