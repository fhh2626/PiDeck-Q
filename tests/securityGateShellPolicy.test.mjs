import assert from "node:assert/strict";
import test from "node:test";
import { createSnapshotDir, loadGate, makeLevel } from "./helpers/l2_securityGateHarness.mjs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/** Keep the extension instance alive while tests rewrite the on-disk policy. */
async function createPolicyGate(t, levels, sessionLevels = {}) {
	const tmp = createSnapshotDir("pideck-shell-policy-");
	t.after(() => tmp.cleanup());
	const snapshot = {
		schemaVersion: 1,
		enabled: true,
		defaultLevelId: levels[0].id,
		levels,
		sessionLevels,
	};
	const path = tmp.writeSnapshot(snapshot);
	const gate = await loadGate({ PIDECK_SECURITY_CONFIG: path, PIDECK_SESSION_ID: "session-1" });
	const prompts = [];
	const ctx = {
		cwd: tmp.dir,
		hasUI: true,
		ui: { select: async (message) => { prompts.push(message); return "允许执行"; } },
	};
	return {
		snapshot,
		prompts,
		write: () => tmp.writeSnapshot(snapshot),
		call: (toolName, command, context = ctx) => gate.toolCall({ toolName, input: { command } }, context),
	};
}

for (const tool of ["bash", "powershell"]) {
	for (const defaultAction of ["allow", "ask"]) {
		test(`${tool}: an explicit deny cannot become an approval prompt when a regex matches (${defaultAction} fallback)`, async (t) => {
			const gate = await createPolicyGate(t, [makeLevel("custom", {
				toolActions: { [tool]: "deny" },
				denyBashPatterns: ["dangerous-command"],
				denyPowerShellPatterns: ["dangerous-command"],
				defaultAction,
			})]);
			assert.equal((await gate.call(tool, "dangerous-command"))?.block, true);
			assert.equal(gate.prompts.length, 0, "a denied tool must not offer permission to execute");
			assert.equal((await gate.call(tool, "harmless-command"))?.block, true);
		});
	}
}

test("PowerShell patterns are case insensitive and stay separate from Bash patterns", async (t) => {
	const gate = await createPolicyGate(t, [makeLevel("custom", {
		toolActions: { bash: "ask", powershell: "ask" },
		denyBashPatterns: ["\\brm\\s+-rf\\b"],
		denyPowerShellPatterns: ["\\bRemove-Item\\b"],
		defaultAction: "deny",
	})]);
	assert.equal((await gate.call("powershell", "rEmOvE-iTeM ./tmp"))?.block, true);
	assert.equal(await gate.call("bash", "Remove-Item ./tmp"), undefined);
	assert.equal((await gate.call("bash", "rm -rf ./tmp"))?.block, true);
	assert.equal(await gate.call("powershell", "rm -rf ./tmp"), undefined);
	assert.equal(gate.prompts.length, 2, "only commands outside their own shell patterns ask for approval");
});

test("an empty PowerShell list disables regex matching and a missing list keeps legacy defaults", async (t) => {
	const level = makeLevel("custom", {
		toolActions: { powershell: "ask" },
		denyPowerShellPatterns: [],
		defaultAction: "deny",
	});
	const gate = await createPolicyGate(t, [level]);
	assert.equal(await gate.call("powershell", "Remove-Item ./tmp"), undefined);
	delete level.denyPowerShellPatterns;
	gate.write();
	assert.equal((await gate.call("powershell", "Remove-Item ./tmp"))?.block, true);
	assert.equal(await gate.call("powershell", "Get-Content ./file.txt"), undefined);
	assert.equal(gate.prompts.length, 2);
});

test("PowerShell regex edits take effect on the next call without restarting the gate", async (t) => {
	const level = makeLevel("custom", {
		toolActions: { powershell: "ask" },
		denyPowerShellPatterns: ["\\bRemove-Item\\b"],
		defaultAction: "deny",
	});
	const gate = await createPolicyGate(t, [level]);
	assert.equal((await gate.call("powershell", "Remove-Item ./tmp"))?.block, true);
	level.denyPowerShellPatterns = ["\\bSet-Content\\b"];
	gate.write();
	assert.equal(await gate.call("powershell", "Remove-Item ./tmp"), undefined);
	assert.equal((await gate.call("powershell", "Set-Content ./file.txt value"))?.block, true);
});

test("built-in PowerShell levels and session overrides apply their configured actions", async (t) => {
	const { createDefaultSecurityLevels } = loadTsCommonJs("src/shared/types/security.ts");
	const gate = await createPolicyGate(t, createDefaultSecurityLevels(), { "session-1": "standard" });
	assert.equal(await gate.call("powershell", "Remove-Item ./tmp"), undefined);
	assert.equal(gate.prompts.length, 1, "standard level asks before executing");
	gate.snapshot.sessionLevels["session-1"] = "strict";
	gate.write();
	assert.equal((await gate.call("powershell", "Remove-Item ./tmp"))?.block, true);
	assert.equal(gate.prompts.length, 1, "strict level rejects matched commands directly");
	assert.equal(await gate.call("powershell", "Get-Content ./file.txt"), undefined);
	assert.equal(gate.prompts.length, 2, "strict level still asks for unmatched commands");
	gate.snapshot.sessionLevels["session-1"] = "off";
	gate.write();
	assert.equal(await gate.call("powershell", "Remove-Item ./tmp"), undefined);
	assert.equal(gate.prompts.length, 2, "off level does not prompt");
});

test("an explicit PowerShell allow preserves the configured override for matching commands", async (t) => {
	const gate = await createPolicyGate(t, [makeLevel("custom", {
		toolActions: { powershell: "allow" },
		denyPowerShellPatterns: ["\\bRemove-Item\\b"],
		defaultAction: "deny",
	})]);
	assert.equal(await gate.call("powershell", "Remove-Item ./tmp"), undefined);
	assert.equal(gate.prompts.length, 0);
});

test("PowerShell confirmation cancellation, missing UI and UI errors all block execution", async (t) => {
	const gate = await createPolicyGate(t, [makeLevel("custom", { toolActions: { powershell: "ask" } })]);
	for (const context of [
		{ hasUI: false },
		{ hasUI: true, ui: { select: async () => undefined } },
		{ hasUI: true, ui: { select: async () => "拒绝" } },
		{ hasUI: true, ui: { select: async () => { throw new Error("closed"); } } },
	]) {
		assert.equal((await gate.call("powershell", "Get-Content ./file.txt", context))?.block, true);
	}
});

test("invalid PowerShell patterns block execution until a valid policy is restored", async (t) => {
	const level = makeLevel("custom", { toolActions: { powershell: "allow" } });
	const gate = await createPolicyGate(t, [level]);
	for (const invalid of [null, "Remove-Item", [7], ["("]]) {
		level.denyPowerShellPatterns = invalid;
		gate.write();
		const result = await gate.call("powershell", "Get-Content ./file.txt");
		assert.equal(result?.block, true);
		assert.match(result.reason, /SECURITY_POLICY_UNAVAILABLE/);
	}
	level.denyPowerShellPatterns = [];
	gate.write();
	assert.equal(await gate.call("powershell", "Get-Content ./file.txt"), undefined);
});
