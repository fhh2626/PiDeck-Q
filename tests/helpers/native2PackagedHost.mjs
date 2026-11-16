import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { childPathEnvironment, environmentPath } from "./native2BackendHarness.mjs";
import { joinPathParts } from "./native2FakeProcess.mjs";

/**
 * Packaged-host harness for the native2 acceptance gate.
 *
 * Unlike `native2BackendHarness.mjs` (which speaks the wire protocols against
 * `PiDeckBackend.exe` directly), this harness starts the **packaged product**: the real
 * `PiDeck-Q.exe` out of an isolated stage, which spawns its own C++ sidecar, which in turn
 * serves the real renderer bundle over loopback HTTP + SSE. UI assertions therefore run in
 * the real WebView2 page through the Chrome DevTools Protocol, and process assertions run
 * on the real process tree.
 *
 * Two properties are deliberate:
 *  - the child environment is an **isolated PATH** (`C:\Windows\system32;C:\Windows` +
 *    the stage + a directory holding the native fake `pi`), so a packaged binary that
 *    still needed Node or an undeployed Qt DLL fails here instead of on a user machine;
 *  - WebView2 gets its own user-data folder and its own remote-debugging port, so a
 *    running installed PiDeck-Q does not block the gate and is never touched.
 */

export const STAGE_ENV = "PIDECK_NATIVE2_STAGE";
export const DEFAULT_STAGE = "build/native2-validation-unpacked";

export function requirePackagedHost(repoRoot = process.cwd(), environment = process.env) {
	const relative = environment[STAGE_ENV]?.trim() || environment.PIDECK_STAGE_DIR?.trim() || DEFAULT_STAGE;
	// Absolute on purpose: the host is spawned with the fixture as its working directory,
	// and a relative executable path would be resolved against that directory instead.
	const stage = resolve(repoRoot, relative);
	const required = environment.PIDECK_REQUIRE_BACKEND_TESTS === "1";
	const host = join(stage, process.platform === "win32" ? "PiDeck-Q.exe" : "PiDeck-Q");
	if (!existsSync(host)) {
		// A missing package must fail the required gate: a silently skipped suite would be
		// read as "the packaged product was verified".
		if (required) {
			throw new Error(
				`PIDECK_REQUIRE_BACKEND_TESTS=1 but no packaged host exists at ${host}; build it with ` +
					`"PIDECK_STAGE_DIR=${relative} xmake f -m release -y && xmake -r"`,
			);
		}
		return { stage: "", host: "", available: false, relative };
	}
	return { stage, host, available: true, relative };
}

/** Explicit fake-pi path, used to prove the gate fails on an older test double. */
export const FAKE_PI_ENV = "PIDECK_NATIVE2_FAKE_PI";
const FAKE_PI_SOURCE = "native/tests/Native2FakePi.cpp";

/**
 * Fake `pi` built from `native/tests/Native2FakePi.cpp` (dependency-free native binary).
 *
 * A binary older than its source is **stale** and must fail a required gate: the exact
 * stale release/debug build this check rejects hid the multi-turn defects (reused message
 * ids, a latched ask answer), so testing it would have produced a green result for a fake
 * that no longer speaks the asserted turn shape. Non-required runs treat it as absent, so a
 * plain `npm test` on a checkout with a developer's old binary skips instead of failing.
 */
export function resolveFakePi(repoRoot = process.cwd()) {
	const required = process.env.PIDECK_REQUIRE_BACKEND_TESTS === "1";
	const override = process.env[FAKE_PI_ENV] ?? "";
	const candidates = override
		? [resolve(repoRoot, override)]
		: [
				resolve(repoRoot, "build/windows/x64/release/PiDeck-FakePi2.exe"),
				resolve(repoRoot, "build/windows/x64/debug/PiDeck-FakePi2.exe"),
			];
	const source = resolve(repoRoot, FAKE_PI_SOURCE);
	const sourceMtime = existsSync(source) ? statSync(source).mtimeMs : 0;
	let stale = "";
	for (const candidate of candidates) {
		if (!existsSync(candidate)) continue;
		const mtime = statSync(candidate).mtimeMs;
		if (sourceMtime > 0 && mtime < sourceMtime) {
			stale = `${candidate} (${new Date(mtime).toISOString()}) is older than ${FAKE_PI_SOURCE} (${new Date(sourceMtime).toISOString()})`;
			continue;
		}
		return candidate;
	}
	if (required) {
		throw new Error(
			`PIDECK_REQUIRE_BACKEND_TESTS=1 but no fresh native fake pi is available` +
				(stale ? `: ${stale}; rebuild it with "xmake build -y PiDeck-FakePi2"` : `; build it with "xmake build -y PiDeck-FakePi2"`),
		);
	}
	if (stale) console.log(`warning: ignoring stale native fake pi ${stale}`);
	return "";
}

