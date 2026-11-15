import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";

import { createBackendFixture, resolveBackendExecutable, startBackendSession } from "./helpers/native2BackendHarness.mjs";
import { git } from "./helpers/native2GitFixture.mjs";
import { listWebNetworkAddresses } from "../src/main/web/WebNetwork.ts";

/**
 * Tail-channel parity: the handler surface that no earlier suite drove.
 *
 * Three groups are covered here because they share one property — a handler that is
 * "registered" but wrong is invisible until a user clicks it:
 *
 *  1. window/app commands that only the Qt host can perform (`native/src/main.cpp` is the
 *     golden for the host method names and parameter shapes);
 *  2. leaf commands that hand a path to the host (`shell.openPath`, `shell.showItemInFolder`,
 *     `dialog.open`, `dialog.save`) plus the workspace-boundary check in front of them;
 *  3. the scratch-pad domain, which until now had two registration sites: the registry
 *     resolves async handlers first and keeps the newest sync handler, so the two copies
 *     silently alternated. It must be one owner now.
 *
 * Everything runs against the real `PiDeckBackend.exe` over the real host bridge and the
 * real loopback RPC. No pi is spawned, so the suite stays hermetic.
 */

const executable = resolveBackendExecutable();
const slash = (value) => String(value).replaceAll("\\", "/");

