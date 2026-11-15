import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { resolveBackendExecutable, startBackendSession } from "./helpers/native2BackendHarness.mjs";

/**
 * `editors:open-project` result schema + launch shape (native2).
 *
 * Oracle: `src/main/ipc/editorsIpc.ts` handler → `EditorDetector.openProjectInEditor`
 * (`EditorDetector.ts:413`). The documented residual (§29.6/§30.4) was "only the fallback
 * path is asserted; the successful spawn is not hermetic". It is hermetic for the
 * executable path: the test's own `node.exe` acts as the editor (a real `.exe`, so
 * `resolveLaunchableCommand` short-circuits like it does for `Code.exe`) and records the
 * argv it was given, which is the only observable that matters for "open in editor".
 *
 * Honest limit: the `.cmd`/`.bat` branch (`cmd /d /s /c start "" …`) cannot be verified in
 * this environment — a `start`-ed batch file never runs and holds the caller's pipes, even
 * when driven from a plain batch file with no backend involved — so that branch is covered
 * by source parity with the oracle's `quoteCmdArg` rule instead of an end-to-end launch.
 */

const executable = resolveBackendExecutable();
const slash = (value) => String(value).replaceAll("\\", "/");

/** `node -e <script> <projectPath>`: records the argv the editor received. */
function recordingArgs(logPath) {
	return ["-e", `require('fs').writeFileSync(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(1)))`];
}

async function waitForArgv(logPath, timeoutMs = 20_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (existsSync(logPath)) {
			try {
				const parsed = JSON.parse(readFileSync(logPath, "utf8"));
				if (Array.isArray(parsed)) return parsed;
			} catch {
				// half-written file: retry
			}
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	assert.fail(`the editor was never launched (no argv recorded in ${logPath})`);
}

if (!executable) {
	describe("native2 editors:open-project", () => {
		test("backend executable is available", () => {
			assert.fail("PiDeckBackend.exe was not built; run xmake build -y PiDeckBackend");
		});
	});
} else if (process.platform !== "win32") {
	describe("native2 editors:open-project", () => {
		test("external-editor launching is Windows-scoped", (t) => {
			t.skip("the editor resolution and /mnt conversion are Windows-specific");
		});
	});
} else {
	describe("native2 editors:open-project", () => {
		let root;

		before(() => {
			root = mkdtempSync(join(tmpdir(), "pideck-native2-editors-"));
		});

		after(() => {
			if (root) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		});

		test("a successful open resolves like the oracle and hands the project path over verbatim", async (t) => {
			// `&`, spaces, parentheses, comma and `=` in the project path are exactly what the
			// oracle's quoting rule exists for; a renderer-visible `/mnt/...` path is mapped
			// back to a Windows path (`toWindowsCompatiblePath`).
			const projectPath = join(root, "R&D project (beta), x=y");
			const logPath = join(root, "argv-custom.json");
			const session = await startBackendSession(t, { projects: [] });
			const response = await session.invoke("editors:open-project", [
				{ id: "custom", name: "Recording editor", command: process.execPath, args: recordingArgs(logPath) },
				projectPath,
			]);
			assert.equal(response.payload.ok, true, JSON.stringify(response.payload));
			// Oracle resolves `undefined` for `Promise<void>`; the wire envelope carries null.
			assert.equal(response.payload.result, null, JSON.stringify(response.payload));
			assert.deepEqual(await waitForArgv(logPath), [projectPath]);
		});

		test("vscode gets --new-window and a /mnt project path becomes a drive path", async (t) => {
			const logPath = join(root, "argv-vscode.json");
			const session = await startBackendSession(t, { projects: [] });
			const response = await session.invoke("editors:open-project", [
				// `--` keeps node from parsing the appended `--new-window` as its own option.
				{ id: "vscode", name: "VS Code", command: process.execPath, args: [...recordingArgs(logPath), "--"] },
				"/mnt/d/tmp/My Project",
			]);
			assert.equal(response.payload.ok, true, JSON.stringify(response.payload));
			// Oracle `toWindowsCompatiblePath`: `/mnt/d/tmp/...` → `D:\tmp\...`; a raw POSIX path
			// would be handed to a Windows editor, which cannot open it.
			assert.deepEqual((await waitForArgv(logPath)).map(slash), ["--new-window", "D:/tmp/My Project"]);
		});

		test("a failed spawn whose fallback also fails rejects instead of reporting success", async (t) => {
			const session = await startBackendSession(t, {
				projects: [],
				hostHandlers: {
					// The oracle rejects when `openPath` reports `ok:false`; resolving here would
					// let the renderer clear its spinner without opening anything.
					"shell.openPath": () => ({ result: { ok: false, error: "denied by policy" } }),
				},
			});
			const response = await session.invoke("editors:open-project", [
				{ id: "custom", name: "Missing", command: join(root, "missing-editor.exe"), args: [] },
				join(root, "another project"),
			]);
			assert.equal(response.payload.ok, false, JSON.stringify(response.payload));
			assert.match(String(response.payload.error?.message ?? ""), /Unable to start editor|denied by policy/);
		});

		test("a fallback that succeeds still resolves null", async (t) => {
			const session = await startBackendSession(t, { projects: [] });
			const response = await session.invoke("editors:open-project", [
				{ id: "custom", name: "Missing", command: join(root, "missing-editor-2.exe"), args: [] },
				join(root, "fallback project"),
			]);
			assert.equal(response.payload.ok, true, JSON.stringify(response.payload));
			assert.equal(response.payload.result, null, JSON.stringify(response.payload));
		});
	});
}
