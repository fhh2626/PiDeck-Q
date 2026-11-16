import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import {
	createFakePi,
	resolveBackendExecutable,
	startBackendSession,
} from "./helpers/native2BackendHarness.mjs";

// The environment PiDeck hands to a pi runtime, compared with
// `PiProcess.spawn` (src/main/pi/PiProcess.ts:430-485):
//
//  - the security snapshot path and the security-gate extension path are injected (the
//    subagents extension re-uses the latter for its own children);
//  - a top-level pi never inherits the standalone-binary marker, and a Pi-Bolt runtime
//    sets it;
//  - every one of those variables is registered in `WSLENV` when pi runs inside a distro
//    (`wsl.exe` only forwards registered names), and an inherited marker is *removed*
//    from `WSLENV` rather than appended twice.
//
// Everything drives the real `PiDeckBackend.exe`; the fake wsl proxies the pi spawn into
// a fake pi so no distro is required.

const executable = resolveBackendExecutable();
const slash = (value) => String(value).replaceAll("\\", "/");
const RESOURCES = join(process.cwd(), "resources");
const GATE_NAME = "pi-deck-security-gate.ts";

/** Minimal pi session file: header + one user turn. */
function writeSessionFile(sessionsDir, projectPath, name) {
	const entries = [
		{ type: "session", version: 3, id: name, timestamp: "2026-01-01T00:00:00.000Z", cwd: projectPath },
		{
			type: "message",
			id: "u1",
			parentId: null,
			timestamp: "2026-01-01T00:00:01.000Z",
			message: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1_767_225_601_000 },
		},
	];
	const path = join(sessionsDir, `${name}.jsonl`);
	writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	return path;
}

