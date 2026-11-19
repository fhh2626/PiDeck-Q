import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { request as nodeRequest } from "node:http";
import { fileURLToPath } from "node:url";

import { joinPathParts } from "./native2FakeProcess.mjs";

/**
 * Black-box harness for the C++ backend.
 *
 * It speaks only the real wire protocols:
 *  - the Qt host bridge (4-byte little-endian length-prefixed JSON) implemented
 *    exactly like native/src/HostRpcServer.cpp, so the backend cannot tell the
 *    difference between this harness and the real host;
 *  - the renderer loopback HTTP/SSE endpoints used by NativeDesktopTransport.
 *
 * Nothing here imports backend source, so a passing test is evidence about
 * behaviour rather than about internal structure.
 */

const DEFAULT_BACKEND_PATHS = [
	"build/windows/x64/debug/PiDeckBackend.exe",
	"build/windows/x64/release/PiDeckBackend.exe",
	"build/native2-validation-unpacked/PiDeckBackend.exe",
];

export function resolveBackendExecutable(repoRoot = process.cwd()) {
	// The gate pins the exact output it built; optional callers retain fallback discovery.
	const pinned = process.env.PIDECK_BACKEND_TEST_EXECUTABLE;
	const candidates = pinned ? [pinned] : DEFAULT_BACKEND_PATHS;
	for (const relative of candidates) {
		const candidate = join(repoRoot, relative);
		if (existsSync(candidate)) {
			assertRequiredBackendFresh(candidate, repoRoot);
			return candidate;
		}
	}
	// Under the required gate a missing binary must fail, not skip: a suite that silently
	// skips still prints "pass" and would be mistaken for parity evidence.
	if (process.env.PIDECK_REQUIRE_BACKEND_TESTS === "1") {
		throw new Error(
			`PIDECK_REQUIRE_BACKEND_TESTS=1 but no backend executable exists (looked for ${candidates.join(
				", ",
			)}); build one with "PIDECK_STAGE_DIR=build/native2-validation-unpacked xmake build -y PiDeckBackend"`,
		);
	}
	return "";
}

/**
 * Optional suites must explain why they cannot run, and must never exercise a stale
 * executable. Required gates retain resolveBackendExecutable's hard failure behavior.
 */
export function backendTestAvailability(repoRoot = process.cwd()) {
	const executable = resolveBackendExecutable(repoRoot);
	if (!executable) return {
		executable: "",
		skip: "PiDeckBackend executable not found; run npm run test:native-runtime",
	};
	const source = newestBackendSource(repoRoot);
	if (source && statSync(executable).mtimeMs < source.mtimeMs) return {
		executable: "",
		skip: "PiDeckBackend executable is stale; run npm run test:native-runtime",
	};
	return { executable, skip: false };
}

