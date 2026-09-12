import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ensureChildPowerShellTool } from "../childPowerShellBridge.ts";
import { shellPolicySnapshotPath } from "../childReconciliation.ts";

function createChildPi(initialTools) {
	const tools = [...initialTools];
	const registered = [];
	return {
		pi: {
			getAllTools: () => tools,
			registerTool: (tool) => {
				registered.push(tool);
				tools.push({
					...tool,
					sourceInfo: { source: "file", path: "change-pi-prompt/childPowerShellBridge.ts" },
				});
			},
		},
		tools,
		registered,
	};
}

function publishPolicy(agentDir, ownerKey, powershell) {
	mkdirSync(join(agentDir, "change-pi-prompt"), { recursive: true });
	writeFileSync(shellPolicySnapshotPath(agentDir, ownerKey), JSON.stringify({
		version: 2,
		platform: "win32",
		shell: { bash: false, powershell },
		parentActiveTools: powershell ? ["read", "powershell"] : ["read"],
	}), "utf8");
}

test("PowerShell-only Windows worker gets Pi's powershell tool even when the child registry omitted it", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pideck-child-powershell-bridge-"));
	try {
		const ownerKey = "parent-test";
		publishPolicy(agentDir, ownerKey, true);

		// Reproduce the real failure: worker has its historical bash allowlist slot, but the child
		// runtime did not register Pi's newer `powershell` builtin at all.
		const { pi, tools, registered } = createChildPi([
			{ name: "read", sourceInfo: { source: "builtin" } },
			{ name: "grep", sourceInfo: { source: "builtin" } },
			{ name: "find", sourceInfo: { source: "builtin" } },
			{ name: "ls", sourceInfo: { source: "builtin" } },
			{ name: "edit", sourceInfo: { source: "builtin" } },
			{ name: "write", sourceInfo: { source: "builtin" } },
			{ name: "contact_supervisor", sourceInfo: { source: "builtin" } },
			{ name: "bash", sourceInfo: { source: "builtin" } },
		]);

		const changed = ensureChildPowerShellTool(pi, agentDir, {
			platform: "win32",
			systemPrompt: '<active_agent name="worker"/>\n\nYou are worker.',
			cwd: process.cwd(),
			ownerKey,
		});

		assert.equal(changed, true);
		assert.equal(registered.length, 1);
		assert.equal(registered[0].name, "powershell");
		assert.equal(tools.some(tool => tool.name === "powershell"), true);

		// Idempotent across subsequent before_agent_start turns.
		assert.equal(ensureChildPowerShellTool(pi, agentDir, {
			platform: "win32",
			systemPrompt: '<active_agent name="worker"/>\n\nYou are worker.',
			cwd: process.cwd(),
			ownerKey,
		}), false);
		assert.equal(registered.length, 1);
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("bridge never widens shell-less agents or a parent that did not authorize PowerShell", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pideck-child-powershell-bridge-deny-"));
	try {
		const ownerKey = "parent-test";
		publishPolicy(agentDir, ownerKey, false);
		const { pi, registered } = createChildPi([
			{ name: "read", sourceInfo: { source: "builtin" } },
			{ name: "bash", sourceInfo: { source: "builtin" } },
		]);

		assert.equal(ensureChildPowerShellTool(pi, agentDir, {
			platform: "win32",
			systemPrompt: '<active_agent name="worker"/>\n\nYou are worker.',
			cwd: process.cwd(),
			ownerKey,
		}), false);

		assert.equal(ensureChildPowerShellTool(pi, agentDir, {
			platform: "win32",
			systemPrompt: '<active_agent name="reviewer"/>\n\nYou are reviewer.',
			cwd: process.cwd(),
			ownerKey,
		}), false);
		assert.equal(registered.length, 0);
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});
