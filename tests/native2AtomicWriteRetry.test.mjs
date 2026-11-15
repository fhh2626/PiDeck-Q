import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import {
	resolveBackendExecutable,
	startBackendSession,
} from "./helpers/native2BackendHarness.mjs";

const executable = resolveBackendExecutable();

/**
 * Windows AV/indexers/cloud sync briefly hold a rename target (EPERM/EBUSY). The oracle
 * retries the atomic write for ~300 ms (`renameWithRetry`); without the retry one
 * transient sharing violation loses the user's settings change.
 *
 * The lock is taken with FileShare.Read: the backend can still *read* settings.json,
 * only the rename/replace of the target is denied — exactly the production failure mode.
 */
function holdReadShareLock(path, markerPath, holdMs) {
	const script = [
		`$f=[System.IO.File]::Open('${path.replaceAll("'", "''")}','Open','Read','Read')`,
		`[System.IO.File]::WriteAllText('${markerPath.replaceAll("'", "''")}','locked')`,
		`Start-Sleep -Milliseconds ${holdMs}`,
		"$f.Close()",
	].join("; ");
	const child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
		stdio: "ignore",
		windowsHide: true,
	});
	const exited = new Promise((resolve) => child.once("exit", resolve));
	return { child, exited };
}

async function waitForFile(path, timeoutMs = 10_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (existsSync(path)) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`file did not appear: ${path}`);
}

if (executable && process.platform === "win32") {
	describe("native2 atomic JSON write retries a transient Windows rename lock", () => {
		let root;
		let projectPath;

		before(() => {
			root = mkdtempSync(join(tmpdir(), "pideck-native2-atomic-"));
			projectPath = join(root, "project");
			mkdirSync(projectPath, { recursive: true });
		});

		after(() => {
			if (root) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		});

		test("settings:update succeeds while the target is briefly held by another process", async (t) => {
			const session = await startBackendSession(t, {
				projects: [{ id: "atomic", path: projectPath }],
				settings: { language: "en-US", theme: "system" },
			});
			const settingsPath = join(session.fixture.userData, "settings.json");
			const marker = join(session.fixture.userData, "lock-held.marker");
			writeFileSync(settingsPath, JSON.stringify({ language: "en-US", theme: "system" }));

			const lock = await holdReadShareLock(settingsPath, marker, 120);
			t.after(() => {
				lock.child.kill();
			});
			await waitForFile(marker);

			const updated = await session.invoke("settings:update", [{ theme: "dark" }]);
			await lock.exited;
			assert.equal(updated.payload.ok, true, JSON.stringify(updated.payload));
			const persisted = JSON.parse(readFileSync(settingsPath, "utf8"));
			assert.equal(persisted.theme, "dark", "the update must survive the transient lock");
		});
	});
}
