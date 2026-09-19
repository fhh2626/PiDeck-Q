import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

function makeValidSnapshot(overrides = {}) {
	return {
		schemaVersion: 1,
		enabled: true,
		defaultLevelId: "standard",
		levels: [
			{
				id: "standard",
				name: "Standard",
				description: "Standard level",
				toolActions: {
					read: "allow",
					write: "ask",
					edit: "ask",
					bash: "deny",
					powershell: "deny",
					grep: "allow",
					find: "allow",
					ls: "allow",
					ask_question: "allow",
				},
				denyBashPatterns: ["\\brm\\b"],
				denyPowerShellPatterns: ["\\bRemove-Item\\b"],
				pathPolicy: "workspace",
				customAllowDirs: [],
				denyDirs: [],
				protectSensitivePaths: true,
				defaultAction: "deny",
			},
			{
				id: "off",
				name: "Off",
				description: "Off level",
				toolActions: {},
				denyBashPatterns: [],
				pathPolicy: "unrestricted",
				customAllowDirs: [],
				denyDirs: [],
				protectSensitivePaths: false,
				defaultAction: "allow",
			},
		],
		sessionLevels: {},
		...overrides,
	};
}

test("snapshot loading: unconfigured env stays inactive without blocking", async () => {
	const handlers = new Map();
	const gate = loadTsCommonJs("resources/extensions/pi-deck-security-gate.ts", {
		globals: {
			process: {
				platform: "win32",
				env: {},
			},
		},
	});
	await gate.default({ on: (name, fn) => handlers.set(name, fn) });
	const toolCall = handlers.get("tool_call");
	assert.ok(toolCall);
	const res = await toolCall({ toolName: "bash", input: { command: "rm -rf /" } }, { cwd: "C:\\w", hasUI: false });
	assert.equal(res, undefined, "unconfigured environment must not block tools");
});

test("snapshot loading: missing file blocks all 9 managed tools", async () => {
	const handlers = new Map();
	const gate = loadTsCommonJs("resources/extensions/pi-deck-security-gate.ts", {
		stubs: {
			"node:fs": {
				existsSync: () => false,
				statSync: () => { throw new Error("ENOENT"); },
				readFileSync: () => { throw new Error("ENOENT"); },
			},
		},
		globals: {
			process: {
				platform: "win32",
				env: {
					PIDECK_SECURITY_CONFIG: "C:\\policy.json",
					PIDECK_SESSION_ID: "session-1",
				},
			},
		},
	});
	await gate.default({ on: (name, fn) => handlers.set(name, fn) });
	const toolCall = handlers.get("tool_call");

	const managedTools = [
		{ toolName: "read", input: { path: "C:\\w\\a.txt" } },
		{ toolName: "write", input: { path: "C:\\w\\a.txt", content: "hi" } },
		{ toolName: "edit", input: { path: "C:\\w\\a.txt" } },
		{ toolName: "bash", input: { command: "echo 1" } },
		{ toolName: "powershell", input: { command: "Write-Output 1" } },
		{ toolName: "grep", input: { path: "C:\\w" } },
		{ toolName: "find", input: { path: "C:\\w" } },
		{ toolName: "ls", input: { path: "C:\\w" } },
		{ toolName: "ask_question", input: { question: "ok?" } },
	];

	for (const tool of managedTools) {
		const res = await toolCall(tool, { cwd: "C:\\w", hasUI: false });
		assert.equal(res?.block, true, `managed tool ${tool.toolName} must be blocked`);
		assert.match(res?.reason ?? "", /SECURITY_POLICY_UNAVAILABLE/);
	}

	// 非受管工具不被本门阻断
	const resCustom = await toolCall({ toolName: "web_search", input: { query: "test" } }, { cwd: "C:\\w", hasUI: false });
	assert.equal(resCustom, undefined, "unmanaged tool must not be blocked");
});

