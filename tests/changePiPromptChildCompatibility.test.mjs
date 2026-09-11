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
	getActiveAgentName,
	reconcileChildActiveShellTools,
	resolveChildShellSlots,
	resolveEffectiveShellPolicy,
} from "../resources/extensions/pideck-q-change-pi-prompt/childShellPolicy.ts";
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
test("child tool provider resolution follows parent active tools and internal tool rules", () => {
	const tempDir = mkdtempSync(join(tmpdir(), "pideck-provider-"));
	try {
		const fakeWebSearchPath = join(tempDir, "fake-websearch.ts");
		writeFileSync(fakeWebSearchPath, "// websearch", "utf8");

		const parentTools = [
			{ name: "read", sourceInfo: { source: "builtin" } },
			{ name: "write", sourceInfo: { source: "builtin" } },
			{ name: "edit", sourceInfo: { source: "builtin" } },
			{ name: "grep", sourceInfo: { source: "builtin" } },
			{ name: "find", sourceInfo: { source: "builtin" } },
			{ name: "ls", sourceInfo: { source: "builtin" } },
			// web_search 来自 fake-websearch.ts
			{ name: "web_search", sourceInfo: { source: "file", path: fakeWebSearchPath } },
		];
		const parentActiveTools = ["read", "write", "edit", "grep", "find", "ls", "web_search"];

		// 1. researcher 需要 web_search 且父环境 active：注入 provider
		const webSearchRes = resolveToolProviderExtension("web_search", parentTools, parentActiveTools);
		assert.equal(webSearchRes.available, true);
		assert.equal(webSearchRes.providerPath, fakeWebSearchPath);

		// 2. 父 Agent 最终已经把 web_search 隐藏（不在 active tools）：不得判 available，更不得注入 provider
		const inactiveRes = resolveToolProviderExtension("web_search", parentTools, ["read", "write"]);
		assert.equal(inactiveRes.available, false, "Inactive parent extension tools must not be injected into children");
		assert.equal(inactiveRes.providerPath, undefined);

		// 3. builtin 工具不受父 active 限制（child runtime 自己提供）
		const grepRes = resolveToolProviderExtension("grep", parentTools, ["read"]);
		assert.equal(grepRes.available, true);
		assert.equal(grepRes.providerPath, undefined, "Builtin tools must not have providerPath");

		// 4. pi-subagents 内部工具（contact_supervisor / structured_output）不受父 active 限制
		assert.equal(resolveToolProviderExtension("contact_supervisor", parentTools, []).available, true);
		assert.equal(resolveToolProviderExtension("structured_output", parentTools, []).available, true);

		// 5. researcher 还需要 source_check：父环境缺失 -> 判 missing
		const sourceCheckRes = resolveToolProviderExtension("source_check", parentTools, parentActiveTools);
		assert.equal(sourceCheckRes.available, false, "source_check provider is missing in parentTools");
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

// 9. Child Prompt Compatibility Mode: 保留角色 prompt，只追加 child-tools 块，幂等
test("child prompt mode preserves original role text and injects idempotent child-tools block", () => {
	const originalWorkerPrompt = `<active_agent name="worker"/>\n\nYou are worker: the implementation subagent.\n\nUse the provided tools directly.`;

	assert.equal(isChildSession(originalWorkerPrompt), true);
	assert.equal(getActiveAgentName(originalWorkerPrompt), "worker");

	// bash + powershell 都可用：两者都写 available
	const activeToolsWithBash = ["read", "write", "bash"];
	const injected = injectChildToolEnvironment(originalWorkerPrompt, activeToolsWithBash);

	assert.ok(injected.startsWith(originalWorkerPrompt), "Original role prompt must be byte-preserved at start");
	assert.ok(injected.includes("## Child Tool Environment"));
	assert.ok(injected.includes("- `bash` is available."));
	assert.ok(injected.includes("- `powershell` is unavailable."));
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
		const parentActiveTools = ["read", "bash"];

		const res = reconcileChildEnvironments({
			agentDir: tempDir,
			catalog,
			parentTools,
			parentActiveTools,
			platform: "win32",
			shellPolicy: resolveEffectiveShellPolicy({
				platform: "win32",
				availability: { bash: true, powershell: false },
				parentTools,
				parentActiveTools,
			}),
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
			parentActiveTools,
			platform: "win32",
			shellPolicy: resolveEffectiveShellPolicy({
				platform: "win32",
				availability: { bash: true, powershell: false },
				parentTools,
				parentActiveTools,
			}),
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
	const resBuiltin = resolveToolProviderExtension("custom", [builtinTool], ["custom"]);
	assert.equal(resBuiltin.available, false);

	const relativeTool = { name: "custom", sourceInfo: { source: "file", path: "./relative/path.ts" } };
	const resRelative = resolveToolProviderExtension("custom", [relativeTool], ["custom"]);
	assert.equal(resRelative.available, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// Canonical child shell environment
// getAllTools = registered capability; getActiveTools = what the model really has.
// ─────────────────────────────────────────────────────────────────────────────

const WORKER_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write", "contact_supervisor"];
const REVIEWER_TOOLS = ["read", "grep", "find", "ls", "contact_supervisor"];

function pwshAdapterTool(path) {
	return { name: "bash", sourceInfo: { source: "npm:@99percentpeople/pi-pwsh-adapter", path } };
}

// 14. Windows PowerShell-only：最重要的回归场景
// parent registered: read/bash/powershell/edit; parent active after prune: read/powershell/edit
test("Windows PowerShell-only parent canonicalizes a shell-capable child to powershell", () => {
	const parentTools = [
		{ name: "read", sourceInfo: { source: "builtin" } },
		{ name: "bash", sourceInfo: { source: "builtin" } },
		{ name: "powershell", sourceInfo: { source: "builtin" } },
		{ name: "edit", sourceInfo: { source: "builtin" } },
	];
	const parentActiveTools = ["read", "powershell", "edit"];

	const policy = resolveEffectiveShellPolicy({
		platform: "win32",
		availability: { bash: false, powershell: true },
		parentTools,
		parentActiveTools,
	});
	assert.deepEqual(policy, { bash: false, powershell: true, bashProviderPath: undefined, powershellProviderPath: undefined });

	const slots = resolveChildShellSlots({ platform: "win32", policy, declaredTools: WORKER_TOOLS });
	assert.equal(slots.bash, false, "child must not keep a bash slot without a real bash backend");
	assert.equal(slots.powershell, true, "shell-capable child must receive powershell");
	assert.equal(slots.available, true, "a canonical powershell backend satisfies the agent's shell requirement");
	assert.deepEqual(slots.providerPaths, []);

	// child-side canonicalization of the final active tools
	const childActive = reconcileChildActiveShellTools({
		platform: "win32",
		availability: { bash: false, powershell: true },
		registeredTools: [...WORKER_TOOLS, "powershell"],
		activeTools: WORKER_TOOLS,
		wantsShell: true,
	});
	assert.deepEqual(childActive, ["read", "grep", "find", "ls", "edit", "write", "contact_supervisor", "powershell"]);
	assert.equal(childActive.includes("bash"), false);

	// prompt block: bash superseded, powershell authoritative
	const block = buildChildToolEnvironmentBlock(childActive);
	assert.ok(block.includes("- `bash` is unavailable. Do not call it, even if the role prompt mentions bash."));
	assert.ok(block.includes("- `powershell` is available; use `powershell` for shell commands."));
	assert.ok(block.includes("- Available tools below are authoritative for this runtime."));
});

// 15. pwsh-adapter 回归：adapter 占着 bash 名字也不等于真实 bash 后端
test("pwsh-adapter bash slot never keeps bash and never blocks the canonical powershell", () => {
	const tempDir = mkdtempSync(join(tmpdir(), "pideck-pwsh-adapter-"));
	try {
		const adapterPath = join(tempDir, "pwsh-adapter.ts");
		writeFileSync(adapterPath, "// pwsh adapter", "utf8");

		const parentTools = [
			{ name: "read", sourceInfo: { source: "builtin" } },
			pwshAdapterTool(adapterPath),
			{ name: "powershell", sourceInfo: { source: "builtin" } },
		];
		const parentActiveTools = ["read", "powershell"];

		const policy = resolveEffectiveShellPolicy({
			platform: "win32",
			availability: { bash: false, powershell: true },
			parentTools,
			parentActiveTools,
		});
		assert.equal(policy.bash, false, "a pwsh adapter must not make the child bash slot active");
		assert.equal(policy.powershell, true);

		const slots = resolveChildShellSlots({ platform: "win32", policy, declaredTools: WORKER_TOOLS });
		assert.equal(slots.bash, false);
		assert.equal(slots.powershell, true);
		assert.deepEqual(slots.providerPaths, [], "the adapter must not be injected for the bash slot");
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

// 16. 真实 Git Bash + PowerShell 共存
test("real Git Bash and PowerShell coexist in the child shell set", () => {
	const parentTools = [
		{ name: "bash", sourceInfo: { source: "builtin" } },
		{ name: "powershell", sourceInfo: { source: "builtin" } },
	];
	const parentActiveTools = ["bash", "powershell"];
	const policy = resolveEffectiveShellPolicy({
		platform: "win32",
		availability: { bash: true, powershell: true },
		parentTools,
		parentActiveTools,
	});
	assert.deepEqual(policy, { bash: true, powershell: true, bashProviderPath: undefined, powershellProviderPath: undefined });

	const slots = resolveChildShellSlots({ platform: "win32", policy, declaredTools: WORKER_TOOLS });
	assert.equal(slots.bash, true);
	assert.equal(slots.powershell, true);

	const childActive = reconcileChildActiveShellTools({
		platform: "win32",
		availability: { bash: true, powershell: true },
		registeredTools: [...WORKER_TOOLS, "powershell"],
		activeTools: WORKER_TOOLS,
		wantsShell: true,
	});
	assert.ok(childActive.includes("bash"));
	assert.ok(childActive.includes("powershell"));

	const block = buildChildToolEnvironmentBlock(childActive);
	assert.ok(block.includes("- `bash` is available."));
	assert.ok(block.includes("- `powershell` is available."));
});

// 17. 只有真实 Git Bash
test("only real Git Bash available keeps bash and drops powershell", () => {
	const parentTools = [
		{ name: "bash", sourceInfo: { source: "builtin" } },
		{ name: "powershell", sourceInfo: { source: "builtin" } },
	];
	const parentActiveTools = ["bash"];
	const policy = resolveEffectiveShellPolicy({
		platform: "win32",
		availability: { bash: true, powershell: false },
		parentTools,
		parentActiveTools,
	});
	assert.equal(policy.bash, true);
	assert.equal(policy.powershell, false);

	const slots = resolveChildShellSlots({ platform: "win32", policy, declaredTools: WORKER_TOOLS });
	assert.equal(slots.bash, true);
	assert.equal(slots.powershell, false);
	assert.equal(slots.available, true);

	const childActive = reconcileChildActiveShellTools({
		platform: "win32",
		availability: { bash: true, powershell: false },
		registeredTools: WORKER_TOOLS,
		activeTools: WORKER_TOOLS,
		wantsShell: true,
	});
	assert.ok(childActive.includes("bash"));
	assert.equal(childActive.includes("powershell"), false);

	const block = buildChildToolEnvironmentBlock(childActive);
	assert.ok(block.includes("- `bash` is available."));
	assert.ok(block.includes("- `powershell` is unavailable."));
});

// 18. reviewer 不因为环境有 PowerShell 而扩权
test("agents without a shell requirement never receive powershell", () => {
	const childActive = reconcileChildActiveShellTools({
		platform: "win32",
		availability: { bash: false, powershell: true },
		registeredTools: [...REVIEWER_TOOLS, "powershell"],
		activeTools: REVIEWER_TOOLS,
		wantsShell: false,
	});
	assert.deepEqual(childActive, REVIEWER_TOOLS);
	assert.equal(childActive.includes("powershell"), false);
	assert.equal(childActive.includes("bash"), false);

	// 无法识别 child 身份：只 prune，绝不扩权
	const unknownChild = reconcileChildActiveShellTools({
		platform: "win32",
		availability: { bash: false, powershell: true },
		registeredTools: [...REVIEWER_TOOLS, "bash", "powershell"],
		activeTools: [...REVIEWER_TOOLS, "bash"],
		wantsShell: false,
		pruneOnly: true,
	});
	assert.equal(unknownChild.includes("powershell"), false, "Unknown child identity must never be widened");
	assert.equal(unknownChild.includes("bash"), false, "Unknown child identity still prunes unavailable shells");
});

// 19. Linux/macOS 不做 PowerShell 替换
test("non-Windows platforms never rewrite bash into powershell", () => {
	const parentTools = [
		{ name: "bash", sourceInfo: { source: "builtin" } },
		{ name: "powershell", sourceInfo: { source: "builtin" } },
	];
	const policy = resolveEffectiveShellPolicy({
		platform: "linux",
		availability: { bash: false, powershell: true },
		parentTools,
		parentActiveTools: ["powershell"],
	});
	const slots = resolveChildShellSlots({ platform: "linux", policy, declaredTools: WORKER_TOOLS });
	assert.equal(slots.bash, false);
	assert.equal(slots.powershell, false, "Linux must not hand a bash-declaring agent a powershell slot");
	assert.equal(slots.available, false, "The agent's shell requirement cannot be met, so the child fails closed");

	const childActive = reconcileChildActiveShellTools({
		platform: "linux",
		availability: { bash: false, powershell: true },
		registeredTools: [...WORKER_TOOLS, "powershell"],
		activeTools: WORKER_TOOLS,
		wantsShell: true,
	});
	assert.equal(childActive.includes("bash"), false);
	assert.equal(childActive.includes("powershell"), false);
});

// 20. extension powershell provider 必须像其他 extension tool 一样注入
test("extension-provided powershell is injected into the child shell environment", () => {
	const tempDir = mkdtempSync(join(tmpdir(), "pideck-pwsh-provider-"));
	try {
		const shellProviderPath = join(tempDir, "shell-provider.ts");
		writeFileSync(shellProviderPath, "// shell provider", "utf8");

		const parentTools = [
			{ name: "read", sourceInfo: { source: "builtin" } },
			{ name: "powershell", sourceInfo: { source: "file", path: shellProviderPath } },
		];
		const parentActiveTools = ["read", "powershell"];
		const policy = resolveEffectiveShellPolicy({
			platform: "win32",
			availability: { bash: false, powershell: true },
			parentTools,
			parentActiveTools,
		});
		assert.equal(policy.powershell, true);
		assert.equal(policy.powershellProviderPath, shellProviderPath);

		const slots = resolveChildShellSlots({ platform: "win32", policy, declaredTools: WORKER_TOOLS });
		assert.deepEqual(slots.providerPaths, [shellProviderPath]);

		// 未注册（或路径不可加载）的 powershell 不能被宣称为可用
		const unloadable = resolveEffectiveShellPolicy({
			platform: "win32",
			availability: { bash: false, powershell: true },
			parentTools: [{ name: "powershell", sourceInfo: { source: "file", path: join(tempDir, "missing.ts") } }],
			parentActiveTools,
		});
		assert.equal(unloadable.powershell, false, "An unloadable extension powershell must not be claimed");

		const notRegistered = resolveEffectiveShellPolicy({
			platform: "win32",
			availability: { bash: false, powershell: true },
			parentTools,
			parentActiveTools: ["read"],
		});
		assert.equal(notRegistered.powershell, false, "An inactive parent powershell must not be claimed");
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

// 21. 端到端：Windows 无 Git Bash 场景下的 child reconciliation
// （worker/scout/oracle/delegate 应可用，reviewer 不被打扰，inactive extension provider 不注入）
test("reconcileChildEnvironments canonicalizes shell-capable agents on a PowerShell-only Windows host", () => {
	const tempDir = mkdtempSync(join(tmpdir(), "pideck-child-shell-e2e-"));
	try {
		const dormantWebSearchPath = join(tempDir, "web-search.ts");
		writeFileSync(dormantWebSearchPath, "// web search", "utf8");

		const parentTools = [
			{ name: "read", sourceInfo: { source: "builtin" } },
			{ name: "write", sourceInfo: { source: "builtin" } },
			{ name: "edit", sourceInfo: { source: "builtin" } },
			{ name: "grep", sourceInfo: { source: "builtin" } },
			{ name: "find", sourceInfo: { source: "builtin" } },
			{ name: "ls", sourceInfo: { source: "builtin" } },
			{ name: "bash", sourceInfo: { source: "builtin" } },
			{ name: "powershell", sourceInfo: { source: "builtin" } },
			// 已注册但当前 inactive 的 extension tool
			{ name: "web_search", sourceInfo: { source: "file", path: dormantWebSearchPath } },
		];
		const parentActiveTools = ["read", "write", "edit", "grep", "find", "ls", "powershell"];

		const catalog = loadSubagentCatalog(join(process.cwd(), "resources/extensions/pideck-q-subagents"));
		const res = reconcileChildEnvironments({
			agentDir: tempDir,
			catalog,
			parentTools,
			parentActiveTools,
			platform: "win32",
			shellPolicy: resolveEffectiveShellPolicy({
				platform: "win32",
				availability: { bash: false, powershell: true },
				parentTools,
				parentActiveTools,
			}),
			changePiPromptPath: join(process.cwd(), "resources/extensions/pideck-q-change-pi-prompt.ts"),
		});

		// shell-capable agents：bash 被规范化为 powershell，不得判 missing
		for (const name of ["worker", "scout", "oracle", "delegate"]) {
			const status = res.compatibilityStatus.get(name);
			assert.ok(status, `${name} must be reconciled`);
			assert.equal(status.ok, true, `${name} must not be blocked: ${status.missingTools.join(",")}`);
			assert.equal(status.missingTools.includes("bash"), false);
		}

		// 无 shell 需求的 reviewer 不受影响
		const reviewer = res.compatibilityStatus.get("reviewer");
		assert.ok(reviewer);
		assert.equal(reviewer.ok, true, reviewer.missingTools.join(","));

		// inactive 的 parent extension provider 不得被注入，且必须报告为 missing
		const researcher = res.compatibilityStatus.get("researcher");
		assert.ok(researcher);
		assert.equal(researcher.missingTools.includes("web_search"), true, "Inactive parent extension tools must be reported missing");
		assert.equal(researcher.injectedExtensions.includes(dormantWebSearchPath), false);

		// settings.json 不得出现 pwsh-adapter 类的 bash provider 注入
		const settings = existsSync(join(tempDir, "settings.json"))
			? JSON.parse(readFileSync(join(tempDir, "settings.json"), "utf8"))
			: { subagents: { agentOverrides: {} } };
		for (const name of ["worker", "scout", "oracle", "delegate"]) {
			const list = settings.subagents?.agentOverrides?.[name]?.subagentOnlyExtensions ?? [];
			for (const entry of list) {
				assert.equal(/pi-pwsh-adapter/.test(entry), false, `${name} must not keep a pwsh-adapter provider`);
			}
		}
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

// 22. 端到端：child before_agent_start 先规范化 tools，再生成 prompt block
test("child before_agent_start canonicalizes active tools before rendering the tool environment block", async () => {
	const tempDir = mkdtempSync(join(tmpdir(), "pideck-child-runtime-"));
	try {
		const registered = [
			{ name: "read", sourceInfo: { source: "builtin" } },
			{ name: "grep", sourceInfo: { source: "builtin" } },
			{ name: "find", sourceInfo: { source: "builtin" } },
			{ name: "ls", sourceInfo: { source: "builtin" } },
			{ name: "edit", sourceInfo: { source: "builtin" } },
			{ name: "write", sourceInfo: { source: "builtin" } },
			{ name: "contact_supervisor", sourceInfo: { source: "builtin" } },
			{ name: "bash", sourceInfo: { source: "builtin" } },
			{ name: "powershell", sourceInfo: { source: "builtin" } },
		];

		async function runChild(prompt, activeTools) {
			const { mockPi, setTools, getHandler } = createMockPi();
			setTools(registered);
			mockPi.setActiveTools(activeTools);
			registerPromptExtension(mockPi, tempDir, {
				probeHost: {
					platform: "win32",
					env: { Path: "" },
					exists: path => path === "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
				},
				isStandalone: () => true,
			});
			const ctx = { hasUI: true, ui: { notify: () => {}, editor: async () => undefined } };
			const result = await getHandler("before_agent_start")({ systemPrompt: prompt, systemPromptOptions: {} }, ctx);
			return { result, active: mockPi.getActiveTools() };
		}

		// worker（声明 bash）：得到 powershell，丢掉 bash，角色 prompt 原样保留
		const workerPrompt = `<active_agent name="worker"/>\n\nYou are worker: the implementation subagent.\n\nUse \`bash\` for inspection, validation, and relevant tests.`;
		const worker = await runChild(workerPrompt, WORKER_TOOLS);
		assert.equal(worker.active.includes("bash"), false, "child bash must be hidden when the backend is missing");
		assert.equal(worker.active.includes("powershell"), true, "child must receive powershell");
		assert.ok(worker.result, "child prompt must be updated");
		const workerPromptOut = worker.result.systemPrompt;
		assert.ok(workerPromptOut.startsWith(workerPrompt), "role prompt must be byte-preserved");
		assert.ok(!workerPromptOut.includes("You are Pi"), "child prompt must not become the parent identity");
		assert.ok(workerPromptOut.includes("`bash` is unavailable. Do not call it, even if the role prompt mentions bash."));
		assert.ok(workerPromptOut.includes("`powershell` is available; use `powershell` for shell commands."));
		assert.ok(workerPromptOut.includes("Do not call it, even if the role prompt mentions bash"), "must supersede the role prompt's bash instruction");

		// reviewer（不声明 shell）：不扩权
		const reviewerPrompt = `<active_agent name="reviewer"/>\n\nYou are a disciplined review subagent.`;
		const reviewer = await runChild(reviewerPrompt, REVIEWER_TOOLS);
		assert.deepEqual(reviewer.active, REVIEWER_TOOLS);
		const reviewerOut = reviewer.result.systemPrompt;
		assert.ok(reviewerOut.includes("No shell tool is available; use read/grep/find/ls/edit/write instead."));
		assert.ok(!reviewerOut.includes("`powershell` is available"));
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

// 13. 确认没有修改 resources/extensions/pideck-q-subagents/**
test("pideck-q-subagents directory was not modified", () => {
	const status = execSync("git status --porcelain resources/extensions/pideck-q-subagents", { encoding: "utf8" });
	assert.equal(status.trim(), "", "resources/extensions/pideck-q-subagents must be 100% untouched");
});
