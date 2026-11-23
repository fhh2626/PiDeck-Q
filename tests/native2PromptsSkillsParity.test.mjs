import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";

import { resolveBackendExecutable, startBackendSession } from "./helpers/native2BackendHarness.mjs";
import { writeNodeShim } from "./helpers/native2FakeProcess.mjs";

const executable = resolveBackendExecutable();


/** Windows paths are compared with forward slashes on the wire. */
function normalizePaths(value) {
	if (typeof value === "string") {
		if (
			/^[A-Za-z]:[\\/]/.test(value)
			|| value.startsWith("\\\\")
			// Skill ids embed a native path behind a location prefix.
			|| /^(?:pi-global|agents-global|local):[A-Za-z]:/.test(value)
		) {
			return value.replaceAll("\\", "/");
		}
		return value;
	}
	if (Array.isArray(value)) return value.map(normalizePaths);
	if (value && typeof value === "object") {
		const result = {};
		for (const [key, entry] of Object.entries(value)) result[key] = normalizePaths(entry);
		return result;
	}
	return value;
}

/** Oracle values come from a `vm` realm; a JSON round-trip compares data, not realms. */
function plain(value) {
	return JSON.parse(JSON.stringify(value ?? null));
}

/** Install the fake CLI through the host platform's executable shim. */
function installFakePi(root) {
	const script = resolve("tests/fixtures/native2-fake-pi-cli.mjs");
	const shim = writeNodeShim(root, "pi", script);
	const statePath = join(root, "fake-pi-state.json");
	writeFileSync(statePath, JSON.stringify({ calls: [], packages: [] }));
	return { shim, statePath };
}

