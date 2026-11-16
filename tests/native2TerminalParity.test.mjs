import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import test from "node:test";

import {
	SseClient,
	resolveBackendExecutable,
	startBackendSession,
} from "./helpers/native2BackendHarness.mjs";

const executable = resolveBackendExecutable();
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PROJECT_ID = "terminal-project";
const IS_WINDOWS = process.platform === "win32";
const TEST_SHELL = IS_WINDOWS ? "cmd" : "bash";
const LINE_END = IS_WINDOWS ? "\r\n" : "\n";

/**
 * Child-side console query. `mode con` is localized (this machine runs a zh-CN
 * console), so the size is read from PowerShell's RawUI instead.
 */
const SIZE_QUERY = IS_WINDOWS
	? 'powershell -NoProfile -Command "$s=$Host.UI.RawUI.WindowSize; Write-Host (\\"SIZE=\\" + $s.Width + \\"x\\" + $s.Height)"\r\n'
	: 'set -- $(stty size); printf "SIZE=%sx%s\\n" "$2" "$1"\n';

/** Fixture with one real project directory the terminal can start in. */
function projectPrepare(fixture) {
	const projectPath = join(fixture.root, "project");
	mkdirSync(projectPath, { recursive: true });
	writeFileSync(
		join(fixture.userData, "projects.json"),
		JSON.stringify([
			{
				id: PROJECT_ID,
				name: "terminal-project",
				path: projectPath,
				lastOpenedAt: 1_700_000_000_000,
				sortOrder: 0,
				environment: "windows",
			},
		]),
	);
	return { projectPath };
}

async function startTerminalSession(t) {
	const session = await startBackendSession(t, { prepare: projectPrepare });
	const client = new SseClient(`${session.baseUrl}__pideck/events?token=${session.token}`);
	await client.connect();
	t.after(() => client.close());
	return { ...session, client, projectPath: join(session.fixture.root, "project") };
}

function projectTarget(cwd) {
	return { kind: "project", projectId: PROJECT_ID, cwd };
}

/** Collect every `terminal:data` chunk already received for one tab. */
function collectedData(client, tabId) {
	return client.frames
		.filter((frame) => frame.payload.channel === "terminal:data" && frame.payload.args?.[0]?.tabId === tabId)
		.map((frame) => frame.payload.args[0].data)
		.join("");
}

/**
 * Wait for the real shell's first prompt before writing input. The POSIX branch accepts
 * the conventional user or root prompt, and the Windows branch keeps its cwd check.
 */