test("snapshot loading: invalid JSON blocks managed tools", async () => {
	const handlers = new Map();
	const gate = loadTsCommonJs("resources/extensions/pi-deck-security-gate.ts", {
		stubs: {
			"node:fs": {
				existsSync: () => true,
				statSync: () => ({ mtimeMs: 1 }),
				readFileSync: () => "INVALID_JSON{{{",
			},
		},
		globals: {
			process: {
				platform: "win32",
				env: {
					PIDECK_SECURITY_CONFIG: "C:\\policy.json",
					PIDECK_SESSION_ID: "session-1",
				},
			},
		},
	});
	await gate.default({ on: (name, fn) => handlers.set(name, fn) });
	const toolCall = handlers.get("tool_call");
	const res = await toolCall({ toolName: "read", input: { path: "C:\\w\\a.txt" } }, { cwd: "C:\\w", hasUI: false });
	assert.equal(res?.block, true, "managed tool must be blocked on invalid JSON");
});

test("snapshot loading: enabled: false in valid snapshot allows tools", async () => {
	const validDisabled = makeValidSnapshot({ enabled: false });
	const handlers = new Map();
	const gate = loadTsCommonJs("resources/extensions/pi-deck-security-gate.ts", {
		stubs: {
			"node:fs": {
				existsSync: () => true,
				statSync: () => ({ mtimeMs: 1 }),
				readFileSync: () => JSON.stringify(validDisabled),
			},
		},
		globals: {
			process: {
				platform: "win32",
				env: {
					PIDECK_SECURITY_CONFIG: "C:\\policy.json",
					PIDECK_SESSION_ID: "session-1",
				},
			},
		},
	});
	await gate.default({ on: (name, fn) => handlers.set(name, fn) });
	const toolCall = handlers.get("tool_call");
	const res = await toolCall({ toolName: "bash", input: { command: "rm -rf /" } }, { cwd: "C:\\w", hasUI: false });
	assert.equal(res, undefined, "valid enabled=false must allow tools");
});

test("snapshot loading: invalid shape with enabled: false or true blocks managed tools", async () => {
	const invalidCases = [
		{ schemaVersion: 1, defaultLevelId: "standard", levels: [null], sessionLevels: {} },
		{ schemaVersion: 1, defaultLevelId: "standard", levels: [], sessionLevels: {} },
		{ schemaVersion: 1, defaultLevelId: "missing", levels: [{ id: "off", name: "Off", description: "", toolActions: {}, denyBashPatterns: [], pathPolicy: "unrestricted", customAllowDirs: [], denyDirs: [], protectSensitivePaths: false, defaultAction: "allow" }], sessionLevels: {} },
		{ schemaVersion: 1, defaultLevelId: "standard", levels: [{ id: "standard", name: "Std", description: "", toolActions: {}, denyBashPatterns: [], pathPolicy: "unrestricted", customAllowDirs: [], denyDirs: [], protectSensitivePaths: false, defaultAction: "allow" }], sessionLevels: null },
		{ schemaVersion: 1, defaultLevelId: "standard", levels: [{ id: "standard", name: "Std", description: "", toolActions: {}, denyBashPatterns: [], pathPolicy: "unrestricted", customAllowDirs: [], denyDirs: [], protectSensitivePaths: false, defaultAction: "allow" }], sessionLevels: { s1: "missing" } },
		{ schemaVersion: 1, defaultLevelId: "standard", levels: [{ id: "standard", name: "Std", description: "", toolActions: {}, denyBashPatterns: [], pathPolicy: "unrestricted", customAllowDirs: [], denyDirs: [""], protectSensitivePaths: false, defaultAction: "allow" }], sessionLevels: {} },
	];

	for (const baseCase of invalidCases) {
		for (const enabled of [true, false]) {
			const candidate = { ...baseCase, enabled };
			const handlers = new Map();
			const gate = loadTsCommonJs("resources/extensions/pi-deck-security-gate.ts", {
				stubs: {
					"node:fs": {
						existsSync: () => true,
						statSync: () => ({ mtimeMs: 1 }),
						readFileSync: () => JSON.stringify(candidate),
					},
				},
				globals: {
					process: {
						platform: "win32",
						env: {
							PIDECK_SECURITY_CONFIG: "C:\\policy.json",
							PIDECK_SESSION_ID: "session-1",
						},
					},
				},
			});
			await gate.default({ on: (name, fn) => handlers.set(name, fn) });
			const toolCall = handlers.get("tool_call");
			const res = await toolCall({ toolName: "write", input: { path: "C:\\w\\a.txt", content: "x" } }, { cwd: "C:\\w", hasUI: false });
			assert.equal(res?.block, true, `invalid candidate with enabled=${enabled} must block managed tool`);
			assert.match(res?.reason ?? "", /SECURITY_POLICY_UNAVAILABLE/);
		}
	}
});

