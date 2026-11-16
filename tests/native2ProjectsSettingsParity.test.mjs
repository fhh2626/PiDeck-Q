import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import {
	backendFixtureSettings,
	resolveBackendExecutable,
	SseClient,
	startBackendSession,
} from "./helpers/native2BackendHarness.mjs";

const executable = resolveBackendExecutable();

/** Deny atomic writes without relying on POSIX rename honoring a target's read-only mode. */
function blockAtomicSettingsWrite(filePath) {
	if (process.platform === "win32") {
		chmodSync(filePath, 0o444);
		return () => chmodSync(filePath, 0o666);
	}
	// A POSIX rename may replace a read-only file. Temporarily obstruct its parent
	// instead, keeping the entire original directory available for an exact restore.
	// This also fails for a privileged test runner, unlike chmod on the directory.
	const directory = dirname(filePath);
	const savedDirectory = `${directory}.write-blocked`;
	renameSync(directory, savedDirectory);
	try {
		writeFileSync(directory, "settings write blocker\n", { flag: "wx" });
	} catch (error) {
		renameSync(savedDirectory, directory);
		throw error;
	}
	return () => {
		rmSync(directory);
		renameSync(savedDirectory, directory);
	};
}

// The Node modules are the behavioural oracle: the C++ backend must return the same
// records, write the same bytes to disk and report the same errors for the same input.
const { ProjectStore } = loadTsCommonJs(resolve("src/main/projects/ProjectStore.ts"));
const { ProjectResourceManager } = loadTsCommonJs(resolve("src/main/projects/ProjectResourceManager.ts"));
const { SettingsStore } = loadTsCommonJs(resolve("src/main/settings/SettingsStore.ts"));
const { SecurityStore } = loadTsCommonJs(resolve("src/main/security/SecurityStore.ts"));
const { buildSnapshot, validateSecurityConfig } = loadTsCommonJs(resolve("src/main/security/policy.ts"));
const { readSubagentSettings, applySubagentSettings } = loadTsCommonJs(
	resolve("src/main/subagents/SubagentSettingsStore.ts"),
);
const { VisionBridgeConfigManager } = loadTsCommonJs(resolve("src/main/settings/visionBridgeConfig.ts"));
const { ConfigManager } = loadTsCommonJs(resolve("src/main/config/ConfigManager.ts"));
const { lookupModelSpec, buildSpecIndex } = loadTsCommonJs(resolve("src/main/pi/modelSpecsIndex.ts"));
// modelSpecsStore imports sql.js at module scope; the row→entry mapping is pure.
const { entriesFromRows } = loadTsCommonJs(resolve("src/main/pi/modelSpecsStore.ts"), {
	stubs: { "sql.js": { __esModule: true, default: () => ({ Database: class {} }) } },
});

