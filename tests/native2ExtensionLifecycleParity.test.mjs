import assert from "node:assert/strict";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, describe, test } from "node:test";
import {
	createFakePi,
	resolveBackendExecutable,
	startBackendSession,
} from "./helpers/native2BackendHarness.mjs";
import { writeNodeShim } from "./helpers/native2FakeProcess.mjs";

const executable = resolveBackendExecutable();




const slash = (value) => String(value).replaceAll("\\", "/");


/** Install the fake CLI using the host's launcher while preserving Windows batch coverage. */
function installFakePi(root) {
	const script = resolve("tests/fixtures/native2-fake-pi-cli.mjs");
	const shim = writeNodeShim(root, "pi", script);
	const statePath = join(root, "fake-pi-state.json");
	writeFileSync(statePath, JSON.stringify({ calls: [], packages: [] }));
	return { shim, statePath };
}

/**
 * Same fake CLI behind a wrapper that records the *raw* argv before the fixture strips
 * `--approve`: the version-gated trust flag is part of the launch contract.
 */
function installFakePiRecordingRaw(root) {
	const { shim, statePath } = installFakePi(root);
	const rawPath = join(root, "raw-pi-args.jsonl");
	const wrapper = join(root, "pi-wrapper.mjs");
	writeFileSync(
		wrapper,
		`import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(rawPath)}, JSON.stringify(process.argv.slice(2)) + "\\n");\nawait import(${JSON.stringify(pathToFileURL(resolve("tests/fixtures/native2-fake-pi-cli.mjs")).href)});\n`,
	);
	writeNodeShim(root, "pi", wrapper);
	return { shim, statePath, rawPath };
}

/** Copy the shipped built-ins (sources only, no node_modules) into a fixture resources dir. */
function copyBuiltInResources(destination) {
	const source = resolve("resources/extensions");
	const extensions = join(destination, "extensions");
	mkdirSync(extensions, { recursive: true });
	const copied = [];
	for (const entry of readdirSync(source)) {
		if (entry === "node_modules") continue;
		if (!entry.endsWith(".ts") && entry !== "pideck-q-subagents") continue;
		cpSync(join(source, entry), join(extensions, entry), { recursive: true });
		copied.push(entry);
	}
	return { directory: extensions, copied };
}

function snapshotTree(directory) {
	const result = {};
	const walk = (current, relative) => {
		for (const entry of readdirSync(current).sort()) {
			const full = join(current, entry);
			const key = relative ? `${relative}/${entry}` : entry;
			if (statSync(full).isDirectory()) walk(full, key);
			else result[key] = statSync(full).size;
		}
	};
	walk(directory, "");
	return result;
}

