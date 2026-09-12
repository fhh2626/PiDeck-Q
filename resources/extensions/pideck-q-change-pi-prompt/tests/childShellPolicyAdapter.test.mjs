import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	mapDeclaredToolsToHostShells,
	reconcileChildActiveShellTools,
	resolveChildShellSlots,
	resolveEffectiveShellPolicy,
} from "../childShellPolicy.ts";

test("active pwsh adapter does not publish bash or inject the adapter into children", () => {
	const dir = mkdtempSync(join(tmpdir(), "pideck-pwsh-policy-"));
	try {
		const adapterPath = join(dir, "pi-pwsh-adapter.js");
		writeFileSync(adapterPath, "// test adapter\n", "utf8");

		const policy = resolveEffectiveShellPolicy({
			platform: "win32",
			availability: { bash: false, powershell: true },
			parentTools: [{
				name: "bash",
				sourceInfo: {
					source: "npm:@99percentpeople/pi-pwsh-adapter@1.0.0",
					path: adapterPath,
				},
			}],
			parentActiveTools: ["bash"],
		});

		assert.equal(policy.bash, false);
		assert.equal(policy.powershell, false, "an adapter-occupied bash slot is not a powershell tool");
		assert.equal(policy.powershellProviderPath, undefined, "adapter must not occupy the shared child bash slot");

		const slots = resolveChildShellSlots({
			platform: "win32",
			policy,
			declaredTools: ["read", "bash"],
		});
		assert.equal(slots.bash, false);
		assert.equal(slots.powershell, false);
		assert.equal(slots.available, false);
		assert.deepEqual(slots.providerPaths, []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("inactive pwsh adapter does not widen the child shell ceiling", () => {
	const policy = resolveEffectiveShellPolicy({
		platform: "win32",
		availability: { bash: false, powershell: true },
		parentTools: [{
			name: "bash",
			sourceInfo: { source: "npm:@99percentpeople/pi-pwsh-adapter" },
		}],
		parentActiveTools: ["read"],
	});

	assert.equal(policy.bash, false);
	assert.equal(policy.powershell, false);
});

test("a pwsh-adapter bash slot is pruned and powershell is not invented", () => {
	const active = reconcileChildActiveShellTools({
		platform: "win32",
		availability: { bash: true, powershell: true },
		registeredTools: [
			{
				name: "bash",
				sourceInfo: { source: "npm:@99percentpeople/pi-pwsh-adapter", path: "C:/adapter.ts" },
			},
			{ name: "powershell", sourceInfo: { source: "builtin" } },
		],
		activeTools: ["read", "bash"],
		wantsShell: true,
		ceiling: { bash: false, powershell: true },
	});

	assert.equal(active.includes("bash"), false, "adapter-occupied bash is not a real bash backend");
	assert.equal(active.includes("powershell"), false, "powershell must not be added when the child did not have it");
});

test("a known shell-less child drops ambient shell tools even when their backends and parent ceiling allow them", () => {
	const active = reconcileChildActiveShellTools({
		platform: "win32",
		availability: { bash: true, powershell: true },
		registeredTools: [
			{ name: "read", sourceInfo: { source: "builtin" } },
			{ name: "bash", sourceInfo: { source: "builtin" } },
			{ name: "powershell", sourceInfo: { source: "builtin" } },
		],
		activeTools: ["read", "bash", "powershell"],
		wantsShell: false,
		ceiling: { bash: true, powershell: true },
	});

	assert.deepEqual(active, ["read"]);
});

test("mapDeclaredToolsToHostShells rewrites only declared shell slots", () => {
	const worker = ["read", "grep", "find", "ls", "bash", "edit", "write", "contact_supervisor"];
	assert.deepEqual(
		mapDeclaredToolsToHostShells(worker, { bash: false, powershell: true }),
		["read", "grep", "find", "ls", "powershell", "edit", "write", "contact_supervisor"],
	);
	assert.deepEqual(
		mapDeclaredToolsToHostShells(worker, { bash: true, powershell: true }),
		["read", "grep", "find", "ls", "bash", "powershell", "edit", "write", "contact_supervisor"],
	);
	assert.deepEqual(
		mapDeclaredToolsToHostShells(worker, { bash: false, powershell: false }),
		["read", "grep", "find", "ls", "edit", "write", "contact_supervisor"],
	);
	assert.deepEqual(
		mapDeclaredToolsToHostShells(["read", "grep", "find", "ls", "contact_supervisor"], { bash: false, powershell: true }),
		["read", "grep", "find", "ls", "contact_supervisor"],
	);
});