/** Newest backend source or build definition that can affect the executable. */
function newestBackendSource(repoRoot) {
	let newest = null;
	const walk = (directory) => {
		let entries;
		try {
			entries = readdirSync(directory, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const entryPath = join(directory, entry.name);
			if (entry.isDirectory()) {
				walk(entryPath);
				continue;
			}
			if (!/\.(cpp|h)$/.test(entry.name)) continue;
			const mtimeMs = statSync(entryPath).mtimeMs;
			if (!newest || mtimeMs > newest.mtimeMs) newest = { path: entryPath, mtimeMs };
		}
	};
	walk(join(repoRoot, "native", "backend"));
	walk(join(repoRoot, "native", "common"));
	const definition = join(repoRoot, "xmake.lua");
	if (existsSync(definition)) {
		const mtimeMs = statSync(definition).mtimeMs;
		if (!newest || mtimeMs > newest.mtimeMs) newest = { path: definition, mtimeMs };
	}
	return newest;
}

/**
 * A stale executable is worse than a missing one: the suite runs, passes, and reports a
 * fixed bug as still-present (or vice versa). Under the required gate, refuse it.
 */
function assertRequiredBackendFresh(executable, repoRoot) {
	if (process.env.PIDECK_REQUIRE_BACKEND_TESTS !== "1") return;
	const source = newestBackendSource(repoRoot);
	if (source && statSync(executable).mtimeMs < source.mtimeMs) {
		throw new Error(
			`backend executable is stale: ${source.path} is newer than ${executable}; rebuild with "PIDECK_STAGE_DIR=build/native2-validation-unpacked xmake build -y PiDeckBackend"`,
		);
	}
}

/** Find the Qt DLLs for the selected backend, ignoring stale build metadata. */
export function qtBinDirectory(repoRoot = process.cwd(), { executable, localAppData = process.env.LOCALAPPDATA } = {}) {
	const selected = executable || process.env.PIDECK_BACKEND_TEST_EXECUTABLE
		|| DEFAULT_BACKEND_PATHS.find((candidate) => existsSync(join(repoRoot, candidate)));
	const hasQt = (directory) => existsSync(join(directory, "Qt6Core.dll"));
	const deployed = selected && dirname(resolve(repoRoot, selected));
	if (deployed && hasQt(deployed)) return deployed;
	if (!localAppData) return "";
	const packagesRoot = join(localAppData, ".xmake", "packages", "p", "pideck-qt", "6.11.2");
	if (!existsSync(packagesRoot)) return "";
	const mode = selected?.match(/[\\/]windows[\\/]x64[\\/](debug|release)[\\/]/i)?.[1]?.toLowerCase();
	if (mode) {
		const dependency = join(repoRoot, `build/.deps/PiDeckBackend/windows/x64/${mode}/native/backend/main.cpp.obj.d`);
		const match = existsSync(dependency) && readFileSync(dependency, "utf8").match(/pideck-qt[\\/]+6\.11\.2[\\/]+([A-Za-z0-9]+)/);
		if (match) {
			const candidate = join(packagesRoot, match[1], "qt", "bin");
			if (hasQt(candidate)) return candidate;
		}
	}
	for (const entry of readdirSync(packagesRoot)) {
		const candidate = join(packagesRoot, entry, "qt", "bin");
		if (hasQt(candidate)) return candidate;
	}
	return "";
}

/** Every spelling of the search-path variable, i.e. `PATH` and the Windows `Path`. */
const SEARCH_PATH_KEY = /^path$/i;

/**
 * Read the inherited search-path value whatever its spelling.
 *
 * Node's `process.env` reads are case insensitive, but object spread is not: once a block is
 * copied with `{ ...process.env }`, only the stored spelling survives. A real Windows
 * environment spells the variable `Path`, so `merged.PATH` is `undefined` there while it
 * looks perfectly fine in an uppercase shell.
 */
export function environmentPath(environment = process.env, fallback = "") {
	let resolved = fallback;
	for (const [key, value] of Object.entries(environment)) {
		if (!SEARCH_PATH_KEY.test(key)) continue;
		resolved = value === undefined || value === null ? "" : String(value);
	}
	return resolved;
}

/**
 * Copy an environment block so the search path appears exactly once, set to `pathValue`.
 *
 * Two entries that mean the same variable but spell it differently are unsafe: the child
 * keeps only one of them and discards the other value, so a prepended directory can silently
 * become the whole PATH (git/node/npx then vanish) or an override can lose to the inherited
 * value. The inherited spelling is kept, so a Windows `Path` stays `Path`.
 */
export function childPathEnvironment(environment, pathValue) {
	const child = {};
	let key = "PATH";
	for (const [name, value] of Object.entries(environment)) {
		if (SEARCH_PATH_KEY.test(name)) {
			key = name;
			continue;
		}
		child[name] = value;
	}
	child[key] = pathValue;
	return child;
}

export function encodeFrame(value) {
	const payload = Buffer.from(JSON.stringify(value), "utf8");
	const header = Buffer.alloc(4);
	header.writeUInt32LE(payload.length, 0);
	return Buffer.concat([header, payload]);
}

function createFrameParser(onFrame) {
	let buffer = Buffer.alloc(0);
	return (chunk) => {
		buffer = Buffer.concat([buffer, chunk]);
		while (buffer.length >= 4) {
			const length = buffer.readUInt32LE(0);
			if (buffer.length < 4 + length) return;
			const payload = buffer.subarray(4, 4 + length);
			buffer = buffer.subarray(4 + length);
			onFrame(JSON.parse(payload.toString("utf8")));
		}
	};
}

/**
 * Minimal Qt-host stand-in: authenticates the sidecar, answers the host methods a
 * test declares, records every request, and can push host events.
 */
export class FakeHost {
	constructor({ token = "test-host-token", handlers = {} } = {}) {
		this.token = token;
		this.handlers = handlers;
		this.frames = [];
		this.requests = [];
		this.socket = null;
		this.server = null;
		this.readyWaiters = [];
		this.requestWaiters = [];
		this.closed = false;
	}

	async start() {
		this.server = createServer((socket) => {
			this.socket = socket;
			socket.on("error", () => undefined);
			socket.on("close", () => {
				this.closed = true;
			});
			socket.on(
				"data",
				createFrameParser((frame) => {
					this.frames.push(frame);
					if (frame.type === "hello") {
						socket.write(encodeFrame({ type: "hello", ok: frame.token === this.token }));
						return;
					}
					if (frame.type === "request") {
						this.requests.push(frame);
						for (const waiter of [...this.requestWaiters]) {
							if (waiter.method === frame.method) {
								this.requestWaiters.splice(this.requestWaiters.indexOf(waiter), 1);
								waiter.resolve(frame);
							}
						}
						const handler = this.handlers[frame.method];
						// Missing fixture wiring must not wait for an OS dialog or a full
						// production timeout. Intentional stalls declare a no-op handler.
						if (!handler) {
							this.respondError(frame.id, `Unexpected host request in test: ${frame.method}`);
							return;
						}
						const outcome = handler(frame.params ?? {});
						if (outcome === undefined) return;
						socket.write(
							encodeFrame({
								type: "response",
								id: frame.id,
								ok: outcome.ok !== false,
								...(outcome.ok === false
									? { error: { message: outcome.error ?? "host handler failed" } }
									: { result: outcome.result ?? null }),
							}),
						);
						return;
					}
					if (frame.type === "event") {
						for (const waiter of [...this.readyWaiters]) {
							if (waiter.name === frame.name) {
								this.readyWaiters.splice(this.readyWaiters.indexOf(waiter), 1);
								waiter.resolve(frame.payload);
							}
						}
					}
				}),
			);
		});
		await new Promise((resolve) => this.server.listen(0, "127.0.0.1", resolve));
		return this.server.address().port;
	}

	emit(name, payload = null) {
		if (!this.socket) throw new Error("fake host is not connected");
		this.socket.write(encodeFrame({ type: "event", name, payload }));
	}

	respond(id, result) {
		if (!this.socket) throw new Error("fake host is not connected");
		this.socket.write(encodeFrame({ type: "response", id, ok: true, result }));
	}

	respondError(id, message) {
		if (!this.socket) throw new Error("fake host is not connected");
		this.socket.write(encodeFrame({ type: "response", id, ok: false, error: { message } }));
	}

	waitForEvent(name, timeoutMs = 10_000) {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`host event ${name} did not arrive`)), timeoutMs);
			this.readyWaiters.push({
				name,
				resolve: (payload) => {
					clearTimeout(timer);
					resolve(payload);
				},
			});
		});
	}

	waitForRequest(method, timeoutMs = 10_000) {
		const existing = this.requests.find((frame) => frame.method === method);
		if (existing) return Promise.resolve(existing);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`host request ${method} did not arrive`)), timeoutMs);
			this.requestWaiters.push({
				method,
				resolve: (frame) => {
					clearTimeout(timer);
					resolve(frame);
				},
			});
		});
	}

	async stop() {
		if (this.socket) this.socket.destroy();
		if (this.server) await new Promise((resolve) => this.server.close(resolve));
		this.server = null;
		this.socket = null;
	}
}