function waitForPrompt(client, tabId, projectPath) {
	return waitForData(client, tabId, (data) => IS_WINDOWS
		? data.includes(`${projectPath.split(/[\\/]/).pop()}>`)
		: /[$#] /.test(data));
}

function waitForData(client, tabId, predicate, timeoutMs = 20_000) {
	return client.waitFor(
		(frame) =>
			frame.payload.channel === "terminal:data" &&
			frame.payload.args?.[0]?.tabId === tabId &&
			predicate(collectedData(client, tabId)),
		timeoutMs,
	);
}

/** Read real child identities through the host's process table. */
function childProcesses(parentPid) {
	if (!IS_WINDOWS) {
		const output = execFileSync("ps", ["-A", "-o", "pid=,ppid=,comm="], { encoding: "utf8", timeout: 20_000 });
		return output.split("\n").flatMap((line) => {
			const fields = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
			return fields && Number(fields[2]) === parentPid ? [{ ProcessId: Number(fields[1]), Name: fields[3] }] : [];
		});
	}
	const script =
		`Get-CimInstance Win32_Process -Filter "ParentProcessId=${parentPid}" | ` +
		"Select-Object ProcessId,Name | ConvertTo-Json -Compress";
	const output = execFileSync(
		"powershell",
		["-NoProfile", "-NonInteractive", "-Command", script],
		{ encoding: "utf8", timeout: 20_000 },
	).trim();
	if (!output) return [];
	const parsed = JSON.parse(output);
	return Array.isArray(parsed) ? parsed : [parsed];
}

/** Check the original pid even after it has been reparented by backend shutdown. */
function processExists(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (error.code === "ESRCH") return false;
		if (error.code === "EPERM") return true;
		throw error;
	}
}

if (!executable) {
	test("native2 terminal parity", { skip: "PiDeckBackend.exe is not built (run: xmake build PiDeckBackend)" }, () => {});
} else {
	test("shell discovery returns usable labeled candidates", async (t) => {
		const { invoke } = await startTerminalSession(t);
		const response = await invoke("terminal:shells");
		assert.equal(response.payload.ok, true, JSON.stringify(response.payload));
		const shells = response.payload.result;
		assert.ok(Array.isArray(shells) && shells.length > 0);

		assert.ok(shells.some((entry) => entry.shell === TEST_SHELL && entry.available === true));
		for (const entry of shells) {
			assert.equal(typeof entry.label, "string");
			assert.ok(entry.label.length > 0);
			assert.equal(entry.available, true);
		}
		assert.equal(new Set(shells.map((entry) => entry.shell)).size, shells.length, "candidates must be deduped");
	});

	test("terminal:create returns a real tab with the stable project owner key", async (t) => {
		const { invoke, projectPath } = await startTerminalSession(t);
		const created = await invoke("terminal:create", [projectTarget(projectPath), TEST_SHELL]);
		assert.equal(created.payload.ok, true, JSON.stringify(created.payload));
		const tab = created.payload.result;

		assert.match(tab.id, UUID_PATTERN);
		assert.equal(tab.agentId, "");
		assert.equal(tab.cwd, projectPath);
		assert.equal(tab.shell, TEST_SHELL);
		assert.equal(tab.title, `${TEST_SHELL} 1`);
		assert.equal(typeof tab.createdAt, "number");
		assert.ok(tab.createdAt > 1_600_000_000_000);
		// Project ownership is path-based, so two sessions in the same directory share it.
		assert.equal(tab.ownerKey, `cwd:${IS_WINDOWS ? projectPath.replaceAll("\\", "/").toLowerCase() : projectPath}`);

		// Windows owners fold local path case. POSIX owners preserve it.
		const sameOwner = await invoke("terminal:list", [projectTarget(projectPath.toUpperCase())]);
		assert.equal(sameOwner.payload.ok, true, JSON.stringify(sameOwner.payload));
		assert.deepEqual(
			sameOwner.payload.result.map((entry) => entry.id),
			IS_WINDOWS ? [tab.id] : [],
		);

		// A trailing separator is the same directory.
		const trailing = await invoke("terminal:list", [projectTarget(`${projectPath}${IS_WINDOWS ? "\\" : "/"}`)]);
		assert.deepEqual(
			trailing.payload.result.map((entry) => entry.id),
			[tab.id],
		);

		await invoke("terminal:close", [tab.id]);
	});

	test("a live shell accepts input after startup and its output arrives as terminal:data", async (t) => {
		const { invoke, projectPath, client } = await startTerminalSession(t);
		const created = await invoke("terminal:create", [projectTarget(projectPath), TEST_SHELL]);
		assert.equal(created.payload.ok, true, JSON.stringify(created.payload));
		const tabId = created.payload.result.id;

		// Startup output must arrive before any input: the PTY is live, not just spawned.
		await waitForPrompt(client, tabId, projectPath);
		assert.ok(collectedData(client, tabId).length > 0);

		// `type` prints the file contents, so the marker can only appear if the child
		// actually executed the command. A ConPTY echo of the typed line cannot contain it.
		const marker = `PIDEK_OUTPUT_${randomUUID()}`;
		writeFileSync(join(projectPath, "marker.txt"), `${marker}\r\n`);
		const input = await invoke("terminal:input", [tabId, `${IS_WINDOWS ? "type" : "cat"} marker.txt${LINE_END}`]);
		assert.equal(input.payload.ok, true, JSON.stringify(input.payload));

		await waitForData(client, tabId, (data) => data.includes(marker));
		assert.match(collectedData(client, tabId), new RegExp(marker));

		await invoke("terminal:close", [tabId]);
	});

	test("terminal:exit reports the real child exit code", async (t) => {
		const { invoke, projectPath, client } = await startTerminalSession(t);
		const created = await invoke("terminal:create", [projectTarget(projectPath), TEST_SHELL]);
		const tabId = created.payload.result.id;
		await waitForData(client, tabId, (data) => data.length > 0);

		await invoke("terminal:input", [tabId, `exit 7${LINE_END}`]);
		const exit = await client.waitFor(
			(frame) => frame.payload.channel === "terminal:exit" && frame.payload.args?.[0]?.tabId === tabId,
			20_000,
		);
		assert.equal(exit.payload.args[0].exitCode, 7);

		// The tab stays listed, marked exited, with the exit banner in its replay buffer.
		const listed = await invoke("terminal:list", [projectTarget(projectPath)]);
		const tab = listed.payload.result.find((entry) => entry.id === tabId);
		assert.ok(tab, "an exited tab stays in the owner bucket");
		assert.equal(tab.exited, true);
		assert.equal(tab.exitCode, 7);
		assert.match(tab.buffer, /\[process exited with code 7\]/);

		// Input to an exited tab is a silent no-op, exactly like the oracle.
		const afterExit = await invoke("terminal:input", [tabId, `echo ignored${LINE_END}`]);
		assert.equal(afterExit.payload.ok, true, JSON.stringify(afterExit.payload));
	});

	test("terminal:ensure is idempotent and create numbers tabs per owner", async (t) => {
		const { invoke, projectPath } = await startTerminalSession(t);
		// ensure() creates with the discovered default shell, exactly like the oracle.
		const first = await invoke("terminal:ensure", [projectTarget(projectPath)]);
		assert.equal(first.payload.ok, true, JSON.stringify(first.payload));
		assert.equal(first.payload.result.length, 1);
		const firstId = first.payload.result[0].id;
		const defaultShell = first.payload.result[0].shell;
		assert.equal(first.payload.result[0].title, `${defaultShell} 1`);

		const again = await invoke("terminal:ensure", [projectTarget(projectPath)]);
		assert.deepEqual(
			again.payload.result.map((entry) => entry.id),
			[firstId],
			"ensure must not create a second terminal",
		);

		const second = await invoke("terminal:create", [projectTarget(projectPath), TEST_SHELL]);
		assert.equal(second.payload.result.title, `${TEST_SHELL} 2`, "the tab index counts the owner bucket");
		const listed = await invoke("terminal:list", [projectTarget(projectPath)]);
		assert.equal(listed.payload.result.length, 2);
		assert.deepEqual(
			listed.payload.result.map((entry) => entry.title).sort(),
			[`${defaultShell} 1`, `${TEST_SHELL} 2`].sort(),
		);
		for (const entry of listed.payload.result) {
			assert.equal(typeof entry.buffer, "string", "list snapshots carry the replay buffer");
		}
	});

	test("terminal:resize reaches the child console", async (t) => {
		const { invoke, projectPath, client } = await startTerminalSession(t);
		const created = await invoke("terminal:create", [projectTarget(projectPath), TEST_SHELL]);
		const tabId = created.payload.result.id;
		await waitForPrompt(client, tabId, projectPath);

		// The oracle clamps a collapsed viewport so the PTY stays usable. ConPTY reports
		// the resulting viewport as CSI 8 ; rows ; cols t, which is emitted only when the
		// pseudoconsole itself was resized and cannot be produced by the shell.
		const clamped = await invoke("terminal:resize", [tabId, 0, 0]);
		assert.equal(clamped.payload.ok, true, JSON.stringify(clamped.payload));
		if (IS_WINDOWS) {
			await waitForData(client, tabId, (data) => data.includes("\u001b[8;1;2t"));
		} else {
			await invoke("terminal:input", [tabId, SIZE_QUERY]);
			await waitForData(client, tabId, (data) => data.includes("SIZE=2x1"));
		}

		const resized = await invoke("terminal:resize", [tabId, 100, 40]);
		assert.equal(resized.payload.ok, true, JSON.stringify(resized.payload));
		// The child queries its own console, which proves the size reached the process
		// rather than only the ConPTY front end. Locale independent on purpose.
		await invoke("terminal:input", [tabId, SIZE_QUERY]);
		await waitForData(client, tabId, (data) => data.includes("SIZE=100x40"));
		assert.match(collectedData(client, tabId), /SIZE=100x40/);
	});

	test("terminals are isolated per owner", async (t) => {
		const { invoke, fixture, projectPath } = await startTerminalSession(t);
		const otherPath = join(fixture.root, "other-project");
		mkdirSync(otherPath, { recursive: true });

		const first = await invoke("terminal:create", [projectTarget(projectPath), TEST_SHELL]);
		const second = await invoke("terminal:create", [projectTarget(otherPath), TEST_SHELL]);
		assert.equal(first.payload.ok, true, JSON.stringify(first.payload));
		assert.equal(second.payload.ok, true, JSON.stringify(second.payload));
		assert.notEqual(first.payload.result.ownerKey, second.payload.result.ownerKey);
		assert.equal(second.payload.result.title, `${TEST_SHELL} 1`, "each owner numbers its own tabs");

		const firstList = await invoke("terminal:list", [projectTarget(projectPath)]);
		assert.deepEqual(
			firstList.payload.result.map((entry) => entry.id),
			[first.payload.result.id],
		);
		const secondList = await invoke("terminal:list", [projectTarget(otherPath)]);
		assert.deepEqual(
			secondList.payload.result.map((entry) => entry.id),
			[second.payload.result.id],
		);
	});

	test("an agent target is validated against the runtime instead of falling back to a project terminal", async (t) => {
		const { invoke } = await startTerminalSession(t);
		const response = await invoke("terminal:create", [
			{ kind: "agent", sessionId: "missing-session", agentId: "missing-agent", runtimeGeneration: 1 },
		]);
		assert.equal(response.payload.ok, false);
		assert.match(response.payload.error.message, /Session not found/i);

		const staleGeneration = await invoke("terminal:list", [
			{ kind: "agent", sessionId: "missing-session", agentId: "missing-agent", runtimeGeneration: 0 },
		]);
		assert.equal(staleGeneration.payload.ok, false);
	});

	test("the renderer can never name the terminal executable", async (t) => {
		const { invoke } = await startTerminalSession(t);
		// The prototype accepted (program, argv). A bare string is not a target.
		const legacyShape = await invoke("terminal:create", ["cmd.exe", ["/c", "echo pwned"]]);
		assert.equal(legacyShape.payload.ok, false);
		assert.match(legacyShape.payload.error.message, /Terminal target is required/);

		// An empty cwd must not silently start a shell in the backend's own directory.
		const emptyCwd = await invoke("terminal:create", [{ kind: "project", projectId: PROJECT_ID, cwd: "" }]);
		assert.equal(emptyCwd.payload.ok, false);
		assert.match(emptyCwd.payload.error.message, /Terminal cwd is required/);

		// An unknown shell id falls back to the discovered order instead of executing it.
		const unknownShell = await invoke("terminal:create", [projectTarget(process.cwd()), "not-a-shell"]);
		assert.equal(unknownShell.payload.ok, true, JSON.stringify(unknownShell.payload));
		assert.notEqual(unknownShell.payload.result.shell, "not-a-shell");
		await invoke("terminal:close", [unknownShell.payload.result.id]);
	});

	test("the replay buffer is bounded", async (t) => {
		const { invoke, projectPath, client } = await startTerminalSession(t);
		const created = await invoke("terminal:create", [projectTarget(projectPath), TEST_SHELL]);
		const tabId = created.payload.result.id;
		await waitForData(client, tabId, (data) => data.length > 0);

		// ~240k characters of child output, comfortably above the 200k cap.
		const filler = "0123456789".repeat(6);
		const marker = `REPLAY_END_${randomUUID()}`;
		writeFileSync(join(projectPath, "replay-end.txt"), `${marker}${LINE_END}`);
		const command = IS_WINDOWS
			? `for /L %i in (1,1,4000) do @echo ${filler}\r\ntype replay-end.txt\r\n`
			: `for ((i=0; i<4000; i++)); do printf '%s\\n' '${filler}'; done; cat replay-end.txt\n`;
		await invoke("terminal:input", [
			tabId,
			command,
		]);
		// Only executed file output contains the marker, so the full loop has completed.
		await waitForData(client, tabId, (data) => data.includes(marker), 30_000);
		const listed = await invoke("terminal:list", [projectTarget(projectPath)]);
		const buffer = listed.payload.result.find((entry) => entry.id === tabId)?.buffer ?? "";
		assert.ok(buffer.length > 0);
		assert.ok(buffer.length <= 200_000, `replay buffer must stay bounded, saw ${buffer.length}`);
		assert.ok(buffer.length >= 100_000, `the cap must keep the newest output, saw ${buffer.length}`);
		assert.ok(buffer.includes(marker), "the newest output must remain in the replay buffer");
	});

	test("terminal:close kills the process and forgets the tab", async (t) => {
		const { invoke, projectPath, backend } = await startTerminalSession(t);
		const created = await invoke("terminal:create", [projectTarget(projectPath), TEST_SHELL]);
		const tabId = created.payload.result.id;

		const before = childProcesses(backend.child.pid);
		assert.ok(
			before.some((entry) => entry.ProcessId > 0),
			"the backend must own the PTY child process",
		);

		const closed = await invoke("terminal:close", [tabId]);
		assert.equal(closed.payload.ok, true, JSON.stringify(closed.payload));

		const listed = await invoke("terminal:list", [projectTarget(projectPath)]);
		assert.deepEqual(listed.payload.result, []);

		const missing = await invoke("terminal:input", [tabId, `echo hi${LINE_END}`]);
		assert.equal(missing.payload.ok, false);
		assert.match(missing.payload.error.message, new RegExp(`Terminal not found: ${tabId}`));

		// The shell process must be gone, not merely detached from the tab table.
		let remaining = before;
		for (let attempt = 0; attempt < 40; attempt += 1) {
			remaining = before.filter((entry) => processExists(entry.ProcessId));
			if (remaining.length === 0) break;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		assert.deepEqual(remaining, [], "closing a tab must terminate its PTY child");
	});

	test("shutdown closes every terminal", async (t) => {
		const { invoke, projectPath, backend, host } = await startTerminalSession(t);
		const created = await invoke("terminal:create", [projectTarget(projectPath), TEST_SHELL]);
		assert.equal(created.payload.ok, true, JSON.stringify(created.payload));
		const before = childProcesses(backend.child.pid);
		assert.ok(before.length > 0);

		host.emit("application.prepareQuit");
		await host.waitForEvent("application.readyToExit", 15_000);
		const exit = await backend.exited;
		assert.equal(exit.code, 0, `stderr: ${exit.stderr}`);

		let remaining = before;
		for (let attempt = 0; attempt < 40; attempt += 1) {
			remaining = before.filter((entry) => processExists(entry.ProcessId));
			if (remaining.length === 0) break;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		assert.deepEqual(remaining, [], "no PTY child may survive the backend");
	});
}
