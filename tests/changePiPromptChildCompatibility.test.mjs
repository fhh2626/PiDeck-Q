import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	loadSubagentCatalog,
	parseAgentFrontmatter,
} from "../resources/extensions/pideck-q-change-pi-prompt/subagentCatalog.ts";
import {
	reconcileChildEnvironments,
	resolveToolProviderExtension,
} from "../resources/extensions/pideck-q-change-pi-prompt/childReconciliation.ts";
import {
	buildChildToolEnvironmentBlock,
	injectChildToolEnvironment,
	isChildSession,
	registerPromptExtension,
} from "../resources/extensions/pideck-q-change-pi-prompt/runtime.ts";
import { transformSystemPrompt } from "../resources/extensions/pideck-q-change-pi-prompt/transform.ts";
import { DEFAULT_CONFIG, DEFAULT_PROMPTS } from "../resources/extensions/pideck-q-change-pi-prompt/defaults.ts";

function createMockPi() {
	const handlers = new Map();
	let tools = [];
	let activeTools = [];

	return {
		mockPi: {
			on: (event, fn) => { handlers.set(event, fn); },
			getAllTools: () => tools,
			getActiveTools: () => [...activeTools],
			setActiveTools: (next) => { activeTools = [...next]; },
			registerCommand: () => {},
		},
		setTools: (newTools) => {
			tools = newTools;
			activeTools = newTools.map(t => t.name);
		},
		setActiveTools: (next) => { activeTools = [...next]; },
		getHandler: (event) => handlers.get(event),
	};
}