export function spawnBackend({ executable, hostPort, token, env = {}, cwd = process.cwd() }) {
	// A test that overrides PATH (e.g. to reach a fake npx) must not drop the Qt DLL
	// directory: PiDeckBackend.exe imports Qt6Core/Network/Sql.dll and no DLL is deployed
	// beside the executable, so losing this entry kills the process at load time and every
	// renderer.ready wait then times out after 15 s. Merge the caller's env first, then
	// prepend the Qt bin directory to whatever PATH survived the merge.
	const merged = { ...process.env, ...env };
	// `merged.PATH` is not readable here: object spread is case sensitive, so a Windows block
	// (which spells the variable `Path`) leaves it `undefined` and the Qt directory would
	// become the child's whole PATH. Re-emitting one spelling also matters, because two
	// case-variant entries collide in the child and the surviving one decides which value
	// wins (measured: the later entry wins, the earlier value is discarded).
	// Resolve overrides separately because replacing an existing object key does not move
	// its insertion position. A duplicate ambient spelling must not outrank the caller.
	const childPath = joinPathParts([qtBinDirectory(process.cwd(), { executable: resolve(cwd, executable) }), environmentPath(env, environmentPath(process.env))]);
	const child = spawn(executable, [], {
		windowsHide: true,
		cwd,
		env: {
			...childPathEnvironment(merged, childPath),
			PIDECK_HOST_PORT: String(hostPort),
			PIDECK_HOST_TOKEN: token,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	const output = { stdout: "", stderr: "", spawnError: "" };
	child.stdout.on("data", (chunk) => {
		output.stdout += chunk.toString("utf8");
	});
	child.stderr.on("data", (chunk) => {
		output.stderr += chunk.toString("utf8");
	});
	// A spawn failure (ENOENT, EAGAIN, a loader refusing the image) arrives as an `error`
	// event, not as an exit. Recording it turns "renderer.ready never arrived" into the
	// actual reason instead of an unexplained 15 s timeout.
	child.on("error", (error) => {
		output.spawnError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
	});
	const exited = new Promise((resolve) => {
		child.once("exit", (code, signal) => resolve({ code, signal, ...output }));
		child.once("error", () => resolve({ code: null, signal: null, ...output }));
	});
	// `exit` precedes stdio closure. A fixture cannot be removed until inherited
	// streams have also closed and the process no longer owns its working directory.
	const closed = new Promise((resolve) => {
		child.once("close", (code, signal) => resolve({ code, signal, ...output }));
	});
	return { child, output, exited, closed };
}

/** Wait for teardown without leaving a timeout alive after the process settles. */
async function settlesWithin(promise, timeoutMs) {
	let timer;
	try {
		return await Promise.race([
			promise.then(() => true),
			new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
		]);
	} finally {
		clearTimeout(timer);
	}
}

/** Reap the backend before removing its fixture, including the forced-cleanup path. */
export async function stopBackendProcess(backend, host, { graceMs = 3_000 } = {}) {
	try {
		if (!backend) return;
		if (backend.child.exitCode === null && !backend.output?.spawnError) {
			try { host.emit("application.prepareQuit"); } catch { /* host already disconnected */ }
			if (!await settlesWithin(backend.exited, graceMs) && backend.child.exitCode === null) {
				if (process.platform === "win32" && backend.child.pid) {
					// Kill this exact fixture's descendants, never other Node or Pi processes.
					spawnSync("taskkill", ["/PID", String(backend.child.pid), "/T", "/F"], {
						stdio: "ignore", timeout: 5_000, windowsHide: true,
					});
				} else {
					backend.child.kill("SIGKILL");
				}
			}
		}
		if (!await settlesWithin(backend.closed ?? backend.exited, 5_000)) {
			throw new Error("backend fixture still owns process streams after teardown");
		}
	} finally {
		// A failed teardown must not leave the host TCP server holding the test runner open.
		await host.stop();
	}
}

/**
 * Wait until the backend announces renderer.ready and return its payload.
 *
 * Passing the spawned backend makes the wait fail fast with the child's own reason (spawn
 * error, exit code, stderr tail) instead of a bare timeout: the handshake normally arrives in
 * tens of milliseconds, so a timeout means the process never got that far.
 */
export async function waitForRendererReady(host, timeoutMs = 15_000, backend = null) {
	try {
		if (!backend) return await host.waitForEvent("renderer.ready", timeoutMs);
		const ready = host.waitForEvent("renderer.ready", timeoutMs);
		// A backend that dies before the handshake must not consume the whole budget; the
		// race is only about reporting, never about accepting a missing renderer.ready.
		const failure = backend.exited.then((exit) => {
			throw new Error(`the backend exited before announcing renderer.ready: ${describeBackendExit(exit)}`);
		});
		return await Promise.race([ready, failure]);
	} catch (error) {
		if (!backend || String(error?.message ?? error).startsWith("the backend exited before")) throw error;
		throw new Error(`${error instanceof Error ? error.message : String(error)} (${describeBackendExit({
			code: backend.child.exitCode,
			signal: backend.child.signalCode,
			...backend.output,
		})})`);
	}
}

/** Short, assertion-friendly description of a backend child that never completed a handshake. */
function describeBackendExit({ code, signal, stdout = "", stderr = "", spawnError = "" }) {
	const tail = (value) => value.trim().split(/\r?\n/).slice(-4).join(" | ").slice(0, 400);
	const parts = [`exit=${code === null || code === undefined ? "still running" : code}`, `signal=${signal ?? "none"}`];
	if (spawnError) parts.push(`spawnError=${spawnError}`);
	if (stderr.trim()) parts.push(`stderr=${tail(stderr)}`);
	if (stdout.trim()) parts.push(`stdout=${tail(stdout)}`);
	return parts.join(" ");
}

export function httpRequest(url, { method = "GET", headers = {}, body = null } = {}) {
	return new Promise((resolve, reject) => {
		// Node's http client would otherwise frame a string body with
		// Transfer-Encoding: chunked, which the hardened parser rejects by design.
		const resolvedHeaders = body === null
			? headers
			: { "content-length": String(Buffer.byteLength(body)), ...headers };
		const request = nodeRequest(url, { method, headers: resolvedHeaders }, (response) => {
			const chunks = [];
			response.on("data", (chunk) => chunks.push(chunk));
			response.on("end", () => {
				resolve({
					status: response.statusCode,
					headers: response.headers,
					body: Buffer.concat(chunks).toString("utf8"),
				});
			});
		});
		request.on("error", reject);
		if (body !== null) request.write(body);
		request.end();
	});
}

const httpRequestImpl = nodeRequest;

/** Send a raw HTTP request over a socket and return the raw response text. */
export function rawHttp(port, requestText, { timeoutMs = 5_000 } = {}) {
	return new Promise((resolve, reject) => {
		const socket = connect({ host: "127.0.0.1", port });
		let data = "";
		const timer = setTimeout(() => {
			socket.destroy();
			resolve(data);
		}, timeoutMs);
		socket.on("connect", () => socket.write(requestText));
		socket.on("data", (chunk) => {
			data += chunk.toString("utf8");
		});
		socket.on("close", () => {
			clearTimeout(timer);
			resolve(data);
		});
		socket.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
	});
}

export async function rpc(baseUrl, token, channel, args = [], options = {}) {
	const response = await httpRequest(`${baseUrl}__pideck/rpc`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-pideck-token": token,
			...(options.headers ?? {}),
		},
		body: JSON.stringify({ channel, args }),
	});
	return { status: response.status, payload: JSON.parse(response.body) };
}

/**
 * Replayable SSE client. Parses `id:`/`data:` frames and exposes a promise that
 * resolves on the next matching frame.
 */
export class SseClient {
	constructor(url) {
		this.url = url;
		this.frames = [];
		this.waiters = [];
		this.raw = "";
		this.closed = false;
		this.request = null;
	}

	connect() {
		return new Promise((resolve, reject) => {
			this.request = httpRequestImpl(this.url, { method: "GET", headers: { accept: "text/event-stream" } }, (response) => {
				if (response.statusCode !== 200) {
					reject(new Error(`SSE status ${response.statusCode}`));
					return;
				}
				resolve();
				response.setEncoding("utf8");
				response.on("data", (chunk) => this.consume(chunk));
				response.on("end", () => {
					this.closed = true;
				});
			});
			this.request.on("error", (error) => {
				if (!this.closed) reject(error);
			});
			this.request.end();
		});
	}

	consume(chunk) {
		this.raw += chunk;
		let boundary = this.raw.indexOf("\n\n");
		while (boundary >= 0) {
			const block = this.raw.slice(0, boundary);
			this.raw = this.raw.slice(boundary + 2);
			this.handleBlock(block);
			boundary = this.raw.indexOf("\n\n");
		}
	}

	handleBlock(block) {
		let id = null;
		const dataLines = [];
		for (const line of block.split("\n")) {
			if (line.startsWith("id:")) id = Number(line.slice(3).trim());
			else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
		}
		if (dataLines.length === 0) return;
		const frame = { id, payload: JSON.parse(dataLines.join("\n")) };
		this.frames.push(frame);
		for (const waiter of [...this.waiters]) {
			if (waiter.match(frame)) {
				this.waiters.splice(this.waiters.indexOf(waiter), 1);
				waiter.resolve(frame);
			}
		}
	}

	waitFor(match, timeoutMs = 10_000) {
		const predicate = typeof match === "function" ? match : (frame) => frame.payload.channel === match;
		const existing = this.frames.find(predicate);
		if (existing) return Promise.resolve(existing);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("SSE frame did not arrive")), timeoutMs);
			this.waiters.push({
				match: predicate,
				resolve: (frame) => {
					clearTimeout(timer);
					resolve(frame);
				},
			});
		});
	}

	close() {
		this.closed = true;
		this.request?.destroy();
	}
}

