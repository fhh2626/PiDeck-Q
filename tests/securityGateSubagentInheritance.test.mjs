import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize, resolve } from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);

/** processStub 让测试控制 cwd/env，用来区分「兄弟路径回退」与「cwd 回退」两条解析路径。 */
function loadChildLaunchModule(processStub = process) {
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
					effectiveMcpSelections: [],
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
		process: processStub,
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

/** The Pi runtime UUID and the PiDeck security UUID are different identity domains. */
for (const host of ["parent", "runner"]) {
	for (const [label, environmentId, explicitId, expected] of [
		["inherits the PiDeck identity, not the Pi runtime UUID", "deck-session-uuid", undefined, "deck-session-uuid"],
		["explicit security identity wins over inherited environment", "deck-session-uuid", "explicit-deck-uuid", "explicit-deck-uuid"],
		["CLI without desktop identity falls back to the Pi parent", undefined, undefined, "pi-session-uuid"],
	]) {
		test(`child-launch ${host}: ${label}`, () => {
			const { buildInProcessChildLaunch } = loadChildLaunchModule({
				env: { PIDECK_SESSION_ID: environmentId }, cwd: () => process.cwd(), platform: process.platform,
			});
			const launch = buildInProcessChildLaunch({
				cwd: process.cwd(), host, childAgentName: "readonly", childIndex: 0, sessionEnabled: false,
				inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false,
				parentSessionId: "pi-session-uuid", securityConfigPath: "fixture-only-policy.json",
				securitySessionId: explicitId,
			});
			assert.equal(launch.session.processEnv.PIDECK_SESSION_ID, expected);
			assert.equal(launch.config.parentSessionId, "pi-session-uuid", "routing keeps the Pi identity");
		});
	}
}

test("child-launch: sibling fallback resolves the gate from shared/ even when cwd is elsewhere", () => {
	// 回归：兄弟路径必须是 shared -> runs -> src -> pideck-q-subagents -> extensions 四级上溯。
	// 上溯层数错误时，cwd 回退（resources/extensions/...）会在仓库根目录下掩盖问题，
	// 所以把 cwd 指到一个没有 resources/ 的临时目录，强制只能靠兄弟路径解析。
	const emptyCwd = mkdtempSync(join(tmpdir(), "pideck-sec-sibling-"));
	try {
		const { resolveSecurityGateExtensionPath } = loadChildLaunchModule({
			env: {},
			cwd: () => emptyCwd,
			platform: process.platform,
		});
		const gatePath = resolveSecurityGateExtensionPath();
		assert.ok(gatePath, "sibling fallback must find the gate without relying on cwd");
		assert.equal(normalize(gatePath), normalize(resolve("resources/extensions/pi-deck-security-gate.ts")));
	} finally {
		rmSync(emptyCwd, { recursive: true, force: true });
	}
});

test("child-launch: PIDECK_SECURITY_GATE_EXTENSION wins when it exists and is ignored when stale", () => {
	const dir = mkdtempSync(join(tmpdir(), "pideck-sec-envgate-"));
	try {
		const fakeGate = join(dir, "custom-gate.ts");
		writeFileSync(fakeGate, "// fake", "utf8");
		const real = normalize(resolve("resources/extensions/pi-deck-security-gate.ts"));
		const withEnv = loadChildLaunchModule({ env: { PIDECK_SECURITY_GATE_EXTENSION: fakeGate }, cwd: () => dir, platform: process.platform });
		assert.equal(withEnv.resolveSecurityGateExtensionPath(), fakeGate);
		const stale = loadChildLaunchModule({ env: { PIDECK_SECURITY_GATE_EXTENSION: join(dir, "gone.ts") }, cwd: () => dir, platform: process.platform });
		assert.equal(normalize(stale.resolveSecurityGateExtensionPath()), real, "stale env path falls back to the sibling file");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
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
		assert.equal(isSecurityPolicyActive(disabledPath), true, "disabled snapshots still inject the gate so handlers can hot-reload");

		// 只要配置了路径（即使不存在或非法），isSecurityPolicyActive 都返回 true（fail-closed）
		assert.equal(isSecurityPolicyActive(join(tempDir, "nonexistent.json")), true);
		assert.equal(isSecurityPolicyActive(""), false);
		assert.equal(isSecurityPolicyActive(undefined), false);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

test("child-launch: inherits security policy into foreground (parent) and runner child", () => {
	// Exercise the CLI fallback independently of the hosting desktop's identity.
	const { buildInProcessChildLaunch, resolveSecurityGateExtensionPath } = loadChildLaunchModule({
		env: { ...process.env, PIDECK_SESSION_ID: undefined }, cwd: () => process.cwd(), platform: process.platform,
	});
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

		// 4. Security currently disabled: still inject gate + config so child tools can hot-reload if the parent later enables it.
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
			disabledLaunch.session.extensionPaths.some((p) => normalize(p) === normalize(gatePath)),
			"Disabled security still injects Security Gate so tool_call can honor later enablement",
		);
		assert.equal(disabledLaunch.session.processEnv?.PIDECK_SECURITY_CONFIG, disabledConfigPath);
		assert.equal(disabledLaunch.session.processEnv?.PIDECK_SESSION_ID, "parent-session-123");

		// 5. Config file missing: still inject gate + config so child tools fail-closed
		const missingConfigPath = join(tempDir, "nonexistent-policy.json");
		const missingLaunch = buildInProcessChildLaunch({
			cwd: tempDir,
			childAgentName: "worker",
			childIndex: 0,
			sessionEnabled: true,
			inheritProjectContext: false,
			inheritGlobalContext: false,
			inheritSkills: false,
			host: "parent",
			parentSessionId: "parent-session-123",
			securityConfigPath: missingConfigPath,
		});
		assert.ok(
			missingLaunch.session.extensionPaths.some((p) => normalize(p) === normalize(gatePath)),
			"Missing config path must still inject Security Gate",
		);
		assert.equal(missingLaunch.session.processEnv?.PIDECK_SECURITY_CONFIG, missingConfigPath);
		assert.equal(missingLaunch.session.processEnv?.PIDECK_SESSION_ID, "parent-session-123");

		// 6. Config file invalid JSON: still inject gate + config so child tools fail-closed
		const invalidConfigPath = join(tempDir, "invalid-policy.json");
		writeFileSync(invalidConfigPath, "MALFORMED_JSON{{{");
		const invalidLaunch = buildInProcessChildLaunch({
			cwd: tempDir,
			childAgentName: "worker",
			childIndex: 0,
			sessionEnabled: true,
			inheritProjectContext: false,
			inheritGlobalContext: false,
			inheritSkills: false,
			host: "parent",
			parentSessionId: "parent-session-123",
			securityConfigPath: invalidConfigPath,
		});
		assert.ok(
			invalidLaunch.session.extensionPaths.some((p) => normalize(p) === normalize(gatePath)),
			"Invalid JSON config path must still inject Security Gate",
		);
		assert.equal(invalidLaunch.session.processEnv?.PIDECK_SECURITY_CONFIG, invalidConfigPath);
		assert.equal(invalidLaunch.session.processEnv?.PIDECK_SESSION_ID, "parent-session-123");
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
		levels: [
			{
				id: "strict",
				name: "Strict",
				description: "Strict mode",
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

test("Scenario E: Missing or corrupted snapshot blocks child tools (fail-closed)", async () => {
	const tempDir = mkdtempSync(join(tmpdir(), "pideck-sec-scen-e-"));
	const missingConfigPath = join(tempDir, "missing-policy.json");
	const invalidConfigPath = join(tempDir, "invalid-policy.json");
	writeFileSync(invalidConfigPath, "MALFORMED_JSON{{{");

	const { buildInProcessChildLaunch } = loadChildLaunchModule();

	// 1. 缺失快照文件
	const missingLaunch = buildInProcessChildLaunch({
		cwd: tempDir,
		childAgentName: "worker",
		childIndex: 0,
		sessionEnabled: true,
		inheritProjectContext: false,
		inheritGlobalContext: false,
		inheritSkills: false,
		host: "parent",
		parentSessionId: "parent-session-missing",
		securityConfigPath: missingConfigPath,
	});
	const missingGate = await loadChildSecurityGate(missingLaunch.session.processEnv);

	try {
		const ctx = { cwd: tempDir, hasUI: false };
		const res = await missingGate.toolCall({
			toolName: "bash",
			input: { command: "echo test" },
		}, ctx);
		assert.equal(res?.block, true, "Missing policy must block child tool");
		assert.match(res?.reason ?? "", /SECURITY_POLICY_UNAVAILABLE/);
	} finally {
		missingGate.cleanup();
	}

	// 2. 损坏快照文件
	const invalidLaunch = buildInProcessChildLaunch({
		cwd: tempDir,
		childAgentName: "worker",
		childIndex: 0,
		sessionEnabled: true,
		inheritProjectContext: false,
		inheritGlobalContext: false,
		inheritSkills: false,
		host: "parent",
		parentSessionId: "parent-session-invalid",
		securityConfigPath: invalidConfigPath,
	});
	const invalidGate = await loadChildSecurityGate(invalidLaunch.session.processEnv);

	try {
		const ctx = { cwd: tempDir, hasUI: false };
		const res = await invalidGate.toolCall({
			toolName: "write",
			input: { path: join(tempDir, "a.txt"), content: "x" },
		}, ctx);
		assert.equal(res?.block, true, "Corrupted policy must block child tool");
		assert.match(res?.reason ?? "", /SECURITY_POLICY_UNAVAILABLE/);
	} finally {
		invalidGate.cleanup();
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

	// The desktop policy UUID deliberately differs from the underlying Pi UUID.
	const desktopEnv = { PIDECK_SESSION_ID: "parent-standard-session" };
	const { buildInProcessChildLaunch } = loadChildLaunchModule({
		env: desktopEnv, cwd: () => process.cwd(), platform: process.platform,
	});

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
		parentSessionId: "pi-runtime-standard-session",
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
	desktopEnv.PIDECK_SESSION_ID = "parent-strict-session";
	const strictLaunch = buildInProcessChildLaunch({
		cwd: workspaceDir,
		childAgentName: "worker",
		childIndex: 0,
		sessionEnabled: true,
		inheritProjectContext: false,
		inheritGlobalContext: false,
		inheritSkills: false,
		host: "parent",
		parentSessionId: "pi-runtime-strict-session",
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