const oneTurn = [{ ack: true, events: [
	{ event: { type: "agent_start" } },
	{ event: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" } } },
	{ event: { type: "agent_end", messages: [] } },
	{ event: { type: "agent_settled" } },
] }];

/** A `.cmd` shim that runs `script` with every argument (npm's pi install shape). */
function writeNodeShim(directory, name, script) {
	mkdirSync(directory, { recursive: true });
	const shim = join(directory, process.platform === "win32" ? `${name}.cmd` : `${name}.sh`);
	writeFileSync(
		shim,
		process.platform === "win32"
			? `@echo off\r\nnode "${script}" %*\r\n`
			: `#!/bin/sh\nexec node "${script}" "$@"\n`,
	);
	if (process.platform !== "win32") chmodSync(shim, 0o755);
	return shim;
}

/** Write the security policy snapshot the runtime forwards to pi. */
function writeSecuritySnapshot(userData) {
	const path = join(userData, "security-policy.json");
	writeFileSync(path, JSON.stringify({ version: 1, rules: [] }));
	return path;
}

if (executable) {
	describe("native2 pi launch environment parity", () => {
		let root;
		before(() => {
			root = mkdtempSync(join(tmpdir(), "pideck-native2-launch-env-"));
		});
		after(() => {
			if (root) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		});

		const projectDirectory = (label) => {
			const directory = join(root, `${label}-${Math.random().toString(16).slice(2, 8)}`);
			mkdirSync(directory, { recursive: true });
			return directory;
		};

		/** Activate one imported session and return the fake pi spawn record. */
		const spawnRecord = async (t, { settings = {}, env = {}, prepare = null } = {}) => {
			const projectPath = projectDirectory("project");
			let fake = null;
			const session = await startBackendSession(t, {
				projects: [{ id: "env", path: projectPath }],
				settings: { language: "en-US", ...settings },
				prepare: (fixture) => {
					fake = createFakePi(fixture, { turns: oneTurn });
					const snapshot = writeSecuritySnapshot(fixture.userData);
					const prepared = prepare ? prepare(fixture, fake) : {};
					return {
						settings: { customPiPath: fake.shim, ...(prepared.settings ?? {}) },
						env: {
							FAKE_PI_SCENARIO: fake.scenarioPath,
							FAKE_PI_LOG: fake.logPath,
							PIDECK_RESOURCES_PATH: RESOURCES,
							...(prepared.env ?? {}),
							...env,
						},
					};
				},
			});
			const filePath = writeSessionFile(session.fixture.sessions, projectPath, `env-${Date.now()}`);
			const list = await session.invoke("sessions:catalog-list", ["env"]);
			assert.equal(list.payload.ok, true, JSON.stringify(list.payload));
			const record = list.payload.result.find((entry) => slash(entry.filePath) === slash(filePath));
			assert.ok(record, JSON.stringify(list.payload.result));
			const activated = await session.invoke("sessions:runtime-activate", [record.id]);
			assert.equal(activated.payload.ok, true, JSON.stringify(activated.payload));
			const spawn = fake.readLog().find((entry) => entry.kind === "spawn");
			assert.ok(spawn, "pi must have been spawned");
			return { session, fake, spawn, record, projectPath, snapshot: writeSecuritySnapshot(session.fixture.userData) };
		};

		// Native launches leave WSLENV unchanged, matching PiProcess.spawn. Windows Terminal
		// commonly seeds it, so both its absence and inheritance must be explicit test inputs.
		for (const inheritedWslEnv of [undefined, "WT_SESSION:WT_PROFILE_ID:"]) {
			const label = inheritedWslEnv === undefined ? "without WSLENV" : "with inherited WSLENV";
			test(`native pi receives the gate extension and never the standalone marker (${label})`, async (t) => {
				const { spawn, session, snapshot } = await spawnRecord(t, {
					env: { WSLENV: inheritedWslEnv, PIDECK_PI_STANDALONE: "1" },
				});

				assert.equal(spawn.argv.includes("--mode"), true);
				assert.equal(slash(spawn.env.PIDECK_SECURITY_CONFIG), slash(snapshot));
				assert.equal(
					slash(spawn.env.PIDECK_SECURITY_GATE_EXTENSION),
					slash(join(RESOURCES, "extensions", GATE_NAME)),
					"the subagents extension resolves the gate from PIDECK_SECURITY_GATE_EXTENSION",
				);
				// A TypeScript pi must strip the inherited standalone marker.
				assert.equal(spawn.env.PIDECK_PI_STANDALONE, null);
				// No distro: no forwarding names are added and existing bytes stay unchanged.
				assert.equal(spawn.env.WSLENV, inheritedWslEnv ?? null);
				assert.equal(session.trashCalls.length, 0);
			});
		}

		test("a Pi-Bolt runtime advertises the standalone marker", async (t) => {
			const { spawn } = await spawnRecord(t, {
				settings: { piRuntimePreference: "bolt" },
				prepare: (_fixture, fake) => ({ settings: { piRuntimePreference: "bolt", piBoltPath: fake.shim } }),
			});
			assert.equal(spawn.env.PIDECK_PI_STANDALONE, "1");
			// Bolt has no TypeScript `--offline` flag.
			assert.equal(spawn.argv.includes("--offline"), false, JSON.stringify(spawn.argv));
		});

		test("WSL pi gets an inherited marker stripped and every forwarded name registered", {
			skip: process.platform !== "win32" && "WSL runtime launch is Windows-only in both native and Node PiLocator",
		}, async (t) => {
			const wslRoot = join(root, "wsl");
			const scenarioPath = join(wslRoot, "scenario.json");
			const logPath = join(wslRoot, "wsl.log");
			const uncRoot = join(wslRoot, "unc");
			mkdirSync(uncRoot, { recursive: true });
			const projectPath = projectDirectory("wsl-project");
			let fake = null;
			const session = await startBackendSession(t, {
				projects: [{ id: "wsl", path: projectPath }],
				settings: { language: "en-US", wslEnabled: true, wslDistro: "Ubuntu", wslUser: "dev" },
				prepare: (fixture) => {
					fake = createFakePi(fixture, { turns: oneTurn });
					const shim = writeNodeShim(wslRoot, "wsl-fixture", join(process.cwd(), "tests/fixtures/native2-fake-wsl.mjs"));
					writeFileSync(
						scenarioPath,
						JSON.stringify({
							distros: ["Ubuntu"],
							which: "/usr/local/bin/pi",
							whoami: "dev",
							piVersion: "0.79.0",
							piRuntime: join(fake.directory, "fake-pi.mjs"),
						}),
					);
					writeSecuritySnapshot(fixture.userData);
					return {
						settings: { wslEnabled: true, wslDistro: "Ubuntu", wslUser: "dev" },
						env: {
							PIDECK_WSL_EXE: shim,
							PIDECK_WSL_UNC_ROOT: uncRoot,
							FAKE_WSL_SCENARIO: scenarioPath,
							FAKE_WSL_LOG: logPath,
							FAKE_PI_SCENARIO: fake.scenarioPath,
							FAKE_PI_LOG: fake.logPath,
							PIDECK_RESOURCES_PATH: RESOURCES,
							// The parent shell was Pi-Bolt; the marker must not reach a stock pi.
							PIDECK_PI_STANDALONE: "1",
							WSLENV: "KEEP_TOKEN:PIDECK_PI_STANDALONE:OTHER",
						},
					};
				},
			});

			// An anonymous session needs no JSONL and therefore no WSL scanner: the launch
			// path is what this test measures.
			const created = await session.invoke("sessions:create-anonymous", [{ projectId: "wsl" }]);
			assert.equal(created.payload.ok, true, JSON.stringify(created.payload));
			const record = created.payload.result.session;
			const activated = await session.invoke("sessions:runtime-activate", [record.id]);
			assert.equal(activated.payload.ok, true, JSON.stringify(activated.payload));

			const spawn = fake.readLog().find((entry) => entry.kind === "spawn");
			assert.ok(spawn, "the WSL runtime must reach the fake pi");
			assert.equal(spawn.env.PIDECK_PI_STANDALONE, null, "an inherited marker must be dropped");
			assert.ok(spawn.argv.includes("--no-session"), JSON.stringify(spawn.argv));

			// Paths handed to pi inside the distro are Linux paths.
			assert.match(spawn.env.PIDECK_SECURITY_CONFIG, /^\/mnt\/[a-z]\//);
			assert.match(spawn.env.PIDECK_SECURITY_GATE_EXTENSION, /^\/mnt\/[a-z]\//);
			assert.equal(spawn.env.PIDECK_SECURITY_GATE_EXTENSION.endsWith(GATE_NAME), true);
			assert.equal(spawn.env.PIDECK_UI_LANGUAGE, "en-US");
			assert.equal(spawn.env.PIDECK_DESKTOP, "1");
			assert.match(spawn.env.PIDECK_SESSION_ID, /^[0-9a-f-]{36}$/);

			// `wsl.exe` forwards only registered names: the inherited marker is gone, the
			// PiDeck variables are appended in the oracle's order.
			const names = String(spawn.env.WSLENV).split(":");
			assert.equal(names.includes("PIDECK_PI_STANDALONE"), false, `WSLENV was ${spawn.env.WSLENV}`);
			assert.deepEqual(names, [
				"KEEP_TOKEN",
				"OTHER",
				"PIDECK_SECURITY_CONFIG",
				"PIDECK_SECURITY_GATE_EXTENSION",
				"PIDECK_SESSION_ID",
				"PIDECK_UI_LANGUAGE",
				"PIDECK_DESKTOP",
			]);

			const wslLog = existsSync(logPath)
				? readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
				: [];
			const rpcCall = wslLog.find((entry) => entry.argv.includes("--mode"));
			assert.ok(rpcCall, "the runtime spawn must go through the configured wsl executable");
			assert.ok(rpcCall.argv.includes("-d") && rpcCall.argv.includes("Ubuntu"));
			assert.ok(rpcCall.argv.includes("-u") && rpcCall.argv.includes("dev"));

			// Oracle `PiLocator.createInvocation(command, args, { wslCwd })`: the Linux working
			// directory is handed over explicitly as `--cd <linuxCwd>` and the command follows
			// directly (no `--`). Relying on wsl.exe translating the inherited Windows cwd is
			// not equivalent: a UNC project (or a distro with different mounts) silently starts
			// pi in `$HOME`.
			const cdIndex = rpcCall.argv.indexOf("--cd");
			assert.ok(cdIndex > 0, `wsl argv must carry --cd: ${JSON.stringify(rpcCall.argv)}`);
			const drive = /^([A-Za-z]):[\\/]/.exec(projectPath);
			assert.ok(drive, `expected a drive project path, got ${projectPath}`);
			const linuxCwd = `/mnt/${drive[1].toLowerCase()}/${projectPath.slice(3).replaceAll("\\", "/")}`;
			assert.equal(rpcCall.argv[cdIndex + 1], linuxCwd);
			assert.equal(rpcCall.argv.includes("--"), false, JSON.stringify(rpcCall.argv));
			assert.equal(rpcCall.argv[cdIndex + 2], "pi", "the command follows --cd directly");
			// The Windows-side cwd of the shim is the host form of the same directory
			// (oracle `toWindowsHostPath(this.cwd)`), so a distro-internal project can be a UNC
			// share while pi still starts exactly where `--cd` points.
			assert.equal(slash(rpcCall.cwd), slash(projectPath));
		});
	});
}