/**
 * Isolated backend fixture: user data, renderer shell, session/prompt/skill roots and
 * a project catalog. Nothing here touches a real user profile or repository.
 */
export function backendFixtureSettings(settings = {}, environment = process.env) {
	// A sandbox may permit TCP but deny Unix-domain sockets. Runtime/file suites
	// can explicitly disable the unrelated singleton feature; tests of that feature
	// must request singleInstance:true and still exercise the real local endpoint.
	return { theme: "system", ...(environment.PIDECK_TEST_SINGLE_INSTANCE === "0" ? { singleInstance: false } : {}), ...settings };
}

export function createBackendFixture({ projects = [], settings = {}, prefix = "pideck-native2-" } = {}) {
	const root = mkdtempSync(join(tmpdir(), prefix));
	const userData = join(root, "user-data");
	const home = join(root, "home");
	const renderer = join(root, "renderer");
	const backgrounds = join(root, "backgrounds");
	const sessions = join(root, "sessions");
	const prompts = join(root, "prompts");
	const skills = join(root, "skills");
	for (const directory of [userData, home, join(renderer, "assets"), backgrounds, sessions, prompts, skills]) {
		mkdirSync(directory, { recursive: true });
	}
	writeFileSync(join(renderer, "index.html"), "<!doctype html><html><body>PiDeck shell</body></html>");
	writeFileSync(join(renderer, "assets/app.js"), "export const marker = 'pideck-app';\n");
	writeFileSync(join(userData, "settings.json"), JSON.stringify(backendFixtureSettings(settings)));
	if (projects.length > 0) {
		writeFileSync(
			join(userData, "projects.json"),
			JSON.stringify(
				projects.map((project, index) => ({
					id: project.id,
					name: project.name ?? `project-${index}`,
					path: project.path,
					lastOpenedAt: 1_700_000_000_000 + index,
					sortOrder: index,
					environment: "windows",
				})),
			),
		);
	}
	return { root, userData, home, renderer, backgrounds, sessions, prompts, skills };
}

