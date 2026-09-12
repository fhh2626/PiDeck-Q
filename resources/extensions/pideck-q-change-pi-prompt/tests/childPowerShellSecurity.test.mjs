import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { enforcePowerShellBackedBashSecurity } from "../childPowerShellSecurity.ts";
import { CHILD_POWERSHELL_BRIDGE_MARKER } from "../contributions.ts";

function withSecurityEnv(configPath, sessionId, fn) {
	const previousPath = process.env.PIDECK_SECURITY_CONFIG;
	const previousSession = process.env.PIDECK_SESSION_ID;
	process.env.PIDECK_SECURITY_CONFIG = configPath;
	process.env.PIDECK_SESSION_ID = sessionId;
	return Promise.resolve()
		.then(fn)
		.finally(() => {
			if (previousPath === undefined) delete process.env.PIDECK_SECURITY_CONFIG;
			else process.env.PIDECK_SECURITY_CONFIG = previousPath;
			if (previousSession === undefined) delete process.env.PIDECK_SESSION_ID;
			else process.env.PIDECK_SESSION_ID = previousSession;
		});
}

function writeSecurityConfig(path, level) {
	writeFileSync(path, JSON.stringify({
		schemaVersion: 1,
		enabled: true,
		defaultLevelId: level.id,
		levels: [level],
		sessionLevels: { "parent-session": level.id },
	}), "utf8");
}

function bridgePi() {
	return {
		getAllTools: () => [{
			name: "bash",
			description: `${CHILD_POWERSHELL_BRIDGE_MARKER} PowerShell backend`,
			sourceInfo: { source: "file", path: "change-pi-prompt.ts" },
		}],
	};
}

const headlessCtx = {
	hasUI: false,
	cwd: process.cwd(),
	ui: { select: async () => undefined },
};

test("PowerShell-backed bash supplements the security gate when PowerShell policy is stricter", async () => {
	const tempDir = mkdtempSync(join(tmpdir(), "pideck-pwsh-security-"));
	try {
		const configPath = join(tempDir, "security.json");
		writeSecurityConfig(configPath, {
			id: "custom",
			name: "Custom",
			toolActions: { bash: "allow", powershell: "deny" },
			denyBashPatterns: [],
			denyPowerShellPatterns: [],
			defaultAction: "allow",
		});

		await withSecurityEnv(configPath, "parent-session", async () => {
			const result = await enforcePowerShellBackedBashSecurity(
				bridgePi(),
				{ toolName: "bash", input: { command: "Get-ChildItem" } },
				headlessCtx,
				{ enabled: true },
			);
			assert.ok(result?.block);
			assert.match(result.reason, /PowerShell/);
		});
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

test("PowerShell pattern can require confirmation when the Bash-name policy would allow", async () => {
	const tempDir = mkdtempSync(join(tmpdir(), "pideck-pwsh-security-pattern-"));
	try {
		const configPath = join(tempDir, "security.json");
		writeSecurityConfig(configPath, {
			id: "custom",
			name: "Custom",
			toolActions: { bash: "allow", powershell: "ask" },
			denyBashPatterns: [],
			denyPowerShellPatterns: ["\\bRemove-Item\\b"],
			defaultAction: "ask",
		});

		await withSecurityEnv(configPath, "parent-session", async () => {
			const result = await enforcePowerShellBackedBashSecurity(
				bridgePi(),
				{ toolName: "bash", input: { command: "Remove-Item ./x.txt" } },
				headlessCtx,
				{ enabled: true },
			);
			assert.ok(result?.block, "headless child must fail closed when semantic PowerShell policy asks");
		});
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

test("ordinary Bash is not affected by the PowerShell semantic supplement", async () => {
	const tempDir = mkdtempSync(join(tmpdir(), "pideck-pwsh-security-normal-bash-"));
	try {
		const configPath = join(tempDir, "security.json");
		writeSecurityConfig(configPath, {
			id: "custom",
			name: "Custom",
			toolActions: { bash: "allow", powershell: "deny" },
			denyBashPatterns: [],
			denyPowerShellPatterns: [],
			defaultAction: "allow",
		});
		const pi = {
			getAllTools: () => [{ name: "bash", description: "Execute bash", sourceInfo: { source: "builtin" } }],
		};

		await withSecurityEnv(configPath, "parent-session", async () => {
			const result = await enforcePowerShellBackedBashSecurity(
				pi,
				{ toolName: "bash", input: { command: "ls" } },
				headlessCtx,
				{ enabled: true },
			);
			assert.equal(result, undefined);
		});
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});
