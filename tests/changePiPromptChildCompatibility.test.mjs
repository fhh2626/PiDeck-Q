import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	loadSubagentCatalog,
	parseAgentFrontmatter,
} from "../resources/extensions/pideck-q-change-pi-prompt/subagentCatalog.ts";
import {
	reconcileChildEnvironments,
	readEffectiveShellPolicySnapshot,
	resolveLoadableToolProvider,
	resolveShellPolicyOwnerKey,
	resolveToolProviderExtension,
	reconciliationLockPath,
	shellPolicyOwnerToken,
	shellPolicySnapshotPath,
	SHELL_POLICY_OWNER_ENV,
	withReconciliationLock,
} from "../resources/extensions/pideck-q-change-pi-prompt/childReconciliation.ts";
import {
	getActiveAgentName,
	isBuiltinOrInternalChildTool,
	reconcileChildActiveShellTools,
	reconcileChildExtensionTools,
	resolveChildShellSlots,
	resolveEffectiveShellPolicy,
	toParentActiveTools,
	toShellCeiling,
} from "../resources/extensions/pideck-q-change-pi-prompt/childShellPolicy.ts";
import {
	bashAvailable,
	classifyConfiguredShellKind,
	powershellAvailable,
	probeShellAvailability,
} from "../resources/extensions/pideck-q-change-pi-prompt/shellAvailability.ts";
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

		// 2. 父 Agent 最终已经把 web_search 隐藏（不在 active tools）：
		//    当前 parent 不允许（available=false），但 provider 本身仍可加载（全局 superset 保留）
		const inactiveRes = resolveToolProviderExtension("web_search", parentTools, ["read", "write"]);
		assert.equal(inactiveRes.available, false, "Inactive parent extension tools must not be handed to children of this parent");
		assert.equal(inactiveRes.providerPath, undefined);
		const inactiveLoadable = resolveLoadableToolProvider("web_search", parentTools);
		assert.equal(inactiveLoadable.loadable, true, "A loadable provider stays in the shared superset even when this parent is inactive");
		assert.equal(inactiveLoadable.providerPath, fakeWebSearchPath);

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
		assert.equal(resolveLoadableToolProvider("source_check", parentTools).loadable, false, "A missing provider is not loadable");

		// 6. builtin / internal 工具无需 provider，也不受父 active 影响
		assert.equal(resolveLoadableToolProvider("grep", parentTools).loadable, true);
		assert.equal(resolveLoadableToolProvider("contact_supervisor", parentTools).loadable, true);
		assert.equal(resolveLoadableToolProvider("grep", parentTools).providerPath, undefined, "Builtin tools must not have providerPath");
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

	// 无任何 shell 可用时的 block：不得推荐该 agent 实际没有的工具
	const activeToolsNoShell = ["read", "write", "edit"];
	const injectedNoShell = injectChildToolEnvironment(originalWorkerPrompt, activeToolsNoShell);
	assert.ok(injectedNoShell.includes("No shell tool is available; use only the non-shell tools that are active in this child."));
	assert.ok(!injectedNoShell.includes("`bash`"));
	assert.ok(!/read\/grep|edit\/write/.test(injectedNoShell));
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
test("reconcileChildEnvironments preserves user settings and updates subagentOnlyExtensions cleanly", async () => {
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

		const res = await reconcileChildEnvironments({
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
		const secondRes = await reconcileChildEnvironments({
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

/** Registered-tool snapshots for child-side canonicalization calls. */
function registered(...names) {
	return names.map((name) => ({ name, sourceInfo: { source: "builtin" } }));
}

// 14. Windows PowerShell-only：不再把 bash-only child 改写成 powershell
test("Windows PowerShell-only parent does not rewrite a bash-only child into powershell", () => {
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
	assert.equal(slots.powershell, false, "undeclared powershell must not be added");
	assert.equal(slots.available, false);
	assert.deepEqual(slots.providerPaths, []);

	const childActive = reconcileChildActiveShellTools({
		platform: "win32",
		availability: { bash: false, powershell: true },
		registeredTools: registered(...WORKER_TOOLS, "powershell"),
		activeTools: WORKER_TOOLS,
		wantsShell: true,
	});
	assert.deepEqual(childActive, ["read", "grep", "find", "ls", "edit", "write", "contact_supervisor"]);
	assert.equal(childActive.includes("bash"), false);
	assert.equal(childActive.includes("powershell"), false);

	const block = buildChildToolEnvironmentBlock(childActive);
	assert.ok(block.includes("- No shell tool is available; use only the non-shell tools that are active in this child."));
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
		assert.equal(slots.powershell, false, "a bash-only agent must not receive undeclared powershell");
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
	assert.equal(slots.powershell, false, "undeclared powershell stays off the child allowlist");

	const childActive = reconcileChildActiveShellTools({
		platform: "win32",
		availability: { bash: true, powershell: true },
		registeredTools: registered(...WORKER_TOOLS, "powershell"),
		activeTools: WORKER_TOOLS,
		wantsShell: true,
	});
	assert.ok(childActive.includes("bash"));
	assert.equal(childActive.includes("powershell"), false);

	const block = buildChildToolEnvironmentBlock(childActive);
	assert.ok(block.includes("- `bash` is available."));
	assert.ok(block.includes("- `powershell` is unavailable."));
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
		registeredTools: registered(...WORKER_TOOLS),
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
		registeredTools: registered(...REVIEWER_TOOLS, "powershell"),
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
		registeredTools: registered(...REVIEWER_TOOLS, "bash", "powershell"),
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
	assert.equal(slots.powershell, false, "a bash-declaring agent must not receive undeclared powershell");
	assert.equal(slots.available, false);

	const childActive = reconcileChildActiveShellTools({
		platform: "linux",
		availability: { bash: false, powershell: true },
		registeredTools: registered(...WORKER_TOOLS, "powershell"),
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
		assert.deepEqual(slots.providerPaths, [], "a bash-only agent must not receive an undeclared powershell provider");

		const declaredPowerShell = resolveChildShellSlots({
			platform: "win32",
			policy,
			declaredTools: ["read", "powershell"],
		});
		assert.deepEqual(declaredPowerShell.providerPaths, [shellProviderPath]);

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
test("reconcileChildEnvironments does not rewrite bash-only agents on a PowerShell-only Windows host", async () => {
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
		const hostShells = { bash: false, powershell: true };
		const res = await reconcileChildEnvironments({
			agentDir: tempDir,
			catalog,
			parentTools,
			parentActiveTools,
			platform: "win32",
			shellPolicy: resolveEffectiveShellPolicy({
				platform: "win32",
				availability: hostShells,
				parentTools,
				parentActiveTools,
			}),
			hostShells,
			changePiPromptPath: join(process.cwd(), "resources/extensions/pideck-q-change-pi-prompt.ts"),
		});

		// bash-only agents：缺少 bash 后端不再伪装成 powershell，也不把 builtin shell 当成 missing provider
		for (const name of ["worker", "scout", "oracle", "delegate"]) {
			const status = res.compatibilityStatus.get(name);
			assert.ok(status, `${name} must be reconciled`);
			assert.equal(status.ok, true, `${name} must not be blocked: ${status.missingTools.join(",")}`);
			assert.equal(status.missingTools.includes("bash"), false);
			assert.equal(status.missingTools.includes("powershell"), false);
		}

		// 无 shell 需求的 reviewer 不受影响
		const reviewer = res.compatibilityStatus.get("reviewer");
		assert.ok(reviewer);
		assert.equal(reviewer.ok, true, reviewer.missingTools.join(","));

		// inactive 的 parent extension provider：仍会进入全局 superset（其他 session 可能需要），
		// 但当前 parent 的 compatibility 必须报告为 missing。
		const researcher = res.compatibilityStatus.get("researcher");
		assert.ok(researcher);
		assert.equal(researcher.missingTools.includes("web_search"), true, "Inactive parent extension tools must be reported missing for this parent");
		assert.equal(researcher.injectedExtensions.includes(dormantWebSearchPath), true, "A loadable provider belongs to the shared superset");

		// settings.json 不得出现 pwsh-adapter 类的 bash provider 注入
		const settings = existsSync(join(tempDir, "settings.json"))
			? JSON.parse(readFileSync(join(tempDir, "settings.json"), "utf8"))
			: { subagents: { agentOverrides: {} } };
		for (const name of ["worker", "scout", "oracle", "delegate"]) {
			const list = settings.subagents?.agentOverrides?.[name]?.subagentOnlyExtensions ?? [];
			for (const entry of list) {
				assert.equal(/pi-pwsh-adapter/.test(entry), false, `${name} must not keep a pwsh-adapter provider`);
			}
			const tools = settings.subagents?.agentOverrides?.[name]?.tools;
			assert.ok(Array.isArray(tools), `${name} must receive a host-shell tools override`);
			assert.equal(tools.includes("bash"), false, `${name} must not keep bash without a bash backend`);
			assert.equal(tools.includes("powershell"), true, `${name} must allow powershell on this host`);
		}
		assert.equal(settings.subagents?.agentOverrides?.reviewer?.tools, undefined, "reviewer must not receive a tools override");
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

test("host-shell tools overrides never clobber a user-written tools list", async () => {
	const tempDir = mkdtempSync(join(tmpdir(), "pideck-child-tools-user-"));
	try {
		const catalog = loadSubagentCatalog(join(process.cwd(), "resources/extensions/pideck-q-subagents"));
		const parentTools = [
			{ name: "read", sourceInfo: { source: "builtin" } },
			{ name: "bash", sourceInfo: { source: "builtin" } },
			{ name: "powershell", sourceInfo: { source: "builtin" } },
		];
		const userTools = ["read", "bash", "edit"];
		mkdirSync(join(tempDir, "change-pi-prompt"), { recursive: true });
		writeFileSync(join(tempDir, "settings.json"), JSON.stringify({
			subagents: {
				agentOverrides: {
					worker: { tools: userTools },
				},
			},
		}), "utf8");

		const hostShells = { bash: false, powershell: true };
		await reconcileChildEnvironments({
			agentDir: tempDir,
			catalog,
			parentTools,
			parentActiveTools: ["read", "powershell"],
			platform: "win32",
			shellPolicy: resolveEffectiveShellPolicy({
				platform: "win32",
				availability: hostShells,
				parentTools,
				parentActiveTools: ["read", "powershell"],
			}),
			hostShells,
			changePiPromptPath: join(process.cwd(), "resources/extensions/pideck-q-change-pi-prompt.ts"),
		});

		const settings = JSON.parse(readFileSync(join(tempDir, "settings.json"), "utf8"));
		assert.deepEqual(settings.subagents.agentOverrides.worker.tools, userTools);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

test("managed host-shell tools overrides update when the host backends change", async () => {
	const tempDir = mkdtempSync(join(tmpdir(), "pideck-child-tools-managed-"));
	try {
		const catalog = loadSubagentCatalog(join(process.cwd(), "resources/extensions/pideck-q-subagents"));
		const parentTools = [
			{ name: "read", sourceInfo: { source: "builtin" } },
			{ name: "bash", sourceInfo: { source: "builtin" } },
			{ name: "powershell", sourceInfo: { source: "builtin" } },
		];
		const changePiPromptPath = join(process.cwd(), "resources/extensions/pideck-q-change-pi-prompt.ts");
		const run = (hostShells) => reconcileChildEnvironments({
			agentDir: tempDir,
			catalog,
			parentTools,
			parentActiveTools: ["read", ...(hostShells.bash ? ["bash"] : []), ...(hostShells.powershell ? ["powershell"] : [])],
			platform: "win32",
			shellPolicy: resolveEffectiveShellPolicy({
				platform: "win32",
				availability: hostShells,
				parentTools,
				parentActiveTools: ["read"],
			}),
			hostShells,
			changePiPromptPath,
		});

		await run({ bash: false, powershell: true });
		let tools = JSON.parse(readFileSync(join(tempDir, "settings.json"), "utf8")).subagents.agentOverrides.worker.tools;
		assert.equal(tools.includes("powershell"), true);
		assert.equal(tools.includes("bash"), false);

		await run({ bash: true, powershell: true });
		tools = JSON.parse(readFileSync(join(tempDir, "settings.json"), "utf8")).subagents.agentOverrides.worker.tools;
		assert.equal(tools.includes("bash"), true);
		assert.equal(tools.includes("powershell"), true);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

test("host-shell tools override is omitted when it matches the agent frontmatter", async () => {
	const tempDir = mkdtempSync(join(tmpdir(), "pideck-child-tools-match-"));
	try {
		const catalog = loadSubagentCatalog(join(process.cwd(), "resources/extensions/pideck-q-subagents"));
		const parentTools = [
			{ name: "read", sourceInfo: { source: "builtin" } },
			{ name: "bash", sourceInfo: { source: "builtin" } },
		];
		await reconcileChildEnvironments({
			agentDir: tempDir,
			catalog,
			parentTools,
			parentActiveTools: ["read", "bash"],
			platform: "linux",
			shellPolicy: resolveEffectiveShellPolicy({
				platform: "linux",
				availability: { bash: true, powershell: false },
				parentTools,
				parentActiveTools: ["read", "bash"],
			}),
			hostShells: { bash: true, powershell: false },
			changePiPromptPath: join(process.cwd(), "resources/extensions/pideck-q-change-pi-prompt.ts"),
		});
		const settings = existsSync(join(tempDir, "settings.json"))
			? JSON.parse(readFileSync(join(tempDir, "settings.json"), "utf8"))
			: {};
		assert.equal(settings.subagents?.agentOverrides?.worker?.tools, undefined);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

// 22. 端到端：child before_agent_start 先规范化 tools，再生成 prompt block
test("child before_agent_start prunes unavailable shells before rendering the tool environment block", async () => {
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

		// worker（声明 bash）：丢掉缺失后端的 bash，不发明 powershell，角色 prompt 原样保留
		const workerPrompt = `<active_agent name="worker"/>\n\nYou are worker: the implementation subagent.\n\nUse \`bash\` for inspection, validation, and relevant tests.`;
		const worker = await runChild(workerPrompt, WORKER_TOOLS);
		assert.equal(worker.active.includes("bash"), false, "child bash must be hidden when the backend is missing");
		assert.equal(worker.active.includes("powershell"), false, "undeclared powershell must not be added");
		assert.ok(worker.result, "child prompt must be updated");
		const workerPromptOut = worker.result.systemPrompt;
		assert.ok(workerPromptOut.startsWith(workerPrompt), "role prompt must be byte-preserved");
		assert.ok(!workerPromptOut.includes("You are Pi"), "child prompt must not become the parent identity");
		assert.ok(workerPromptOut.includes("No shell tool is available; use only the non-shell tools that are active in this child."));

		// reviewer（不声明 shell）：不扩权
		const reviewerPrompt = `<active_agent name="reviewer"/>\n\nYou are a disciplined review subagent.`;
		const reviewer = await runChild(reviewerPrompt, REVIEWER_TOOLS);
		assert.deepEqual(reviewer.active, REVIEWER_TOOLS);
		const reviewerOut = reviewer.result.systemPrompt;
		assert.ok(reviewerOut.includes("No shell tool is available; use only the non-shell tools that are active in this child."));
		assert.ok(!reviewerOut.includes("`powershell` is available"));
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

// 13. pwsh-adapter 回归：即使 Git Bash 真的存在，adapter 占着 bash 名字也不能把 bash 重新加回来
test("a pwsh-adapter bash slot is never re-added even when a real bash backend exists", () => {
	const childActive = reconcileChildActiveShellTools({
		platform: "win32",
		availability: { bash: true, powershell: true },
		registeredTools: [
			{ name: "bash", sourceInfo: { source: "npm:@99percentpeople/pi-pwsh-adapter", path: "C:/adapter.ts" } },
			{ name: "powershell", sourceInfo: { source: "builtin" } },
		],
		activeTools: WORKER_TOOLS,
		wantsShell: true,
		ceiling: { bash: false, powershell: true },
	});
	assert.equal(childActive.includes("bash"), false, "adapter-occupied bash must never be treated as a real backend");
	assert.equal(childActive.includes("powershell"), false, "powershell must not be invented for a bash-only allowlist");
});

// 14. parent shell ceiling：parent 不开的 shell，child 不能因为本机后端存在而自己加回来
test("child shell mapping never exceeds the parent's published shell ceiling", () => {
	const registeredSnapshots = registered(...WORKER_TOOLS, "powershell");

	// 本机 bash 存在，但 parent 最终没暴露 bash -> child 不得加回
	const bashOff = reconcileChildActiveShellTools({
		platform: "win32",
		availability: { bash: true, powershell: true },
		registeredTools: registeredSnapshots,
		activeTools: WORKER_TOOLS,
		wantsShell: true,
		ceiling: { bash: false, powershell: true },
	});
	assert.equal(bashOff.includes("bash"), false, "parent ceiling must win over local availability");
	assert.equal(bashOff.includes("powershell"), false, "powershell must not be added when it was not already active");

	// parent ceiling 也没 powershell：不得因为本机有 pwsh 就加进去
	const shellOff = reconcileChildActiveShellTools({
		platform: "win32",
		availability: { bash: true, powershell: true },
		registeredTools: registeredSnapshots,
		activeTools: WORKER_TOOLS,
		wantsShell: true,
		ceiling: { bash: false, powershell: false },
	});
	assert.equal(shellOff.includes("bash"), false);
	assert.equal(shellOff.includes("powershell"), false);

	// 无 ceiling（未发布快照）时回退到 availability + registry 判定
	const noCeiling = reconcileChildActiveShellTools({
		platform: "win32",
		availability: { bash: true, powershell: true },
		registeredTools: registeredSnapshots,
		activeTools: WORKER_TOOLS,
		wantsShell: true,
	});
	assert.equal(noCeiling.includes("bash"), true);
	assert.equal(noCeiling.includes("powershell"), false, "no-ceiling fallback still must not invent powershell");

	// 未注册的 shell 无论 availability 如何都不能宣称可用
	const unregistered = reconcileChildActiveShellTools({
		platform: "win32",
		availability: { bash: false, powershell: true },
		registeredTools: registered(...WORKER_TOOLS),
		activeTools: WORKER_TOOLS,
		wantsShell: true,
	});
	assert.equal(unregistered.includes("powershell"), false, "a child cannot claim a shell it does not register");
});

// 15. settings.shellPath 必须按 basename 分类，不能一律当成 bash（Windows pwsh.exe 场景）
test("configured shellPath contributes only to the backend it really is", () => {
	const windows = {
		platform: "win32",
		env: { Path: "", USERPROFILE: "C:\\Users\\me" },
		exists: (path) => path === "D:\\tools\\pwsh.exe" || path === "D:\\tools\\bash.exe" || path === "D:\\tools\\sh.exe",
	};

	// pwsh.exe 只能贡献 powershell，绝不能把 bash 变成 available
	const pwshOnly = probeShellAvailability(windows, "D:\\tools\\pwsh.exe");
	assert.deepEqual(pwshOnly, { bash: false, powershell: true }, "pwsh.exe must not make bash available");
	assert.equal(bashAvailable(windows, "D:\\tools\\pwsh.exe"), false);
	assert.equal(powershellAvailable(windows, "D:\\tools\\pwsh.exe"), true);

	// 真 bash 名字仍然贡献 bash
	const realBash = probeShellAvailability(windows, "D:\\tools\\bash.exe");
	assert.deepEqual(realBash, { bash: true, powershell: false });
	assert.equal(classifyConfiguredShellKind(windows, "D:\\tools\\sh.exe"), "bash");

	// 未知 shell（如 cmd.exe）不贡献任何一个后端
	assert.equal(classifyConfiguredShellKind(windows, "C:\\Windows\\System32\\cmd.exe"), undefined);
	const unknown = { ...windows, exists: (path) => path === "C:\\Windows\\System32\\cmd.exe" };
	assert.deepEqual(probeShellAvailability(unknown, "C:\\Windows\\System32\\cmd.exe"), { bash: false, powershell: false });

	// 不存在的配置路径不能凭空产生后端
	assert.deepEqual(probeShellAvailability(windows, "D:\\tools\\missing.exe"), { bash: false, powershell: false });
});

// 16. 全局 reconciliation 只能由 parent 执行：child session 不得写 settings.json / 不得改 overrides
test("a child session never runs global reconciliation", async () => {	const tempDir = mkdtempSync(join(tmpdir(), "pideck-child-no-reconcile-"));
	const previousOwner = process.env[SHELL_POLICY_OWNER_ENV];
	try {
		delete process.env[SHELL_POLICY_OWNER_ENV];
		const changePiPromptPath = join(process.cwd(), "resources/extensions/pideck-q-change-pi-prompt.ts");
		const subagentTool = {
			name: "subagent",
			description: "subagent",
			sourceInfo: { source: "npm:pi-subagents", path: join(process.cwd(), "resources/extensions/pideck-q-subagents/dist/index.js") },
		};
		const tools = [subagentTool, { name: "read", sourceInfo: { source: "builtin" } }, { name: "bash", sourceInfo: { source: "builtin" } }];

		const { mockPi, setTools, getHandler } = createMockPi();
		setTools(tools);
		registerPromptExtension(mockPi, tempDir, {
			probeHost: { platform: "win32", env: { Path: "" }, exists: () => false },
			isStandalone: () => true,
			changePiPromptPath,
		});
		// mock ctx 没有 sessionManager，owner key 退化为进程级 "pid-<pid>"。
		const ctx = { hasUI: true, ui: { notify: () => {}, editor: async () => undefined } };

		// session_start 本身不得写共享 override（它只做 session-local 的 shell prune）
		await getHandler("session_start")({ type: "session_start", reason: "startup" }, ctx);
		assert.equal(existsSync(join(tempDir, "settings.json")), false, "session_start must not write shared child overrides");

		// child session 的 before_agent_start 同样不得写
		const childPrompt = `<active_agent name="worker"/>\n\nYou are worker.`;
		await getHandler("before_agent_start")({ systemPrompt: childPrompt, systemPromptOptions: {} }, ctx);
		assert.equal(existsSync(join(tempDir, "settings.json")), false, "child before_agent_start must not write shared child overrides");

		// 模拟一个早已结束的 session 留下的 owner 快照，验证写入时的过期清理
		const stalePath = shellPolicySnapshotPath(tempDir, "old-session");
		mkdirSync(join(tempDir, "change-pi-prompt"), { recursive: true });
		writeFileSync(stalePath, JSON.stringify({ version: 1, platform: "win32", bash: true, powershell: true }), "utf8");
		const past = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
		utimesSync(stalePath, past, past);

		// parent session 才写（loadSubagentCatalog 能找到 bundled agents）
		const parentPrompt = "You are an expert coding assistant operating inside pi, a coding agent harness.\n\nAvailable tools:\n- subagent: Delegate\n\nGuidelines:\n- Be concise in your responses\n";
		await getHandler("before_agent_start")({ systemPrompt: parentPrompt, systemPromptOptions: { selectedTools: ["subagent", "read", "bash"] } }, ctx);
		assert.equal(existsSync(join(tempDir, "settings.json")), true, "the parent must still reconcile child overrides");

		const settings = JSON.parse(readFileSync(join(tempDir, "settings.json"), "utf8"));
		assert.ok(settings.subagents?.agentOverrides?.worker?.subagentOnlyExtensions?.includes(changePiPromptPath));

		// parent 发布的是 owner-scoped 快照，而不是所有 session 共用一个全局文件
		const ownerKey = `pid-${process.pid}`;
		assert.equal(process.env[SHELL_POLICY_OWNER_ENV], ownerKey, "the parent must publish its owner key for child runtimes");
		const snapshotPath = shellPolicySnapshotPath(tempDir, ownerKey);
		assert.equal(existsSync(snapshotPath), true, "the parent must publish the effective child policy");
		assert.deepEqual(JSON.parse(readFileSync(snapshotPath, "utf8")), {
			version: 2,
			platform: "win32",
			shell: { bash: false, powershell: false },
			// bash 已因本机无后端被 prune，快照记录的是最终的 getActiveTools() 结果
			parentActiveTools: ["subagent", "read"],
		});
		assert.equal(existsSync(join(tempDir, "change-pi-prompt", "effective-shell-policy.json")), false, "no single global ceiling file may be written");
		// 原子写入不得留下半截 temp 文件
		assert.deepEqual(readdirSync(join(tempDir, "change-pi-prompt")).filter((name) => name.includes(".tmp.")), [], "atomic writes must not leave temp files behind");
		// 过期 owner 快照在写入时被清理，避免文件无限积累
		assert.equal(existsSync(stalePath), false, "stale owner snapshots must be pruned on write");
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
		if (previousOwner === undefined) delete process.env[SHELL_POLICY_OWNER_ENV];
		else process.env[SHELL_POLICY_OWNER_ENV] = previousOwner;
	}
});

// 17. ceiling 快照的读取边界：缺失/损坏/跨平台/无 owner 一律忽略（回退到保守判定）
test("effective shell policy snapshots are consumed conservatively", () => {
	const tempDir = mkdtempSync(join(tmpdir(), "pideck-shell-snapshot-"));
	try {
		const owner = "owner-a";
		const snapshotPath = shellPolicySnapshotPath(tempDir, owner);
		// 无 owner 上下文时不得猜测任何文件
		assert.equal(resolveShellPolicyOwnerKey({}), undefined);
		assert.equal(readEffectiveShellPolicySnapshot(tempDir, "win32", ""), undefined);
		assert.equal(readEffectiveShellPolicySnapshot(tempDir, "win32", owner), undefined);

		mkdirSync(join(tempDir, "change-pi-prompt"), { recursive: true });
		writeFileSync(snapshotPath, "not json", "utf8");
		assert.equal(readEffectiveShellPolicySnapshot(tempDir, "win32", owner), undefined);

		// 未知版本忽略；version 1 仍可读（只有 shell ceiling，没有 extension tool ceiling）
		writeFileSync(snapshotPath, JSON.stringify({ version: 3, platform: "win32" }), "utf8");
		assert.equal(readEffectiveShellPolicySnapshot(tempDir, "win32", owner), undefined, "unknown versions must be ignored");

		writeFileSync(snapshotPath, JSON.stringify({ version: 1, platform: "win32", bash: "yes", powershell: true }), "utf8");
		assert.equal(readEffectiveShellPolicySnapshot(tempDir, "win32", owner), undefined, "non-boolean fields must be ignored");

		writeFileSync(snapshotPath, JSON.stringify({ version: 2, platform: "win32", shell: { bash: "yes", powershell: true }, parentActiveTools: [] }), "utf8");
		assert.equal(readEffectiveShellPolicySnapshot(tempDir, "win32", owner), undefined, "v2 non-boolean shell fields must be ignored");

		writeFileSync(snapshotPath, JSON.stringify({ version: 2, platform: "win32", shell: { bash: true, powershell: true } }), "utf8");
		assert.equal(readEffectiveShellPolicySnapshot(tempDir, "win32", owner), undefined, "v2 without parentActiveTools must be ignored");

		writeFileSync(snapshotPath, JSON.stringify({ version: 1, platform: "linux", bash: true, powershell: true }), "utf8");
		assert.equal(readEffectiveShellPolicySnapshot(tempDir, "win32", owner), undefined, "a foreign-platform snapshot must be ignored");

		// version 1：只提供 shell ceiling，不提供 extension tool ceiling
		writeFileSync(snapshotPath, JSON.stringify({ version: 1, platform: "win32", bash: false, powershell: true }), "utf8");
		assert.deepEqual(readEffectiveShellPolicySnapshot(tempDir, "win32", owner), {
			version: 1,
			platform: "win32",
			bash: false,
			powershell: true,
		});
		assert.deepEqual(toShellCeiling(readEffectiveShellPolicySnapshot(tempDir, "win32", owner)), { bash: false, powershell: true });
		assert.equal(toParentActiveTools(readEffectiveShellPolicySnapshot(tempDir, "win32", owner)), undefined, "version 1 carries no extension tool ceiling");

		// version 2：shell + parentActiveTools 同时提供（非字符串项被丢弃）
		writeFileSync(snapshotPath, JSON.stringify({ version: 2, platform: "win32", shell: { bash: false, powershell: true }, parentActiveTools: ["read", 7, "web_search"] }), "utf8");
		assert.deepEqual(readEffectiveShellPolicySnapshot(tempDir, "win32", owner), {
			version: 2,
			platform: "win32",
			shell: { bash: false, powershell: true },
			parentActiveTools: ["read", "web_search"],
		});
		assert.deepEqual(toShellCeiling(readEffectiveShellPolicySnapshot(tempDir, "win32", owner)), { bash: false, powershell: true });
		assert.deepEqual(toParentActiveTools(readEffectiveShellPolicySnapshot(tempDir, "win32", owner)), ["read", "web_search"]);
		assert.equal(toParentActiveTools(undefined), undefined);
		assert.equal(toShellCeiling(undefined), undefined);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

// 19. 并行 session 隔离：一个 parent 的 ceiling 不能被另一个 session 覆盖（owner 文件必须不同）
test("a parent shell ceiling is scoped to its owning session", () => {
	const tempDir = mkdtempSync(join(tmpdir(), "pideck-shell-owner-"));
	try {
		const parentA = "session-a";
		const parentB = "session-b";
		const pathA = shellPolicySnapshotPath(tempDir, parentA);
		const pathB = shellPolicySnapshotPath(tempDir, parentB);
		assert.notEqual(pathA, pathB);

		// Parent A: bash=false, powershell=true；Parent B 随后覆盖自己的文件
		mkdirSync(join(tempDir, "change-pi-prompt"), { recursive: true });
		writeFileSync(pathA, JSON.stringify({ version: 2, platform: "win32", shell: { bash: false, powershell: true }, parentActiveTools: ["read", "powershell"] }), "utf8");
		writeFileSync(pathB, JSON.stringify({ version: 2, platform: "win32", shell: { bash: true, powershell: false }, parentActiveTools: ["read", "bash"] }), "utf8");

		// A 的 child 必须读到 A 的 ceiling，而不是 B 的
		assert.deepEqual(readEffectiveShellPolicySnapshot(tempDir, "win32", parentA), { version: 2, platform: "win32", shell: { bash: false, powershell: true }, parentActiveTools: ["read", "powershell"] });
		assert.deepEqual(readEffectiveShellPolicySnapshot(tempDir, "win32", parentB), { version: 2, platform: "win32", shell: { bash: true, powershell: false }, parentActiveTools: ["read", "bash"] });

		const registeredTools = registered(...WORKER_TOOLS, "powershell");
		const aTools = reconcileChildActiveShellTools({
			platform: "win32",
			availability: { bash: true, powershell: true },
			registeredTools,
			activeTools: WORKER_TOOLS,
			wantsShell: true,
			ceiling: toShellCeiling(readEffectiveShellPolicySnapshot(tempDir, "win32", parentA)),
		});
		assert.equal(aTools.includes("bash"), false, "parent A's ceiling must survive parent B's write");
		assert.equal(aTools.includes("powershell"), false, "parent A's powershell ceiling does not invent a powershell tool");
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

// 20. owner key 不能逃出 state 目录：非法字符的 key 被 hash 成安全文件名
test("shell policy owner keys cannot escape the state directory", () => {
	const tempDir = mkdtempSync(join(tmpdir(), "pideck-shell-owner-path-"));
	try {
		const traversal = shellPolicySnapshotPath(tempDir, "../../evil");
		assert.equal(traversal.startsWith(join(tempDir, "change-pi-prompt")), true, "a traversal owner key must stay inside the state directory");
		assert.equal(shellPolicyOwnerToken("../../evil").startsWith("h-"), true);
		assert.notEqual(shellPolicyOwnerToken(".."), "..");
		assert.equal(shellPolicyOwnerToken("..").startsWith("h-"), true, "reserved names are hashed, not used verbatim");
		assert.equal(shellPolicyOwnerToken("11111111-2222-3333-4444-555555555555"), "11111111-2222-3333-4444-555555555555");
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

// 21. 全局 provider superset：Parent B inactive 某工具，不得从共享 settings.json 删掉 Parent A 需要的 provider
test("an inactive parent session never evicts another session's provider", async () => {
	const tempDir = mkdtempSync(join(tmpdir(), "pideck-provider-superset-"));
	try {
		const webSearchPath = join(tempDir, "web-search.ts");
		writeFileSync(webSearchPath, "// web search", "utf8");
		const catalog = loadSubagentCatalog(join(process.cwd(), "resources/extensions/pideck-q-subagents"));
		const changePiPromptPath = join(process.cwd(), "resources/extensions/pideck-q-change-pi-prompt.ts");
		const parentTools = [
			{ name: "read", sourceInfo: { source: "builtin" } },
			{ name: "web_search", sourceInfo: { source: "file", path: webSearchPath } },
		];

		// Parent A：web_search active -> researcher 注入 provider
		const resA = await reconcileChildEnvironments({
			agentDir: tempDir,
			catalog,
			parentTools,
			parentActiveTools: ["read", "web_search"],
			platform: "linux",
			shellPolicy: { bash: false, powershell: false },
			shellPolicyOwnerKey: "session-a",
			changePiPromptPath,
		});
		// researcher 还声明了 fetch_content / get_search_content / source_check，本例只关心 web_search：
		// 以 web_search 是否进入 injectedExtensions 为准，不断言整个 agent 的 ok。
		assert.equal(resA.compatibilityStatus.get("researcher").missingTools.includes("web_search"), false);
		assert.equal(resA.compatibilityStatus.get("researcher").injectedExtensions.includes(webSearchPath), true);
		const afterA = JSON.parse(readFileSync(join(tempDir, "settings.json"), "utf8"));
		assert.ok(afterA.subagents.agentOverrides.researcher.subagentOnlyExtensions.includes(webSearchPath));

		// Parent B：同一个注册表但 web_search inactive -> 不得删除 A 的 provider
		const resB = await reconcileChildEnvironments({
			agentDir: tempDir,
			catalog,
			parentTools,
			parentActiveTools: ["read"],
			platform: "linux",
			shellPolicy: { bash: false, powershell: false },
			shellPolicyOwnerKey: "session-b",
			changePiPromptPath,
		});
		// 对 B 自己来说 web_search 不可用（permission ceiling 生效）
		assert.equal(resB.compatibilityStatus.get("researcher").missingTools.includes("web_search"), true);
		// 但共享 superset 仍然保留 provider，A 后续启动 researcher 仍能加载
		const afterB = JSON.parse(readFileSync(join(tempDir, "settings.json"), "utf8"));
		assert.ok(
			afterB.subagents.agentOverrides.researcher.subagentOnlyExtensions.includes(webSearchPath),
			"an inactive parent must not evict a provider other sessions need",
		);
		const managedB = JSON.parse(readFileSync(join(tempDir, "change-pi-prompt", "managed-child-extensions.json"), "utf8"));
		assert.ok(managedB.managedPaths.includes(webSearchPath), "the managed superset must keep the still-existing provider");
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

// 21b. 最强形式：Parent B 的注册表里根本没有这个 provider（不只是 inactive）。
//      provider 的存在性不能由“当前 parent 能否看到它”来推断，否则 B 会把自己看不见的 superset 条目删掉。
test("a parent whose registry lacks the provider still does not evict it", async () => {
	const tempDir = mkdtempSync(join(tmpdir(), "pideck-provider-absent-"));
	try {
		const webSearchPath = join(tempDir, "web-search.ts");
		writeFileSync(webSearchPath, "// web search", "utf8");
		const catalog = loadSubagentCatalog(join(process.cwd(), "resources/extensions/pideck-q-subagents"));
		const changePiPromptPath = join(process.cwd(), "resources/extensions/pideck-q-change-pi-prompt.ts");
		const base = { agentDir: tempDir, catalog, platform: "linux", shellPolicy: { bash: false, powershell: false }, changePiPromptPath };

		// Parent A：注册并启用了 web_search，于是它把 provider 写进共享 superset。
		await reconcileChildEnvironments({
			...base,
			parentTools: [
				{ name: "read", sourceInfo: { source: "builtin" } },
				{ name: "web_search", sourceInfo: { source: "file", path: webSearchPath } },
			],
			parentActiveTools: ["read", "web_search"],
			shellPolicyOwnerKey: "session-a",
		});
		const afterA = JSON.parse(readFileSync(join(tempDir, "settings.json"), "utf8"));
		assert.ok(afterA.subagents.agentOverrides.researcher.subagentOnlyExtensions.includes(webSearchPath));

		// Parent B：注册表里完全没有 web_search（工具未安装/未加载），而且当前 inactive。
		// 此时 resolveLoadableToolProvider 返回 loadable=false；但 superset 的既有条目必须原样保留，
		// 因为“本 session 看不见”并不等于“文件不存在，可以删”。
		const resB = await reconcileChildEnvironments({
			...base,
			parentTools: [{ name: "read", sourceInfo: { source: "builtin" } }],
			parentActiveTools: ["read"],
			shellPolicyOwnerKey: "session-b",
		});

		// B 自己：provider 不可加载，因此它的 researcher 确实缺少 web_search。
		assert.equal(resB.compatibilityStatus.get("researcher").missingTools.includes("web_search"), true);

		// 但共享 superset 与 managed state 都不得因为 B 看不见而丢弃这个仍然存在的文件。
		const afterB = JSON.parse(readFileSync(join(tempDir, "settings.json"), "utf8"));
		assert.ok(
			afterB.subagents.agentOverrides.researcher.subagentOnlyExtensions.includes(webSearchPath),
			"a parent that cannot see the provider must not evict it from the shared superset",
		);
		const managedB = JSON.parse(readFileSync(join(tempDir, "change-pi-prompt", "managed-child-extensions.json"), "utf8"));
		assert.ok(managedB.managedPaths.includes(webSearchPath), "managed superset keeps the still-existing provider file");
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

// 22. 两个 parent 各自发现不同 provider：无论写入顺序，最终必须是并集（不能 last-writer-wins）
test("provider discoveries from parallel parents union instead of overwriting", async () => {
	const tempDir = mkdtempSync(join(tmpdir(), "pideck-provider-union-"));
	try {
		const providerA = join(tempDir, "provider-a.ts");
		const providerB = join(tempDir, "provider-b.ts");
		writeFileSync(providerA, "// a", "utf8");
		writeFileSync(providerB, "// b", "utf8");
		const catalog = loadSubagentCatalog(join(process.cwd(), "resources/extensions/pideck-q-subagents"));
		const changePiPromptPath = join(process.cwd(), "resources/extensions/pideck-q-change-pi-prompt.ts");
		const toolsA = [{ name: "read", sourceInfo: { source: "builtin" } }, { name: "web_search", sourceInfo: { source: "file", path: providerA } }];
		const toolsB = [{ name: "read", sourceInfo: { source: "builtin" } }, { name: "fetch_content", sourceInfo: { source: "file", path: providerB } }];
		const base = { agentDir: tempDir, catalog, platform: "linux", shellPolicy: { bash: false, powershell: false }, changePiPromptPath };

		// A 写，然后 B 写
		await reconcileChildEnvironments({ ...base, parentTools: toolsA, parentActiveTools: ["read", "web_search"], shellPolicyOwnerKey: "session-a" });
		await reconcileChildEnvironments({ ...base, parentTools: toolsB, parentActiveTools: ["read", "fetch_content"], shellPolicyOwnerKey: "session-b" });
		let settings = JSON.parse(readFileSync(join(tempDir, "settings.json"), "utf8"));
		let researcher = settings.subagents.agentOverrides.researcher.subagentOnlyExtensions;
		assert.ok(researcher.includes(providerA), "A's provider must survive B's write");
		assert.ok(researcher.includes(providerB), "B's provider must be added");

		// 反向：B 先写、A 后写（回到空目录）也一样得到并集
		rmSync(join(tempDir, "settings.json"), { force: true });
		rmSync(join(tempDir, "change-pi-prompt", "managed-child-extensions.json"), { force: true });
		await reconcileChildEnvironments({ ...base, parentTools: toolsB, parentActiveTools: ["read", "fetch_content"], shellPolicyOwnerKey: "session-b" });
		await reconcileChildEnvironments({ ...base, parentTools: toolsA, parentActiveTools: ["read", "web_search"], shellPolicyOwnerKey: "session-a" });
		settings = JSON.parse(readFileSync(join(tempDir, "settings.json"), "utf8"));
		researcher = settings.subagents.agentOverrides.researcher.subagentOnlyExtensions;
		assert.ok(researcher.includes(providerA));
		assert.ok(researcher.includes(providerB));
		const managed = JSON.parse(readFileSync(join(tempDir, "change-pi-prompt", "managed-child-extensions.json"), "utf8"));
		assert.ok(managed.managedPaths.includes(providerA));
		assert.ok(managed.managedPaths.includes(providerB));
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

// 23. 全局加载 provider != 每个 session 都获得该工具：inactive parent 的 child 必须 prune
//     并且 Parent A 自己的 child 仍然保留同一个工具
test("a globally loaded provider does not become active in a session that did not enable it", async () => {
	const tempDir = mkdtempSync(join(tmpdir(), "pideck-provider-ceiling-"));
	try {
		const webSearchPath = join(tempDir, "web-search.ts");
		writeFileSync(webSearchPath, "// web search", "utf8");
		const catalog = loadSubagentCatalog(join(process.cwd(), "resources/extensions/pideck-q-subagents"));
		const changePiPromptPath = join(process.cwd(), "resources/extensions/pideck-q-change-pi-prompt.ts");
		const parentTools = [
			{ name: "read", sourceInfo: { source: "builtin" } },
			{ name: "grep", sourceInfo: { source: "builtin" } },
			{ name: "web_search", sourceInfo: { source: "file", path: webSearchPath } },
		];
		const base = { agentDir: tempDir, catalog, parentTools, platform: "linux", shellPolicy: { bash: false, powershell: false }, changePiPromptPath };

		// 共享 settings 已包含 provider（因为全局 superset 保留它）
		await reconcileChildEnvironments({ ...base, parentActiveTools: ["read", "grep", "web_search"], shellPolicyOwnerKey: "session-a" });
		await reconcileChildEnvironments({ ...base, parentActiveTools: ["read", "grep"], shellPolicyOwnerKey: "session-b" });

		// child 已经因为全局 superset 注册了 web_search，但 B 的 owner policy 不允许它
		const registeredTools = [
			{ name: "read", sourceInfo: { source: "builtin" } },
			{ name: "grep", sourceInfo: { source: "builtin" } },
			{ name: "web_search", sourceInfo: { source: "file", path: webSearchPath } },
		];
		const childActive = ["read", "grep", "web_search"];

		const bPolicy = readEffectiveShellPolicySnapshot(tempDir, "linux", "session-b");
		const bPruned = reconcileChildExtensionTools({
			registeredTools,
			activeTools: childActive,
			parentActiveTools: toParentActiveTools(bPolicy),
		});
		assert.equal(bPruned.includes("web_search"), false, "parent B's child must not keep a tool B did not enable");
		assert.deepEqual(bPruned, ["read", "grep"]);

		// 同一个 child 形态，但 Parent A 允许 web_search -> 保留
		const aPolicy = readEffectiveShellPolicySnapshot(tempDir, "linux", "session-a");
		const aPruned = reconcileChildExtensionTools({
			registeredTools,
			activeTools: childActive,
			parentActiveTools: toParentActiveTools(aPolicy),
		});
		assert.deepEqual(aPruned, ["read", "grep", "web_search"]);

		// 没有 version 2 snapshot（旧 parent / 文件缺失）：保持旧行为，不误删
		assert.deepEqual(
			reconcileChildExtensionTools({ registeredTools, activeTools: childActive, parentActiveTools: undefined }),
			childActive,
		);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

// 24. builtin / pi-subagents 内部工具不会被 parent activeTools 误 prune
test("builtin and pi-subagents internal child tools survive the parent ceiling", () => {
	const registeredTools = [
		{ name: "read", sourceInfo: { source: "builtin" } },
		{ name: "grep", sourceInfo: { source: "builtin" } },
		{ name: "find", sourceInfo: { source: "builtin" } },
		{ name: "ls", sourceInfo: { source: "builtin" } },
		{ name: "contact_supervisor", sourceInfo: { source: "npm:pi-subagents" } },
	];
	const childActive = ["read", "grep", "find", "ls", "contact_supervisor"];

	// parent 只 active 了 read：其余全部仍是 child runtime 自己提供的工具
	const pruned = reconcileChildExtensionTools({ registeredTools, activeTools: childActive, parentActiveTools: ["read"] });
	assert.deepEqual(pruned, childActive);

	assert.equal(isBuiltinOrInternalChildTool("contact_supervisor"), true);
	assert.equal(isBuiltinOrInternalChildTool("structured_output"), true);
	assert.equal(isBuiltinOrInternalChildTool("bg_wait"), true);
	assert.equal(isBuiltinOrInternalChildTool("subagent_supervisor"), true);
	assert.equal(isBuiltinOrInternalChildTool("web_search"), false);

	// registry 标记为 builtin 的工具同样不受 ceiling 影响；未知工具不猜、不删
	assert.deepEqual(
		reconcileChildExtensionTools({ registeredTools, activeTools: ["read", "mystery"], parentActiveTools: [] }),
		["read", "mystery"],
	);
});

// 25. managed state / settings 只清理“文件真正不存在”的 provider，不因 inactive 而删
test("stale managed provider paths are pruned only when the file is really gone", async () => {
	const tempDir = mkdtempSync(join(tmpdir(), "pideck-provider-stale-"));
	try {
		const alivePath = join(tempDir, "alive-provider.ts");
		const gonePath = join(tempDir, "gone-provider.ts");
		writeFileSync(alivePath, "// alive", "utf8");
		writeFileSync(gonePath, "// gone", "utf8");
		const stateDir = join(tempDir, "change-pi-prompt");
		mkdirSync(stateDir, { recursive: true });
		writeFileSync(
			join(stateDir, "managed-child-extensions.json"),
			JSON.stringify({ version: 1, managedPaths: [alivePath, gonePath] }),
			"utf8",
		);
		writeFileSync(
			join(tempDir, "settings.json"),
			JSON.stringify({ subagents: { agentOverrides: { researcher: { subagentOnlyExtensions: [alivePath, gonePath] } } } }),
			"utf8",
		);

		// gone-provider.ts 已删除，alive-provider.ts 仍在但本 session inactive
		rmSync(gonePath, { force: true });

		const catalog = loadSubagentCatalog(join(process.cwd(), "resources/extensions/pideck-q-subagents"));
		const res = await reconcileChildEnvironments({
			agentDir: tempDir,
			catalog,
			parentTools: [{ name: "read", sourceInfo: { source: "builtin" } }],
			parentActiveTools: ["read"],
			platform: "linux",
			shellPolicy: { bash: false, powershell: false },
			shellPolicyOwnerKey: "session-a",
			changePiPromptPath: join(process.cwd(), "resources/extensions/pideck-q-change-pi-prompt.ts"),
		});

		const managed = JSON.parse(readFileSync(join(stateDir, "managed-child-extensions.json"), "utf8"));
		assert.ok(managed.managedPaths.includes(alivePath), "an existing provider must survive even when inactive");
		assert.equal(managed.managedPaths.includes(gonePath), false, "a provider whose file is gone must be pruned");
		assert.equal(res.managedPaths.includes(gonePath), false);

		const settings = JSON.parse(readFileSync(join(tempDir, "settings.json"), "utf8"));
		const kept = settings.subagents.agentOverrides.researcher.subagentOnlyExtensions;
		assert.ok(kept.includes(alivePath), "settings must keep the still-existing managed provider");
		assert.equal(kept.includes(gonePath), false, "settings must drop the deleted managed provider");
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

// 26. reconciliation lock：串行化的 read-merge-write 不丢失并发写，且 stale lock 可回收
test("the reconciliation lock serializes shared writes and reclaims stale locks", async () => {
	const tempDir = mkdtempSync(join(tmpdir(), "pideck-reconcile-lock-"));
	try {
		const lockPath = reconciliationLockPath(tempDir);

		// 逻辑层：B 在 A 之后读取最新 settings -> 并集
		const seen = [];
		const order = [];
		let shared = { providers: [] };
		const writer = (label, provider) => withReconciliationLock(tempDir, () => {
			// 模拟“锁内重新 read 最新文件”
			const current = JSON.parse(JSON.stringify(shared));
			seen.push({ label, current: [...current.providers] });
			shared = { providers: [...new Set([...current.providers, provider])] };
			order.push(label);
		});
		await writer("a", "provider-a");
		await writer("b", "provider-b");
		assert.deepEqual(order, ["a", "b"]);
		assert.deepEqual(seen[1].current, ["provider-a"], "the second writer must observe the first writer's result");
		assert.deepEqual(shared.providers, ["provider-a", "provider-b"]);

		// 锁在 fn 结束后必须释放
		assert.equal(existsSync(lockPath), false, "the lock must be released after the callback");

		// stale lock 可回收：createdAt 远早于阈值
		mkdirSync(join(tempDir, "change-pi-prompt"), { recursive: true });
		writeFileSync(lockPath, JSON.stringify({ pid: 999999, createdAt: Date.now() - 120_000 }), "utf8");
		let reclaimed = false;
		await withReconciliationLock(tempDir, () => { reclaimed = true; });
		assert.equal(reclaimed, true, "an abandoned lock must be reclaimed");

		// 新鲜 lock：不抢占，超时后 fail conservative（返回 undefined），且不破坏锁
		writeFileSync(lockPath, JSON.stringify({ pid: process.pid, createdAt: Date.now() }), "utf8");
		let ranWhileHeld = false;
		const waited = [];
		const result = await withReconciliationLock(tempDir, () => { ranWhileHeld = true; }, {
			timeoutMs: 120,
			retryMs: 40,
			wait: async (delay) => { waited.push(delay); },
		});
		assert.equal(result, undefined, "a held lock must fail conservative instead of running the merge");
		assert.equal(ranWhileHeld, false, "a held lock must never let another writer inside");
		assert.ok(waited.length > 0, "the lock must retry instead of giving up immediately");
		assert.equal(existsSync(lockPath), true, "a lock owned by someone else must not be removed");

		// reconciliation 拿不到锁时必须返回 undefined（不写任何共享文件）
		const res = await reconcileChildEnvironments({
			agentDir: tempDir,
			catalog: undefined,
			parentTools: [],
			parentActiveTools: [],
			platform: "linux",
			shellPolicy: { bash: false, powershell: false },
			shellPolicyOwnerKey: "session-a",
			lock: { timeoutMs: 60, retryMs: 30, wait: async () => {} },
		});
		assert.equal(res, undefined, "reconciliation must fail conservative when the lock is unavailable");
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

// 27. child 的 extension ceiling 是 prune-only：不会因为 parent active 而新增工具
test("the child extension ceiling only prunes and never adds tools", () => {
	const registeredTools = [
		{ name: "read", sourceInfo: { source: "builtin" } },
		{ name: "web_search", sourceInfo: { source: "file", path: "C:\\tools\\web-search.ts" } },
	];
	// parent 允许 web_search，但 child 自己没 active 它 -> 不得主动添加
	const pruned = reconcileChildExtensionTools({
		registeredTools,
		activeTools: ["read"],
		parentActiveTools: ["read", "web_search"],
	});
	assert.deepEqual(pruned, ["read"], "a plain extension tool must never be added by the ceiling");
});

// 28. 端到端：child before_agent_start 先 prun 掉 parent 未启用的 extension tool，再做 shell canonicalization，
//     最后根据最终 active tools 生成 Child Tool Environment（顺序不得颠倒）
test("child before_agent_start applies the owner extension ceiling before rendering the tool environment", async () => {
	const tempDir = mkdtempSync(join(tmpdir(), "pideck-child-extension-ceiling-"));
	const previousOwner = process.env[SHELL_POLICY_OWNER_ENV];
	try {
		const webSearchPath = join(tempDir, "web-search.ts");
		writeFileSync(webSearchPath, "// web search", "utf8");
		const owner = "session-b";
		// Parent B 的 owner policy：允许 read/grep，不允许 web_search
		mkdirSync(join(tempDir, "change-pi-prompt"), { recursive: true });
		writeFileSync(
			shellPolicySnapshotPath(tempDir, owner),
			JSON.stringify({ version: 2, platform: "linux", shell: { bash: false, powershell: false }, parentActiveTools: ["read", "grep"] }),
			"utf8",
		);
		process.env[SHELL_POLICY_OWNER_ENV] = owner;

		const registeredTools = [
			{ name: "read", sourceInfo: { source: "builtin" } },
			{ name: "grep", sourceInfo: { source: "builtin" } },
			{ name: "contact_supervisor", sourceInfo: { source: "npm:pi-subagents" } },
			// 全局 superset 已注册，所以 child 确实看得见 web_search
			{ name: "web_search", sourceInfo: { source: "file", path: webSearchPath } },
		];

		const { mockPi, setTools, getHandler } = createMockPi();
		setTools(registeredTools);
		mockPi.setActiveTools(["read", "grep", "contact_supervisor", "web_search"]);
		registerPromptExtension(mockPi, tempDir, {
			probeHost: { platform: "linux", env: {}, exists: () => false },
			isStandalone: () => true,
		});
		const ctx = { hasUI: true, ui: { notify: () => {}, editor: async () => undefined } };

		const childPrompt = `<active_agent name="reviewer"/>\n\nYou are a disciplined review subagent.`;
		const result = await getHandler("before_agent_start")({ systemPrompt: childPrompt, systemPromptOptions: {} }, ctx);

		// parent 未启用的 extension tool 被 prune，builtin/internal 不受影响
		const active = mockPi.getActiveTools();
		assert.equal(active.includes("web_search"), false, "the child must not keep a tool its parent did not enable");
		assert.equal(active.includes("contact_supervisor"), true, "internal tools must survive the ceiling");
		assert.equal(active.includes("read"), true);

		// prompt 必须在最终 active tools 之后生成，且角色 prompt 保留
		assert.ok(result, "child prompt must be injected");
		assert.ok(result.systemPrompt.startsWith(childPrompt), "role prompt must be byte-preserved");
		assert.ok(result.systemPrompt.includes("No shell tool is available"));
	} finally {
		if (previousOwner === undefined) delete process.env[SHELL_POLICY_OWNER_ENV];
		else process.env[SHELL_POLICY_OWNER_ENV] = previousOwner;
		rmSync(tempDir, { recursive: true, force: true });
	}
});

// 18. 确认没有修改 resources/extensions/pideck-q-subagents/**
test("pideck-q-subagents directory was not modified", () => {
	const status = execSync("git status --porcelain resources/extensions/pideck-q-subagents", { encoding: "utf8" });
	assert.equal(status.trim(), "", "resources/extensions/pideck-q-subagents must be 100% untouched");
});