/** Bind resources and homes explicitly instead of inheriting installed/user locations. */
export function backendEnvFor(fixture, extra = {}) {
	return {
		PIDECK_RESOURCES_PATH: extra.PIDECK_APP_PATH
			? join(extra.PIDECK_APP_PATH, "resources")
			: fileURLToPath(new URL("../../resources", import.meta.url)),
		PIDECK_USER_DATA: fixture.userData,
		PIDECK_HOME: extra.PIDECK_HOME ?? join(fixture.root, "home"),
		PIDECK_HOST_HOME: extra.PIDECK_HOME ?? join(fixture.root, "home"),
		PIDECK_RENDERER_ROOT: fixture.renderer,
		PIDECK_BACKGROUND_DIR: fixture.backgrounds,
		PIDECK_SESSIONS_DIR: fixture.sessions,
		PIDECK_PROMPTS_DIR: fixture.prompts,
		PIDECK_SKILLS_DIR: fixture.skills,
		PIDECK_VERSION: "0.4.3",
		...extra,
	};
}

/**
 * Materialize the scriptable fake pi inside a fixture and return its launch shim.
 *
 * The shim is a `.cmd` file on purpose: npm installs pi as `pi.cmd` on Windows, so the
 * launcher's batch-shim path is exercised by every runtime test instead of a synthetic
 * executable that only exists in tests.
 */