/** Windows drive-letter paths are compared with forward slashes on the wire. */
function normalizePaths(value) {
	if (typeof value === "string") {
		// `project:<path>` ids embed a native path, so they need the same treatment.
		if (
			/^[A-Za-z]:[\\/]/.test(value)
			|| value.startsWith("\\\\")
			|| /^(?:project|project-pi|project-agents):[A-Za-z]:/.test(value)
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

/**
 * Oracle values come from a `vm` realm, so their prototypes differ from this realm's.
 * A JSON round-trip makes the comparison about data instead of about realm identity.
 */
function plain(value) {
	return JSON.parse(JSON.stringify(value ?? null));
}

/** Drop the fields that are legitimately time- or randomness-dependent. */
function projectShape(project) {
	const copy = { ...project };
	delete copy.lastOpenedAt;
	if (copy.id && copy.kind !== "chat" && !copy.id.startsWith("builtin-")) copy.id = "<id>";
	return normalizePaths(copy);
}

function settingsShape(settings) {
	const copy = { ...settings };
	// The web service token is generated per profile; only its validity is comparable.
	if (typeof copy.webServiceAccessToken === "string") {
		copy.webServiceAccessToken = /^[A-Za-z0-9_-]{32,128}$/.test(copy.webServiceAccessToken)
			? "<token>"
			: copy.webServiceAccessToken;
	}
	return copy;
}

const PROJECT_ID = "proj-1";

function writeProjectTree(root) {
	mkdirSync(join(root, ".pi", "skills", "alpha-skill"), { recursive: true });
	writeFileSync(
		join(root, ".pi", "skills", "alpha-skill", "SKILL.md"),
		"---\nname: alpha-skill\ndescription: Alpha skill for tests\n---\n\n# alpha-skill\n",
	);
	mkdirSync(join(root, ".agents", "skills", "beta-skill"), { recursive: true });
	writeFileSync(
		join(root, ".agents", "skills", "beta-skill", "SKILL.md"),
		"---\nname: beta-skill\ndescription: Beta skill\n---\n",
	);
	mkdirSync(join(root, ".pi", "extensions", "demo-ext"), { recursive: true });
	writeFileSync(join(root, ".pi", "extensions", "demo-ext", "index.ts"), "export default {};\n");
	writeFileSync(join(root, ".pi", "extensions", "flat-ext.ts"), "export default {};\n");
	writeFileSync(join(root, ".pi", "settings.json"), JSON.stringify({ theme: "dark" }));
}

if (executable) {
	describe("native2 projects / settings / config parity", () => {
		let root;
		let projectPath;
		let homeSeq = 0;

		before(() => {
			root = mkdtempSync(join(tmpdir(), "pideck-native2-projects-"));
			projectPath = join(root, "project");
			writeProjectTree(projectPath);
		});

		after(() => {
			if (root) rmSync(root, { recursive: true, force: true });
		});

		/**
		 * A hermetic `~/.pi/agent` per test: pi's own settings/models/auth/trust files are
		 * shared mutable state, so reusing one home would leak between assertions.
		 */
		function homeFor() {
			homeSeq += 1;
			const home = join(root, `home-${homeSeq}`);
			mkdirSync(join(home, ".pi", "agent"), { recursive: true });
			return home;
		}

		const start = (t, extra = {}) =>
			startBackendSession(t, {
				projects: [{ id: PROJECT_ID, path: projectPath }],
				// Pin the language so the localized built-in strings are deterministic.
				settings: { language: "en-US" },
				env: { PIDECK_HOME: extra.home ?? homeFor() },
				...extra,
			});

		/**
		 * Start a backend whose `projects.json` is exactly `records`, and load the Node
		 * oracle from an identical copy so both start from the same bytes.
		 */
		async function startWithProjects(t, records, extra = {}) {
			const session = await startBackendSession(t, {
				settings: { language: "en-US" },
				env: { PIDECK_HOME: extra.home ?? homeFor() },
				prepare: (fixture) => {
					writeFileSync(join(fixture.userData, "projects.json"), JSON.stringify(records));
					return extra.prepare?.(fixture);
				},
			});
			const oracleDir = join(session.fixture.root, "oracle");
			mkdirSync(oracleDir, { recursive: true });
			writeFileSync(
				join(oracleDir, "projects.json"),
				readFileSync(join(session.fixture.userData, "projects.json")),
			);
			const oracle = new ProjectStore({
				projectsFile: join(oracleDir, "projects.json"),
				chatPathFile: join(oracleDir, "chat-path.json"),
				// The chat workspace path is a fixed function of the user data dir, so both
				// implementations must resolve the same folder.
				defaultChatProjectPath: join(session.fixture.userData, "chat-workspace"),
				userDataDir: oracleDir,
			});
			await oracle.load();
			return { session, oracle };
		}

		function oracleResources() {
			return new ProjectResourceManager(
				(id) => (id === PROJECT_ID ? { id: PROJECT_ID, path: projectPath, name: "project" } : undefined),
				() => "copy",
			);
		}

		test("projects:list matches the Node ProjectStore, including the built-in chat project", async (t) => {
			const { session, oracle } = await startWithProjects(t, [
				{ id: PROJECT_ID, name: "project", path: projectPath, sortOrder: 0, environment: "windows" },
			]);
			const actual = await session.invoke("projects:list");
			assert.equal(actual.payload.ok, true, JSON.stringify(actual.payload));
			const list = actual.payload.result;
			assert.equal(list.length, 2, JSON.stringify(list));
			assert.equal(list[0].id, "builtin-chat");
			assert.equal(list[0].kind, "chat");
			assert.equal(list[0].name, "Chat");
			assert.equal(list[0].pinned, true);
			assert.equal(list[0].sortOrder, -1);

			assert.deepEqual(
				plain(normalizePaths(list).map(projectShape)),
				plain(oracle.list().map(projectShape)),
			);
		});

		test("projects:add normalizes the path and returns the same record shape as the oracle", async (t) => {
			const session = await start(t);
			const added = await session.invoke("projects:add");
			assert.equal(added.payload.ok, true, JSON.stringify(added.payload));
			// The dialog is cancelled by the harness, so nothing is added.
			assert.equal(added.payload.result, null);

			const second = join(root, "second-project");
			mkdirSync(second, { recursive: true });
			session.host.handlers["dialog.open"] = () => ({ result: { canceled: false, filePaths: [second] } });
			const created = await session.invoke("projects:add");
			assert.equal(created.payload.ok, true, JSON.stringify(created.payload));
			const record = created.payload.result;
			assert.equal(normalizePaths(record.path), normalizePaths(second));
			assert.equal(record.environment, "windows");
			assert.equal(record.name, "second-project");
			assert.match(record.id, /^[0-9a-f-]{36}$/);

			const list = (await session.invoke("projects:list")).payload.result;
			assert.equal(list.length, 3);
			assert.ok(list.some((project) => project.id === record.id));
		});

		test("projects:add returns the existing record for an already registered path", async (t) => {
			const session = await start(t);
			session.host.handlers["dialog.open"] = () => ({
				result: { canceled: false, filePaths: [projectPath] },
			});
			const duplicate = await session.invoke("projects:add");
			assert.equal(duplicate.payload.ok, true, JSON.stringify(duplicate.payload));
			// ProjectStore.add() refreshes the existing record instead of creating a second one.
			assert.equal(duplicate.payload.result.id, PROJECT_ID);
			assert.equal((await session.invoke("projects:list")).payload.result.length, 2);
		});

		test("projects:remove drops worktree children and keeps the chat project", async (t) => {
			const childPath = join(root, "wt-child");
			mkdirSync(childPath, { recursive: true });
			const { session, oracle } = await startWithProjects(t, [
				{ id: PROJECT_ID, name: "project", path: projectPath, sortOrder: 0, environment: "windows" },
				{
					id: "wt-child",
					name: "wt-child",
					path: childPath,
					sortOrder: 1,
					environment: "windows",
					worktreeParentId: PROJECT_ID,
				},
			]);
			assert.equal(oracle.list().length, 3, "the oracle must see both projects plus chat");

			const removed = await session.invoke("projects:remove", [PROJECT_ID]);
			assert.equal(removed.payload.ok, true, JSON.stringify(removed.payload));
			const ids = removed.payload.result.map((project) => project.id);
			assert.ok(!ids.includes(PROJECT_ID));
			assert.ok(!ids.includes("wt-child"), "worktree children are removed with their parent");
			assert.ok(ids.includes("builtin-chat"));

			await oracle.remove(PROJECT_ID);
			assert.deepEqual(
				plain(removed.payload.result.map(projectShape)),
				plain(oracle.list().map(projectShape)),
			);
		});

		test("projects:reorder matches the oracle's sort order assignment", async (t) => {
			const secondPath = join(root, "reorder-second");
			const thirdPath = join(root, "reorder-third");
			mkdirSync(secondPath, { recursive: true });
			mkdirSync(thirdPath, { recursive: true });
			const { session, oracle } = await startWithProjects(t, [
				{ id: PROJECT_ID, name: "project", path: projectPath, sortOrder: 0, environment: "windows" },
				{ id: "second", name: "reorder-second", path: secondPath, sortOrder: 1, environment: "windows" },
				{ id: "third", name: "reorder-third", path: thirdPath, sortOrder: 2, environment: "windows" },
			]);
			const order = ["third", "second", PROJECT_ID];
			const actual = await session.invoke("projects:reorder", [order]);
			assert.equal(actual.payload.ok, true, JSON.stringify(actual.payload));
			const expected = await oracle.reorder(order);
			assert.deepEqual(
				plain(actual.payload.result.map(projectShape)),
				plain(expected.map(projectShape)),
			);
			// The chat project keeps sortOrder -1 and stays first.
			assert.equal(actual.payload.result[0].id, "builtin-chat");
			assert.equal(actual.payload.result[0].sortOrder, -1);
			assert.deepEqual(
				actual.payload.result.slice(1).map((project) => project.id),
				["third", "second", PROJECT_ID],
			);
		});

		test("projects:set-chat-path persists chat-path.json and rejects an overlapping project", async (t) => {
			const session = await start(t);
			const chatDir = join(root, "chat-dir");
			const actual = await session.invoke("projects:set-chat-path", [chatDir]);
			assert.equal(actual.payload.ok, true, JSON.stringify(actual.payload));
			assert.equal(normalizePaths(actual.payload.result.path), normalizePaths(chatDir));
			const stored = JSON.parse(readFileSync(join(session.fixture.userData, "chat-path.json"), "utf8"));
			assert.equal(normalizePaths(stored.path), normalizePaths(chatDir));

			const overlap = await session.invoke("projects:set-chat-path", [projectPath]);
			assert.equal(overlap.payload.ok, false);
			assert.equal(overlap.payload.error.message, "CHAT_PATH_OVERLAPS_PROJECT");

			const invalid = await session.invoke("projects:set-chat-path", [""]);
			assert.equal(invalid.payload.ok, false);
			assert.equal(invalid.payload.error.message, "Invalid chat path");
		});

		test("projects:choose-chat-path applies the picked directory", async (t) => {
			const session = await start(t);
			const picked = join(root, "picked-chat");
			mkdirSync(picked, { recursive: true });
			session.host.handlers["dialog.open"] = () => ({ result: { canceled: false, filePaths: [picked] } });
			const chosen = await session.invoke("projects:choose-chat-path");
			assert.equal(chosen.payload.ok, true, JSON.stringify(chosen.payload));
			// The oracle's chooseChatPath returns the raw path string (or null), not a record.
			assert.equal(normalizePaths(chosen.payload.result), normalizePaths(picked));
		});

		test("a corrupt projects.json is preserved next to itself before the catalog is rebuilt", async (t) => {
			const session = await startWithProjects(t, [], {
				prepare: (fixture) => {
					writeFileSync(join(fixture.userData, "projects.json"), "{ not json");
					return undefined;
				},
			}).then((started) => started.session);
			const projectsFile = join(session.fixture.userData, "projects.json");
			// The catalog is unreadable, so the store falls back to the chat project only.
			const list = (await session.invoke("projects:list")).payload.result;
			assert.deepEqual(list.map((project) => project.id), ["builtin-chat"]);
			assert.ok(existsSync(`${projectsFile}.corrupt`), "corrupt catalog must be preserved");
			assert.equal(readFileSync(`${projectsFile}.corrupt`, "utf8"), "{ not json");
		});

		test("project-resources:list matches the Node ProjectResourceManager", async (t) => {
			const session = await start(t);
			const actual = await session.invoke("project-resources:list", [PROJECT_ID]);
			assert.equal(actual.payload.ok, true, JSON.stringify(actual.payload));
			const expected = await oracleResources().list(PROJECT_ID);
			assert.deepEqual(
				plain(normalizePaths(actual.payload.result)),
				plain(normalizePaths(expected)),
			);
		});

		test("project-resources:list rejects an unknown project and the chat project", async (t) => {
			const session = await start(t);
			const missing = await session.invoke("project-resources:list", ["nope"]);
			assert.equal(missing.payload.ok, false);
			assert.match(missing.payload.error.message, /no longer exists|does not exist/);

			const chat = await session.invoke("project-resources:list", ["builtin-chat"]);
			assert.equal(chat.payload.ok, false);
			assert.ok(chat.payload.error.message.length > 0);
		});

		test("project-resources:create-skill writes the same SKILL.md as the oracle", async (t) => {
			const session = await start(t);
			const actual = await session.invoke("project-resources:create-skill", [
				{ projectId: PROJECT_ID, name: "Gamma Skill", description: "Gamma description" },
			]);
			assert.equal(actual.payload.ok, true, JSON.stringify(actual.payload));
			const created = actual.payload.result;
			assert.equal(created.name, "Gamma Skill");
			assert.equal(created.type, "directory");
			assert.equal(created.enabled, true);
			assert.equal(created.valid, true);
			const content = readFileSync(created.path, "utf8");
			assert.match(content, /^---\nname: Gamma Skill\ndescription: Gamma description\n---\n/);

			// The oracle refuses the same duplicate name with the same localized message.
			// (Oracle errors come from a `vm` realm, so `instanceof Error` does not hold.)
			await assert.rejects(
				() => oracleResources().createSkill({ projectId: PROJECT_ID, name: "Gamma Skill", description: "x" }),
				(error) => typeof error?.message === "string" && error.message.length > 0,
			);
			const duplicate = await session.invoke("project-resources:create-skill", [
				{ projectId: PROJECT_ID, name: "Gamma Skill", description: "Gamma description" },
			]);
			assert.equal(duplicate.payload.ok, false);
			assert.match(duplicate.payload.error.message, /gamma-skill/);
		});

		test("project-resources:toggle-skill flips disable-model-invocation like the oracle", async (t) => {
			const session = await start(t);
			const list = (await session.invoke("project-resources:list", [PROJECT_ID])).payload.result;
			const skill = list.skills.find((entry) => entry.name === "alpha-skill");
			assert.ok(skill, JSON.stringify(list.skills));
			const disabled = await session.invoke("project-resources:toggle-skill", [
				PROJECT_ID,
				skill.path,
				false,
			]);
			assert.equal(disabled.payload.ok, true, JSON.stringify(disabled.payload));
			assert.equal(disabled.payload.result.enabled, false);
			assert.match(readFileSync(skill.path, "utf8"), /disable-model-invocation: true/);

			const enabled = await session.invoke("project-resources:toggle-skill", [
				PROJECT_ID,
				skill.path,
				true,
			]);
			assert.equal(enabled.payload.result.enabled, true);
			assert.match(readFileSync(skill.path, "utf8"), /disable-model-invocation: false/);
		});

		test("project-resources:rename-skill moves the directory and rewrites the name", async (t) => {
			const session = await start(t);
			const list = (await session.invoke("project-resources:list", [PROJECT_ID])).payload.result;
			const skill = list.skills.find((entry) => entry.name === "beta-skill");
			assert.ok(skill, JSON.stringify(list.skills));
			const renamed = await session.invoke("project-resources:rename-skill", [
				PROJECT_ID,
				skill.path,
				"Delta Skill",
			]);
			assert.equal(renamed.payload.ok, true, JSON.stringify(renamed.payload));
			assert.equal(renamed.payload.result.name, "Delta Skill");
			assert.ok(!existsSync(skill.path), "the old directory is moved, not copied");
			assert.match(readFileSync(renamed.payload.result.path, "utf8"), /^---\nname: Delta Skill\n/);
		});

		test("project-resources:toggle-extension writes disabledExtensions by file name", async (t) => {
			const session = await start(t);
			const flatPath = join(projectPath, ".pi", "extensions", "flat-ext.ts");
			const toggled = await session.invoke("project-resources:toggle-extension", [
				PROJECT_ID,
				flatPath,
				false,
			]);
			assert.equal(toggled.payload.ok, true, JSON.stringify(toggled.payload));
			const settings = JSON.parse(readFileSync(join(projectPath, ".pi", "settings.json"), "utf8"));
			// The oracle writes the full file name (`flat-ext.ts`) because it takes the last
			// path segment, while the list compares against the source id (`flat-ext`).
			assert.deepEqual(settings.disabledExtensions, ["flat-ext.ts"]);
			assert.equal(settings.theme, "dark", "unrelated settings survive the write");

			const list = (await session.invoke("project-resources:list", [PROJECT_ID])).payload.result;
			const flat = list.extensions.find((entry) => entry.source === "flat-ext");
			assert.equal(flat.enabled, true, "the oracle's source/file-name mismatch is preserved");

			// A directory extension uses the same id for both, so the toggle round-trips.
			const dirPath = join(projectPath, ".pi", "extensions", "demo-ext");
			await session.invoke("project-resources:toggle-extension", [PROJECT_ID, dirPath, false]);
			const disabledList = (await session.invoke("project-resources:list", [PROJECT_ID])).payload.result;
			assert.equal(disabledList.extensions.find((entry) => entry.source === "demo-ext").enabled, false);
			await session.invoke("project-resources:toggle-extension", [PROJECT_ID, dirPath, true]);
			const enabledList = (await session.invoke("project-resources:list", [PROJECT_ID])).payload.result;
			assert.equal(enabledList.extensions.find((entry) => entry.source === "demo-ext").enabled, true);
		});

		test("project-resources:delete-skill and delete-extension use the recycle bin", async (t) => {
			const session = await start(t);
			const list = (await session.invoke("project-resources:list", [PROJECT_ID])).payload.result;
			const skill = list.skills.find((entry) => entry.name === "alpha-skill");
			const deleted = await session.invoke("project-resources:delete-skill", [PROJECT_ID, skill.path]);
			assert.equal(deleted.payload.ok, true, JSON.stringify(deleted.payload));
			// A directory skill is trashed as a whole package, not as a lone SKILL.md.
			assert.deepEqual(session.trashCalls, [skill.dir]);
			assert.ok(existsSync(skill.path), "the harness trash recorder must not delete the file");

			const extension = list.extensions.find((entry) => entry.source === "demo-ext");
			const deletedExtension = await session.invoke("project-resources:delete-extension", [
				PROJECT_ID,
				extension.path,
			]);
			assert.equal(deletedExtension.payload.ok, true, JSON.stringify(deletedExtension.payload));
			assert.deepEqual(session.trashCalls, [skill.dir, extension.path]);
		});

		test("project-resources rejects a path that escapes the project", async (t) => {
			const session = await start(t);
			const outside = join(root, "outside", "SKILL.md");
			const toggled = await session.invoke("project-resources:toggle-skill", [
				PROJECT_ID,
				outside,
				false,
			]);
			assert.equal(toggled.payload.ok, false);
			assert.ok(toggled.payload.error.message.length > 0);
			assert.equal(existsSync(join(root, "outside")), false);
		});

		test("settings:get matches SettingsStore.load() including migrations", async (t) => {
			const home = homeFor();
			const session = await start(t, { home });
			const actual = await session.invoke("settings:get");
			assert.equal(actual.payload.ok, true, JSON.stringify(actual.payload));

			const oracleFile = join(root, `settings-oracle-${Math.random().toString(16).slice(2)}.json`);
			writeFileSync(oracleFile, JSON.stringify(backendFixtureSettings({ language: "en-US" })));
			const oracle = new SettingsStore({
				desktopSettingsFile: oracleFile,
				piAgentSettingsFile: join(home, ".pi", "agent", "settings.json"),
				getSystemLocale: () => "en-US",
			});
			const expected = await oracle.load();
			assert.deepEqual(
				plain(settingsShape(actual.payload.result)),
				plain(settingsShape(expected)),
			);
		});

		test("settings:get mirrors pi's hideThinkingBlock as showThinking", async (t) => {
			const home = homeFor();
			writeFileSync(
				join(home, ".pi", "agent", "settings.json"),
				JSON.stringify({ hideThinkingBlock: true }),
			);
			const session = await start(t, { home });
			const actual = await session.invoke("settings:get");
			assert.equal(actual.payload.result.showThinking, false);
		});

		test("settings:get migrates legacy keys the same way as the oracle", async (t) => {
			const home = homeFor();
			const legacy = {
				language: "en-US",
				contentMaxWidth: 1400,
				fontFamilyMono: "commit-mono",
				externalEditors: { vscode: { enabled: false } },
				builtInExtensionDefaultsVersion: 1,
			};
			const session = await start(t, { home, settings: legacy });
			const actual = await session.invoke("settings:get");
			assert.equal(actual.payload.ok, true, JSON.stringify(actual.payload));
			const settings = actual.payload.result;
			// 1400px → round(((1400-800)/1000)*40+60) = 84%, the oracle's linear mapping.
			assert.equal(settings.chatContentWidthPct, 84);
			assert.equal(settings.fontFamilyMono, "system-mono");
			// The deep merge keeps the untouched editor defaults.
			assert.equal(settings.externalEditors.vscode.enabled, false);
			assert.equal(settings.externalEditors.cursor.enabled, false, "untouched editors keep their defaults");

			// The whole migrated object must match the oracle, not just the fields above.
			const oracleFile = join(root, `settings-legacy-${Math.random().toString(16).slice(2)}.json`);
			writeFileSync(oracleFile, JSON.stringify(backendFixtureSettings(legacy)));
			const oracle = new SettingsStore({
				desktopSettingsFile: oracleFile,
				piAgentSettingsFile: join(home, ".pi", "agent", "settings.json"),
				getSystemLocale: () => "en-US",
			});
			const expected = await oracle.load();
			assert.deepEqual(
				plain(settingsShape(settings)),
				plain(settingsShape(expected)),
			);
		});

		test("settings:update rejects host-owned fields and re-localizes the built-in prompt", async (t) => {
			const session = await start(t);
			const updated = await session.invoke("settings:update", [
				{ showThinking: false, installationType: "installed", theme: "dark", language: "zh-CN" },
			]);
			assert.equal(updated.payload.ok, true, JSON.stringify(updated.payload));
			const settings = updated.payload.result;
			assert.equal(settings.theme, "dark");
			assert.equal(settings.installationType, "portable");
			assert.equal(settings.showThinking, true);
			// A language-only change re-localizes the built-in template.
			assert.match(settings.gitCommitMessagePrompt, /git commit/);
			const stored = JSON.parse(
				readFileSync(join(session.fixture.userData, "settings.json"), "utf8"),
			);
			assert.equal(stored.showThinking, undefined);
			assert.equal(stored.installationType, undefined);
		});

		test("settings:update applies window chrome through the host and mirrors zoom", async (t) => {
			const session = await start(t);
			const sse = new SseClient(
				`${session.baseUrl}__pideck/events?token=${encodeURIComponent(session.token)}`,
			);
			// Subscribe before the update so the broadcast cannot be missed.
			await sse.connect().catch(() => undefined);
			t.after(() => sse.close());

			const chrome = await session.invoke("settings:update", [{ useNativeTitleBar: true }]);
			assert.equal(chrome.payload.ok, true, JSON.stringify(chrome.payload));
			// Title-bar changes are a host capability, not a renderer event.
			const request = await session.host.waitForRequest("window.applySettings");
			assert.equal(request.params.useNativeTitleBar, true);

			const zoom = await session.invoke("settings:update", [{ zoomFactor: 1.25 }]);
			assert.equal(zoom.payload.ok, true, JSON.stringify(zoom.payload));
			const event = await sse.waitFor("settings:apply-window");
			assert.equal(event.payload.channel, "settings:apply-window");
			assert.equal(event.payload.args[0].zoomFactor, 1.25);
		});

		test("settings:update ignores a weak web service token", async (t) => {
			const session = await start(t);
			const before = (await session.invoke("settings:get")).payload.result.webServiceAccessToken;
			const updated = await session.invoke("settings:update", [{ webServiceAccessToken: "short" }]);
			assert.equal(updated.payload.ok, true, JSON.stringify(updated.payload));
			assert.equal(updated.payload.result.webServiceAccessToken, before);
		});

		test("settings:update rejects a failed write and keeps the previous file and settings", async (t) => {
			// The oracle (`SettingsStore.applyUpdate`) awaits `writeSettings` *before* it swaps
			// its in-memory snapshot, so a failed write leaves both memory and disk on the old
			// values. The native catalog must propagate the same failure instead of reporting
			// "saved" and then applying side effects for a value that never reached disk.
			const session = await start(t);
			const filePath = join(session.fixture.userData, "settings.json");
			const before = (await session.invoke("settings:get")).payload.result;
			const beforeBytes = readFileSync(filePath, "utf8");

			const restore = blockAtomicSettingsWrite(filePath);
			let failed;
			try {
				failed = await session.invoke("settings:update", [
					{ theme: "dark", useNativeTitleBar: true },
				]);
			} finally {
				restore();
			}
			assert.equal(failed.payload.ok, false, JSON.stringify(failed.payload));
			assert.match(failed.payload.error.message, /settings/i);

			// The prior file and the prior reported settings survive the failure.
			assert.equal(readFileSync(filePath, "utf8"), beforeBytes);
			const after = (await session.invoke("settings:get")).payload.result;
			assert.equal(after.theme, before.theme);
			assert.equal(after.useNativeTitleBar, before.useNativeTitleBar);

			// No side effect ran for the values that were never persisted: the host was not
			// asked to change the title bar. (A "saved" answer followed by chrome changes is
			// the user-visible symptom of swallowing the write error.)
			assert.equal(
				session.host.requests.some((frame) => frame.method === "window.applySettings"),
				false,
				JSON.stringify(session.host.requests.map((frame) => frame.method)),
			);

			// Execute the Node oracle with the same write obstruction and keep both its
			// in-memory snapshot and the prior persisted bytes under the original assertions.
			const oracleDirectory = join(session.fixture.root, "oracle-settings");
			mkdirSync(oracleDirectory);
			const oracleFile = join(oracleDirectory, "settings.json");
			writeFileSync(oracleFile, beforeBytes);
			const oracle = new SettingsStore({
				desktopSettingsFile: oracleFile,
				piAgentSettingsFile: join(homeFor(), ".pi", "agent", "settings.json"),
				getSystemLocale: () => "en-US",
			});
			const loaded = await oracle.load();
			const oracleBytes = readFileSync(oracleFile, "utf8");
			const restoreOracle = blockAtomicSettingsWrite(oracleFile);
			try {
				await assert.rejects(() => oracle.update({ theme: "dark" }));
				assert.equal(oracle.get().theme, loaded.theme);
			} finally {
				restoreOracle();
			}
			assert.equal(readFileSync(oracleFile, "utf8"), oracleBytes);
		});

		test("settings:restart-web-service is a real no-op while the LAN service is disabled", async (t) => {
			// The placeholder (`WEB_SERVICE_UNAVAILABLE`) is gone: the LAN web domain now owns
			// the listener. A disabled service must still restart cleanly without starting one,
			// because the settings page is the only owner of "enabled".
			const session = await start(t);
			const settings = (await session.invoke("settings:get")).payload.result;
			assert.equal(settings.webServiceEnabled, false);
			const restarted = await session.invoke("settings:restart-web-service");
			assert.equal(restarted.payload.ok, true, JSON.stringify(restarted.payload));
			const after = (await session.invoke("settings:get")).payload.result;
			assert.equal(after.webServiceEnabled, false, "restart must not enable the service");
		});

		test("security:get-config matches SecurityStore.getConfig()", async (t) => {
			const session = await start(t);
			const actual = await session.invoke("security:get-config");
			assert.equal(actual.payload.ok, true, JSON.stringify(actual.payload));
			const oracle = new SecurityStore({
				settingsStore: { get: () => ({ language: "en-US" }), update: async () => undefined },
				userDataDir: session.fixture.userData,
			});
			assert.deepEqual(plain(actual.payload.result), plain(oracle.getConfig()));
		});

		test("security:update-config reports the same validation failure as the oracle", async (t) => {
			const session = await start(t);
			const bad = await session.invoke("security:update-config", [
				{ defaultLevelId: "does-not-exist" },
			]);
			// The IPC contract answers 200 with a structured failure, not an RPC error.
			assert.equal(bad.payload.ok, true);
			assert.equal(bad.payload.result.ok, false);
			assert.equal(bad.payload.result.code, "VALIDATION_FAILED");
			assert.match(bad.payload.result.error, /默认等级不存在/);

			const errors = validateSecurityConfig({
				enabled: false,
				defaultLevelId: "does-not-exist",
				levels: [],
				sessionOverrides: {},
			});
			assert.ok(errors.length > 0, "the oracle rejects the same config");

			const malformed = await session.invoke("security:update-config", [{ levels: "nope" }]);
			assert.equal(malformed.payload.result.ok, false);
			assert.equal(malformed.payload.result.code, "VALIDATION_FAILED");
		});

		test("security:update-config persists a valid patch and writes the snapshot", async (t) => {
			const session = await start(t);
			const updated = await session.invoke("security:update-config", [{ enabled: true }]);
			assert.equal(updated.payload.ok, true, JSON.stringify(updated.payload));
			assert.equal(updated.payload.result.ok, true);
			assert.equal(updated.payload.result.config.enabled, true);
			const stored = JSON.parse(readFileSync(join(session.fixture.userData, "settings.json"), "utf8"));
			assert.equal(stored.securityConfig.enabled, true);
			const snapshot = JSON.parse(
				readFileSync(join(session.fixture.userData, "security-policy.json"), "utf8"),
			);
			assert.deepEqual(plain(snapshot), plain(buildSnapshot(updated.payload.result.config)));
		});

		test("security:set-session-level writes the same snapshot as buildSnapshot", async (t) => {
			const session = await start(t);
			const updated = await session.invoke("security:set-session-level", ["session-1", "strict"]);
			assert.equal(updated.payload.ok, true, JSON.stringify(updated.payload));
			assert.equal(updated.payload.result.config.sessionOverrides["session-1"], "strict");
			const snapshot = JSON.parse(
				readFileSync(join(session.fixture.userData, "security-policy.json"), "utf8"),
			);
			assert.deepEqual(plain(snapshot), plain(buildSnapshot(updated.payload.result.config)));
			assert.equal(snapshot.schemaVersion, 1);
			assert.equal(snapshot.sessionLevels["session-1"], "strict");

			const cleared = await session.invoke("security:set-session-level", ["session-1", ""]);
			assert.equal(cleared.payload.result.config.sessionOverrides["session-1"], undefined);

			const unknown = await session.invoke("security:set-session-level", ["session-1", "nope"]);
			assert.equal(unknown.payload.result.ok, false);
			assert.match(unknown.payload.result.error, /安全等级不存在/);

			const emptyId = await session.invoke("security:set-session-level", ["", "strict"]);
			assert.equal(emptyId.payload.result.ok, false);
			assert.equal(emptyId.payload.result.code, "VALIDATION_FAILED");
		});

		test("subagents settings round-trip matches the oracle's read/apply functions", async (t) => {
			const home = homeFor();
			const session = await start(t, { home });
			const initial = await session.invoke("subagents:get-settings", [PROJECT_ID]);
			assert.equal(initial.payload.ok, true, JSON.stringify(initial.payload));
			assert.deepEqual(plain(initial.payload.result), {
				global: { useOwnModel: false, preferDelegation: false },
				project: { useOwnModel: false, preferDelegation: false },
			});

			const saved = await session.invoke("subagents:save-settings", [
				"global",
				null,
				{
					useOwnModel: true,
					model: { provider: "openrouter", modelId: "anthropic/claude", thinkingLevel: "high" },
					preferDelegation: true,
				},
			]);
			assert.equal(saved.payload.ok, true, JSON.stringify(saved.payload));
			const stored = JSON.parse(readFileSync(join(home, ".pi", "agent", "settings.json"), "utf8"));
			const expected = applySubagentSettings({}, {
				useOwnModel: true,
				model: { provider: "openrouter", modelId: "anthropic/claude", thinkingLevel: "high" },
				preferDelegation: true,
			});
			assert.deepEqual(plain(stored), plain(expected));
			assert.equal(stored.subagents.defaultModel, "openrouter/anthropic/claude");
			assert.deepEqual(plain(readSubagentSettings(stored)), {
				useOwnModel: true,
				model: { provider: "openrouter", modelId: "anthropic/claude", thinkingLevel: "high" },
				preferDelegation: true,
			});

			const reread = await session.invoke("subagents:get-settings", [PROJECT_ID]);
			assert.deepEqual(plain(reread.payload.result.global), plain(readSubagentSettings(stored)));

			const invalid = await session.invoke("subagents:save-settings", [
				"global",
				null,
				{ useOwnModel: true, preferDelegation: false },
			]);
			assert.equal(invalid.payload.ok, false);
			assert.match(invalid.payload.error.message, /model is required/);

			const badScope = await session.invoke("subagents:save-settings", ["nope", null, {}]);
			assert.equal(badScope.payload.ok, false);
		});

		test("subagents settings write the project block into .pi/settings.json", async (t) => {
			const session = await start(t);
			const saved = await session.invoke("subagents:save-settings", [
				"project",
				PROJECT_ID,
				{ useOwnModel: false, preferDelegation: true },
			]);
			assert.equal(saved.payload.ok, true, JSON.stringify(saved.payload));
			const stored = JSON.parse(readFileSync(join(projectPath, ".pi", "settings.json"), "utf8"));
			assert.deepEqual(plain(stored.subagents), { preferDelegation: true });
			assert.equal(stored.theme, "dark", "unrelated project settings survive");
		});

		test("vision:get-config and vision:save-config match VisionBridgeConfigManager", async (t) => {
			const home = homeFor();
			const session = await start(t, { home });
			// The oracle resolves its config directory from the process environment.
			const previousVisionDir = process.env.PIDECK_VISION_CONFIG_DIR;
			process.env.PIDECK_VISION_CONFIG_DIR = join(home, ".pi", "agent");
			t.after(() => {
				if (previousVisionDir === undefined) delete process.env.PIDECK_VISION_CONFIG_DIR;
				else process.env.PIDECK_VISION_CONFIG_DIR = previousVisionDir;
			});
			const oracle = new VisionBridgeConfigManager({
				getModelsConfig: async () => ({ parsed: { providers: {} } }),
			});
			const actual = await session.invoke("vision:get-config");
			assert.equal(actual.payload.ok, true, JSON.stringify(actual.payload));
			const expected = await oracle.getState();
			assert.deepEqual(
				plain(normalizePaths(actual.payload.result)),
				plain(normalizePaths(expected)),
			);

			const saved = await session.invoke("vision:save-config", [
				{ provider: "openai", model: "gpt-4o-mini", maxTokens: 0, concurrency: 4 },
			]);
			assert.equal(saved.payload.ok, true, JSON.stringify(saved.payload));
			const file = JSON.parse(readFileSync(join(home, ".pi", "agent", "pi-deck-vision.json"), "utf8"));
			assert.equal(file.provider, "openai");
			assert.equal(file.model, "gpt-4o-mini");
			assert.equal(file.maxTokens, 0);
			assert.equal(file.concurrency, 4);
			assert.equal(file.timeoutMs, 120_000);
			assert.ok(file.promptTemplate.length > 0);
			assert.equal((await oracle.getConfig()).provider, file.provider);

			const rejected = await session.invoke("vision:save-config", [{ provider: "", model: "" }]);
			assert.equal(rejected.payload.ok, true, JSON.stringify(rejected.payload));
			assert.equal(rejected.payload.result.ok, false);
		});

		test("vision:get-log and vision:get-events tail the extension files", async (t) => {
			const home = homeFor();
			const session = await start(t, { home });
			const dir = join(home, ".pi", "agent");
			writeFileSync(join(dir, "pi-deck-vision.log"), "line-1\nline-2\n");
			const event = { ts: 1, kind: "input", model: "openai/gpt-4o", prompt: "p", totalDurationMs: 5, items: [] };
			writeFileSync(
				join(dir, "pi-deck-vision-events.jsonl"),
				`${JSON.stringify(event)}\n{ broken\n${JSON.stringify({ ...event, ts: 2 })}\n`,
			);
			const log = await session.invoke("vision:get-log");
			assert.equal(log.payload.result.exists, true);
			assert.equal(log.payload.result.content, "line-1\nline-2\n");
			assert.equal(log.payload.result.truncated, false);

			const events = await session.invoke("vision:get-events");
			assert.equal(events.payload.result.exists, true);
			assert.equal(events.payload.result.events.length, 2);
			assert.deepEqual(events.payload.result.events[1], { ...event, ts: 2 });

			const cleared = await session.invoke("vision:clear-log");
			assert.equal(cleared.payload.result.ok, true);
			assert.equal(existsSync(join(dir, "pi-deck-vision.log")), false);
			const clearedEvents = await session.invoke("vision:clear-events");
			assert.equal(clearedEvents.payload.result.ok, true);
			assert.equal(existsSync(join(dir, "pi-deck-vision-events.jsonl")), false);
		});

		test("config:get-* return the ConfigFileReadResult shape and decode a broken file", async (t) => {
			const home = homeFor();
			const session = await start(t, { home });
			const dir = join(home, ".pi", "agent");
			writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: {} }));
			writeFileSync(join(dir, "auth.json"), "{ broken");
			const models = await session.invoke("config:get-models");
			assert.equal(models.payload.ok, true, JSON.stringify(models.payload));
			assert.deepEqual(models.payload.result.parsed, { providers: {} });
			assert.equal(models.payload.result.diagnostic, undefined);

			const auth = await session.invoke("config:get-auth");
			assert.equal(auth.payload.ok, true);
			assert.deepEqual(auth.payload.result.parsed, {});
			assert.equal(auth.payload.result.diagnostic.fileName, "auth.json");
			assert.equal(auth.payload.result.diagnostic.docsUrl, "https://pi.dev/docs/latest/providers");
			assert.equal(auth.payload.result.diagnostic.line, 1);
			assert.ok(auth.payload.result.raw.includes("broken"));

			const missing = await session.invoke("config:get-settings");
			assert.equal(missing.payload.ok, true);
			assert.deepEqual(missing.payload.result.parsed, {});
			assert.equal(missing.payload.result.diagnostic, undefined);
		});

		test("config:save-models normalizes api aliases and rejects invalid providers", async (t) => {
			const home = homeFor();
			const session = await start(t, { home });
			const saved = await session.invoke("config:save-models", [
				{ providers: { relay: { api: "openai-chat-completions", models: [{ id: "m1" }] } } },
			]);
			assert.equal(saved.payload.ok, true, JSON.stringify(saved.payload));
			assert.deepEqual(saved.payload.result, { valid: true });
			const stored = JSON.parse(readFileSync(join(home, ".pi", "agent", "models.json"), "utf8"));
			assert.equal(stored.providers.relay.api, "openai-completions");

			const invalid = await session.invoke("config:save-models", [
				{ providers: { relay: { models: [{ name: "no-id" }] } } },
			]);
			assert.equal(invalid.payload.result.valid, false);
			assert.match(invalid.payload.result.error, /relay/);

			const oracle = new ConfigManager(join(home, ".pi", "agent"), () => "copy");
			const oracleResult = await oracle.saveModelsConfig({
				providers: { relay: { models: [{ name: "no-id" }] } },
			});
			assert.equal(oracleResult.valid, false);
		});

		test("config:save-auth and config:save-settings validate the same way as the oracle", async (t) => {
			const home = homeFor();
			const session = await start(t, { home });
			const savedAuth = await session.invoke("config:save-auth", [
				{ relay: { type: "api_key", key: "secret" } },
			]);
			assert.equal(savedAuth.payload.result.valid, true);
			const authFile = JSON.parse(readFileSync(join(home, ".pi", "agent", "auth.json"), "utf8"));
			assert.deepEqual(authFile, { relay: { type: "api_key", key: "secret" } });

			// The oracle writes auth.json verbatim (no schema validation) and reports success.
			const verbatim = await session.invoke("config:save-auth", [{ relay: "nope" }]);
			assert.equal(verbatim.payload.result.valid, true);
			assert.deepEqual(
				JSON.parse(readFileSync(join(home, ".pi", "agent", "auth.json"), "utf8")),
				{ relay: "nope" },
			);

			const savedSettings = await session.invoke("config:save-settings", [{ theme: "dark" }]);
			assert.equal(savedSettings.payload.result.valid, true);
			const settingsFile = JSON.parse(
				readFileSync(join(home, ".pi", "agent", "settings.json"), "utf8"),
			);
			assert.equal(settingsFile.theme, "dark");
		});

		test("config:save-raw only accepts the four known files and valid JSON", async (t) => {
			const home = homeFor();
			const session = await start(t, { home });
			const badJson = await session.invoke("config:save-raw", ["settings.json", "{ nope"]);
			assert.equal(badJson.payload.result.valid, false);
			assert.match(badJson.payload.result.error, /JSON/);

			const badName = await session.invoke("config:save-raw", ["other.json", "{}"]);
			assert.equal(badName.payload.result.valid, false);
			assert.match(badName.payload.result.error, /other\.json/);

			const ok = await session.invoke("config:save-raw", ["trust.json", '{"C:\\\\x":true}']);
			assert.equal(ok.payload.result.valid, true);
			assert.equal(
				readFileSync(join(home, ".pi", "agent", "trust.json"), "utf8"),
				'{"C:\\\\x":true}',
			);
		});

		test("config:export and config:import round-trip the three files", async (t) => {
			const home = homeFor();
			const session = await start(t, { home });
			const dir = join(home, ".pi", "agent");
			writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { p: { models: [{ id: "a" }] } } }));
			writeFileSync(join(dir, "auth.json"), JSON.stringify({ p: { type: "api_key", key: "k" } }));
			const exported = await session.invoke("config:export");
			assert.equal(exported.payload.ok, true, JSON.stringify(exported.payload));
			const pkg = JSON.parse(exported.payload.result);
			assert.equal(pkg.version, 1);
			assert.match(pkg.exportedAt, /^\d{4}-\d{2}-\d{2}T/);
			assert.deepEqual(pkg.files["models.json"], { providers: { p: { models: [{ id: "a" }] } } });
			assert.deepEqual(pkg.files["auth.json"], { p: { type: "api_key", key: "k" } });

			rmSync(join(dir, "models.json"));
			const imported = await session.invoke("config:import", [exported.payload.result]);
			assert.equal(imported.payload.result.valid, true);
			assert.deepEqual(
				JSON.parse(readFileSync(join(dir, "models.json"), "utf8")),
				{ providers: { p: { models: [{ id: "a" }] } } },
			);

			const missingFiles = await session.invoke("config:import", ['{"version":1}']);
			assert.equal(missingFiles.payload.result.valid, false);
			assert.match(missingFiles.payload.result.error, /files/);
		});

		test("config:fetch-models and config:test-provider talk to a real HTTP endpoint", async (t) => {
			const requests = [];
			const server = createServer((request, response) => {
				const chunks = [];
				request.on("data", (chunk) => chunks.push(chunk));
				request.on("end", () => {
					requests.push({
						url: request.url,
						headers: request.headers,
						body: Buffer.concat(chunks).toString("utf8"),
					});
					response.setHeader("content-type", "application/json");
					if (request.url.endsWith("/models")) {
						response.end(JSON.stringify({ data: [{ id: "mock-1" }, { id: "mock-2" }] }));
						return;
					}
					response.end(
						JSON.stringify({
							model: "mock-1",
							choices: [{ message: { content: "Hi there" } }],
							usage: { prompt_tokens: 3, completion_tokens: 2 },
						}),
					);
				});
			});
			await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
			const port = server.address().port;
			t.after(() => server.close());

			const session = await start(t);
			const fetched = await session.invoke("config:fetch-models", [
				{ baseUrl: `http://127.0.0.1:${port}`, apiKey: "secret-key", apiType: "openai-completions" },
			]);
			assert.equal(fetched.payload.ok, true, JSON.stringify(fetched.payload));
			assert.equal(fetched.payload.result.success, true);
			assert.deepEqual(fetched.payload.result.models, [
				{ id: "mock-1", name: "mock-1" },
				{ id: "mock-2", name: "mock-2" },
			]);
			// The probe appends /v1 and the key never appears in a returned URL.
			assert.match(requests[0].url, /^\/v1\/models$/);
			assert.ok(!fetched.payload.result.requestUrl.includes("secret-key"));
			assert.equal(requests[0].headers.authorization, "Bearer secret-key");

			const tested = await session.invoke("config:test-provider", [
				{
					baseUrl: `http://127.0.0.1:${port}`,
					apiKey: "secret-key",
					modelId: "mock-1",
					apiType: "openai-completions",
				},
			]);
			assert.equal(tested.payload.ok, true, JSON.stringify(tested.payload));
			assert.equal(tested.payload.result.success, true);
			assert.equal(tested.payload.result.snippet, "Hi there");
			assert.deepEqual(tested.payload.result.tokens, { input: 3, output: 2 });
			assert.match(requests.at(-1).url, /^\/v1\/chat\/completions$/);
			assert.ok(!tested.payload.result.requestBody.includes("secret-key"));

			const failing = await session.invoke("config:test-provider", [
				{ baseUrl: "http://127.0.0.1:1", apiKey: "k", modelId: "m", apiType: "openai-completions" },
			]);
			assert.equal(failing.payload.ok, true, JSON.stringify(failing.payload));
			assert.equal(failing.payload.result.success, false);
			assert.ok(failing.payload.result.error.length > 0);
		});

		test("scratch-pad drafts match the oracle's file naming and load/save contract", async (t) => {
			const session = await start(t);
			const created = await session.invoke("scratch-pad:create");
			assert.equal(created.payload.ok, true, JSON.stringify(created.payload));
			const draft = created.payload.result;
			assert.match(draft.name, /^\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}$/);
			assert.ok(existsSync(draft.path));
			assert.equal(draft.id, draft.name);

			const saved = await session.invoke("scratch-pad:save", [draft.path, "# hello\n"]);
			assert.equal(saved.payload.ok, true, JSON.stringify(saved.payload));
			assert.equal(readFileSync(draft.path, "utf8"), "# hello\n");

			const loaded = await session.invoke("scratch-pad:load", [draft.path]);
			assert.equal(loaded.payload.result.content, "# hello\n");
			assert.ok(loaded.payload.result.lastEditedAt > 0);
			assert.equal(loaded.payload.result.cursorPosition, 0);

			const empty = await session.invoke("scratch-pad:load", [""]);
			assert.deepEqual(empty.payload.result, { content: "", lastEditedAt: 0, cursorPosition: 0 });

			const list = await session.invoke("scratch-pad:list");
			assert.ok(list.payload.result.some((entry) => entry.path === draft.path));

			const removed = await session.invoke("scratch-pad:delete", [draft.path]);
			assert.equal(removed.payload.ok, true, JSON.stringify(removed.payload));
			assert.deepEqual(session.trashCalls, [draft.path]);
			assert.ok(existsSync(draft.path), "the harness trash recorder must not delete the file");
		});

		test("projects:get-model-spec matches the bundled model-specs index", async (t) => {
			const session = await start(t);
			const { DatabaseSync } = await import("node:sqlite").catch(() => ({ DatabaseSync: null }));
			if (!DatabaseSync) return t.skip("node:sqlite is unavailable");
			const db = new DatabaseSync(resolve("resources/model-specs.db"));
			const rows = db
				.prepare(
					"SELECT source, provider, id, context_window, max_tokens, reasoning, tool_call, attachment, input_modalities FROM model_specs",
				)
				.all()
				.map((row) => ({
					source: row.source,
					provider: row.provider,
					id: row.id,
					contextWindow: row.context_window,
					maxTokens: row.max_tokens,
					reasoning: row.reasoning,
					toolCall: row.tool_call,
					attachment: row.attachment,
					inputModalities: row.input_modalities,
				}));
			db.close();
			const { openrouter, modelsDev } = entriesFromRows(rows);
			const index = buildSpecIndex(openrouter, modelsDev);
			const sample = rows.find((row) => row.source === "openrouter");
			assert.ok(sample, "the bundled database must contain OpenRouter rows");
			const expected = lookupModelSpec(index, "relay", sample.id);
			const actual = await session.invoke("projects:get-model-spec", ["relay", sample.id]);
			assert.equal(actual.payload.ok, true, JSON.stringify(actual.payload));
			assert.deepEqual(plain(actual.payload.result), plain(expected ?? null));

			// An unknown model resolves to null instead of an empty object.
			const unknown = await session.invoke("projects:get-model-spec", ["relay", "definitely-not-a-model"]);
			assert.equal(unknown.payload.ok, true);
			assert.equal(unknown.payload.result, null);
		});
	});
} else {
	describe("native2 projects / settings / config parity", () => {
		test("requires a built PiDeckBackend.exe", () => {
			assert.fail(
				"PiDeckBackend.exe is missing. Build it with `xmake build -y PiDeckBackend` before running the parity suite.",
			);
		});
	});
}