/**
 * Product-package invariants for the C++ kind. `scripts/verify-build-artifacts.mjs` already
 * derives these from the shared definition, so the gate re-runs it instead of keeping a
 * second copy of the rules; the extra checks here are the ones the verifier intentionally
 * does not own (the TS extension dependencies must *stay*).
 */
export function verifyPackagedStage(stage) {
	const verifier = spawnSync(
		process.execPath,
		["scripts/verify-build-artifacts.mjs", "--out", stage],
		{ env: process.env, encoding: "utf8" },
	);
	if (verifier.status !== 0) {
		throw new Error(`verify-build-artifacts rejected ${stage}: ${verifier.stdout}${verifier.stderr}`);
	}
	return verifier.stdout.trim();
}

export function stageFacts(stage) {
	let files = 0;
	let bytes = 0;
	const walk = (directory) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) walk(path);
			else {
				files += 1;
				bytes += statSync(path).size;
			}
		}
	};
	walk(stage);
	return { files, bytes };
}

const FAKE_PI_EXE = "pi.exe";

/**
 * Isolated profile for one host launch: user data (settings/projects), a private WebView2
 * user-data folder, a private `PIDECK_HOME` so pi sessions/prompts never touch the real
 * `~/.pi`, a fixture project, and the native fake pi in its own PATH directory.
 */
export function createHostFixture({ fakePi, prefix = "pideck-native2-package-" }) {
	const root = mkdtempSync(join(tmpdir(), prefix));
	const userData = join(root, "user-data");
	const webview2 = join(root, "webview2");
	const piHome = join(root, "pi-home");
	const project = join(root, "project");
	const piDirectory = join(root, "fake-pi");
	for (const directory of [userData, webview2, piHome, project, piDirectory]) mkdirSync(directory, { recursive: true });
	writeFileSync(join(project, "README.md"), "# fixture project\n");
	const piExecutable = join(piDirectory, FAKE_PI_EXE);
	cpSync(fakePi, piExecutable);
	writeFileSync(
		join(userData, "projects.json"),
		JSON.stringify([
			{
				id: "fixture-project",
				name: "fixture-project",
				path: project,
				lastOpenedAt: 1_794_600_000_000,
				sortOrder: 0,
				environment: "windows",
			},
		]),
	);
	writeFileSync(
		join(userData, "settings.json"),
		JSON.stringify({
			theme: "system",
			language: "en-US",
			// Pretend the environment check already passed, exactly like a returning user:
			// the fixture must not depend on the real `pi` being installed on this machine.
			piEnvironmentChecked: true,
			piInstall: { command: piExecutable, version: "0.79.0", runtimeKind: "typescript" },
			customPiPath: "",
			enableNotifications: false,
			closeToTray: false,
		}),
	);
	return {
		root,
		userData,
		webview2,
		piHome,
		project,
		piDirectory,
		piExecutable,
		piTrafficLog: join(root, "pi-traffic.log"),
		cleanup: () => {
			// WebView2 keeps its own processes (and their profile handles) alive for a moment
			// after the host dies, so a single rm can race the release. Retry generously and
			// leave the directory behind rather than failing an otherwise green gate.
			try {
				rmSync(root, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 });
			} catch (error) {
				console.log(`warning: temp fixture could not be removed: ${String(error)}`);
			}
		},
	};
}

/** Every process on the machine with parent links, so descendants can be walked. */
export function processTable() {
	const script =
		"Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,WorkingSetSize | ConvertTo-Json -Compress";
	const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
		encoding: "utf8",
		maxBuffer: 32 * 1024 * 1024,
	});
	if (result.status !== 0) throw new Error(`process table unavailable: ${result.stderr}`);
	const parsed = JSON.parse(result.stdout);
	return Array.isArray(parsed) ? parsed : [parsed];
}

