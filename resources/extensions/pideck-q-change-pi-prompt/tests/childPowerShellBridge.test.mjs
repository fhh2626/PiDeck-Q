import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ensureChildPowerShellTool } from "../childPowerShellBridge.ts";
import { shellPolicySnapshotPath } from "../childReconciliation.ts";
import { reconcileChildActiveShellTools } from "../childShellPolicy.ts";
import { isChildPowerShellBridge } from "../contributions.ts";

const WORKER_TOOLS = ["read", "grep", "find", "ls", "edit", "write", "contact_supervisor", "bash"];

function createChildPi(initialTools) {
	const tools = [...initialTools];
	const registered = [];
	return {
		pi: {
			getAllTools: () => tools,
			registerTool: (tool) => {
				registered.push(tool);
				const snapshot = {
					...tool,
					sourceInfo: { source: "file", path: "change-pi-prompt/childPowerShellBridge.ts" },
				};
				// Pi's registry is keyed by tool name; an extension tool replaces the built-in definition
				// for the same allowed slot rather than creating a second visible entry.
				const index = tools.findIndex((candidate) => candidate.name === tool.name);
				if (index >= 0) tools[index] = snapshot;
				else tools.push(snapshot);
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

test("PowerShell-only Windows worker receives a PowerShell-backed bash compatibility slot", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pideck-child-powershell-bridge-"));
	try {
		const ownerKey = "parent-test";
		publishPolicy(agentDir, ownerKey, true);

		// Reproduce the real failure: worker's child launch allowlist contains historical `bash`,
		// not Pi's newer `powershell` tool name.
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
		assert.equal(registered[0].name, "bash", "bridge must stay inside the child allowlist");
		assert.equal(tools.some((tool) => tool.name === "powershell"), false, "bridge must not rely on a filtered-out tool name");
		const bridged = tools.find((tool) => tool.name === "bash");
		assert.equal(isChildPowerShellBridge(bridged), true);
		assert.match(bridged.description, /PowerShell/);

		// Main child canonicalization must re-add the compatibility slot after ordinary bash pruning,
		// using PowerShell availability and the parent's PowerShell ceiling rather than Git Bash.
		const reconciled = reconcileChildActiveShellTools({
			platform: "win32",
			availability: { bash: false, powershell: true },
			registeredTools: tools,
			activeTools: WORKER_TOOLS.filter((name) => name !== "bash"),
			wantsShell: true,
			ceiling: { bash: false, powershell: true },
		});
		assert.equal(reconciled.includes("bash"), true);
		assert.equal(reconciled.includes("powershell"), false);

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

test("disabled child adaptation never registers a bridge from a stale parent policy", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pideck-child-powershell-bridge-disabled-"));
	try {
		const ownerKey = "parent-test";
		publishPolicy(agentDir, ownerKey, true);
		const { pi, registered } = createChildPi([
			{ name: "read", sourceInfo: { source: "builtin" } },
			{ name: "bash", sourceInfo: { source: "builtin" } },
		]);

		assert.equal(ensureChildPowerShellTool(pi, agentDir, {
			platform: "win32",
			systemPrompt: '<active_agent name="worker"/>\n\nYou are worker.',
			cwd: process.cwd(),
			ownerKey,
			enabled: false,
		}), false);
		assert.equal(registered.length, 0);
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});
