import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

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