export function descendants(pid) {
	const table = processTable();
	const byParent = new Map();
	for (const entry of table) {
		const list = byParent.get(entry.ParentProcessId) ?? [];
		list.push(entry);
		byParent.set(entry.ParentProcessId, list);
	}
	const found = [];
	const queue = [pid];
	while (queue.length > 0) {
		const current = queue.shift();
		for (const child of byParent.get(current) ?? []) {
			found.push(child);
			queue.push(child.ProcessId);
		}
	}
	return found;
}

/**
 * Start the packaged host. `PATH` is deliberately minimal; the stage must provide every
 * DLL it needs and nothing may fall back to the machine's Node installation.
 */
export function launchHost({ stage, fixture, port, isolatedPath = true, extraEnv = {} }) {
	const host = resolve(stage, process.platform === "win32" ? "PiDeck-Q.exe" : "PiDeck-Q");
	const pathParts = isolatedPath
		? ["C:\\Windows\\system32", "C:\\Windows", fixture.piDirectory, stage]
		: ["C:\\Windows\\system32", "C:\\Windows", "C:\\Windows\\System32\\Wbem", fixture.piDirectory, stage];
	const hostPath = joinPathParts([
		...pathParts,
		// A non-isolated launch keeps the machine search path. It is read case insensitively
		// because a Windows block spells the variable `Path` and the host environment below is
		// built with object spread.
		isolatedPath ? "" : environmentPath(process.env),
	]);
	const environment = childPathEnvironment(
		{
			...process.env,
			PIDECK_USER_DATA: fixture.userData,
			PIDECK_HOME: fixture.piHome,
			FAKE_PI_LOG: fixture.piTrafficLog,
			WEBVIEW2_USER_DATA_FOLDER: fixture.webview2,
			WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
		},
		hostPath,
	);
	// Exercise the backend shipped beside the host. Inherited test overrides must
	// not substitute a different executable or command-line arguments.
	delete environment.PIDECK_SIDECAR_EXECUTABLE;
	delete environment.PIDECK_SIDECAR_ARGS;
	// Re-applied through the helper so an override cannot reintroduce a second, case-variant
	// search-path entry next to the isolated one.
	const child = spawn(host, [], {
		cwd: fixture.project,
		env: childPathEnvironment({ ...environment, ...extraEnv }, environmentPath(extraEnv, hostPath)),
		stdio: ["ignore", "pipe", "pipe"],
	});
	const output = { stdout: "", stderr: "" };
	child.stdout.on("data", (chunk) => {
		output.stdout += chunk.toString("utf8");
	});
	child.stderr.on("data", (chunk) => {
		output.stderr += chunk.toString("utf8");
	});
	const exited = new Promise((resolve) => {
		child.once("error", (error) => {
			output.error = error.message;
			resolve({ code: null, signal: null, at: Date.now(), ...output });
		});
		child.once("exit", (code, signal) => resolve({ code, signal, at: Date.now(), ...output }));
	});
	const startedAt = Date.now();
	return {
		child,
		exited,
		output,
		startedAt,
		hostPath,
		kill: () => {
			if (child.exitCode === null) child.kill();
		},
		/** Force-kill the whole tree (test cleanup only; the quit gate never uses this). */
		killTree: () => {
			if (process.platform === "win32") {
				spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
			} else if (child.exitCode === null) {
				child.kill("SIGKILL");
			}
		},
	};
}

/** Minimal CDP client: enough for real input events and DOM evaluation. */
export class Cdp {
	constructor(socket, { timeoutMs = 10_000 } = {}) {
		this.socket = socket;
		this.timeoutMs = timeoutMs;
		this.nextId = 1;
		this.pending = new Map();
		const rejectPending = (message) => {
			for (const waiter of this.pending.values()) {
				clearTimeout(waiter.timer);
				waiter.reject(new Error(message));
			}
			this.pending.clear();
		};
		socket.addEventListener("close", () => rejectPending("CDP target closed"));
		socket.addEventListener("error", () => rejectPending("CDP socket failed"));
		socket.addEventListener("message", (event) => {
			let frame;
			try {
				frame = JSON.parse(event.data);
			} catch {
				rejectPending("CDP target returned malformed JSON");
				return;
			}
			const waiter = this.pending.get(frame.id);
			if (!waiter) return;
			clearTimeout(waiter.timer);
			this.pending.delete(frame.id);
			if (frame.error) waiter.reject(new Error(`${frame.error.message} (${frame.error.code})`));
			else waiter.resolve(frame.result);
		});
	}

