import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	ensureStandaloneSubagentConfig,
	ensureStandaloneSubagentForegroundSafe,
	inspectNativeAsyncByDefault,
	nativeSubagentConfigPath,
	rewriteUpstreamAsyncDefault,
	SUBAGENT_SCHEMA_ASYNC_SENTENCE,
	validateStandaloneWorkflowScript,
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

		registerPromptExtension(mockPi, tempDir, {
			probeHost,
			isStandalone: () => true,
		});
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

		// C3: 模型传入 workflowScript (显式 async: false) -> 强制设为 async: false
		const workflowInput = { workflowScript: "return await runs.run('a', { agent: 'worker', task: 'hi', async: false });" };
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

test("ensureStandaloneSubagentForegroundSafe auto-creates minimal foreground-safe config when absent and never overwrites existing config", async () => {
	const tempDir = mkdtempSync(join(tmpdir(), "pideck-ensure-config-"));
	const configPath = nativeSubagentConfigPath(tempDir);

	try {
		// 1. 配置文件不存在 -> 自动创建最小配置 (asyncByDefault=false, forceTopLevelAsync=false) -> ok=true
		assert.equal(existsSync(configPath), false);
		const created = await ensureStandaloneSubagentForegroundSafe(tempDir);
		assert.equal(created.ok, true);
		assert.equal(created.asyncByDefault, false);
		assert.equal(created.forceTopLevelAsync, false);
		assert.match(created.message, /created foreground-safe config/);
		assert.equal(existsSync(configPath), true);

		const parsed = JSON.parse(readFileSync(configPath, "utf8"));
		assert.deepEqual(parsed, {
			asyncByDefault: false,
			forceTopLevelAsync: false,
		});

		// ensureStandaloneSubagentConfig 别名函数行为一致
		const aliasCheck = await ensureStandaloneSubagentConfig(tempDir);
		assert.equal(aliasCheck.ok, true);

		// 2. 已有 asyncByDefault=false 且 forceTopLevelAsync 缺失 -> 允许，且不重写文件
		const customSafe = { asyncByDefault: false, customSetting: "preserved" };
		writeFileSync(configPath, JSON.stringify(customSafe), "utf8");
		const safeCheck = await ensureStandaloneSubagentForegroundSafe(tempDir);
		assert.equal(safeCheck.ok, true);
		assert.equal(safeCheck.asyncByDefault, false);
		assert.equal(safeCheck.forceTopLevelAsync, undefined);
		const rawAfterSafe = readFileSync(configPath, "utf8");
		assert.equal(rawAfterSafe, JSON.stringify(customSafe), "已存在文件绝不能被重写");

		// 3. 已有 asyncByDefault=true -> block 且文件原样不变
		const unsafeAsync = { asyncByDefault: true, userChoice: "do not overwrite" };
		writeFileSync(configPath, JSON.stringify(unsafeAsync), "utf8");
		const unsafeAsyncCheck = await ensureStandaloneSubagentForegroundSafe(tempDir);
		assert.equal(unsafeAsyncCheck.ok, false);
		assert.equal(unsafeAsyncCheck.asyncByDefault, true);
		assert.equal(readFileSync(configPath, "utf8"), JSON.stringify(unsafeAsync), "已有不安全文件不得被覆盖");

		// 4. 已有 forceTopLevelAsync=true -> block 且文件原样不变
		const unsafeForce = { asyncByDefault: false, forceTopLevelAsync: true };
		writeFileSync(configPath, JSON.stringify(unsafeForce), "utf8");
		const unsafeForceCheck = await ensureStandaloneSubagentForegroundSafe(tempDir);
		assert.equal(unsafeForceCheck.ok, false);
		assert.equal(unsafeForceCheck.forceTopLevelAsync, true);
		assert.equal(readFileSync(configPath, "utf8"), JSON.stringify(unsafeForce), "已有配置不得被覆盖");

		// 5. malformed JSON -> block 且不覆盖
		const malformed = "{ invalid json content ...";
		writeFileSync(configPath, malformed, "utf8");
		const malformedCheck = await ensureStandaloneSubagentForegroundSafe(tempDir);
		assert.equal(malformedCheck.ok, false);
		assert.match(malformedCheck.message, /配置检查失败|配置解析失败/);
		assert.equal(readFileSync(configPath, "utf8"), malformed, "畸形配置文件不得被覆盖");

		// 6. symlink config -> block 且不覆盖
		rmSync(configPath, { force: true });
		const realFile = join(tempDir, "real-config.json");
		writeFileSync(realFile, JSON.stringify({ asyncByDefault: false }), "utf8");
		try {
			symlinkSync(realFile, configPath);
			const symlinkCheck = await ensureStandaloneSubagentForegroundSafe(tempDir);
			assert.equal(symlinkCheck.ok, false);
			assert.match(symlinkCheck.message, /配置检查失败/);
		} catch (err) {
			if (err.code !== "EPERM") throw err;
		}
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

test("runtime handles missing config on first tool_call, non-standalone, and external runners", async () => {
	const tempDir = mkdtempSync(join(tmpdir(), "pideck-prompt-firstcall-"));
	const configPath = nativeSubagentConfigPath(tempDir);

	try {
		const handlers = new Map();
		const tools = [
			{
				name: "subagent",
				description: "Official subagent",
				sourceInfo: { source: "npm:pi-subagents", path: "C:/node_modules/pi-subagents/index.js" },
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
			getActiveTools: () => ["subagent", "bash"],
			setActiveTools: () => {},
			registerCommand: () => {},
		};

		const probeHost = {
			hasCommand: () => true,
			hasPowerShell: () => true,
		};

		let isStandalone = true;
		registerPromptExtension(mockPi, tempDir, {
			probeHost,
			isStandalone: () => isStandalone,
		});
		const toolCallHandler = handlers.get("tool_call");

		// 1. 初始状态：config.json 完全不存在
		assert.equal(existsSync(configPath), false);

		// 2. 首次 native tool_call -> 不 block，自动创建安全配置，且 input.async 被设为 false, foregroundOnly 为 true
		const nativeInput = { agent: "worker", task: "initial call" };
		const resFirst = await toolCallHandler({ toolName: "subagent", input: nativeInput });
		assert.equal(resFirst, undefined, "首次调用不应被阻断");
		assert.equal(nativeInput.async, false, "native subagent input.async 必须强制为 false");
		assert.equal(nativeInput.foregroundOnly, true, "native direct call 必须设置 foregroundOnly: true");
		assert.equal(existsSync(configPath), true, "应当自动创建 config.json");
		const createdJson = JSON.parse(readFileSync(configPath, "utf8"));
		assert.deepEqual(createdJson, {
			asyncByDefault: false,
			forceTopLevelAsync: false,
		});

		// 3. 非 standalone Pi 环境下：即使 config.json 不存在，也不应自动创建 config.json，不应强制 async: false
		rmSync(configPath, { force: true });
		assert.equal(existsSync(configPath), false);
		isStandalone = false;

		const nonStandaloneInput = { agent: "worker", task: "call in node pi", async: true };
		const resNonStandalone = await toolCallHandler({ toolName: "subagent", input: nonStandaloneInput });
		assert.equal(resNonStandalone, undefined);
		assert.equal(nonStandaloneInput.async, true, "非 standalone Pi 环境下不得篡改 async 为 false");
		assert.equal(existsSync(configPath), false, "非 standalone Pi 环境下不得自动创建 config.json");

		// 4. external-cli / external-job runner 不触发 native config.json 自动创建
		isStandalone = true;
		assert.equal(existsSync(configPath), false);

		// 模拟向 external-cli 类型的 subagent 调用（例如 codex-exec）
		const externalInput = { agent: "codex-exec", task: "external job", async: true };
		const resExternal = await toolCallHandler({ toolName: "subagent", input: externalInput });
		// standalone 下 external runner 无法在后台运行，会以明确 reason 阻断，但绝不应触发 native config.json 创建
		assert.ok(resExternal && resExternal.block === true);
		assert.match(resExternal.reason, /external runner/);
		assert.equal(existsSync(configPath), false, "external runner 不应触发 native subagent config.json 创建");
		assert.equal(externalInput.foregroundOnly, undefined, "external runner 绝不能被注入 foregroundOnly: true");

		// 5. direct unknown agent: standalone 下必须被 fail-closed 阻断
		const unknownInput = { agent: "custom-unknown-agent", task: "unknown task" };
		const resUnknown = await toolCallHandler({ toolName: "subagent", input: unknownInput });
		assert.ok(resUnknown && resUnknown.block === true);
		assert.match(resUnknown.reason, /无法确认 Agent "custom-unknown-agent" 的 runner 类型/);

		// 6. workflowScriptPath: standalone 下必须被阻断，且 input.async 与 input.foregroundOnly 未被篡改
		const scriptPathInput = { workflowScriptPath: "./workflow.js" };
		const resPath = await toolCallHandler({ toolName: "subagent", input: scriptPathInput });
		assert.ok(resPath && resPath.block === true);
		assert.match(resPath.reason, /standalone Pi 环境暂不支持 workflowScriptPath/);
		assert.equal(scriptPathInput.async, undefined);
		assert.equal(scriptPathInput.foregroundOnly, undefined);

		// 7. workflowScriptPath: 非 standalone 下放行
		isStandalone = false;
		const resPathNonStandalone = await toolCallHandler({ toolName: "subagent", input: scriptPathInput });
		assert.equal(resPathNonStandalone, undefined);
		isStandalone = true;

		// 8. named workflow resource: standalone 下必须被阻断，且 input.async 与 input.foregroundOnly 未被篡改
		const namedWorkflowInput = { workflow: "review-workflow", args: {} };
		const resNamed = await toolCallHandler({ toolName: "subagent", input: namedWorkflowInput });
		assert.ok(resNamed && resNamed.block === true);
		assert.match(resNamed.reason, /standalone Pi 环境暂不支持 named workflow resource/);
		assert.equal(namedWorkflowInput.async, undefined);
		assert.equal(namedWorkflowInput.foregroundOnly, undefined);

		// 9. named workflow resource: 非 standalone 下放行
		isStandalone = false;
		const resNamedNonStandalone = await toolCallHandler({ toolName: "subagent", input: namedWorkflowInput });
		assert.equal(resNamedNonStandalone, undefined);
		isStandalone = true;
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

test("ensureStandaloneSubagentForegroundSafe handles write race conditions gracefully", async () => {
	const tempDir = mkdtempSync(join(tmpdir(), "pideck-race-config-"));
	const configPath = nativeSubagentConfigPath(tempDir);

	try {
		// 并发调用 ensureStandaloneSubagentForegroundSafe，两者均应成功且不冲突
		assert.equal(existsSync(configPath), false);
		const [res1, res2] = await Promise.all([
			ensureStandaloneSubagentForegroundSafe(tempDir),
			ensureStandaloneSubagentForegroundSafe(tempDir),
		]);

		assert.equal(res1.ok, true);
		assert.equal(res2.ok, true);
		assert.equal(existsSync(configPath), true);
		const content = JSON.parse(readFileSync(configPath, "utf8"));
		assert.equal(content.asyncByDefault, false);
		assert.equal(content.forceTopLevelAsync, false);

		// 如果竞态写入由外部进程先写入了不安全的配置（如 asyncByDefault: true）
		// ensureStandaloneSubagentForegroundSafe 重新 inspect 时必须判定为 unsafe 并返回 ok=false
		const tempDir2 = mkdtempSync(join(tmpdir(), "pideck-race-unsafe-"));
		const configPath2 = nativeSubagentConfigPath(tempDir2);
		mkdirSync(join(tempDir2, "extensions", "subagent"), { recursive: true });
		writeFileSync(configPath2, JSON.stringify({ asyncByDefault: true }), "utf8");

		const resUnsafe = await ensureStandaloneSubagentForegroundSafe(tempDir2);
		assert.equal(resUnsafe.ok, false);
		assert.equal(resUnsafe.asyncByDefault, true);
		rmSync(tempDir2, { recursive: true, force: true });
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

test("standalone Pi workflowScript and direct subagent enforce foreground-only and lock down in-memory asyncByDefault drift", async () => {
	const tempDir = mkdtempSync(join(tmpdir(), "pideck-captured-async-"));
	const configPath = nativeSubagentConfigPath(tempDir);

	try {
		const handlers = new Map();
		const tools = [
			{
				name: "subagent",
				description: "Official subagent",
				sourceInfo: { source: "npm:pi-subagents", path: "C:/node_modules/pi-subagents/index.js" },
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
			getActiveTools: () => ["subagent", "bash"],
			setActiveTools: () => {},
			registerCommand: () => {},
		};

		const probeHost = {
			hasCommand: () => true,
			hasPowerShell: () => true,
		};

		registerPromptExtension(mockPi, tempDir, {
			probeHost,
			isStandalone: () => true,
		});
		const toolCallHandler = handlers.get("tool_call");

		// 模拟上游 pi-subagents 启动时 config.json 尚不存在（内存中 captured asyncByDefault = true）
		assert.equal(existsSync(configPath), false);

		// 1. Direct native call：
		// 自动创建 config.json，且输入参数最终必须被硬锁为 async=false 且 foregroundOnly=true
		const directCall = { agent: "worker", task: "fix something" };
		const resDirect = await toolCallHandler({ toolName: "subagent", input: directCall });
		assert.equal(resDirect, undefined);
		assert.equal(directCall.async, false);
		assert.equal(directCall.foregroundOnly, true, "native direct call 必须设置 foregroundOnly: true 以免疫上游 forceTopLevelAsync");
		assert.equal(existsSync(configPath), true, "磁盘上自动补齐了 config.json");

		// 2. workflowScript 内 native child 省略 async：
		// 因为此时当前进程内存中上游默认仍为 asyncByDefault=true，必须 block，提示必须显式 async:false
		const omitWorkflow = {
			workflowScript: `return await runs.run('step1', { agent: 'worker', task: 'compile' });`,
		};
		const resOmit = await toolCallHandler({ toolName: "subagent", input: omitWorkflow });
		assert.ok(resOmit && resOmit.block === true);
		assert.match(resOmit.reason, /必须显式声明 async:false/);

		// 3. workflowScript 内 native child 显式声明 async: true：
		// 必须 block
		const trueWorkflow = {
			workflowScript: `return await runs.run('step1', { agent: 'worker', task: 'compile', async: true });`,
		};
		const resTrue = await toolCallHandler({ toolName: "subagent", input: trueWorkflow });
		assert.ok(resTrue && resTrue.block === true);
		assert.match(resTrue.reason, /不支持在 workflowScript 内部调用中使用 async:true/);

		// 4. workflowScript 内 native child 显式声明 async: false：
		// 必须放行，且顶层 workflowScript 也被设为 async: false + foregroundOnly: true
		const safeWorkflow = {
			workflowScript: `return await runs.run('step1', { agent: 'worker', task: 'compile', async: false });`,
		};
		const resSafe = await toolCallHandler({ toolName: "subagent", input: safeWorkflow });
		assert.equal(resSafe, undefined);
		assert.equal(safeWorkflow.async, false);
		assert.equal(safeWorkflow.foregroundOnly, true, "workflowScript 顶层调用也必须被注入 foregroundOnly: true");

		// 5. runs.all 包含省略 async 的 native child：
		// 必须 block
		const omitAllWorkflow = {
			workflowScript: `return await runs.all([
				{ key: 'a', agent: 'worker', task: 't1', async: false },
				{ key: 'b', agent: 'worker', task: 't2' }
			]);`,
		};
		const resAllOmit = await toolCallHandler({ toolName: "subagent", input: omitAllWorkflow });
		assert.ok(resAllOmit && resAllOmit.block === true);
		assert.match(resAllOmit.reason, /必须显式声明 async:false/);

		// 6. runs.all 全部显式声明 async: false：
		// 必须放行
		const safeAllWorkflow = {
			workflowScript: `return await runs.all([
				{ key: 'a', agent: 'worker', task: 't1', async: false },
				{ key: 'b', agent: 'worker', task: 't2', async: false }
			]);`,
		};
		const resAllSafe = await toolCallHandler({ toolName: "subagent", input: safeAllWorkflow });
		assert.equal(resAllSafe, undefined);
		assert.equal(safeAllWorkflow.async, false);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

test("validateStandaloneWorkflowScript parses AST and enforces bounded async rules", () => {
	const fakeCatalog = {
		packageRoot: "/dummy",
		agents: new Map([
			["worker", { name: "worker", aliases: [], runnerType: "native", tools: ["read", "write"], filePath: "/dummy/worker.md" }],
			["codex-exec", { name: "codex-exec", aliases: [], runnerType: "external-cli", tools: [], filePath: "/dummy/codex.md" }],
		]),
	};

	// 1. 无子调用的普通 JS 脚本 -> 允许
	const r1 = validateStandaloneWorkflowScript("return 1 + 2;", fakeCatalog);
	assert.equal(r1.ok, true);

	// 2. 语法错误脚本 -> 失败闭合
	const r2 = validateStandaloneWorkflowScript("return await (;", fakeCatalog);
	assert.equal(r2.ok, false);
	assert.match(r2.reason, /语法校验失败/);

	// 3. runs.run 显式 async: false -> 允许
	const r3 = validateStandaloneWorkflowScript("return await runs.run('a', { agent: 'worker', async: false });", fakeCatalog);
	assert.equal(r3.ok, true);

	// 4. runs.run 省略 async -> 阻断
	const r4 = validateStandaloneWorkflowScript("return await runs.run('a', { agent: 'worker' });", fakeCatalog);
	assert.equal(r4.ok, false);
	assert.match(r4.reason, /必须显式声明 async:false/);

	// 5. runs.run 显式 async: true -> 阻断
	const r5 = validateStandaloneWorkflowScript("return await runs.run('a', { agent: 'worker', async: true });", fakeCatalog);
	assert.equal(r5.ok, false);
	assert.match(r5.reason, /不支持在 workflowScript 内部调用中使用 async:true/);

	// 6. 字符串或注释内出现 async: true，但代码 AST 中没有 async: true 属性
	const r6 = validateStandaloneWorkflowScript(`
		// Comment mentioning async: true
		const note = "Don't use async: true";
		return await runs.run('a', { agent: 'worker', async: false });
	`, fakeCatalog);
	assert.equal(r6.ok, true);

	// 7. runs.lanes 带有 agent 启动的 stage 显式 async: false -> 允许
	const r7 = validateStandaloneWorkflowScript(`
		return await runs.lanes([{
			key: 'l1',
			stages: [
				{ key: 's1', agent: 'worker', task: 't1', async: false },
				{ key: 's2', resume: 'previous', task: 't2' }
			]
		}]);
	`, fakeCatalog);
	assert.equal(r7.ok, true);

	// 8. runs.lanes 带有 agent 启动的 stage 省略 async -> 阻断
	const r8 = validateStandaloneWorkflowScript(`
		return await runs.lanes([{
			key: 'l1',
			stages: [
				{ key: 's1', agent: 'worker', task: 't1' }
			]
		}]);
	`, fakeCatalog);
	assert.equal(r8.ok, false);
	assert.match(r8.reason, /必须显式声明 async:false/);

	// 9. runs.run 尝试启动 external-cli runner -> 在 standalone 下被阻断
	const r9 = validateStandaloneWorkflowScript("return await runs.run('a', { agent: 'codex-exec', async: false });", fakeCatalog);
	assert.equal(r9.ok, false);
	assert.match(r9.reason, /external runner/);

	// 10. runs.run 使用 SpreadElement -> fail-closed 阻断
	const r10 = validateStandaloneWorkflowScript(`
		const opts = { task: 'test' };
		return await runs.run('a', { agent: 'worker', async: false, ...opts });
	`, fakeCatalog);
	assert.equal(r10.ok, false);
	assert.match(r10.reason, /SpreadElement/);

	// 11. runs.all 项中使用 SpreadElement -> fail-closed 阻断
	const r11 = validateStandaloneWorkflowScript(`
		const extra = { task: 't' };
		return await runs.all([{ key: 'a', agent: 'worker', async: false, ...extra }]);
	`, fakeCatalog);
	assert.equal(r11.ok, false);
	assert.match(r11.reason, /SpreadElement/);

	// 12. runs.lanes stages 动态变量而非字面量 -> fail-closed 阻断
	const r12 = validateStandaloneWorkflowScript(`
		const stage = makeStage();
		return await runs.lanes([{ key: 'l', stages: [stage] }]);
	`, fakeCatalog);
	assert.equal(r12.ok, false);
	assert.match(r12.reason, /stage 必须为对象字面量/);

	// 13. runs.lanes stages 中使用 SpreadElement -> fail-closed 阻断
	const r13 = validateStandaloneWorkflowScript(`
		const extra = { task: 't' };
		return await runs.lanes([{ key: 'l', stages: [{ key: 's1', agent: 'worker', async: false, ...extra }] }]);
	`, fakeCatalog);
	assert.equal(r13.ok, false);
	assert.match(r13.reason, /SpreadElement/);

	// 14. 无关变量包含 { async: true } -> 不误杀，只要 runs.run 子代理显式声明 async: false 即放行
	const r14 = validateStandaloneWorkflowScript(`
		const metadata = { async: true };
		return await runs.run('a', { agent: 'worker', async: false });
	`, fakeCatalog);
	assert.equal(r14.ok, true, "无关对象的 async: true 不得误杀合法的 runs.run 调用");

	// 15. duplicate keys -> fail-closed 阻断
	const r15a = validateStandaloneWorkflowScript(`
		return await runs.run('a', { agent: 'worker', async: false, async: false });
	`, fakeCatalog);
	assert.equal(r15a.ok, false);
	assert.match(r15a.reason, /重复静态键 "async"/);

	const r15b = validateStandaloneWorkflowScript(`
		return await runs.run('a', { agent: 'worker', async: false, async: true });
	`, fakeCatalog);
	assert.equal(r15b.ok, false);
	assert.match(r15b.reason, /重复静态键 "async"/);

	// 16. computed property 字符串字面量 -> fail-closed 阻断
	const r16 = validateStandaloneWorkflowScript(`
		return await runs.run('a', { agent: 'worker', ["async"]: true });
	`, fakeCatalog);
	assert.equal(r16.ok, false);
	assert.match(r16.reason, /计算属性/);

	// 17. computed property 变量 -> fail-closed 阻断
	const r17 = validateStandaloneWorkflowScript(`
		const k = 'async';
		return await runs.run('a', { agent: 'worker', async: false, [k]: true });
	`, fakeCatalog);
	assert.equal(r17.ok, false);
	assert.match(r17.reason, /计算属性/);

	// 18. alias runs.run -> fail-closed 阻断
	const r18 = validateStandaloneWorkflowScript(`
		const launch = runs.run;
		return await launch('a', { agent: 'worker', async: false });
	`, fakeCatalog);
	assert.equal(r18.ok, false);
	assert.match(r18.reason, /runs\.run 必须直接调用/);

	// 19. destructuring runs -> fail-closed 阻断
	const r19 = validateStandaloneWorkflowScript(`
		const { run } = runs;
		return await run('a', { agent: 'worker', async: false });
	`, fakeCatalog);
	assert.equal(r19.ok, false);
	assert.match(r19.reason, /runs 只能用于直接方法调用/);

	// 20. runs.run.call -> fail-closed 阻断
	const r20 = validateStandaloneWorkflowScript(`
		return await runs.run.call(null, 'a', { agent: 'worker', async: false });
	`, fakeCatalog);
	assert.equal(r20.ok, false);
	assert.match(r20.reason, /runs\.run 必须直接调用/);

	// 21. Reflect.apply(runs.run, ...) -> fail-closed 阻断
	const r21 = validateStandaloneWorkflowScript(`
		return await Reflect.apply(runs.run, null, ['a', { agent: 'worker', async: false }]);
	`, fakeCatalog);
	assert.equal(r21.ok, false);
	assert.match(r21.reason, /runs\.run 必须直接调用/);

	// 22. computed callee runs["run"] -> fail-closed 阻断
	const r22 = validateStandaloneWorkflowScript(`
		return await runs['run']('a', { agent: 'worker', async: false });
	`, fakeCatalog);
	assert.equal(r22.ok, false);
	assert.match(r22.reason, /runs 只能用于直接方法调用/);

	// 23. dynamic agent name -> fail-closed 阻断
	const r23 = validateStandaloneWorkflowScript(`
		const target = 'worker';
		return await runs.run('a', { agent: target, async: false });
	`, fakeCatalog);
	assert.equal(r23.ok, false);
	assert.match(r23.reason, /agent 必须为静态字符串/);

	// 24. agent not in catalog -> fail-closed 阻断
	const r24 = validateStandaloneWorkflowScript(`
		return await runs.run('a', { agent: 'not-in-catalog', async: false });
	`, fakeCatalog);
	assert.equal(r24.ok, false);
	assert.match(r24.reason, /不在 catalog 中/);

	// 25. globalThis.runs / this.runs bypass -> fail-closed 阻断
	const r25a = validateStandaloneWorkflowScript(`
		return await globalThis.runs.run('a', { agent: 'worker', async: false });
	`, fakeCatalog);
	assert.equal(r25a.ok, false);
	assert.match(r25a.reason, /禁止通过 globalThis\/this 间接访问 runs/);

	const r25b = validateStandaloneWorkflowScript(`
		return await globalThis['runs'].run('a', { agent: 'worker', async: false });
	`, fakeCatalog);
	assert.equal(r25b.ok, false);
	assert.match(r25b.reason, /禁止通过 globalThis\/this 间接访问 runs/);

	const r25c = validateStandaloneWorkflowScript(`
		return await this.runs.run('a', { agent: 'worker', async: false });
	`, fakeCatalog);
	assert.equal(r25c.ok, false);
	assert.match(r25c.reason, /禁止通过 globalThis\/this 间接访问 runs/);

	const r25d = validateStandaloneWorkflowScript(`
		return await this['runs'].run('a', { agent: 'worker', async: false });
	`, fakeCatalog);
	assert.equal(r25d.ok, false);
	assert.match(r25d.reason, /禁止通过 globalThis\/this 间接访问 runs/);

	// 26. safe runs methods directly called -> 放行
	const r26a = validateStandaloneWorkflowScript("return await runs.status('abc');", fakeCatalog);
	assert.equal(r26a.ok, true);

	const r26b = validateStandaloneWorkflowScript("return runs.ref(result);", fakeCatalog);
	assert.equal(r26b.ok, true);

	const r26c = validateStandaloneWorkflowScript("return runs.refs(results);", fakeCatalog);
	assert.equal(r26c.ok, true);

	const r26d = validateStandaloneWorkflowScript("return await runs.steer('worker', 'continue');", fakeCatalog);
	assert.equal(r26d.ok, true);

	// 27. alias safe runs methods -> fail-closed 阻断
	const r27a = validateStandaloneWorkflowScript(`
		const status = runs.status;
		return status('abc');
	`, fakeCatalog);
	assert.equal(r27a.ok, false);
	assert.match(r27a.reason, /runs\.status 必须直接调用/);

	const r27b = validateStandaloneWorkflowScript(`
		const { steer } = runs;
		return steer('worker', 'msg');
	`, fakeCatalog);
	assert.equal(r27b.ok, false);
	assert.match(r27b.reason, /runs 只能用于直接方法调用/);

	const r27c = validateStandaloneWorkflowScript(`
		return await runs.status.call(null, 'abc');
	`, fakeCatalog);
	assert.equal(r27c.ok, false);
	assert.match(r27c.reason, /runs\.status 必须直接调用/);

	const r27d = validateStandaloneWorkflowScript(`
		return await Reflect.apply(runs.status, null, ['abc']);
	`, fakeCatalog);
	assert.equal(r27d.ok, false);
	assert.match(r27d.reason, /runs\.status 必须直接调用/);
});