if (!executable) {
	describe("native2 tail channel parity", () => {
		test("backend executable is available", () => {
			assert.fail("PiDeckBackend.exe was not built; run xmake build -y PiDeckBackend");
		});
	});
} else {
	describe("native2 tail channel parity", () => {
		let root;
		let projectPath;
		let home;

		before(() => {
			root = mkdtempSync(join(tmpdir(), "pideck-native2-tail-"));
			projectPath = join(root, "project");
			mkdirSync(join(projectPath, "src"), { recursive: true });
			writeFileSync(join(projectPath, "README.md"), "# tail\n");
			writeFileSync(join(projectPath, "src/app.ts"), "export const ok = true;\n");
			// Skills live under the pi agent directory, which is resolved from the home the
			// host injects. A test must never read (or create) the developer's real skills.
			home = join(root, "home");
			mkdirSync(join(home, ".pi", "agent", "skills"), { recursive: true });
			mkdirSync(join(home, ".agents", "skills"), { recursive: true });
		});

		after(() => {
			if (root) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		});

		/** Boot a backend whose host answers `methods` with a traceable sentinel. */
		const start = async (t, { prepare = null, extraHandlers = null } = {}) => {
			const calls = [];
			const methods = [
				"window.minimize",
				"window.close",
				"window.toggleMaximize",
				"window.isMaximized",
				"window.toggleAlwaysOnTop",
				"window.beginSystemMove",
				"window.beginSystemResize",
				"window.toggleDevTools",
				"application.restart",
				"shell.openPath",
				"shell.showItemInFolder",
				"dialog.open",
				"dialog.save",
			];
			const hostHandlers = {};
			for (const method of methods) {
				hostHandlers[method] = (params) => {
					calls.push({ method, params });
					// `extraHandlers` only supplies a result; the call is still traced so a test
					// can assert the parameter shape of an overridden method.
					const override = extraHandlers?.[method];
					if (override) return override(params);
					// A distinct result per method proves the handler passes the host answer
					// through instead of inventing one. `shell.openPath` additionally needs the host's
					// real `{ok, error}` shape: the editor fallback only reports success when the OS
					// handler did, exactly like the oracle (`EditorDetector.openProjectInEditor`).
					return method === "shell.openPath" ? { result: { ok: true, from: method } } : { result: { from: method } };
				};
			}
			const session = await startBackendSession(t, {
				projects: [{ id: "tail", path: projectPath }],
				settings: { language: "en-US" },
				// Skills are resolved from the agent directory under this home.
				env: { PIDECK_HOME: home, PIDECK_HOST_HOME: home },
				hostHandlers,
				prepare,
			});
			const seen = (method) => calls.filter((call) => call.method === method);
			return { ...session, calls, seen };
		};

		test("window and app commands reach the Qt host with the host's own method names", async (t) => {
			const session = await start(t);

			// Commands the host performs and whose result the caller never observes: the
			// channel answers `null` so the renderer cannot read a boolean it must not trust.
			assert.deepEqual((await session.invoke("app:window-minimize")).payload, { ok: true, result: null });
			assert.deepEqual((await session.invoke("app:window-close")).payload, { ok: true, result: null });
			assert.deepEqual((await session.invoke("app:begin-window-drag")).payload, { ok: true, result: null });
			assert.deepEqual((await session.invoke("app:toggle-devtools")).payload, { ok: true, result: null });
			assert.deepEqual((await session.invoke("app:restart")).payload, { ok: true, result: null });

			// A resize carries the edge the renderer reports.
			assert.deepEqual((await session.invoke("app:begin-window-resize", ["left"])).payload, {
				ok: true,
				result: null,
			});

			// Toggle/query commands hand the host answer back verbatim.
			assert.deepEqual((await session.invoke("app:window-toggle-always-on-top")).payload, {
				ok: true,
				result: { from: "window.toggleAlwaysOnTop" },
			});
			assert.deepEqual((await session.invoke("app:window-toggle-maximize")).payload, {
				ok: true,
				result: { from: "window.toggleMaximize" },
			});
			assert.deepEqual((await session.invoke("app:window-is-maximized")).payload, {
				ok: true,
				result: { from: "window.isMaximized" },
			});

			assert.deepEqual(session.seen("window.minimize"), [{ method: "window.minimize", params: {} }]);
			assert.deepEqual(session.seen("window.close"), [{ method: "window.close", params: {} }]);
			assert.deepEqual(session.seen("window.beginSystemMove"), [
				{ method: "window.beginSystemMove", params: {} },
			]);
			assert.deepEqual(session.seen("window.beginSystemResize"), [
				{ method: "window.beginSystemResize", params: { edge: "left" } },
			]);
			assert.deepEqual(session.seen("window.toggleDevTools"), [
				{ method: "window.toggleDevTools", params: {} },
			]);
			assert.deepEqual(session.seen("application.restart"), [
				{ method: "application.restart", params: {} },
			]);
		});

		test("leaf commands hand the resolved path to the host, and the workspace boundary still applies", async (t) => {
			const session = await start(t);
			const file = join(projectPath, "src/app.ts");

			assert.deepEqual((await session.invoke("files:open", [file])).payload, { ok: true, result: null });
			assert.equal(slash(session.seen("shell.openPath").at(-1).params.path), slash(resolve(file)));

			assert.deepEqual((await session.invoke("files:show-in-folder", [file])).payload, {
				ok: true,
				result: null,
			});
			assert.equal(slash(session.seen("shell.showItemInFolder").at(-1).params.path), slash(resolve(file)));

			// `prompts:open-folder` opens the managed prompts root, not a caller path.
			assert.equal((await session.invoke("prompts:open-folder")).payload.ok, true);
			const promptsOpen = session.seen("shell.openPath").at(-1);
			assert.equal(slash(promptsOpen.params.path), slash(session.fixture.prompts));

			// `skills:open-folder` opens the managed skills root for the same reason.
			assert.equal((await session.invoke("skills:open-folder", [])).payload.ok, true);
			const skillsOpen = session.seen("shell.openPath").at(-1);
			assert.equal(slash(skillsOpen.params.path), slash(join(home, ".pi", "agent", "skills")));

			// `editors:open-project` spawns the configured editor and falls back to the OS
			// handler when it cannot start. The fallback is asserted here because starting a
			// real GUI editor is not hermetic; the argv mapping is covered by the editor tests.
			const unstartable = await session.invoke("editors:open-project", [
				{ id: "missing", command: "definitely-not-an-editor-pideck", args: ["{path}"] },
				projectPath,
			]);
			assert.deepEqual(unstartable.payload, { ok: true, result: null });
			assert.equal(slash(session.seen("shell.openPath").at(-1).params.path), slash(resolve(projectPath)));

			// `files:copy-internal` copies inside the workspace and never overwrites: the
			// second copy gets a free name.
			const destination = join(projectPath, "copies");
			mkdirSync(destination, { recursive: true });
			const firstCopy = await session.invoke("files:copy-internal", [[file], destination]);
			assert.equal(firstCopy.payload.ok, true, JSON.stringify(firstCopy.payload));
			assert.equal(firstCopy.payload.result.length, 1);
			const secondCopy = await session.invoke("files:copy", [[file], destination]);
			assert.equal(secondCopy.payload.ok, true, JSON.stringify(secondCopy.payload));
			assert.equal(readFileSync(join(destination, "app.ts"), "utf8"), "export const ok = true;\n");
			assert.equal(existsSync(join(destination, "app (1).ts")), true);

			// The default call selects files with multi-select.
			await session.invoke("dialog:pick-files", [{}]);
			assert.deepEqual(session.seen("dialog.open").at(-1), {
				method: "dialog.open",
				params: { properties: ["openFile", "multiSelections"], parent: "none" },
			});
			// Directory mode is an explicit property, never a mixed picker.
			await session.invoke("dialog:pick-files", [{ title: "Pick a folder", includeDirectories: true }]);
			assert.deepEqual(session.seen("dialog.open").at(-1), {
				method: "dialog.open",
				params: {
					title: "Pick a folder",
					properties: ["openDirectory"],
					parent: "none",
				},
			});
			// The image picker constrains the extensions the vision bridge can read.
			await session.invoke("dialog:pick-images", [{}]);
			assert.deepEqual(session.seen("dialog.open").at(-1), {
				method: "dialog.open",
				params: {
					properties: ["openFile", "multiSelections"],
					filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }],
					parent: "none",
				},
			});

			// A path outside every authorized root is refused before the host is told to open
			// it: `shell.openPath` executes the file association, so this is the boundary.
			const outside = join(root, "outside.txt");
			writeFileSync(outside, "nope\n");
			const before = session.seen("shell.openPath").length;
			const denied = await session.invoke("files:open", [outside]);
			assert.equal(denied.payload.ok, false);
			assert.equal(session.seen("shell.openPath").length, before);
		});

		test("the scratch pad has one owner: migration, CRUD, recycle bin and export dialog", async (t) => {
			const legacyBody = "# legacy pad\nstill here\n";
			const session = await start(t, {
				prepare: (fixture) => {
					// The pre-drafts single file the oracle migrates on first access.
					writeFileSync(join(fixture.userData, "scratch-pad.md"), legacyBody);
				},
			});
			const drafts = join(session.fixture.userData, "drafts");

			// 1. Listing migrates the legacy file into a dated draft and removes it.
			const listed = await session.invoke("scratch-pad:list");
			assert.equal(listed.payload.ok, true, JSON.stringify(listed.payload));
			const migrated = listed.payload.result.filter((draft) => slash(draft.path).startsWith(slash(drafts)));
			assert.equal(migrated.length, 1, JSON.stringify(listed.payload.result));
			assert.deepEqual(migrated.map((draft) => draft.name), migrated.map((draft) => draft.id));
			assert.equal(existsSync(join(session.fixture.userData, "scratch-pad.md")), false);
			assert.equal(readFileSync(migrated[0].path, "utf8"), legacyBody);

			// 2. Create returns the full metadata object the panel renders.
			const created = await session.invoke("scratch-pad:create");
			assert.equal(created.payload.ok, true);
			const draft = created.payload.result;
			assert.deepEqual(Object.keys(draft).sort(), ["createdAt", "id", "name", "path", "updatedAt"]);
			assert.equal(slash(draft.path).startsWith(slash(drafts)), true, draft.path);
			assert.equal(existsSync(draft.path), true);

			// 3. Save then load round-trips the body; load reports the file mtime.
			assert.deepEqual((await session.invoke("scratch-pad:save", [draft.path, "# hello\nworld\n"])).payload, {
				ok: true,
				result: null,
			});
			const loaded = await session.invoke("scratch-pad:load", [draft.path]);
			assert.deepEqual(Object.keys(loaded.payload.result).sort(), ["content", "cursorPosition", "lastEditedAt"]);
			assert.equal(loaded.payload.result.content, "# hello\nworld\n");
			assert.equal(loaded.payload.result.cursorPosition, 0);
			assert.ok(loaded.payload.result.lastEditedAt > 0);

			// An unknown draft is empty, not an error.
			assert.deepEqual((await session.invoke("scratch-pad:load", [join(drafts, "missing.md")])).payload, {
				ok: true,
				result: { content: "", cursorPosition: 0, lastEditedAt: 0 },
			});
			assert.deepEqual((await session.invoke("scratch-pad:load", [])).payload, {
				ok: true,
				result: { content: "", cursorPosition: 0, lastEditedAt: 0 },
			});

			// 4. The list is newest-first, so the just-saved draft leads.
			const afterSave = await session.invoke("scratch-pad:list");
			assert.equal(afterSave.payload.result[0].path, draft.path);

			// 5. Deletion goes through the host recycle bin, never a hard unlink.
			const deleted = await session.invoke("scratch-pad:delete", [draft.path]);
			assert.deepEqual(deleted.payload, { ok: true, result: null });
			assert.deepEqual(session.trashCalls, [draft.path]);

			// 6. A draft outside the drafts directory is refused for every mutating channel:
			//    the renderer only ever passes paths this backend produced.
			const escape = join(session.fixture.userData, "settings.json");
			for (const channel of ["scratch-pad:save", "scratch-pad:delete"]) {
				const response = await session.invoke(channel, [escape, "overwritten"]);
				assert.equal(response.payload.ok, false, channel);
				assert.match(
					JSON.stringify(response.payload.error),
					/outside the drafts directory/,
					channel,
				);
			}
			assert.equal(JSON.parse(readFileSync(escape, "utf8")).language, "en-US");

			// 7. Export asks the host for a destination and copies the bytes there.
			const exportDraft = await session.invoke("scratch-pad:create");
			await session.invoke("scratch-pad:save", [exportDraft.payload.result.path, "exported body\n"]);
			const target = join(root, "exported.md");
			const withDialog = await start(t, {
				extraHandlers: {
					"dialog.save": (params) => {
						return { result: { canceled: false, filePath: target } };
					},
				},
				prepare: (fixture) => {
					mkdirSync(join(fixture.userData, "drafts"), { recursive: true });
					writeFileSync(join(fixture.userData, "drafts/draft-a.md"), "exported body\n");
				},
			});
			const exported = await withDialog.invoke("scratch-pad:export", [
				join(withDialog.fixture.userData, "drafts/draft-a.md"),
			]);
			assert.deepEqual(exported.payload, { ok: true, result: true });
			const dialogCall = withDialog.seen("dialog.save").at(-1);
			assert.deepEqual(dialogCall, {
				method: "dialog.save",
				params: {
					defaultPath: "draft-a.md",
					filters: [{ name: "Markdown", extensions: ["md"] }],
				},
			});
			assert.equal(readFileSync(target, "utf8"), "exported body\n");

			// A cancelled dialog is `false`, not an error, and writes nothing.
			const cancelled = await start(t, {
				prepare: (fixture) => {
					mkdirSync(join(fixture.userData, "drafts"), { recursive: true });
					writeFileSync(join(fixture.userData, "drafts/draft-b.md"), "x\n");
				},
			});
			assert.deepEqual(
				(await cancelled.invoke("scratch-pad:export", [join(cancelled.fixture.userData, "drafts/draft-b.md")]))
					.payload,
				{ ok: true, result: false },
			);
		});

		test("project roots, worktrees, session listing, focus and system info answer like the oracle", async (t) => {
			const repo = join(root, "repo");
			mkdirSync(repo, { recursive: true });
			writeFileSync(join(repo, "README.md"), "# repo\n");
			git(repo, ["init", "-q"]);
			git(repo, ["add", "."]);
			git(repo, ["-c", "user.name=T", "-c", "user.email=t@t", "commit", "-q", "-m", "init"]);
			const worktree = join(root, "repo-worktree");
			git(repo, ["worktree", "add", "-q", worktree, "-b", "wt"]);

			const plain = join(root, "plain");
			mkdirSync(plain, { recursive: true });
			const pendingAdds = [repo, plain];
			const session = await start(t, {
				extraHandlers: {
					// `projects:add` asks the host for a folder instead of taking a path.
					"dialog.open": () => ({ result: { canceled: false, filePaths: [pendingAdds.shift()] } }),
				},
			});
			// Register the repository as a second project so the worktree paths line up.
			const added = await session.invoke("projects:add");
			assert.equal(added.payload.ok, true, JSON.stringify(added.payload));
			const repoProject = added.payload.result;
			assert.equal(slash(repoProject.path), slash(resolve(repo)));

			// `projects:list-root` is the sidebar's top level: worktrees are children, not roots.
			const roots = await session.invoke("projects:list-root");
			assert.equal(roots.payload.ok, true);
			assert.ok(Array.isArray(roots.payload.result));
			assert.ok(roots.payload.result.some((project) => project.id === repoProject.id));
			for (const project of roots.payload.result) {
				assert.equal(project.worktreeParentId ?? "", "", JSON.stringify(project));
			}

			// Enabling workspace mode on a real repository registers its existing worktrees.
			const toggled = await session.invoke("projects:toggle-worktree-enabled", [repoProject.id]);
			assert.equal(toggled.payload.ok, true, JSON.stringify(toggled.payload));
			assert.equal(toggled.payload.result.worktreeEnabled, true);
			const projects = await session.invoke("projects:list");
			const registered = projects.payload.result.find(
				(project) => slash(project.path) === slash(resolve(worktree)),
			);
			assert.ok(registered, JSON.stringify(projects.payload.result.map((project) => project.path)));

			const children = await session.invoke("projects:list-worktree-children", [repoProject.id]);
			assert.equal(children.payload.ok, true);
			assert.deepEqual(
				children.payload.result.map((entry) => slash(entry.path ?? entry)),
				[slash(resolve(worktree))],
			);

			// A directory that is not a repository is refused before any git work happens.
			const plainAdded = await session.invoke("projects:add");
			assert.equal(plainAdded.payload.ok, true, JSON.stringify(plainAdded.payload));
			const plainProject = plainAdded.payload.result;
			assert.equal(slash(plainProject.path), slash(resolve(plain)));
			const refused = await session.invoke("projects:toggle-worktree-enabled", [plainProject.id]);
			assert.equal(refused.payload.ok, false);
			assert.match(JSON.stringify(refused.payload.error), /NOT_A_GIT_REPO/);

			// `sessions:list` is the scanner view of one project (no catalog needed).
			const sessions = await session.invoke("sessions:list", [repoProject.id]);
			assert.equal(sessions.payload.ok, true);
			assert.ok(Array.isArray(sessions.payload.result));

			// Focus reporting is fire-and-forget and must not reject on an unknown session.
			assert.deepEqual((await session.invoke("sessions:set-focused-session", ["not-a-session"])).payload, {
				ok: true,
				result: null,
			});

			// Trust config is the `{raw, parsed}` pair the settings editor renders.
			const trust = await session.invoke("config:get-trust");
			assert.equal(trust.payload.ok, true);
			assert.deepEqual(Object.keys(trust.payload.result).sort(), ["parsed", "raw"]);
			assert.equal(typeof trust.payload.result.raw, "string");
			assert.equal(typeof trust.payload.result.parsed, "object");
			// An unknown request id or an out-of-range choice is a boundary error.
			assert.equal((await session.invoke("projects:trust-response", ["", "trust-remember"])).payload.ok, false);
			assert.equal(
				(await session.invoke("projects:trust-response", ["req-1", "allow-everything"])).payload.ok,
				false,
			);

			// System info: LAN addresses are `{address, interfaceName, cidr, isPrivate}` rows the
			// settings page/QR code render, ordered private-first like the oracle.
			const addresses = await session.invoke("app:network-addresses");
			assert.equal(addresses.payload.ok, true);
			assert.ok(Array.isArray(addresses.payload.result));
			for (const entry of addresses.payload.result) {
				assert.deepEqual(Object.keys(entry).sort(), ["address", "cidr", "interfaceName", "isPrivate"]);
				assert.match(entry.address, /^\d+\.\d+\.\d+\.\d+$/, JSON.stringify(entry));
				assert.equal(typeof entry.interfaceName, "string");
				assert.equal(typeof entry.isPrivate, "boolean");
				assert.ok(entry.cidr === null || /^\d+\.\d+\.\d+\.\d+\/\d+$/.test(entry.cidr), entry.cidr);
			}
			// A phone can only reach a private LAN address, so private rows come first, and
			// addresses inside one privacy group follow the oracle's numeric-aware order.
			// Classification is compared against the real oracle (`WebNetwork.ts`), not against
			// the backend's own flags: 169.254/16 is link-local and must NOT be "private",
			// otherwise the QR code targets an unreachable host.
			const oraclePrivate = (address) => listWebNetworkAddresses({
				eth: [{ address, internal: false, cidr: null }],
			})[0]?.isPrivate;
			for (const entry of addresses.payload.result) {
				assert.equal(
					entry.isPrivate,
					oraclePrivate(entry.address),
					`${entry.address} private classification must match the oracle`,
				);
			}
			const oracleOrdered = [...addresses.payload.result]
				.sort((left, right) => (left.isPrivate !== right.isPrivate
					? (left.isPrivate ? -1 : 1)
					: left.address.localeCompare(right.address, undefined, { numeric: true })))
				.map((entry) => entry.address);
			assert.deepEqual(
				addresses.payload.result.map((entry) => entry.address),
				oracleOrdered,
				JSON.stringify(addresses.payload.result),
			);
			const firstPublic = addresses.payload.result.findIndex((entry) => !entry.isPrivate);
			if (firstPublic >= 0) {
				assert.equal(
					addresses.payload.result.slice(firstPublic).every((entry) => !entry.isPrivate),
					true,
					JSON.stringify(addresses.payload.result),
				);
			}
			const numeric = (left, right) =>
				left.localeCompare(right, undefined, { numeric: true, sensitivity: "variant" });
			const seenOrder = addresses.payload.result.map((entry) => entry.address);
			const reordered = [...seenOrder].sort((left, right) => {
				const leftPrivate = addresses.payload.result.find((entry) => entry.address === left).isPrivate;
				const rightPrivate = addresses.payload.result.find((entry) => entry.address === right).isPrivate;
				if (leftPrivate !== rightPrivate) return leftPrivate ? -1 : 1;
				return numeric(left, right);
			});
			assert.deepEqual(seenOrder, reordered, JSON.stringify(addresses.payload.result));
			const languages = await session.invoke("app:preferred-system-languages");
			assert.equal(languages.payload.ok, true);
			assert.ok(Array.isArray(languages.payload.result));
			for (const language of languages.payload.result) assert.equal(typeof language, "string");
		});
	});
}