	static async connect(url, { timeoutMs = 5_000 } = {}) {
		const socket = new WebSocket(url);
		const deadline = Date.now() + timeoutMs;
		let client;
		try {
			await new Promise((resolve, reject) => {
				const settle = (error) => {
					clearTimeout(timer);
					socket.removeEventListener("open", opened);
					socket.removeEventListener("error", failed);
					socket.removeEventListener("close", closed);
					if (error) reject(error);
					else resolve();
				};
				const opened = () => settle();
				const failed = () => settle(new Error("CDP socket failed"));
				const closed = () => settle(new Error("CDP target closed during connection"));
				const timer = setTimeout(() => settle(new Error("CDP connection timed out")), timeoutMs);
				socket.addEventListener("open", opened, { once: true });
				socket.addEventListener("error", failed, { once: true });
				socket.addEventListener("close", closed, { once: true });
			});
			client = new Cdp(socket);
			await client.send("Runtime.enable", {}, { timeoutMs: Math.max(1, deadline - Date.now()) });
			return client;
		} catch (error) {
			if (client) client.close();
			else socket.close();
			throw error;
		}
	}

	// A lost WebView target must fail the assertion, not keep the test process alive forever.
	send(method, params = {}, { timeoutMs = this.timeoutMs } = {}) {
		return new Promise((resolve, reject) => {
			if (this.socket.readyState !== 1) {
				reject(new Error("CDP target closed"));
				return;
			}
			const id = this.nextId++;
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`CDP command timed out: ${method}`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			try {
				this.socket.send(JSON.stringify({ id, method, params }));
			} catch (error) {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(error);
			}
		});
	}

	async evaluate(expression) {
		const result = await this.send("Runtime.evaluate", {
			expression,
			awaitPromise: true,
			returnByValue: true,
			userGesture: true,
		});
		if (result.exceptionDetails) {
			throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
		}
		return result.result?.value;
	}

	async text() {
		return (await this.evaluate("document.body.innerText")) ?? "";
	}

	async clickSelector(selector) {
		return this.evaluate(`(() => {
			const element = document.querySelector(${JSON.stringify(selector)});
			if (!element) return false;
			element.click();
			return true;
		})()`);
	}

	async clickByLabel(label) {
		return this.evaluate(`(() => {
			const button = [...document.querySelectorAll("button,[role=button]")]
				.find((candidate) => (candidate.getAttribute("aria-label") || "") === ${JSON.stringify(label)});
			if (!button) return false;
			button.click();
			return true;
		})()`);
	}

	async clickByText(text) {
		return this.evaluate(`(() => {
			const button = [...document.querySelectorAll("button")].find((candidate) => candidate.textContent.trim() === ${JSON.stringify(text)});
			if (!button) return false;
			button.click();
			return true;
		})()`);
	}

	/** Focus the composer, type through real input events, and press Enter. */
	async sendPrompt(text) {
		const box = await this.evaluate(`(() => {
			const editor = document.querySelector("[contenteditable='true']");
			if (!editor) return null;
			editor.focus();
			editor.scrollIntoView({ block: "center" });
			const rect = editor.getBoundingClientRect();
			return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
		})()`);
		if (!box) throw new Error("composer was not found");
		await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
		await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
		await sleep(120);
		await this.send("Input.insertText", { text });
		await sleep(150);
		for (const type of ["keyDown", "keyUp"]) {
			await this.send("Input.dispatchKeyEvent", {
				type,
				key: "Enter",
				code: "Enter",
				windowsVirtualKeyCode: 13,
				nativeVirtualKeyCode: 13,
				text: type === "keyDown" ? "\r" : undefined,
			});
		}
	}