test("snapshot loading: recovery from corrupted to valid snapshot works without restart", async () => {
	let currentContent = "corrupted";
	const handlers = new Map();
	const gate = loadTsCommonJs("resources/extensions/pi-deck-security-gate.ts", {
		stubs: {
			"node:fs": {
				existsSync: () => true,
				statSync: () => ({ mtimeMs: Date.now() }),
				readFileSync: () => currentContent,
			},
		},
		globals: {
			process: {
				platform: "win32",
				env: {
					PIDECK_SECURITY_CONFIG: "C:\\policy.json",
					PIDECK_SESSION_ID: "session-1",
				},
			},
		},
	});
	await gate.default({ on: (name, fn) => handlers.set(name, fn) });
	const toolCall = handlers.get("tool_call");

	// 1. 损坏时阻断
	const res1 = await toolCall({ toolName: "read", input: { path: "C:\\w\\a.txt" } }, { cwd: "C:\\w", hasUI: false });
	assert.equal(res1?.block, true);

	// 2. 修复后放行
	currentContent = JSON.stringify(makeValidSnapshot({
		levels: [
			{
				id: "standard",
				name: "Standard",
				description: "",
				toolActions: { read: "allow" },
				denyBashPatterns: [],
				pathPolicy: "workspace",
				customAllowDirs: [],
				denyDirs: [],
				protectSensitivePaths: false,
				defaultAction: "allow",
			},
		],
	}));
	const res2 = await toolCall({ toolName: "read", input: { path: "C:\\w\\a.txt" } }, { cwd: "C:\\w", hasUI: false });
	assert.equal(res2, undefined, "recovered valid snapshot must allow tool");
});

test("snapshot loading: multiple extension instances do not pollute each other", async () => {
	const handlers1 = new Map();
	const handlers2 = new Map();

	let activeEnv = {
		PIDECK_SECURITY_CONFIG: "C:\\policy1.json",
		PIDECK_SESSION_ID: "session-1",
	};

	const gateModule = loadTsCommonJs("resources/extensions/pi-deck-security-gate.ts", {
		stubs: {
			"node:fs": {
				existsSync: (p) => p === "C:\\policy1.json",
				statSync: () => ({ mtimeMs: 1 }),
				readFileSync: (p) => {
					if (p === "C:\\policy1.json") return JSON.stringify(makeValidSnapshot());
					throw new Error("ENOENT");
				},
			},
		},
		globals: {
			process: {
				platform: "win32",
				get env() { return activeEnv; },
			},
		},
	});

	// 实例 1
	await gateModule.default({ on: (name, fn) => handlers1.set(name, fn) });

	// 切换环境变量并初始化实例 2（无 env）
	activeEnv = {};
	await gateModule.default({ on: (name, fn) => handlers2.set(name, fn) });

	const toolCall1 = handlers1.get("tool_call");
	const toolCall2 = handlers2.get("tool_call");

	// 实例 1 有配置，应按 standard 规则拦截 rm
	const res1 = await toolCall1({ toolName: "bash", input: { command: "rm a" } }, { cwd: "C:\\w", hasUI: false });
	assert.equal(res1?.block, true);

	// 实例 2 无配置，不应继承实例 1 的配置
	const res2 = await toolCall2({ toolName: "bash", input: { command: "rm a" } }, { cwd: "C:\\w", hasUI: false });
	assert.equal(res2, undefined, "instance 2 must not inherit instance 1 config");
});