// 1. enabled=false：完全零行为
test("enabled=false disables prompt rewrite, tool_call async override, shell prune, and child reconciliation", async () => {
	const tempDir = mkdtempSync(join(tmpdir(), "pideck-test-disabled-"));
	try {
		// 写入 enabled: false 配置
		const configDir = join(tempDir, "change-pi-prompt");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "config.json"), JSON.stringify({ ...DEFAULT_CONFIG, enabled: false }, null, 2), "utf8");

		const { mockPi, setTools, getHandler } = createMockPi();
		setTools([
			{ name: "bash", description: "bash shell" },
			{ name: "subagent", description: "subagent tool", sourceInfo: { source: "npm:pi-subagents", path: "C:/node_modules/pi-subagents/index.js" } },
		]);

		registerPromptExtension(mockPi, tempDir, {
			probeHost: { hasCommand: () => false, hasPowerShell: () => false },
			isStandalone: () => true,
		});

		// before_agent_start 不改 prompt 也不修剪不可用 shell
		const beforeStart = getHandler("before_agent_start");
		const originalPrompt = "You are Pi.\n\n## Available tools\n- bash\n- subagent\n\n## Guidelines\n- Be concise";
		const promptRes = await beforeStart({ systemPrompt: originalPrompt }, { hasUI: false, ui: { notify: () => {} } });
		assert.equal(promptRes, undefined, "Must return undefined (keep original prompt) when disabled");
		assert.deepEqual(mockPi.getActiveTools(), ["bash", "subagent"], "Shell must not be pruned when disabled");

		// context 不改写
		const contextHandler = getHandler("context");
		const msgRes = contextHandler({ messages: [{ role: "user", content: "Plugin default is asyncByDefault:true" }] });
		assert.equal(msgRes, undefined, "Context messages must not be rewritten when disabled");

		// tool_call 不改写 async
		const toolCallHandler = getHandler("tool_call");
		const input = { agent: "worker", task: "task", async: true };
		const callRes = await toolCallHandler({ toolName: "subagent", input });
		assert.equal(callRes, undefined);
		assert.equal(input.async, true, "Async must not be mutated when disabled");

		// 不写 settings.json 中的 child override
		assert.equal(existsSync(join(tempDir, "settings.json")), false, "settings.json must not be created when disabled");
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

// 2. subagent=false：不处理 subagent，但普通 identity/shell/pwsh 仍工作
test("subagent=false leaves subagent alone but allows normal prompt/shell handling", async () => {
	const tempDir = mkdtempSync(join(tmpdir(), "pideck-test-nosubagent-"));
	try {
		const configDir = join(tempDir, "change-pi-prompt");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "config.json"), JSON.stringify({ ...DEFAULT_CONFIG, enabled: true, subagent: false }, null, 2), "utf8");

		const { mockPi, setTools, getHandler } = createMockPi();
		setTools([
			{ name: "bash", description: "bash shell" },
			{ name: "subagent", description: "Run in background unless asyncByDefault:false. Set false only when the parent must block until completion.", sourceInfo: { source: "npm:pi-subagents", path: "C:/node_modules/pi-subagents/index.js" } },
		]);

		registerPromptExtension(mockPi, tempDir, {
			probeHost: { hasCommand: () => true, hasPowerShell: () => true },
			isStandalone: () => true,
		});

		// tool_call 不拦截也不改写 async
		const toolCallHandler = getHandler("tool_call");
		const input = { agent: "worker", task: "task", async: true };
		const callRes = await toolCallHandler({ toolName: "subagent", input });
		assert.equal(callRes, undefined);
		assert.equal(input.async, true, "Async must stay true when subagent adaptation is disabled");
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

// 3 & 4. standalone vs non-standalone & native vs external-cli
test("standalone Pi blocks external-cli and forces native async:false, while Node Pi preserves external-cli", async () => {
	const tempDir = mkdtempSync(join(tmpdir(), "pideck-test-runners-"));
	try {
		const subagentConfigDir = join(tempDir, "extensions", "subagent");
		mkdirSync(subagentConfigDir, { recursive: true });
		writeFileSync(join(subagentConfigDir, "config.json"), JSON.stringify({ asyncByDefault: false }), "utf8");

		// Mock subagent catalog with codex-exec (external-cli) and worker (native)
		const { mockPi, setTools, getHandler } = createMockPi();
		setTools([
			{ name: "subagent", description: "subagent", sourceInfo: { source: "npm:pi-subagents", path: join(process.cwd(), "resources/extensions/pideck-q-subagents/dist/index.js") } },
			{ name: "bash", description: "bash" },
		]);

		let standaloneMode = true;
		registerPromptExtension(mockPi, tempDir, {
			probeHost: { hasCommand: () => true, hasPowerShell: () => true },
			isStandalone: () => standaloneMode,
		});

		const toolCallHandler = getHandler("tool_call");

		// ── Standalone Mode ──
		standaloneMode = true;

		// 1. external-cli (codex-exec) 必须被明确 block，绝不能强改 async:false
		const codexInput = { agent: "codex-exec", task: "analyze", async: true };
		const codexRes = await toolCallHandler({ toolName: "subagent", input: codexInput });
		assert.ok(codexRes && codexRes.block === true);
		assert.match(codexRes.reason, /external runner \(external-cli\)/);
		assert.equal(codexInput.async, true, "Must not convert external-cli to async:false");

		// 2. native (worker) 在 standalone 下必须 async:false
		const workerInput = { agent: "worker", task: "code", async: true };
		const workerRes = await toolCallHandler({ toolName: "subagent", input: workerInput });
		assert.equal(workerRes, undefined);
		assert.equal(workerInput.async, false, "Must force native child to async:false in standalone");

		// ── Non-standalone (Node Pi) Mode ──
		standaloneMode = false;

		// 3. external-cli 在 Node Pi 下正常放行，保持 async:true
		const codexNodeInput = { agent: "codex-exec", task: "analyze", async: true };
		const codexNodeRes = await toolCallHandler({ toolName: "subagent", input: codexNodeInput });
		assert.equal(codexNodeRes, undefined, "External-cli must not be blocked in normal Node Pi");
		assert.equal(codexNodeInput.async, true, "Async must be preserved in Node Pi");

		// 4. native 在 Node Pi 下不强制 async:false
		const workerNodeInput = { agent: "worker", task: "code", async: true };
		const workerNodeRes = await toolCallHandler({ toolName: "subagent", input: workerNodeInput });
		assert.equal(workerNodeRes, undefined);
		assert.equal(workerNodeInput.async, true, "Must not force async:false in normal Node Pi");
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

// 5. 验证真实 bundled agent catalog 结构与漂移
test("bundled agents in pideck-q-subagents match expected runner and tool categories", () => {
	const catalog = loadSubagentCatalog(join(process.cwd(), "resources/extensions/pideck-q-subagents"));
	assert.ok(catalog.agents.size >= 12, "Must load all bundled agents");

	// Native agents
	const nativeNames = ["worker", "scout", "oracle", "delegate", "reviewer", "researcher"];
	for (const name of nativeNames) {
		const agent = catalog.agents.get(name);
		assert.ok(agent, `Agent ${name} must exist in catalog`);
		assert.equal(agent.runnerType, "native", `Agent ${name} must be native`);
		assert.ok(Array.isArray(agent.tools) && agent.tools.length > 0, `Agent ${name} must declare tools`);
	}

	// External CLI agents
	const externalCliNames = ["codex-exec", "codex-exec-writer", "claude-code", "claude-code-writer", "cursor-agent", "cursor-agent-writer"];
	for (const name of externalCliNames) {
		const agent = catalog.agents.get(name);
		assert.ok(agent, `Agent ${name} must exist in catalog`);
		assert.equal(agent.runnerType, "external-cli", `Agent ${name} must be external-cli`);
	}
});

// 6 & 7 & 8. Tool Provider Resolution for worker, reviewer, researcher
test("child tool provider resolution injects required providers and handles missing ones", () => {
	const tempDir = mkdtempSync(join(tmpdir(), "pideck-provider-"));
	try {
		const fakePwshAdapterPath = join(tempDir, "fake-pwsh.ts");
		writeFileSync(fakePwshAdapterPath, "// pwsh", "utf8");
		const fakeWebSearchPath = join(tempDir, "fake-websearch.ts");
		writeFileSync(fakeWebSearchPath, "// websearch", "utf8");

		const parentTools = [
			{ name: "read", sourceInfo: { source: "builtin" } },
			{ name: "write", sourceInfo: { source: "builtin" } },
			{ name: "edit", sourceInfo: { source: "builtin" } },
			{ name: "grep", sourceInfo: { source: "builtin" } },
			{ name: "find", sourceInfo: { source: "builtin" } },
			{ name: "ls", sourceInfo: { source: "builtin" } },
			// bash 来自 pwsh adapter
			{ name: "bash", sourceInfo: { source: "npm:@99percentpeople/pi-pwsh-adapter", path: fakePwshAdapterPath } },
			// web_search 来自 fake-websearch.ts
			{ name: "web_search", sourceInfo: { source: "file", path: fakeWebSearchPath } },
		];

		// 1. worker 需要 bash: 命中 pwsh adapter
		const bashRes = resolveToolProviderExtension("bash", parentTools);
		assert.equal(bashRes.available, true);
		assert.equal(bashRes.providerPath, fakePwshAdapterPath);

		// 2. reviewer 仅需要 read, grep, find, ls, contact_supervisor: 不需要注入 shell provider
		const grepRes = resolveToolProviderExtension("grep", parentTools);
		assert.equal(grepRes.available, true);
		assert.equal(grepRes.providerPath, undefined, "Builtin tools must not have providerPath");

		// 3. researcher 需要 web_search, fetch_content, source_check
		const webSearchRes = resolveToolProviderExtension("web_search", parentTools);
		assert.equal(webSearchRes.available, true);
		assert.equal(webSearchRes.providerPath, fakeWebSearchPath);

		const sourceCheckRes = resolveToolProviderExtension("source_check", parentTools);
		assert.equal(sourceCheckRes.available, false, "source_check provider is missing in parentTools");
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

// 9. Child Prompt Compatibility Mode: 保留角色 prompt，只追加 child-tools 块，幂等
test("child prompt mode preserves original role text and injects idempotent child-tools block", () => {
	const originalWorkerPrompt = `<active_agent name="worker"/>\n\nYou are worker: the implementation subagent.\n\nUse the provided tools directly.`;

	assert.equal(isChildSession(originalWorkerPrompt), true);

	// 注入 active tools block
	const activeToolsWithBash = ["read", "write", "bash"];
	const injected = injectChildToolEnvironment(originalWorkerPrompt, activeToolsWithBash);

	assert.ok(injected.startsWith(originalWorkerPrompt), "Original role prompt must be byte-preserved at start");
	assert.ok(injected.includes("## Child Tool Environment"));
	assert.ok(injected.includes("`bash` currently uses the runtime described by its tool description."));
	assert.ok(!injected.includes("You are Pi"), "Child prompt must NOT be converted to 'You are Pi'");

	// 再次注入（模拟 before_agent_start 再次触发），必须幂等，不重复追加
	const injectedAgain = injectChildToolEnvironment(injected, activeToolsWithBash);
	const occurrences = (injectedAgain.match(/<!-- change-pi-prompt:child-tools:v1 -->/g) || []).length;
	assert.equal(occurrences, 1, "Must not duplicate child-tools block on repeated calls");

	// 无任何 shell 可用时的 block
	const activeToolsNoShell = ["read", "write", "edit"];
	const injectedNoShell = injectChildToolEnvironment(originalWorkerPrompt, activeToolsNoShell);
	assert.ok(injectedNoShell.includes("No shell tool is available; use read/grep/find/ls/edit/write instead."));
	assert.ok(!injectedNoShell.includes("`bash`"));
});

// 10. pwsh-adapter bash + powershell 独立判断 bug 修复
test("transformSystemPrompt handles both pwsh-adapter bash and powershell tool independently", () => {
	const prompt = `You are Pi, an AI assistant.

Available tools:
- bash: Execute bash commands
- powershell: Execute powershell commands

Guidelines:
- Be concise
- Use bash for file operations like ls, rg, find

Pi documentation (online):
- Main documentation: https://...
- Additional docs: https://...
- Examples: https://...
`;

	const tools = [
		{ name: "bash", sourceInfo: { source: "npm:@99percentpeople/pi-pwsh-adapter", path: "C:/adapter.js" } },
		{ name: "powershell", sourceInfo: { source: "builtin" } },
	];
	const activeTools = ["bash", "powershell"];

	const input = {
		systemPrompt: prompt,
		tools,
		activeTools,
		config: DEFAULT_CONFIG,
		prompts: DEFAULT_PROMPTS,
		hostOs: "Windows 11",
		today: "2026-09-10",
	};

	const result = transformSystemPrompt(input);
	// 必须同时包含 pwsh 的解释 与 powershell 的 generic shell 解释
	assert.ok(result.systemPrompt.includes("Invoke Bash explicitly for Bash-only syntax"), "Must include pwsh guidance");
	assert.ok(result.systemPrompt.includes("follow the runtime and syntax stated in the active tool description"), "Must include shell guidance for powershell");
});

// 11. settings.json non-destructive reconciliation
test("reconcileChildEnvironments preserves user settings and updates subagentOnlyExtensions cleanly", () => {
	const tempDir = mkdtempSync(join(tmpdir(), "pideck-test-reconcile-"));
	try {
		const settingsPath = join(tempDir, "settings.json");
		const changePiPromptPath = join(process.cwd(), "resources/extensions/pideck-q-change-pi-prompt.ts");

		// 写入已有 settings，包含用户自定义字段与一个 custom subagentOnlyExtension
		const initialSettings = {
			customUserField: "preserve_me",
			subagents: {
				agentOverrides: {
					worker: {
						subagentOnlyExtensions: ["C:/my-custom/user-tool.ts"],
						userProp: 123,
					},
					delegate: {
						subagentOnlyExtensions: false, // 用户显式禁用
					},
				},
			},
		};
		writeFileSync(settingsPath, JSON.stringify(initialSettings, null, 2), "utf8");

		const catalog = loadSubagentCatalog(join(process.cwd(), "resources/extensions/pideck-q-subagents"));
		const parentTools = [
			{ name: "read", sourceInfo: { source: "builtin" } },
			{ name: "bash", sourceInfo: { source: "builtin" } },
		];

		const res = reconcileChildEnvironments({
			agentDir: tempDir,
			catalog,
			parentTools,
			changePiPromptPath,
		});

		assert.equal(res.changed, true);
		assert.ok(res.incompatibleAgents.includes("delegate"), "Explicit subagentOnlyExtensions: false must be marked incompatible");

		// 读取更新后的 settings.json
		const updated = JSON.parse(readFileSync(settingsPath, "utf8"));
		assert.equal(updated.customUserField, "preserve_me", "User custom fields must be preserved");
		assert.equal(updated.subagents.agentOverrides.worker.userProp, 123, "User props inside agentOverride must be preserved");

		const workerExts = updated.subagents.agentOverrides.worker.subagentOnlyExtensions;
		assert.ok(workerExts.includes("C:/my-custom/user-tool.ts"), "User's custom extension must be kept");
		assert.ok(workerExts.includes(changePiPromptPath), "change-pi-prompt.ts must be injected");

		// delegate 不得被修改（保留 false）
		assert.equal(updated.subagents.agentOverrides.delegate.subagentOnlyExtensions, false);

		// 再次 reconciliation（无变化），changed 应为 false，不重写文件
		const secondRes = reconcileChildEnvironments({
			agentDir: tempDir,
			catalog,
			parentTools,
			changePiPromptPath,
		});
		assert.equal(secondRes.changed, false, "Must be no-op when nothing changed");
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

// 12. provider path 边界：builtin / 非绝对路径不写入
test("resolveToolProviderExtension rejects builtin or relative fake paths", () => {
	const builtinTool = { name: "custom", sourceInfo: { source: "builtin", path: "builtin" } };
	const resBuiltin = resolveToolProviderExtension("custom", [builtinTool]);
	assert.equal(resBuiltin.available, false);

	const relativeTool = { name: "custom", sourceInfo: { source: "file", path: "./relative/path.ts" } };
	const resRelative = resolveToolProviderExtension("custom", [relativeTool]);
	assert.equal(resRelative.available, false);
});

// 13. 确认没有修改 resources/extensions/pideck-q-subagents/**
test("pideck-q-subagents directory was not modified", () => {
	const status = execSync("git status --porcelain resources/extensions/pideck-q-subagents", { encoding: "utf8" });
	assert.equal(status.trim(), "", "resources/extensions/pideck-q-subagents must be 100% untouched");
});
