import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize, resolve } from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);

function loadChildLaunchModule() {
	const rawSource = readFileSync(
		"resources/extensions/pideck-q-subagents/src/runs/shared/child-launch.ts",
		"utf8",
	);
	const resolvedFileUrl = JSON.stringify(
		new URL("file:///" + resolve("resources/extensions/pideck-q-subagents/src/runs/shared/child-launch.ts").replace(/\\/g, "/")).href,
	);
	const source = rawSource.replaceAll("import.meta.url", resolvedFileUrl);
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	});

	const gateExtensionPath = resolve("resources/extensions/pi-deck-security-gate.ts");

	const sandbox = {
		exports: {},
		require: (id) => {
			if (id.startsWith("node:")) return require(id);
			return {
				resolvePiLaunchToolPlan: (x) => ({
					extensionArgs: x.extensions ? [...x.extensions] : [],
					requiredChildTools: [],
					effectiveMcpTools: [],
					excludeTools: x.excludeTools ?? [],
					effectiveToolAllowlist: x.tools ?? ["read", "write", "edit", "bash", "powershell"],
					explicitToolAllowlist: Boolean(x.tools),
					disableAmbientExtensions: false,
					runtimeExtensions: [],
					configuredExtensions: [],
				}),
				isSubagentRuntimeExtensionPath: () => false,
				projectLaunchResolvedChildExtensions: () => ({}),
				createCapturedChildHooks: () => ({ hooks: [] }),
				withChildSessionErrorReporting: (x) => x,
				resolveChildDepth: () => ({ depth: 1, maxDepth: 2 }),
				intersectThinkingCeilings: () => undefined,
				encodeExtensionBindings: () => "{}",
				PI_SUBAGENT_EXTENSION_BINDINGS_ENV: "PI_SUBAGENT_EXTENSION_BINDINGS",
				MCP_DIRECT_TOOLS_ENV: "MCP_DIRECT_TOOLS",
				supervisorChannelDir: () => "temp",
			};
		},
		console,
		process,
		__dirname: resolve("resources/extensions/pideck-q-subagents/src/runs/shared"),
	};

	vm.runInNewContext(outputText, sandbox, { filename: "child-launch.ts" });
	return sandbox.exports;
}