	close() {
		this.socket.close();
	}
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait for a CDP page target and connect to it. */
export async function connectPage(port, { timeoutMs = 120_000, launch } = {}) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (launch && (launch.child.exitCode !== null || launch.child.signalCode || launch.output.error)) {
			throw new Error(`packaged host exited before WebView2 was ready: ${JSON.stringify({
				code: launch.child.exitCode, signal: launch.child.signalCode, ...launch.output,
			})}`);
		}
		try {
			const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
				signal: AbortSignal.timeout(Math.min(2_000, Math.max(1, deadline - Date.now()))),
			});
			const targets = await response.json();
			const page = targets.find((target) => target.type === "page");
			if (page) return {
				cdp: await Cdp.connect(page.webSocketDebuggerUrl, { timeoutMs: Math.min(5_000, Math.max(1, deadline - Date.now())) }),
				target: page,
			};
		} catch {
			// host still booting
		}
		await sleep(250);
	}
	throw new Error(`the packaged host never exposed a CDP page target on port ${port}: ${JSON.stringify(launch?.output ?? {})}`);
}

export async function waitForText(cdp, needle, { timeoutMs = 60_000, absent = false } = {}) {
	const deadline = Date.now() + timeoutMs;
	let text = "";
	while (Date.now() < deadline) {
		text = await cdp.text();
		const present = text.includes(needle);
		if (absent ? !present : present) return text;
		await sleep(250);
	}
	throw new Error(`timed out waiting for ${absent ? "absence of" : ""} "${needle}"; page said: ${text.slice(0, 600)}`);
}

export async function waitFor(cdp, expression, { timeoutMs = 60_000, label = "condition" } = {}) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = await cdp.evaluate(expression);
		if (value) return value;
		await sleep(250);
	}
	throw new Error(`timed out waiting for ${label}`);
}

export function readPiTraffic(path) {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			try {
				return JSON.parse(line);
			} catch {
				return { kind: "unparsed", line };
			}
		});
}

/**
 * The renderer keeps the bootstrap token in the page's first navigation entry: the host
 * loads `/?runtime=native&token=...` and the app replaces the visible URL afterwards.
 * Reading it here lets the gate exercise the packaged backend over the *same* authenticated
 * renderer transport the page uses (no second channel, no invented endpoint).
 */
export async function pageRpcToken(cdp) {
	const token = await cdp.evaluate(`(() => {
		const entries = performance.getEntriesByType("navigation");
		const url = entries.length > 0 ? new URL(entries[0].name) : null;
		if (url) return url.searchParams.get("token") ?? "";
		return new URL(location.href).searchParams.get("token") ?? "";
	})()`);
	if (!token) throw new Error("could not read the renderer token from the page");
	return token;
}

/** RPC through the renderer's own loopback transport (token required, like the page). */
export async function pageRpc(cdp, channel, args = []) {
	const origin = await cdp.evaluate("location.origin");
	const token = await pageRpcToken(cdp);
	const response = await fetch(`${origin}/__pideck/rpc`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-pideck-token": token },
		body: JSON.stringify({ channel, args }),
	});
	return { status: response.status, payload: await response.json() };
}

export function findFreePort(start = 9400) {
	// Deterministic-enough scan: the gate only needs a port nothing else listens on.
	for (let port = start; port < start + 200; port += 1) {
		const probe = spawnSync(
			process.platform === "win32" ? "powershell.exe" : "sh",
			process.platform === "win32"
				? [
						"-NoProfile",
						"-NonInteractive",
						"-Command",
						`if ((Test-NetConnection -ComputerName 127.0.0.1 -Port ${port} -InformationLevel Quiet -WarningAction SilentlyContinue)) { exit 0 } else { exit 1 }`,
					]
				: ["-c", `(echo > /dev/tcp/127.0.0.1/${port}) >/dev/null 2>&1 && exit 0 || exit 1`],
			{ stdio: "ignore" },
		);
		if (probe.status !== 0) return port;
	}
	throw new Error("no free loopback port found for the CDP endpoint");
}

export function pathInside(root, candidate) {
	if (!candidate) return false;
	const normalizedRoot = resolve(root).toLowerCase();
	const normalizedCandidate = resolve(candidate).toLowerCase();
	return normalizedCandidate.startsWith(`${normalizedRoot}\\`) || normalizedCandidate.startsWith(`${normalizedRoot}/`);
}
