import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	reconcileChildActiveShellTools,
	resolveChildShellSlots,
	resolveEffectiveShellPolicy,
} from "../childShellPolicy.ts";

test("active pwsh adapter publishes PowerShell capability without injecting the adapter into children", () => {
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
		assert.equal(policy.powershell, true);
		assert.equal(policy.powershellProviderPath, undefined, "adapter must not occupy the shared child bash slot");

		const slots = resolveChildShellSlots({
			platform: "win32",
			policy,
			declaredTools: ["read", "bash"],
		});
		assert.equal(slots.available, true);
		assert.equal(slots.powershell, true);
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

test("canonical powershell wins over a pwsh-adapter bash compatibility slot when both are registered", () => {
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

	assert.equal(active.includes("bash"), false, "compatibility alias must disappear once canonical powershell exists");
	assert.equal(active.includes("powershell"), true);
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