async function loadChildSecurityGate(processEnvOverrides = {}) {
	const source = readFileSync("resources/extensions/pi-deck-security-gate.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	});

	const handlers = new Map();
	const fakePi = {
		on: (event, handler) => {
			handlers.set(event, handler);
		},
	};

	const originalEnv = { ...process.env };
	Object.assign(process.env, processEnvOverrides);

	const sandbox = {
		exports: {},
		require,
		console,
		process,
	};
	vm.runInNewContext(outputText, sandbox, { filename: "pi-deck-security-gate.ts" });
	await sandbox.exports.default(fakePi);

	return {
		toolCall: async (event, ctx) => {
			const fn = handlers.get("tool_call");
			if (!fn) throw new Error("tool_call handler not registered");
			return await fn(event, ctx);
		},
		beforeAgentStart: async (event, ctx) => {
			const fn = handlers.get("before_agent_start");
			if (!fn) return undefined;
			return await fn(event, ctx);
		},
		cleanup: () => {
			process.env = originalEnv;
		},
	};
}

test("child-launch: sibling fallback uses four parents from shared/, not five", () => {
	const source = readFileSync(
		"resources/extensions/pideck-q-subagents/src/runs/shared/child-launch.ts",
		"utf8",
	);
	assert.match(
		source,
		/"\.\.\/\.\.\/\.\.\/\.\.\/pi-deck-security-gate\.ts"/,
		"fallback must be ../../../../pi-deck-security-gate.ts (shared -> runs -> src -> pideck-q-subagents -> extensions)",
	);
	assert.doesNotMatch(
		source,
		/"\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/pi-deck-security-gate\.ts"/,
		"five-parent fallback overshoots resources/ and must not remain",
	);
});

test("child-launch: resolveSecurityGateExtensionPath and isSecurityPolicyActive", () => {
	const { resolveSecurityGateExtensionPath, isSecurityPolicyActive } = loadChildLaunchModule();
	const previousGateEnv = process.env.PIDECK_SECURITY_GATE_EXTENSION;
	delete process.env.PIDECK_SECURITY_GATE_EXTENSION;
	let gatePath;
	try {
		gatePath = resolveSecurityGateExtensionPath();
	} finally {
		if (previousGateEnv === undefined) delete process.env.PIDECK_SECURITY_GATE_EXTENSION;
		else process.env.PIDECK_SECURITY_GATE_EXTENSION = previousGateEnv;
	}
	const expectedGate = resolve("resources/extensions/pi-deck-security-gate.ts");
	assert.ok(gatePath, "Security Gate extension path must resolve");
	assert.ok(existsSync(gatePath), "Security Gate extension file must exist on disk");
	assert.equal(normalize(gatePath), normalize(expectedGate));

	const tempDir = mkdtempSync(join(tmpdir(), "pideck-sec-active-"));
	try {
		const activePath = join(tempDir, "active.json");
		writeFileSync(activePath, JSON.stringify({ enabled: true }));
		assert.equal(isSecurityPolicyActive(activePath), true);

		const disabledPath = join(tempDir, "disabled.json");
		writeFileSync(disabledPath, JSON.stringify({ enabled: false }));
		assert.equal(isSecurityPolicyActive(disabledPath), false);

		assert.equal(isSecurityPolicyActive(join(tempDir, "nonexistent.json")), false);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

test("child-launch: inherits security policy into foreground (parent) and runner child", () => {
	const { buildInProcessChildLaunch, resolveSecurityGateExtensionPath } = loadChildLaunchModule();
	const gatePath = resolveSecurityGateExtensionPath();

	const tempDir = mkdtempSync(join(tmpdir(), "pideck-sec-launch-"));
	try {
		const configPath = join(tempDir, "policy.json");
		writeFileSync(configPath, JSON.stringify({ enabled: true, defaultLevelId: "standard" }));

		// 1. host: parent with security active
		const parentLaunch = buildInProcessChildLaunch({
			cwd: tempDir,
			childAgentName: "worker",
			childIndex: 0,
			sessionEnabled: true,
			inheritProjectContext: false,
			inheritGlobalContext: false,
			inheritSkills: false,
			host: "parent",
			parentSessionId: "parent-session-123",
			securityConfigPath: configPath,
		});

		assert.ok(
			parentLaunch.session.extensionPaths.some((p) => normalize(p) === normalize(gatePath)),
			"Foreground child must include Security Gate in extensionPaths",
		);
		assert.equal(parentLaunch.session.ambientExtensions, false, "Parent host must not enable ambient extensions");
		assert.equal(parentLaunch.session.processEnv?.PIDECK_SECURITY_CONFIG, configPath);
		assert.equal(parentLaunch.session.processEnv?.PIDECK_SESSION_ID, "parent-session-123");

		// 2. host: runner with security active
		const runnerLaunch = buildInProcessChildLaunch({
			cwd: tempDir,
			childAgentName: "worker",
			childIndex: 0,
			sessionEnabled: true,
			inheritProjectContext: false,
			inheritGlobalContext: false,
			inheritSkills: false,
			host: "runner",
			parentSessionId: "parent-session-456",
			securityConfigPath: configPath,
		});

		assert.ok(
			runnerLaunch.session.extensionPaths.some((p) => normalize(p) === normalize(gatePath)),
			"Runner child must include Security Gate in extensionPaths",
		);
		assert.equal(runnerLaunch.session.processEnv?.PIDECK_SECURITY_CONFIG, configPath);
		assert.equal(runnerLaunch.session.processEnv?.PIDECK_SESSION_ID, "parent-session-456");

		// 3. Deduplication: if security gate is already explicitly in extensions, do not duplicate
		const dedupLaunch = buildInProcessChildLaunch({
			cwd: tempDir,
			childAgentName: "worker",
			childIndex: 0,
			sessionEnabled: true,
			inheritProjectContext: false,
			inheritGlobalContext: false,
			inheritSkills: false,
			host: "parent",
			parentSessionId: "parent-session-123",
			securityConfigPath: configPath,
			extensions: [gatePath],
		});

		const gateOccurrences = dedupLaunch.session.extensionPaths.filter(
			(p) => normalize(p) === normalize(gatePath),
		);
		assert.equal(gateOccurrences.length, 1, "Security Gate extension must not be duplicated");

		// 4. Security disabled: does not inject security gate
		const disabledConfigPath = join(tempDir, "disabled-policy.json");
		writeFileSync(disabledConfigPath, JSON.stringify({ enabled: false, defaultLevelId: "standard" }));

		const disabledLaunch = buildInProcessChildLaunch({
			cwd: tempDir,
			childAgentName: "worker",
			childIndex: 0,
			sessionEnabled: true,
			inheritProjectContext: false,
			inheritGlobalContext: false,
			inheritSkills: false,
			host: "parent",
			parentSessionId: "parent-session-123",
			securityConfigPath: disabledConfigPath,
		});

		assert.ok(
			!disabledLaunch.session.extensionPaths.some((p) => normalize(p) === normalize(gatePath)),
			"Disabled security must not inject Security Gate",
		);
		assert.equal(disabledLaunch.session.processEnv?.PIDECK_SECURITY_CONFIG, undefined);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

test("Scenario A: Strict + workspace restriction blocks worker child outside-directory writes", async () => {
	const tempDir = mkdtempSync(join(tmpdir(), "pideck-sec-scen-a-"));
	const workspaceDir = join(tempDir, "workspace");
	const outsideDir = join(tempDir, "outside");
	const configPath = join(tempDir, "policy.json");

	const snapshot = {
		schemaVersion: 1,
		enabled: true,
		defaultLevelId: "strict",
		levels: [
			{
				id: "strict",
				name: "严格",
				description: "严格模式",
				toolActions: {
					read: "allow",
					write: "ask",
					edit: "ask",
					bash: "deny",
					powershell: "deny",
				},
				denyBashPatterns: [],
				denyPowerShellPatterns: [],
				pathPolicy: "workspace",
				customAllowDirs: [],
				denyDirs: [],
				protectSensitivePaths: true,
				defaultAction: "deny",
			},
		],
		sessionLevels: {
			"parent-strict-session": "strict",
		},
	};
	writeFileSync(configPath, JSON.stringify(snapshot));

	const { buildInProcessChildLaunch } = loadChildLaunchModule();
	const childLaunch = buildInProcessChildLaunch({
		cwd: workspaceDir,
		childAgentName: "worker",
		childIndex: 0,
		sessionEnabled: true,
		inheritProjectContext: false,
		inheritGlobalContext: false,
		inheritSkills: false,
		host: "parent",
		parentSessionId: "parent-strict-session",
		securityConfigPath: configPath,
	});

	// Worker child session inherits childLaunch.session.processEnv
	const gate = await loadChildSecurityGate(childLaunch.session.processEnv);

	try {
		const outsideFile = join(outsideDir, "escape.txt");
		const writeEvent = {
			toolName: "write",
			input: { path: outsideFile, content: "malicious code" },
		};
		const ctx = { cwd: workspaceDir, hasUI: false };

		// 必须拦截并拒绝工作目录外部的文件写入
		const result = await gate.toolCall(writeEvent, ctx);
		assert.ok(result?.block, "Worker child writing outside workspace must be blocked");
		assert.match(result.reason, /被拒绝/);
		assert.equal(existsSync(outsideFile), false, "Outside file must not be created");

		// 编辑外部文件也必须被拦截
		const editEvent = {
			toolName: "edit",
			input: { path: outsideFile, edits: [{ oldText: "a", newText: "b" }] },
		};
		const editResult = await gate.toolCall(editEvent, ctx);
		assert.ok(editResult?.block, "Worker child editing outside workspace must be blocked");
	} finally {
		gate.cleanup();
		rmSync(tempDir, { recursive: true, force: true });
	}
});

test("Scenario B: Dangerous shell commands are intercepted for worker child (bash and powershell)", async () => {
	const tempDir = mkdtempSync(join(tmpdir(), "pideck-sec-scen-b-"));
	const configPath = join(tempDir, "policy.json");

	const snapshot = {
		schemaVersion: 1,
		enabled: true,
		defaultLevelId: "strict",
		levels: [
			{
				id: "strict",
				name: "严格",
				description: "严格模式",
				toolActions: {
					bash: "ask",
					powershell: "ask",
				},
				denyBashPatterns: ["\\brm\\s+-[a-z]*[rf]"],
				denyPowerShellPatterns: [
					"\\b(Remove-Item|rm|del)\\b",
					"\\b(Set-Content|Out-File)\\b",
				],
				pathPolicy: "workspace",
				customAllowDirs: [],
				denyDirs: [],
				protectSensitivePaths: true,
				defaultAction: "deny",
			},
		],
		sessionLevels: {
			"parent-session-b": "strict",
		},
	};
	writeFileSync(configPath, JSON.stringify(snapshot));

	const { buildInProcessChildLaunch } = loadChildLaunchModule();
	const childLaunch = buildInProcessChildLaunch({
		cwd: tempDir,
		childAgentName: "worker",
		childIndex: 0,
		sessionEnabled: true,
		inheritProjectContext: false,
		inheritGlobalContext: false,
		inheritSkills: false,
		host: "parent",
		parentSessionId: "parent-session-b",
		securityConfigPath: configPath,
	});

	const gate = await loadChildSecurityGate(childLaunch.session.processEnv);

	try {
		const ctx = { cwd: tempDir, hasUI: false };

		// 1. 危险 bash 命令 -> 拦截
		const dangerousBash = await gate.toolCall({
			toolName: "bash",
			input: { command: "rm -rf /some/directory" },
		}, ctx);
		assert.ok(dangerousBash?.block, "Worker child running dangerous bash must be blocked");
		assert.match(dangerousBash.reason, /被拒绝/);

		// 2. 危险 PowerShell 命令 -> 拦截
		const dangerousPwsh = await gate.toolCall({
			toolName: "powershell",
			input: { command: "Remove-Item -Recurse ./project" },
		}, ctx);
		assert.ok(dangerousPwsh?.block, "Worker child running dangerous PowerShell must be blocked");
		assert.match(dangerousPwsh.reason, /被拒绝/);

		// 3. 恶意 PowerShell 管道写入 -> 拦截
		const pipelinePwsh = await gate.toolCall({
			toolName: "powershell",
			input: { command: "Get-Content foo.txt | Set-Content bar.txt" },
		}, ctx);
		assert.ok(pipelinePwsh?.block, "Worker child running PowerShell write pipeline must be blocked");
	} finally {
		gate.cleanup();
		rmSync(tempDir, { recursive: true, force: true });
	}
});

test("Scenario C: Security disabled leaves worker child tools unrestricted", async () => {
	const tempDir = mkdtempSync(join(tmpdir(), "pideck-sec-scen-c-"));
	const configPath = join(tempDir, "policy.json");

	const snapshot = {
		schemaVersion: 1,
		enabled: false, // 安全管理已关闭
		defaultLevelId: "strict",
		levels: [],
		sessionLevels: {},
	};
	writeFileSync(configPath, JSON.stringify(snapshot));

	const { buildInProcessChildLaunch } = loadChildLaunchModule();
	const childLaunch = buildInProcessChildLaunch({
		cwd: tempDir,
		childAgentName: "worker",
		childIndex: 0,
		sessionEnabled: true,
		inheritProjectContext: false,
		inheritGlobalContext: false,
		inheritSkills: false,
		host: "parent",
		parentSessionId: "parent-session-c",
		securityConfigPath: configPath,
	});

	const gate = await loadChildSecurityGate(childLaunch.session.processEnv);

	try {
		const ctx = { cwd: tempDir, hasUI: false };

		const writeCall = await gate.toolCall({
			toolName: "write",
			input: { path: join(tempDir, "test.txt"), content: "ok" },
		}, ctx);
		assert.equal(writeCall, undefined, "When security is disabled, write must be unblocked");

		const bashCall = await gate.toolCall({
			toolName: "bash",
			input: { command: "rm -rf /anything" },
		}, ctx);
		assert.equal(bashCall, undefined, "When security is disabled, bash must be unblocked");
	} finally {
		gate.cleanup();
		rmSync(tempDir, { recursive: true, force: true });
	}
});

test("Scenario D: Worker child inherits exact parent session level override without falling back", async () => {
	const tempDir = mkdtempSync(join(tmpdir(), "pideck-sec-scen-d-"));
	const workspaceDir = join(tempDir, "workspace");
	const outsideDir = join(tempDir, "outside");
	const configPath = join(tempDir, "policy.json");

	const snapshot = {
		schemaVersion: 1,
		enabled: true,
		defaultLevelId: "standard", // 全局默认是 standard
		levels: [
			{
				id: "standard",
				name: "标准",
				description: "标准模式",
				toolActions: {
					read: "allow",
					write: "allow",
					edit: "allow",
					bash: "ask",
					powershell: "ask",
				},
				denyBashPatterns: ["\\brm\\s+-[a-z]*[rf]"],
				denyPowerShellPatterns: [],
				pathPolicy: "unrestricted",
				customAllowDirs: [],
				denyDirs: [],
				protectSensitivePaths: true,
				defaultAction: "allow",
			},
			{
				id: "strict",
				name: "严格",
				description: "严格模式",
				toolActions: {
					read: "allow",
					write: "deny",
					edit: "deny",
					bash: "deny",
					powershell: "deny",
				},
				denyBashPatterns: [],
				denyPowerShellPatterns: [],
				pathPolicy: "workspace",
				customAllowDirs: [],
				denyDirs: [],
				protectSensitivePaths: true,
				defaultAction: "deny",
			},
		],
		sessionLevels: {
			"parent-standard-session": "standard",
			"parent-strict-session": "strict",
		},
	};
	writeFileSync(configPath, JSON.stringify(snapshot));

	const { buildInProcessChildLaunch } = loadChildLaunchModule();

	// 1. 父 session 是 standard -> child 继承 standard
	const standardLaunch = buildInProcessChildLaunch({
		cwd: workspaceDir,
		childAgentName: "worker",
		childIndex: 0,
		sessionEnabled: true,
		inheritProjectContext: false,
		inheritGlobalContext: false,
		inheritSkills: false,
		host: "parent",
		parentSessionId: "parent-standard-session",
		securityConfigPath: configPath,
	});

	const standardGate = await loadChildSecurityGate(standardLaunch.session.processEnv);
	try {
		const ctx = { cwd: workspaceDir, hasUI: false };
		// standard 下路径策略是 unrestricted，读外部文件放行
		const readOutside = await standardGate.toolCall({
			toolName: "read",
			input: { path: join(outsideDir, "file.txt") },
		}, ctx);
		assert.equal(readOutside, undefined, "Standard level must allow reading outside workspace");
	} finally {
		standardGate.cleanup();
	}

	// 2. 父 session 是 strict -> child 继承 strict（即使全局默认是 standard）
	const strictLaunch = buildInProcessChildLaunch({
		cwd: workspaceDir,
		childAgentName: "worker",
		childIndex: 0,
		sessionEnabled: true,
		inheritProjectContext: false,
		inheritGlobalContext: false,
		inheritSkills: false,
		host: "parent",
		parentSessionId: "parent-strict-session",
		securityConfigPath: configPath,
	});

	const strictGate = await loadChildSecurityGate(strictLaunch.session.processEnv);
	try {
		const ctx = { cwd: workspaceDir, hasUI: false };
		// strict 下读外部文件因为 workspace 限制会被拦截拒绝
		const readOutsideStrict = await strictGate.toolCall({
			toolName: "read",
			input: { path: join(outsideDir, "file.txt") },
		}, ctx);
		assert.ok(readOutsideStrict?.block, "Strict level must block reading outside workspace");
		assert.match(readOutsideStrict.reason, /严格/);
	} finally {
		strictGate.cleanup();
		rmSync(tempDir, { recursive: true, force: true });
	}
});
