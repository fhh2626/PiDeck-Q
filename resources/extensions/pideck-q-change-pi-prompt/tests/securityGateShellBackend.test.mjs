import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import securityGateExtension, { resolveSecurityShellTool } from "../../pi-deck-security-gate.ts";

function adapterTool() {
	return {
		name: "bash",
		description: "PowerShell adapter",
		sourceInfo: { source: "npm:@99percentpeople/pi-pwsh-adapter@1.0.0" },
	};
}

function writeSecurityConfig(path, toolActions, mtimeOffsetMs = 0) {
	writeFileSync(path, JSON.stringify({
		schemaVersion: 1,
		enabled: true,
		defaultLevelId: "custom",
		levels: [{
			id: "custom",
			name: "Custom",
			description: "test",
			toolActions,
			denyBashPatterns: [],
			denyPowerShellPatterns: [],
			pathPolicy: "unrestricted",
			customAllowDirs: [],
			denyDirs: [],
			protectSensitivePaths: false,
			defaultAction: "allow",
		}],
		sessionLevels: { "parent-session": "custom" },
	}), "utf8");
	const stamp = new Date(Date.now() + mtimeOffsetMs);
	utimesSync(path, stamp, stamp);
}

async function withSecurityEnv(configPath, fn) {
	const previousPath = process.env.PIDECK_SECURITY_CONFIG;
	const previousSession = process.env.PIDECK_SESSION_ID;
	process.env.PIDECK_SECURITY_CONFIG = configPath;
	process.env.PIDECK_SESSION_ID = "parent-session";
	try {
		return await fn();
	} finally {
		if (previousPath === undefined) delete process.env.PIDECK_SECURITY_CONFIG;
		else process.env.PIDECK_SECURITY_CONFIG = previousPath;
		if (previousSession === undefined) delete process.env.PIDECK_SESSION_ID;
		else process.env.PIDECK_SESSION_ID = previousSession;
	}
}

test("security shell resolver follows the real backend behind a bash slot", () => {
	assert.equal(resolveSecurityShellTool({ getAllTools: () => [adapterTool()] }, "bash"), "powershell");
	assert.equal(resolveSecurityShellTool({
		getAllTools: () => [{ name: "bash", description: "Execute bash", sourceInfo: { source: "builtin" } }],
	}, "bash"), "bash");
});

test("security gate applies PowerShell policy to a pwsh-adapter bash slot", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pideck-security-shell-backend-"));
	try {
		const configPath = join(dir, "security.json");
		writeSecurityConfig(configPath, { bash: "allow", powershell: "deny" });

		await withSecurityEnv(configPath, async () => {
			const handlers = new Map();
			const pi = {
				on: (name, handler) => handlers.set(name, handler),
				getAllTools: () => [adapterTool()],
			};
			await securityGateExtension(pi);
			const toolCall = handlers.get("tool_call");
			const ctx = {
				hasUI: false,
				cwd: process.cwd(),
				ui: { select: async () => undefined },
			};

			const denied = await toolCall({ toolName: "bash", input: { command: "Get-ChildItem" } }, ctx);
			assert.equal(denied?.block, true);
			assert.match(denied.reason, /powershell \(bash compatibility slot\)/i);

			writeSecurityConfig(configPath, { bash: "deny", powershell: "allow" }, 10_000);
			const allowed = await toolCall({ toolName: "bash", input: { command: "Get-ChildItem" } }, ctx);
			assert.equal(allowed, undefined);
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