export function createFakePi(fixture, scenario, { repoRoot = process.cwd() } = {}) {
	const directory = join(fixture.root, "fake-pi");
	mkdirSync(directory, { recursive: true });
	const script = join(directory, "fake-pi.mjs");
	copyFileSync(join(repoRoot, "tests/fixtures/native2-fake-pi-runtime.mjs"), script);
	const scenarioPath = join(directory, "scenario.json");
	writeFileSync(scenarioPath, JSON.stringify(scenario));
	const logPath = join(directory, "pi.log");
	const shim = join(directory, process.platform === "win32" ? "pi.cmd" : "pi.sh");
	writeFileSync(
		shim,
		process.platform === "win32"
			? `@echo off\r\nnode "${script}" %*\r\n`
			: `#!/bin/sh\nexec node "${script}" "$@"\n`,
	);
	if (process.platform !== "win32") chmodSync(shim, 0o755);
	return {
		shim,
		scenarioPath,
		logPath,
		directory,
		/** Every protocol line the fake pi saw or emitted, in order. */
		readLog: () => {
			if (!existsSync(logPath)) return [];
			return readFileSync(logPath, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line));
		},
		commands: () => {
			if (!existsSync(logPath)) return [];
			return readFileSync(logPath, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line))
				.filter((entry) => entry.kind === "command");
		},
	};
}

