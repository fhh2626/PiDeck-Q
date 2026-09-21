import assert from "node:assert/strict";
import test from "node:test";
import { isPathInsideRoot, evaluatePathAction, resolvePolicyPath } from "../src/main/security/policy.ts";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

test("policy: isPathInsideRoot with win32 flavor blocks C:\\workspace\\..\\outside traversal", () => {
	const root = "C:\\workspace";
	const outside = "C:\\workspace\\..\\outside\\proof.txt";
	const inside = "C:\\workspace\\src\\index.ts";

	assert.equal(isPathInsideRoot(outside, root, "win32"), false);
	assert.equal(isPathInsideRoot(inside, root, "win32"), true);
	assert.equal(isPathInsideRoot(root, root, "win32"), true);
});

test("policy: isPathInsideRoot with posix flavor blocks /workspace/../outside traversal", () => {
	const root = "/workspace";
	const outside = "/workspace/../outside/proof.txt";
	const inside = "/workspace/src/index.ts";

	assert.equal(isPathInsideRoot(outside, root, "posix"), false);
	assert.equal(isPathInsideRoot(inside, root, "posix"), true);
	assert.equal(isPathInsideRoot(root, root, "posix"), true);
});

test("policy: resolvePolicyPath rejects Windows namespaces, bare drives, and drive-unspecified roots", () => {
	assert.equal(resolvePolicyPath("\\\\?\\C:\\workspace\\a.txt", "C:\\workspace", "win32"), null);
	assert.equal(resolvePolicyPath("//?/C:/workspace/a.txt", "C:\\workspace", "win32"), null);
	assert.equal(resolvePolicyPath("\\\\.\\C:\\workspace\\a.txt", "C:\\workspace", "win32"), null);
	assert.equal(resolvePolicyPath("//./C:/workspace/a.txt", "C:\\workspace", "win32"), null);
	assert.equal(resolvePolicyPath("C:", "C:\\workspace", "win32"), null);
	assert.equal(resolvePolicyPath("C:foo", "C:\\workspace", "win32"), null);
	assert.equal(resolvePolicyPath("\\outside\\a.txt", "C:\\workspace", "win32"), null);
	assert.equal(resolvePolicyPath("/outside/a.txt", "C:\\workspace", "win32"), null);
	assert.equal(resolvePolicyPath("a\0b", "C:\\workspace", "win32"), null);
	assert.equal(resolvePolicyPath("", "C:\\workspace", "win32"), null);
});

test("policy: resolvePolicyPath supports UNC paths and normalizes paths", () => {
	assert.equal(resolvePolicyPath("\\\\server\\share\\sub\\file.txt", "C:\\w", "win32"), "\\\\server\\share\\sub\\file.txt");
	assert.equal(isPathInsideRoot("\\\\server\\share\\sub\\file.txt", "\\\\server\\share\\sub", "win32"), true);
	assert.equal(isPathInsideRoot("\\\\server\\share2\\file.txt", "\\\\server\\share\\sub", "win32"), false);
});

test("policy: evaluatePathAction with win32 flavor respects workspace boundary and denyDirs", () => {
	const level = {
		id: "standard",
		name: "Standard",
		description: "",
		toolActions: { read: "allow", write: "ask" },
		denyBashPatterns: [],
		pathPolicy: "workspace",
		customAllowDirs: [],
		denyDirs: ["C:\\workspace\\secret"],
		protectSensitivePaths: true,
		defaultAction: "deny",
	};

	// 穿越到外部：deny
	assert.equal(evaluatePathAction(level, "C:\\workspace\\..\\outside\\proof.txt", "C:\\workspace", "win32"), "deny");
	// 命名空间路径：deny
	assert.equal(evaluatePathAction(level, "\\\\?\\C:\\workspace\\a.txt", "C:\\workspace", "win32"), "deny");
	// 裸盘符：deny
	assert.equal(evaluatePathAction(level, "C:", "C:\\workspace", "win32"), "deny");
	// 盘符相对路径：deny
	assert.equal(evaluatePathAction(level, "C:foo", "C:\\workspace", "win32"), "deny");
	// 当前盘符根相对：deny
	assert.equal(evaluatePathAction(level, "\\outside\\a.txt", "C:\\workspace", "win32"), "deny");

	// 内部安全目录：允许（evaluatePathAction 返回 null 让上层决定，或者按 pathAction 明确）
	assert.equal(evaluatePathAction(level, "C:\\workspace\\src\\index.ts", "C:\\workspace", "win32"), null);

	// 命中 denyDirs：deny
	assert.equal(evaluatePathAction(level, "C:\\workspace\\secret\\key.txt", "C:\\workspace", "win32"), "deny");
});

test("gate extension: tool_call blocks absolute .. traversal and special Windows paths", async () => {
	const handlers = new Map();
	const gate = loadTsCommonJs("resources/extensions/pi-deck-security-gate.ts", {
		stubs: {
			"node:fs": {
				existsSync: () => true,
				statSync: () => ({ mtimeMs: 1 }),
				readFileSync: () => JSON.stringify({
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
							denyBashPatterns: [],
							denyPowerShellPatterns: [],
							pathPolicy: "workspace",
							customAllowDirs: [],
							denyDirs: [],
							protectSensitivePaths: false,
							defaultAction: "deny",
						},
					],
					sessionLevels: {},
				}),
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

	await gate.default({
		on: (name, fn) => handlers.set(name, fn),
	});

	const toolCall = handlers.get("tool_call");
	assert.ok(toolCall, "tool_call handler must be registered");

	const resTraversal = await toolCall(
		{ toolName: "read", input: { path: "C:\\workspace\\..\\outside\\proof.txt" } },
		{ cwd: "C:\\workspace", hasUI: false },
	);
	assert.equal(resTraversal?.block, true, "read tool traversal must be blocked");

	const resNamespace = await toolCall(
		{ toolName: "read", input: { path: "\\\\?\\C:\\workspace\\proof.txt" } },
		{ cwd: "C:\\workspace", hasUI: false },
	);
	assert.equal(resNamespace?.block, true, "read tool namespace path must be blocked");

	const resBareDrive = await toolCall(
		{ toolName: "read", input: { path: "C:" } },
		{ cwd: "C:\\workspace", hasUI: false },
	);
	assert.equal(resBareDrive?.block, true, "read tool bare drive must be blocked");

	const resDriveRoot = await toolCall(
		{ toolName: "read", input: { path: "\\outside\\proof.txt" } },
		{ cwd: "C:\\workspace", hasUI: false },
	);
	assert.equal(resDriveRoot?.block, true, "read tool drive-relative path must be blocked");
});
