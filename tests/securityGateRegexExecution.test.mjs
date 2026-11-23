import assert from "node:assert/strict";
import test from "node:test";

import { createSnapshotDir, makeLevel } from "./helpers/l2_securityGateHarness.mjs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const EXECUTION_FAILURE_PATTERN = "runtime-regex-failure";

/** Model valid syntax whose deferred runtime compilation fails, independently of V8 stack size. */
class ExecutionFailureRegExp extends RegExp {
	test(value) {
		if (this.source === EXECUTION_FAILURE_PATTERN) throw new RangeError("RegExp execution failed");
		return super.test(value);
	}
}

/** Run the public tool_call handler with a real policy file and a deterministic regex failure. */
async function createGate(t, tool, defaultAction, patterns, toolAction = "ask") {
	const tmp = createSnapshotDir("pideck-regex-execution-");
	t.after(() => tmp.cleanup());
	const field = tool === "powershell" ? "denyPowerShellPatterns" : "denyBashPatterns";
	const snapshotPath = tmp.writeSnapshot({
		schemaVersion: 1, enabled: true, defaultLevelId: "custom", sessionLevels: {},
		levels: [makeLevel("custom", { toolActions: { [tool]: toolAction }, defaultAction, [field]: patterns })],
	});
	const extension = loadTsCommonJs("resources/extensions/pi-deck-security-gate.ts", {
		globals: {
			process: { platform: process.platform, env: { PIDECK_SECURITY_CONFIG: snapshotPath, PIDECK_SESSION_ID: "s" } },
			RegExp: ExecutionFailureRegExp,
		},
	});
	const handlers = new Map();
	await extension.default({ on: (name, handler) => handlers.set(name, handler) });
	const prompts = [];
	return {
		prompts,
		call: () => handlers.get("tool_call")({ toolName: tool, input: { command: "Remove-Item ./tmp" } }, {
			cwd: tmp.dir, hasUI: true,
			ui: { select: async (message) => { prompts.push(message); return "允许执行"; } },
		}),
	};
}

for (const tool of ["bash", "powershell"]) {
	for (const defaultAction of ["allow", "ask", "deny"]) {
		test(`${tool} blocks regex execution errors with ${defaultAction} fallback`, async (t) => {
			const gate = await createGate(t, tool, defaultAction, [EXECUTION_FAILURE_PATTERN]);
			assert.equal((await gate.call())?.block, true);
			assert.equal(gate.prompts.length, 0, "unusable rules must never become an approval prompt");
		});
	}

	test(`${tool} preserves explicit allow when its valid regex cannot execute`, async (t) => {
		const gate = await createGate(t, tool, "deny", [EXECUTION_FAILURE_PATTERN], "allow");
		assert.equal(await gate.call(), undefined);
		assert.equal(gate.prompts.length, 0);
	});

	test(`${tool} preserves the first matching rule before a later regex execution error`, async (t) => {
		const gate = await createGate(t, tool, "allow", ["Remove-Item", EXECUTION_FAILURE_PATTERN]);
		assert.equal(await gate.call(), undefined, "the first match keeps the configured approval action");
		assert.equal(gate.prompts.length, 1);
	});
}
