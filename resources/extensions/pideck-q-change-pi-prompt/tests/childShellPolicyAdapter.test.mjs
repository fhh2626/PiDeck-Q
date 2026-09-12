import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveEffectiveShellPolicy } from "../childShellPolicy.ts";

test("active pwsh adapter publishes PowerShell capability to native children", () => {
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
		assert.equal(policy.powershellProviderPath, adapterPath);
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