/**
 * Start a backend against a fixture and return a bound RPC helper.
 * `hostHandlers` answers host requests; `shell.trashItem` defaults to a recorder so
 * tests can assert recycle-bin semantics without deleting anything.
 *
 * `prepare(fixture)` runs after the fixture exists and before the backend spawns, so a
 * test can drop in a fake pi and return the settings/env that point at it.
 */
export async function startBackendSession(
	t,
	{ projects = [], settings = {}, hostHandlers = {}, env = {}, prepare = null } = {},
) {
	const fixture = createBackendFixture({ projects, settings });
	let resolvedSettings = settings;
	let resolvedEnv = env;
	if (prepare) {
		const prepared = prepare(fixture) ?? {};
		resolvedSettings = { ...settings, ...(prepared.settings ?? {}) };
		resolvedEnv = { ...env, ...(prepared.env ?? {}) };
		writeFileSync(join(fixture.userData, "settings.json"), JSON.stringify(backendFixtureSettings(resolvedSettings)));
	}
	const trashCalls = [];
	const handlers = {
		"clipboard.metadataSnapshot": () => ({
			result: { text: "", html: "", filePaths: [], hasImage: false, sequence: 0 },
		}),
		"shell.trashItem": (params) => {
			trashCalls.push(params.path);
			return { result: null };
		},
		"shell.openPath": () => ({ result: { ok: true } }),
		"shell.showItemInFolder": () => ({ result: { ok: true } }),
		"dialog.open": () => ({ result: { canceled: true, filePaths: [] } }),
		...hostHandlers,
	};
	const host = new FakeHost({ token: "parity-test-token", handlers });
	let process_;
	// Resolving or spawning a missing backend can throw after the host starts listening.
	// Register cleanup first so that a failing test still exits and reports the failure.
	t.after(async () => {
		await stopBackendProcess(process_, host);
		rmSync(fixture.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	});
	const hostPort = await host.start();
	process_ = spawnBackend({
		executable: resolveBackendExecutable(),
		hostPort,
		token: "parity-test-token",
		env: backendEnvFor(fixture, resolvedEnv),
	});
	const ready = await waitForRendererReady(host, 15_000, process_);
	const baseUrl = ready.url;
	const token = ready.token;
	return {
		fixture,
		host,
		backend: process_,
		ready,
		baseUrl,
		token,
		trashCalls,
		invoke: (channel, args = []) => rpc(baseUrl, token, channel, args),
	};
}