if (executable) {
	describe("native2 prompts / skills / extensions parity", () => {
		let root;
		let homeSeq = 0;

		before(() => {
			root = mkdtempSync(join(tmpdir(), "pideck-native2-store-"));
		});
		after(() => {
			if (root) rmSync(root, { recursive: true, force: true });
		});

		/** A hermetic `~/.pi/agent` per test; both sides resolve the same layout. */
		function homeFor() {
			homeSeq += 1;
			const home = join(root, `home-${homeSeq}`);
			mkdirSync(join(home, ".pi", "agent", "prompts"), { recursive: true });
			mkdirSync(join(home, ".pi", "agent", "skills"), { recursive: true });
			mkdirSync(join(home, ".agents", "skills"), { recursive: true });
			return home;
		}

		/**
		 * Mutating channels need two identical starting points: the backend owns one
		 * home, the oracle the other, and the results are compared afterwards.
		 */

		const start = (t, home, extra = {}) =>
			startBackendSession(t, {
				settings: { language: "en-US", ...(extra.settings ?? {}) },
				env: {
					PIDECK_HOME: home,
					PIDECK_PROMPTS_DIR: join(home, ".pi", "agent", "prompts"),
					PIDECK_SKILLS_DIR: join(home, ".pi", "agent", "skills"),
					PIDECK_SESSIONS_DIR: join(home, ".pi", "agent", "sessions"),
					// The skill manager resolves ~ from the host home, exactly like the host
					// injects it, so the fixture must own that too.
					PIDECK_HOST_HOME: home,
					PIDECK_FAKE_PI_STATE: join(home, "fake-pi-state.json"),
					...extra.env,
				},
				hostHandlers: extra.hostHandlers,
				prepare: extra.prepare,
			});

		// ── Prompt templates ────────────────────────────────────────────
		test("prompts:list returns the expected records, including built-in templates", async (t) => {
			const home = homeFor();
			writeFileSync(
				join(home, ".pi", "agent", "prompts", "alpha.md"),
				"---\ndescription: Alpha template\n---\n\nDo the alpha thing.\n",
			);
			// A `.d.md` sidecar and an empty file must both be ignored.
			writeFileSync(join(home, ".pi", "agent", "prompts", "alpha.d.md"), "sidecar\n");
			writeFileSync(join(home, ".pi", "agent", "prompts", "empty.md"), "");
			const session = await start(t, home);

			const actual = await session.invoke("prompts:list");
			assert.equal(actual.payload.ok, true, JSON.stringify(actual.payload));
			const names = actual.payload.result.templates.map((item) => item.name);
			assert.deepEqual(names, [
				"alpha",
				"commit",
				"doc",
				"explain",
				"fix",
				"pi-system",
				"refactor",
				"review",
				"skill-discipline",
				"test",
			]);
		});

		test("prompts:create normalizes the name and writes normalized frontmatter", async (t) => {
			const home = homeFor();

			const session = await start(t, home);

			const input = { name: "  My Prompt!! 2 ", description: "  Line one\nLine two  " };
			const actual = await session.invoke("prompts:create", [input]);
			assert.equal(actual.payload.ok, true, JSON.stringify(actual.payload));
			// `scope` is deliberately absent from a create() result.
			assert.equal(actual.payload.result.scope, undefined);
			const onDisk = readFileSync(join(home, ".pi", "agent", "prompts", "my-prompt-2.md"), "utf8");
			assert.equal(onDisk, "---\ndescription: Line one Line two\n---\n");
		});

		test("prompts:create keeps Unicode letters and rejects a duplicate", async (t) => {
			const home = homeFor();

			const session = await start(t, home);

			const input = { name: "中文 模板", description: "中文描述" };
			const actual = await session.invoke("prompts:create", [input]);
			assert.equal(actual.payload.ok, true, JSON.stringify(actual.payload));

			const duplicate = await session.invoke("prompts:create", [input]);
			assert.equal(duplicate.payload.ok, false);
			assert.match(duplicate.payload.error.message, /already exists/i);
		});

		test("prompts:edit reads and writes exact content", async (t) => {
			const home = homeFor();
			writeFileSync(
				join(home, ".pi", "agent", "prompts", "editable.md"),
				"---\ndescription: Before\n---\n\nOriginal body\n",
			);

			const session = await start(t, home);
			const backendPath = join(home, ".pi", "agent", "prompts", "editable.md");


			const read = await session.invoke("prompts:edit", [backendPath]);
			assert.equal(read.payload.ok, true, JSON.stringify(read.payload));
			assert.equal(read.payload.result, "---\ndescription: Before\n---\n\nOriginal body\n");

			const body = "---\ndescription: After\n---\n\nNew body\n";
			const written = await session.invoke("prompts:edit", [backendPath, body]);
			assert.equal(written.payload.ok, true, JSON.stringify(written.payload));
			assert.equal(readFileSync(backendPath, "utf8"), body);

			// A path outside the template root is rejected by both sides.
			const outside = join(home, "outside.md");
			writeFileSync(outside, "nope\n");
			const rejected = await session.invoke("prompts:edit", [outside, "x"]);
			assert.equal(rejected.payload.ok, false);
		});

		test("prompts:rename returns the renamed summary and refuses an existing target", async (t) => {
			const home = homeFor();
			writeFileSync(
				join(home, ".pi", "agent", "prompts", "first.md"),
				"---\ndescription: First template\n---\n",
			);
			writeFileSync(
				join(home, ".pi", "agent", "prompts", "second.md"),
				"---\ndescription: Second template\n---\n",
			);

			const session = await start(t, home);

			const actual = await session.invoke("prompts:rename", ["first", "third"]);
			assert.equal(actual.payload.ok, true, JSON.stringify(actual.payload));
			assert.equal(actual.payload.result.name, "third");
			assert.equal(existsSync(join(home, ".pi", "agent", "prompts", "first.md")), false);
			assert.equal(readFileSync(join(home, ".pi", "agent", "prompts", "third.md"), "utf8"), "---\ndescription: First template\n---\n");

			const conflict = await session.invoke("prompts:rename", ["third", "second"]);
			assert.equal(conflict.payload.ok, false);
			assert.match(conflict.payload.error.message, /already exists/i);
		});

		test("prompts:delete trashes the file and hides a built-in instead", async (t) => {
			const home = homeFor();
			writeFileSync(
				join(home, ".pi", "agent", "prompts", "removable.md"),
				"---\ndescription: Gone soon\n---\n",
			);

			const session = await start(t, home);
			const backendPath = join(home, ".pi", "agent", "prompts", "removable.md");

			const deleted = await session.invoke("prompts:delete", [backendPath]);
			assert.equal(deleted.payload.ok, true, JSON.stringify(deleted.payload));
			// The harness fakes the recycle bin, so the assertion is on the request:
			// the backend must never unlink user content itself.
			assert.deepEqual(
				session.trashCalls.map((path) => normalizePaths(path)),
				[normalizePaths(backendPath)],
			);

			// A built-in has no file: deleting it records the name in settings.
			const hidden = await session.invoke("prompts:delete", ["builtin://review"]);
			assert.equal(hidden.payload.ok, true, JSON.stringify(hidden.payload));
			const list = (await session.invoke("prompts:list")).payload.result;
			assert.ok(!list.templates.some((item) => item.name === "review"));
			assert.equal(list.hasHiddenBuiltins, true);

			const settings = JSON.parse(
				readFileSync(join(session.fixture.userData, "settings.json"), "utf8"),
			);
			assert.deepEqual(plain(settings.hiddenBuiltinPromptNames), ["review"]);

			const restored = await session.invoke("prompts:restore-builtins");
			assert.equal(restored.payload.ok, true, JSON.stringify(restored.payload));
			const after = (await session.invoke("prompts:list")).payload.result;
			assert.ok(after.templates.some((item) => item.name === "review"));
			assert.equal(after.hasHiddenBuiltins, false);
		});

		test("project prompt templates support list/create/rename/delete", async (t) => {
			const home = homeFor();
			const projectPath = join(root, "prompt-project");
			mkdirSync(join(projectPath, ".pi", "prompts"), { recursive: true });
			writeFileSync(
				join(projectPath, ".pi", "prompts", "existing.md"),
				"---\ndescription: Existing project template\n---\n\nbody\n",
			);
			// The oracle mutates the same template directory, so it gets a twin.

			// The project catalog is loaded during startup, so the record must be on disk
			// before the backend spawns.
			const session = await start(t, home, {
				prepare: (fixture) => {
					writeFileSync(
						join(fixture.userData, "projects.json"),
						JSON.stringify([
							{
								id: "proj-prompt",
								name: "prompt-project",
								path: projectPath,
								lastOpenedAt: 1_700_000_000_000,
								sortOrder: 0,
								environment: "windows",
							},
						]),
					);
				},
			});

			const list = await session.invoke("prompts:list-by-project", [projectPath]);
			assert.equal(list.payload.ok, true, JSON.stringify(list.payload));
			assert.equal(list.payload.result.hasHiddenBuiltins, false);
			assert.deepEqual(list.payload.result.templates.map((entry) => entry.name), ["existing"]);

			const created = await session.invoke("prompts:create-in-project", [
				projectPath,
				{ name: "Fresh", description: "Fresh project template" },
			]);
			assert.equal(created.payload.ok, true, JSON.stringify(created.payload));
			assert.equal(created.payload.result.scope, "project");
			assert.equal(readFileSync(join(projectPath, ".pi", "prompts", "fresh.md"), "utf8"), "---\ndescription: Fresh project template\n---\n");

			const renamed = await session.invoke("prompts:rename-in-project", [
				projectPath,
				"fresh",
				"fresher",
			]);
			assert.equal(renamed.payload.ok, true, JSON.stringify(renamed.payload));
			assert.equal(renamed.payload.result.name, "fresher");
			assert.equal(existsSync(join(projectPath, ".pi", "prompts", "fresh.md")), false);

			const deleted = await session.invoke("prompts:delete-in-project", [
				projectPath,
				"fresher.md",
			]);
			assert.equal(deleted.payload.ok, true, JSON.stringify(deleted.payload));
			// The harness fakes the recycle bin, so the request is what gets asserted.
			assert.ok(
				session.trashCalls
					.map((path) => normalizePaths(path))
					.includes(normalizePaths(join(projectPath, ".pi", "prompts", "fresher.md"))),
				JSON.stringify(session.trashCalls),
			);

			// An unregistered project is rejected instead of being created on demand.
			const foreign = join(root, "not-a-project");
			mkdirSync(foreign, { recursive: true });
			const rejected = await session.invoke("prompts:list-by-project", [foreign]);
			assert.equal(rejected.payload.ok, false);
		});

		// ── Skills ──────────────────────────────────────────────────────
		test("skills:list returns the expected records across both locations", async (t) => {
			const home = homeFor();
			const piSkills = join(home, ".pi", "agent", "skills");
			const agentsSkills = join(home, ".agents", "skills");
			mkdirSync(join(piSkills, "alpha-skill"), { recursive: true });
			writeFileSync(
				join(piSkills, "alpha-skill", "SKILL.md"),
				"---\nname: alpha-skill\ndescription: Alpha skill\n---\n\n# alpha-skill\n",
			);
			// A nested directory skill (no SKILL.md at the top level).
			mkdirSync(join(piSkills, "group", "nested-skill"), { recursive: true });
			writeFileSync(
				join(piSkills, "group", "nested-skill", "SKILL.md"),
				"---\nname: nested-skill\ndescription: Nested skill\n---\n",
			);
			// A root-level markdown skill only counts in the pi-global location.
			writeFileSync(
				join(piSkills, "flat-skill.md"),
				"---\nname: flat-skill\ndescription: Flat skill\n---\n",
			);
			writeFileSync(join(agentsSkills, "flat-skill.md"), "---\nname: flat-skill\n---\n");
			// Same name in both roots: pi-global wins.
			mkdirSync(join(agentsSkills, "alpha-skill"), { recursive: true });
			writeFileSync(
				join(agentsSkills, "alpha-skill", "SKILL.md"),
				"---\nname: alpha-skill\ndescription: Duplicate from agents\n---\n",
			);
			// An invalid skill must carry the same warnings on both sides.
			mkdirSync(join(piSkills, "bad_skill"), { recursive: true });
			writeFileSync(join(piSkills, "bad_skill", "SKILL.md"), "---\nname: bad_skill\n---\n");

			const session = await start(t, home);

			const actual = await session.invoke("skills:list");
			assert.equal(actual.payload.ok, true, JSON.stringify(actual.payload));
			const names = actual.payload.result.skills.map((skill) => skill.name);
			assert.ok(names.includes("nested-skill"), JSON.stringify(names));
			assert.ok(names.includes("flat-skill"), JSON.stringify(names));
			const alpha = actual.payload.result.skills.find((skill) => skill.name === "alpha-skill");
			assert.equal(alpha.sourceId, "pi-global");
			const bad = actual.payload.result.skills.find((skill) => skill.name === "bad_skill");
			assert.equal(bad.valid, false);
			assert.ok(bad.warnings.length >= 2, JSON.stringify(bad.warnings));
		});

		test("skills:create writes valid SKILL.md and rejects a duplicate", async (t) => {
			const home = homeFor();

			const session = await start(t, home);

			const input = { name: "New Skill", description: "Does a thing", locationId: "pi-global" };
			const actual = await session.invoke("skills:create", [input]);
			assert.equal(actual.payload.ok, true, JSON.stringify(actual.payload));
			assert.equal(actual.payload.result.name, "new-skill");
			assert.match(readFileSync(actual.payload.result.path, "utf8"), /^name: new-skill$/m);
			assert.match(readFileSync(actual.payload.result.path, "utf8"), /^description: Does a thing$/m);

			const duplicate = await session.invoke("skills:create", [input]);
			assert.equal(duplicate.payload.ok, false);

			const unknown = await session.invoke("skills:create", [
				{ ...input, name: "other", locationId: "project-pi" },
			]);
			assert.equal(unknown.payload.ok, false);
		});

		test("skills:toggle flips disable-model-invocation in persisted frontmatter", async (t) => {
			const home = homeFor();
			mkdirSync(join(home, ".pi", "agent", "skills", "toggle-me"), { recursive: true });
			writeFileSync(
				join(home, ".pi", "agent", "skills", "toggle-me", "SKILL.md"),
				"---\nname: toggle-me\ndescription: Toggle target\n---\n\n# toggle-me\n",
			);

			const session = await start(t, home);
			const backendPath = join(home, ".pi", "agent", "skills", "toggle-me", "SKILL.md");


			const disabled = await session.invoke("skills:toggle", [backendPath, false]);
			assert.equal(disabled.payload.ok, true, JSON.stringify(disabled.payload));
			assert.equal(disabled.payload.result.enabled, false);
			assert.match(readFileSync(backendPath, "utf8"), /^disable-model-invocation: true$/m);

			const enabled = await session.invoke("skills:toggle", [backendPath, true]);
			assert.equal(enabled.payload.ok, true, JSON.stringify(enabled.payload));
			assert.equal(enabled.payload.result.enabled, true);
			assert.doesNotMatch(readFileSync(backendPath, "utf8"), /^disable-model-invocation: true$/m);
		});

		test("skills:rename moves the directory and rewrites the frontmatter name", async (t) => {
			const home = homeFor();
			mkdirSync(join(home, ".pi", "agent", "skills", "before-rename"), { recursive: true });
			writeFileSync(
				join(home, ".pi", "agent", "skills", "before-rename", "SKILL.md"),
				"---\nname: before-rename\ndescription: Rename target\n---\n",
			);

			const session = await start(t, home);
			const backendPath = join(home, ".pi", "agent", "skills", "before-rename", "SKILL.md");


			const actual = await session.invoke("skills:rename", [backendPath, "After Rename"]);
			assert.equal(actual.payload.ok, true, JSON.stringify(actual.payload));
			assert.equal(existsSync(backendPath), false);
			assert.match(readFileSync(actual.payload.result.path, "utf8"), /^name: after-rename$/m);
			assert.equal(actual.payload.result.name, "after-rename");
		});

		test("skills:delete moves the skill directory to the recycle bin", async (t) => {
			const home = homeFor();
			mkdirSync(join(home, ".pi", "agent", "skills", "delete-me"), { recursive: true });
			writeFileSync(
				join(home, ".pi", "agent", "skills", "delete-me", "SKILL.md"),
				"---\nname: delete-me\ndescription: Delete target\n---\n",
			);
			const session = await start(t, home);
			const skillPath = join(home, ".pi", "agent", "skills", "delete-me", "SKILL.md");

			const deleted = await session.invoke("skills:delete", [skillPath]);
			assert.equal(deleted.payload.ok, true, JSON.stringify(deleted.payload));
			// A directory skill is trashed as a whole, never file by file.
			assert.deepEqual(
				session.trashCalls.map((path) => normalizePaths(path)),
				[normalizePaths(join(home, ".pi", "agent", "skills", "delete-me"))],
			);
		});

		// ── Extensions ──────────────────────────────────────────────────
		test("extensions:list returns the expected records for packages, local files and built-ins", async (t) => {
			const home = homeFor();
			const agentDir = join(home, ".pi", "agent");
			const { shim, statePath } = installFakePi(home);
			const packagePath = join(agentDir, "node_modules", "context-mode");
			mkdirSync(packagePath, { recursive: true });
			writeFileSync(statePath, JSON.stringify({
				calls: [],
				packages: [
					{ source: "npm:context-mode", scope: "user", path: packagePath },
					{ source: "npm:filtered-pkg", scope: "user", path: "", filtered: true },
				],
			}));
			// A hand-dropped local extension that `pi list` never reports.
			mkdirSync(join(agentDir, "extensions"), { recursive: true });
			writeFileSync(join(agentDir, "extensions", "local-ext.ts"), "export default {};\n");
			mkdirSync(join(agentDir, "extensions", "dir-ext"), { recursive: true });
			writeFileSync(join(agentDir, "extensions", "dir-ext", "index.ts"), "export default {};\n");
			// pi's own settings carry the disabled list.
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({ disabledExtensions: ["npm:context-mode"] }),
			);




			const session = await start(t, home, {
				// `auto` + customPiPath is the only combination that honours the override;
				// a fixed preference would silently fall back to the real pi on PATH.
				settings: { customPiPath: shim, piRuntimePreference: "auto" },
			});

			const actual = await session.invoke("extensions:list");
			assert.equal(actual.payload.ok, true, JSON.stringify(actual.payload));
			const sources = actual.payload.result.extensions.map((ext) => ext.source);
			assert.ok(sources.includes("npm:context-mode"), JSON.stringify(sources));
			assert.ok(sources.includes("npm:filtered-pkg"));
			assert.ok(sources.includes("local-ext.ts"));
			assert.ok(sources.includes("dir-ext"));
			assert.ok(sources.includes("pi-deck-todo.ts"), "every built-in is listed");
			const filtered = actual.payload.result.extensions.find(
				(ext) => ext.source === "npm:filtered-pkg",
			);
			assert.equal(filtered.filtered, true);
			const contextMode = actual.payload.result.extensions.find(
				(ext) => ext.source === "npm:context-mode",
			);
			assert.equal(contextMode.enabled, false);
		});

		test("extensions:toggle routes built-ins to removedBuiltInExtensions", async (t) => {
			const home = homeFor();
			const agentDir = join(home, ".pi", "agent");
			const { shim } = installFakePi(home);
			mkdirSync(join(agentDir, "extensions"), { recursive: true });
			const session = await start(t, home, {
				settings: { customPiPath: shim, piRuntimePreference: "auto" },
			});

			const removed = await session.invoke("extensions:toggle", ["pi-deck-todo.ts", false]);
			assert.equal(removed.payload.ok, true, JSON.stringify(removed.payload));
			const settings = JSON.parse(
				readFileSync(join(session.fixture.userData, "settings.json"), "utf8"),
			);
			assert.ok(settings.removedBuiltInExtensions.includes("pi-deck-todo.ts"));

			const restored = await session.invoke("extensions:toggle", ["pi-deck-todo.ts", true]);
			assert.equal(restored.payload.ok, true, JSON.stringify(restored.payload));
			const after = JSON.parse(
				readFileSync(join(session.fixture.userData, "settings.json"), "utf8"),
			);
			assert.ok(!after.removedBuiltInExtensions.includes("pi-deck-todo.ts"));

			// A non-built-in toggle writes pi's own disabledExtensions.
			const disabled = await session.invoke("extensions:toggle", ["npm:context-mode", false]);
			assert.equal(disabled.payload.ok, true, JSON.stringify(disabled.payload));
			const piSettings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
			assert.deepEqual(piSettings.disabledExtensions, ["npm:context-mode"]);
		});

		test("extensions:uninstall trashes a local file extension and refuses built-ins", async (t) => {
			const home = homeFor();
			const agentDir = join(home, ".pi", "agent");
			const { shim } = installFakePi(home);
			mkdirSync(join(agentDir, "extensions"), { recursive: true });
			writeFileSync(join(agentDir, "extensions", "local-ext.ts"), "export default {};\n");
			const session = await start(t, home, {
				settings: { customPiPath: shim, piRuntimePreference: "auto" },
			});

			const removed = await session.invoke("extensions:uninstall", ["local-ext.ts", "user"]);
			assert.equal(removed.payload.ok, true, JSON.stringify(removed.payload));
			assert.deepEqual(
				session.trashCalls.map((path) => normalizePaths(path)),
				[normalizePaths(join(agentDir, "extensions", "local-ext.ts"))],
			);

			const builtIn = await session.invoke("extensions:uninstall", ["pi-deck-todo.ts", "user"]);
			assert.equal(builtIn.payload.ok, false);
			assert.match(builtIn.payload.error.message, /built-in/i);

			// A traversal attempt is refused before any filesystem access.
			const traversal = await session.invoke("extensions:uninstall", ["../escape.ts", "user"]);
			assert.equal(traversal.payload.ok, false);
		});

		test("extensions:install and update reach the resolved pi with an argument array", async (t) => {
			const home = homeFor();
			const { shim, statePath } = installFakePi(home);
			const session = await start(t, home, {
				settings: { customPiPath: shim, piRuntimePreference: "auto" },
			});

			const installed = await session.invoke("extensions:install", ["npm:new-package"]);
			assert.equal(installed.payload.ok, true, JSON.stringify(installed.payload));
			assert.match(installed.payload.result, /installed npm:new-package/);

			const updated = await session.invoke("extensions:update");
			assert.equal(updated.payload.ok, true, JSON.stringify(updated.payload));
			assert.deepEqual(plain(updated.payload.result), {
				command: "pi update --extensions",
				output: "updated --extensions",
				updated: true,
			});

			const one = await session.invoke("extensions:update-one", ["npm:new-package"]);
			assert.equal(one.payload.ok, true, JSON.stringify(one.payload));
			assert.equal(one.payload.result.command, "pi update npm:new-package");

			const state = JSON.parse(readFileSync(statePath, "utf8"));
			const calls = state.calls.map((call) => call.join(" "));
			assert.ok(calls.includes("install npm:new-package"), JSON.stringify(calls));
			assert.ok(calls.includes("update --extensions"), JSON.stringify(calls));
			assert.ok(calls.includes("update npm:new-package"), JSON.stringify(calls));
		});
	});
} else {
	describe("native2 prompts / skills / extensions parity", () => {
		test("requires a built backend", (t) => {
			t.skip("PiDeckBackend.exe is not built");
		});
	});
}
