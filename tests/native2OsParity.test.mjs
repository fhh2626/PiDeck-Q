import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { resolveBackendExecutable, startBackendSession } from "./helpers/native2BackendHarness.mjs";

/**
 * Desktop OS capability suite: clipboard snapshot, theme backgrounds, external editor
 * discovery and the process monitor.
 *
 * Every case drives the real backend over the framed host protocol and the loopback RPC
 * endpoint. Host capabilities are answered by the fake host, so the assertions are about
 * the backend's own validation, capability issuance and persistence rather than about Qt.
 */

const executable = resolveBackendExecutable();
const EDITOR_IDS = ["vscode", "cursor", "zed", "sublime", "idea", "webstorm", "phpstorm", "pycharm"];

/** Qt reports POSIX separators; compare paths in one normalized form. */
function normalizePath(value) {
	return value.replace(/\\/g, "/");
}

/** Recycling is a host round trip, so it can land just after the channel answered. */
async function waitFor(predicate, timeoutMs = 5_000) {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		if (predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return false;
}

function readSettings(fixture) {
	return JSON.parse(readFileSync(join(fixture.userData, "settings.json"), "utf8"));
}

if (!executable) {
	test("native2 terminal/os parity", { skip: "PiDeckBackend.exe is not built (run: xmake build PiDeckBackend)" }, () => {});
} else {
	test("native:clipboard-snapshot issues a capability for the host clipboard paths", async (t) => {
		const picked = [];
		const session = await startBackendSession(t, {
			hostHandlers: {
				"clipboard.snapshot": () => ({
					result: {
						text: "clip-text",
						html: "<b>clip</b>",
						filePaths: ["C:\\Users\\Public\\clip.png"],
						hasImage: true,
						sequence: 42,
					},
				}),
			},
			prepare: (fixture) => {
				picked.push(fixture);
				return {};
			},
		});
		const response = await session.invoke("native:clipboard-snapshot");
		assert.equal(response.payload.ok, true, JSON.stringify(response.payload));
		const snapshot = response.payload.result;
		assert.equal(snapshot.text, "clip-text");
		assert.equal(snapshot.sequence, 42);
		assert.deepEqual(snapshot.filePaths, ["C:\\Users\\Public\\clip.png"]);
		assert.equal(typeof snapshot.externalFileCapabilityId, "string");
		assert.ok(snapshot.externalFileCapabilityId.length > 0, "clipboard paths must be redeeemable, never raw");
	});

	test("backgrounds:pick imports the picked image and recycles the previous one", async (t) => {
		const session = await startBackendSession(t, {});
		const source = join(session.fixture.root, "chosen.PNG");
		writeFileSync(source, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]));
		// A stale background from a previous pick must be recycled, not deleted.
		const stale = join(session.fixture.backgrounds, "bg-1.png");
		writeFileSync(stale, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

		session.host.handlers["dialog.open"] = () => ({ result: { canceled: false, filePaths: [source] } });
		const picked = await session.invoke("backgrounds:pick");
		assert.equal(picked.payload.ok, true, JSON.stringify(picked.payload));
		const name = picked.payload.result;
		assert.match(name, /^bg-\d+\.png$/);
		assert.ok(existsSync(join(session.fixture.backgrounds, name)), "the picked image must be copied");
		assert.ok(await waitFor(() => session.trashCalls.length > 0), "the previous background must be recycled");
		assert.deepEqual(session.trashCalls.map(normalizePath), [normalizePath(stale)]);

		// A cancelled dialog reports an empty name and changes nothing.
		session.host.handlers["dialog.open"] = () => ({ result: { canceled: true, filePaths: [] } });
		const cancelled = await session.invoke("backgrounds:pick");
		assert.equal(cancelled.payload.result, "");
	});

	test("backgrounds:remove only accepts generated names", async (t) => {
		const session = await startBackendSession(t, {});
		const name = "bg-1700000000000.png";
		writeFileSync(join(session.fixture.backgrounds, name), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

		const removed = await session.invoke("backgrounds:remove", [name]);
		assert.equal(removed.payload.ok, true, JSON.stringify(removed.payload));
		assert.ok(await waitFor(() => session.trashCalls.length > 0), "the background must be recycled");
		assert.deepEqual(session.trashCalls.map(normalizePath), [normalizePath(join(session.fixture.backgrounds, name))]);

		// Traversal and foreign names are ignored without touching the host.
		for (const bad of ["../settings.json", "bg-../../secret.png", "user-data/settings.json", ""]) {
			const rejected = await session.invoke("backgrounds:remove", [bad]);
			assert.equal(rejected.payload.ok, true, JSON.stringify(rejected.payload));
		}
		assert.equal(session.trashCalls.length, 1, "only the generated name may be recycled");
	});

	test("editors:update validates the command and records a manual override", async (t) => {
		const session = await startBackendSession(t, {});
		const executablePath = join(session.fixture.root, "editor.exe");
		writeFileSync(executablePath, "");

		const updated = await session.invoke("editors:update", ["vscode", { enabled: true, command: executablePath }]);
		assert.equal(updated.payload.ok, true, JSON.stringify(updated.payload));
		const settings = readSettings(session.fixture);
		assert.equal(settings.externalEditors.vscode.enabled, true);
		assert.equal(settings.externalEditors.vscode.command, executablePath);
		assert.equal(settings.externalEditors.vscode.detectedFrom, "manual");
		assert.equal(typeof settings.externalEditors.vscode.updatedAt, "number");

		const missing = await session.invoke("editors:update", ["vscode", { command: join(session.fixture.root, "nope.exe") }]);
		assert.equal(missing.payload.ok, false);
		assert.match(missing.payload.error.message, /Editor path does not exist/);

		const unsupported = await session.invoke("editors:update", ["notepad", { enabled: true }]);
		assert.equal(unsupported.payload.ok, false);
		assert.match(unsupported.payload.error.message, /Unsupported editor: notepad/);
	});

	test("editors:list only reports enabled, launchable editors", async (t) => {
		const session = await startBackendSession(t, {});
		const executablePath = join(session.fixture.root, "editor.exe");
		writeFileSync(executablePath, "");

		const empty = await session.invoke("editors:list");
		assert.deepEqual(empty.payload.result, []);

		await session.invoke("editors:update", ["cursor", { enabled: true, command: executablePath }]);
		const listed = await session.invoke("editors:list");
		assert.equal(listed.payload.ok, true, JSON.stringify(listed.payload));
		assert.deepEqual(listed.payload.result, [
			{ id: "cursor", name: "Cursor", command: executablePath, detectedFrom: "manual" },
		]);

		// Disabling removes it from the menu without losing the stored command.
		await session.invoke("editors:update", ["cursor", { enabled: false }]);
		const disabled = await session.invoke("editors:list");
		assert.deepEqual(disabled.payload.result, []);
		assert.equal(readSettings(session.fixture).externalEditors.cursor.command, executablePath);
	});

	test("editors:redetect persists every supported editor slot", async (t) => {
		// Deliberately a second launch: `editors:redetect` answers from a re-read of the
		// settings file, while the *first-launch* startup task runs its own `detectEditors()`
		// on a worker thread and merges a second detection result when it finishes (oracle
		// `detectExternalEditorsOnFirstLaunch` has the identical async merge). Comparing the
		// answer with the file during that window would race on `updatedAt` — measured on the
		// unseeded fixture: response `…932`, file `…934`, and the startup log line
		// "External editors detected on first launch" stamped `…934` — so the assertion would
		// depend on thread scheduling rather than on behaviour. A configured editor is the
		// production guard that skips first-launch detection
		// (`BackendStartupTasks.cpp:197-203` / `backendStartupTasks.ts:181-182`), leaving
		// `editors:redetect` as the only writer, which keeps the comparison exact below.
		const session = await startBackendSession(t, {
			prepare: (fixture) => {
				const command = join(fixture.root, "editor.exe");
				writeFileSync(command, "");
				return {
					settings: {
						externalEditors: {
							vscode: { enabled: true, command, detectedFrom: "manual", updatedAt: 1 },
						},
					},
				};
			},
		});
		const response = await session.invoke("editors:redetect");
		assert.equal(response.payload.ok, true, JSON.stringify(response.payload));
		const settings = response.payload.result;
		for (const id of EDITOR_IDS) {
			assert.ok(settings.externalEditors[id], `missing editor slot ${id}`);
			assert.equal(typeof settings.externalEditors[id].enabled, "boolean");
		}
		// Detection never invents an enabled editor for a missing binary.
		for (const id of EDITOR_IDS) {
			if (!settings.externalEditors[id].enabled) continue;
			assert.ok(settings.externalEditors[id].command.length > 0);
		}
		// A hand-configured command and its timestamp are never overwritten by re-detection.
		assert.deepEqual(settings.externalEditors.vscode, {
			enabled: true,
			command: join(session.fixture.root, "editor.exe"),
			detectedFrom: "manual",
			updatedAt: 1,
		});
		assert.deepEqual(readSettings(session.fixture).externalEditors, settings.externalEditors);
	});

	test("editors:choose-executable returns the picked path or null", async (t) => {
		const session = await startBackendSession(t, {});
		const chosen = join(session.fixture.root, "chosen.exe");
		writeFileSync(chosen, "");
		session.host.handlers["dialog.open"] = () => ({ result: { canceled: false, filePaths: [chosen] } });
		const picked = await session.invoke("editors:choose-executable");
		assert.equal(picked.payload.result, chosen);

		session.host.handlers["dialog.open"] = () => ({ result: { canceled: true, filePaths: [] } });
		const cancelled = await session.invoke("editors:choose-executable");
		assert.equal(cancelled.payload.result, null);
	});

	test("system:process-metrics reports a real snapshot shape", async (t) => {
		const session = await startBackendSession(t, {});
		const response = await session.invoke("system:process-metrics");
		assert.equal(response.payload.ok, true, JSON.stringify(response.payload));
		const snapshot = response.payload.result;
		assert.deepEqual(snapshot.agents, []);
		assert.equal(snapshot.totalAgentBytes, 0);
		assert.equal(typeof snapshot.sampledAt, "number");
		assert.ok(snapshot.sampledAt > 1_600_000_000_000);
	});

	test("system:stop-agent rejects untrusted input instead of stopping everything", async (t) => {
		const session = await startBackendSession(t, {});
		const empty = await session.invoke("system:stop-agent", [""]);
		assert.equal(empty.payload.ok, false);
		assert.equal(empty.payload.error.message, "invalid agentId");

		const unknown = await session.invoke("system:stop-agent", ["no-such-agent"]);
		assert.equal(unknown.payload.ok, false);
		assert.match(unknown.payload.error.message, /Session runtime is not available/);
	});
}
