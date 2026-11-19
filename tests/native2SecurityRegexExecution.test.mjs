import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { backendTestAvailability, startBackendSession } from "./helpers/native2BackendHarness.mjs";
import { loadGate } from "./helpers/l2_securityGateHarness.mjs";

const { skip } = backendTestAvailability();

for (const [toolName, field, flags] of [
	["bash", "denyBashPatterns", ""],
	["powershell", "denyPowerShellPatterns", "i"],
]) {
	test(`native-saved ${toolName} rules cannot become approvable after a regex execution error`, { skip }, async (t) => {
		const session = await startBackendSession(t);
		const read = await session.invoke("security:get-config");
		assert.equal(read.payload.ok, true, JSON.stringify(read.payload));
		const config = read.payload.result;
		// This valid empty-match pattern is at the supported capture-count boundary.
		// V8 can construct it but fail with stack overflow when .test compiles it.
		// Either successful matching or evaluation failure must block in strict mode.
		const pattern = "()".repeat(32766) + "(?<last>)";
		assert.doesNotThrow(() => new RegExp(pattern, flags));
		config.levels.find((level) => level.id === "strict")[field] = [pattern];
		const saved = await session.invoke("security:update-config", [{
			enabled: true, defaultLevelId: "strict", levels: config.levels,
		}]);
		assert.equal(saved.payload.ok, true, JSON.stringify(saved.payload));
		assert.equal(saved.payload.result.ok, true, JSON.stringify(saved.payload));
		const snapshotPath = join(session.fixture.userData, "security-policy.json");
		const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
		assert.deepEqual(snapshot.levels.find((level) => level.id === "strict")[field], [pattern]);
		const gate = await loadGate({ PIDECK_SECURITY_CONFIG: snapshotPath, PIDECK_SESSION_ID: "regex-execution" });
		let prompts = 0;
		const result = await gate.toolCall({ toolName, input: { command: "Remove-Item ./tmp" } }, {
			cwd: session.fixture.root,
			hasUI: true,
			ui: { select: async () => { prompts += 1; return "允许执行"; } },
		});
		assert.equal(result?.block, true, `A failing deny rule must not allow execution after ${prompts} prompt(s)`);
		assert.equal(prompts, 0, "a rule evaluation failure must not offer command approval");
	});
}
