import assert from "node:assert/strict";
import test from "node:test";

import {
	CHILD_POWERSHELL_PROMPT_START,
	injectPowerShellBackedBashPrompt,
	syncPowerShellBackedBashPrompt,
} from "../childPowerShellBridge.ts";

test("PowerShell-backed bash prompt guidance is explicit and idempotent", () => {
	const original = '<active_agent name="worker"/>\n\nYou are worker. Use `bash` for validation.';
	const injected = injectPowerShellBackedBashPrompt(original);
	assert.ok(injected.startsWith(original));
	assert.match(injected, /executes PowerShell, not GNU Bash/);
	assert.match(injected, /Use PowerShell syntax and semantics/);

	const reinjected = injectPowerShellBackedBashPrompt(injected);
	assert.equal(reinjected, injected);
	assert.equal((reinjected.match(new RegExp(CHILD_POWERSHELL_PROMPT_START, "g")) ?? []).length, 1);
});

test("PowerShell-backed bash prompt guidance is removed when the final tool set no longer uses the alias", () => {
	const original = '<active_agent name="worker"/>\n\nYou are worker.';
	const injected = syncPowerShellBackedBashPrompt(original, true);
	assert.match(injected, /Child Shell Backend/);

	const removed = syncPowerShellBackedBashPrompt(injected, false);
	assert.equal(removed, original);
	assert.doesNotMatch(removed, /Child Shell Backend/);
	assert.doesNotMatch(removed, new RegExp(CHILD_POWERSHELL_PROMPT_START));
});