function writeSessionFile(sessionsDir, projectPath, name) {
	const path = join(sessionsDir, `${name}.jsonl`);
	writeFileSync(
		path,
		`${[
			{ type: "session", version: 3, id: name, timestamp: "2026-01-01T00:00:00.000Z", cwd: projectPath },
			{ type: "model_change", id: "m1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", provider: "anthropic", modelId: "claude-sonnet-4" },
			{
				type: "message",
				id: "u1",
				parentId: "m1",
				timestamp: "2026-01-01T00:00:01.000Z",
				message: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1_767_225_601_000 },
			},
		].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
	);
	return path;
}

if (executable) {
	describe("native2 extension lifecycle parity", () => {
		let root;
		let homeSeq = 0;

		before(() => {
			root = mkdtempSync(join(tmpdir(), "pideck-native2-ext-"));
		});
		after(() => {
			if (root) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		});

		function homeFor() {
			homeSeq += 1;
			const home = join(root, `home-${homeSeq}`);
			mkdirSync(join(home, ".pi", "agent", "extensions"), { recursive: true });
			return home;
		}


		const start = (t, home, extra = {}) =>
			startBackendSession(t, {
				settings: { language: "en-US", ...(extra.settings ?? {}) },
				env: {
					PIDECK_HOME: home,
					PIDECK_HOST_HOME: home,
					PIDECK_PROMPTS_DIR: join(home, ".pi", "agent", "prompts"),
					PIDECK_SKILLS_DIR: join(home, ".pi", "agent", "skills"),
					PIDECK_SESSIONS_DIR: join(home, ".pi", "agent", "sessions"),
					...extra.env,
				},
				prepare: extra.prepare,
			});

		const removedFromSettings = (session) => {
			const settings = JSON.parse(readFileSync(join(session.fixture.userData, "settings.json"), "utf8"));
			return [...(settings.removedBuiltInExtensions ?? [])].sort();
		};

		// ── built-in remove / restore ────────────────────────────────────
		test("extensions:remove-built-in and restore-built-in preserve settings and file boundaries", async (t) => {
			const home = homeFor();
			const { shim, statePath } = installFakePi(home);
			// A historical deployment copy must be cleaned by both remove and restore.
			writeFileSync(join(home, ".pi", "agent", "extensions", "pi-deck-todo.ts"), "export default {};\n");
			const session = await start(t, home, {
				settings: { customPiPath: shim, piRuntimePreference: "auto" },
				env: { PIDECK_FAKE_PI_STATE: statePath },
			});


			const removed = await session.invoke("extensions:remove-built-in", ["pi-deck-todo.ts"]);
			assert.equal(removed.payload.ok, true, JSON.stringify(removed.payload));
			assert.equal(removedFromSettings(session).includes("pi-deck-todo.ts"), true);
			assert.equal(existsSync(join(home, ".pi", "agent", "extensions", "pi-deck-todo.ts")), false);

			// Idempotent: a second remove neither duplicates the entry nor fails.
			const again = await session.invoke("extensions:remove-built-in", ["pi-deck-todo.ts"]);
			assert.equal(again.payload.ok, true, JSON.stringify(again.payload));
			assert.equal(removedFromSettings(session).filter((name) => name === "pi-deck-todo.ts").length, 1);

			// Restore drops the marker and still removes a lingering copy.
			writeFileSync(join(home, ".pi", "agent", "extensions", "pi-deck-todo.ts"), "export default {};\n");
			const restored = await session.invoke("extensions:restore-built-in", ["pi-deck-todo.ts"]);
			assert.equal(restored.payload.ok, true, JSON.stringify(restored.payload));
			assert.equal(removedFromSettings(session).includes("pi-deck-todo.ts"), false);
			assert.equal(existsSync(join(home, ".pi", "agent", "extensions", "pi-deck-todo.ts")), false);

			// Only a shipped basename is accepted; a package name or traversal is refused
			// before any settings write.
			for (const source of ["npm:context-mode", "../escape.ts"]) {
				const before = readFileSync(join(session.fixture.userData, "settings.json"), "utf8");
				const rejected = await session.invoke("extensions:remove-built-in", [source]);
				assert.equal(rejected.payload.ok, false, `${source} must be rejected`);
				assert.equal(readFileSync(join(session.fixture.userData, "settings.json"), "utf8"), before);
			}
		});

		// ── stale deployment copy cleanup ───────────────────────────────
		test("a stale built-in name that is a user directory survives, junction referent included", async (t) => {
			const home = homeFor();
			// A stale deployment *directory* named after a shipped built-in plus an unprivileged
			// junction to content that lives outside the extensions directory.
			const plantStaleCopy = (base) => {
				const stale = join(base, ".pi", "agent", "extensions", "pi-deck-todo.ts");
				const sentinel = join(base, "outside-sentinel");
				mkdirSync(join(stale, "nested"), { recursive: true });
				writeFileSync(join(stale, "index.ts"), "export default {};\n");
				mkdirSync(sentinel, { recursive: true });
				writeFileSync(join(sentinel, "keep.txt"), "outside payload\n");
				symlinkSync(sentinel, join(stale, "nested", "outside"), "junction");
				return { stale, sentinel };
			};
			const planted = [];
			try {
				const { shim, statePath } = installFakePi(home);
				const session = await start(t, home, {
					settings: { customPiPath: shim, piRuntimePreference: "auto" },
					env: { PIDECK_FAKE_PI_STATE: statePath },
				});
				const cpp = plantStaleCopy(home);
				planted.push(cpp);
				// A stale *empty* directory must survive too: `rm` without `recursive` unlinks (and
				// unlink of a directory fails), it never rmdir's behind the user's back.
				const cppEmptyDir = join(home, ".pi", "agent", "extensions", "pi-deck-plan-mode.ts");
				mkdirSync(cppEmptyDir, { recursive: true });

				const removed = await session.invoke("extensions:remove-built-in", ["pi-deck-todo.ts"]);
				assert.equal(removed.payload.ok, true, JSON.stringify(removed.payload));
				const emptied = await session.invoke("extensions:remove-built-in", ["pi-deck-plan-mode.ts"]);
				assert.equal(emptied.payload.ok, true, JSON.stringify(emptied.payload));

				// Disabling a shipped extension authorizes deleting a stale file only.
				// A user directory with that basename and all junction referents must survive.
				assert.equal(existsSync(cpp.stale), true, "the backend must not delete the user's directory");
				assert.equal(existsSync(cppEmptyDir), true, "the backend must not rmdir an empty directory");
				// Full content parity, not just existence: the junction is still a link and both trees
				// are byte-for-byte what the fixture planted, referent reached through the link included.
				assert.deepEqual(snapshotTree(cpp.stale), {
					"index.ts": Buffer.byteLength("export default {};\n"),
					"nested/outside/keep.txt": Buffer.byteLength("outside payload\n"),
				});
				assert.equal(lstatSync(join(cpp.stale, "nested", "outside")).isSymbolicLink(), true);
				assert.equal(readFileSync(join(cpp.sentinel, "keep.txt"), "utf8"), "outside payload\n");
			} catch (error) {
				for (const entry of planted) rmSync(entry.stale, { recursive: true, force: true });
				if (error.code === "EPERM" || error.code === "EACCES") {
					t.skip(`junction creation is not permitted on this machine (${error.code})`);
					return;
				}
				throw error;
			}
		});

		// ── launch integration with copied resources ────────────────────
		test("removed built-ins disappear from the pi launch argv; restored ones come back", async (t) => {
			const home = homeFor();
			const projectPath = join(root, "launch-project");
			mkdirSync(projectPath, { recursive: true });
			const resourcesRoot = join(root, "launch-resources");
			const copied = copyBuiltInResources(resourcesRoot);
			const sourceSnapshot = snapshotTree(resolve("resources/extensions"));
			assert.ok(copied.copied.includes("pi-deck-todo.ts"));
			let fake = null;
			const session = await startBackendSession(t, {
				projects: [{ id: "ext", path: projectPath }],
				settings: { language: "en-US" },
				env: {
					PIDECK_HOME: home,
					PIDECK_HOST_HOME: home,
					PIDECK_RESOURCES_PATH: resourcesRoot,
				},
				prepare: (fixture) => {
					fake = createFakePi(fixture, {});
					return {
						settings: { customPiPath: fake.shim, piRuntimePreference: "auto" },
						env: { FAKE_PI_SCENARIO: fake.scenarioPath, FAKE_PI_LOG: fake.logPath },
					};
				},
			});

			const activate = async (name) => {
				const filePath = writeSessionFile(session.fixture.sessions, projectPath, name);
				const list = await session.invoke("sessions:catalog-list", ["ext"]);
				assert.equal(list.payload.ok, true, JSON.stringify(list.payload));
				const record = list.payload.result.find((entry) => slash(entry.filePath) === slash(filePath));
				assert.ok(record, "imported session must appear in the catalog");
				const activated = await session.invoke("sessions:runtime-activate", [record.id]);
				assert.equal(activated.payload.ok, true, JSON.stringify(activated.payload));
				const spawns = fake.readLog().filter((entry) => entry.kind === "spawn" && entry.argv.includes("--mode"));
				const spawn = spawns.at(-1);
				assert.ok(spawn, "the runtime must spawn pi");
				const extensions = [];
				for (let index = 0; index < spawn.argv.length; index += 1) {
					if (spawn.argv[index] === "--extension") extensions.push(spawn.argv[index + 1]);
				}
				return { target: activated.payload.result.value, extensions };
			};

			const first = await activate(`ext-a-${Date.now()}`);
			const todoPath = join(copied.directory, "pi-deck-todo.ts");
			assert.equal(first.extensions.some((path) => slash(path) === slash(todoPath)), true, JSON.stringify(first.extensions));
			// The shipped defaults stay removed: the settings catalog disables two built-ins.
			assert.equal(first.extensions.some((path) => path.endsWith("pideck-q-websearch.ts")), false);
			assert.equal(first.extensions.every((path) => slash(path).startsWith(slash(copied.directory))), true, JSON.stringify(first.extensions));

			// Removing the built-in affects the next spawn, not the running process.
			const removed = await session.invoke("extensions:remove-built-in", ["pi-deck-todo.ts"]);
			assert.equal(removed.payload.ok, true, JSON.stringify(removed.payload));
			const second = await activate(`ext-b-${Date.now()}`);
			assert.equal(second.extensions.some((path) => slash(path) === slash(todoPath)), false, JSON.stringify(second.extensions));
			assert.equal(second.extensions.length, first.extensions.length - 1);

			const restored = await session.invoke("extensions:restore-built-in", ["pi-deck-todo.ts"]);
			assert.equal(restored.payload.ok, true, JSON.stringify(restored.payload));
			const third = await activate(`ext-c-${Date.now()}`);
			assert.equal(third.extensions.some((path) => slash(path) === slash(todoPath)), true, JSON.stringify(third.extensions));
			assert.deepEqual(third.extensions, first.extensions);

			// No copy is deployed into the user's extension directory and the source tree is
			// untouched: the built-ins load from resources via `-e`.
			assert.equal(existsSync(join(home, ".pi", "agent", "extensions", "pi-deck-todo.ts")), false);
			assert.deepEqual(snapshotTree(resolve("resources/extensions")), sourceSnapshot);
		});

		test("extension commands retry a failed Pi version probe before selecting compatible arguments", async (t) => {
			const home = homeFor();
			const { shim, statePath, rawPath } = installFakePiRecordingRaw(home);
			const initial = JSON.parse(readFileSync(statePath, "utf8"));
			writeFileSync(statePath, JSON.stringify({ ...initial, versionFailuresRemaining: 1 }));
			const session = await start(t, home, {
				settings: { customPiPath: shim, piRuntimePreference: "auto" },
				env: { PIDECK_FAKE_PI_STATE: statePath },
			});
			assert.equal((await session.invoke("extensions:install", ["npm:first"])).payload.ok, true);
			assert.equal((await session.invoke("extensions:install", ["npm:second"])).payload.ok, true);
			const rawCalls = readFileSync(rawPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
			const second = rawCalls.find((call) => call[0] === "install" && call[1] === "npm:second");
			assert.ok(second?.includes("--approve"), JSON.stringify(rawCalls));
		});

		// ── install / update / update-one ───────────────────────────────
		test("extensions:install, update and update-one use the supported CLI contract", async (t) => {
			const home = homeFor();
			const { shim, statePath, rawPath } = installFakePiRecordingRaw(home);
			const session = await start(t, home, {
				settings: { customPiPath: shim, piRuntimePreference: "auto" },
				env: { PIDECK_FAKE_PI_STATE: statePath },
			});

			const installed = await session.invoke("extensions:install", ["npm:new-package"]);
			assert.equal(installed.payload.ok, true, JSON.stringify(installed.payload));

			const updated = await session.invoke("extensions:update");
			assert.equal(updated.payload.ok, true, JSON.stringify(updated.payload));

			const one = await session.invoke("extensions:update-one", ["npm:new-package"]);
			assert.equal(one.payload.ok, true, JSON.stringify(one.payload));

			// The exact argv (including the version-gated `--approve`) must match.
			const calls = (path) =>
				JSON.parse(readFileSync(path, "utf8"))
					.calls.filter((call) => call[0] !== "--version")
					.map((call) => call.join(" "));
			assert.deepEqual(calls(statePath), ["install npm:new-package", "update --extensions", "update npm:new-package"]);
			const rawCalls = readFileSync(rawPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
			// The fixture strips --approve before recording, so the wrapper proves the flag
			// really reached the CLI (pi >= 0.79 accepts it).
			for (const args of [["install", "npm:new-package"], ["update", "--extensions"], ["update", "npm:new-package"]]) {
				assert.ok(
					rawCalls.some((call) => call[0] === args[0] && call[1] === args[1] && call.includes("--approve")),
					JSON.stringify(rawCalls),
				);
			}

			// Failure paths are localized identically.
			const empty = await session.invoke("extensions:install", [""]);
			assert.equal(empty.payload.ok, false);
			const builtIn = await session.invoke("extensions:uninstall", ["pi-deck-todo.ts", "user"]);
			assert.equal(builtIn.payload.ok, false);
		});
	});
} else {
	describe("native2 extension lifecycle parity", () => {
		test("requires a built backend", (t) => {
			t.skip("PiDeckBackend.exe is not built");
		});
	});
}
