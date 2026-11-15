import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveBackendExecutable, startBackendSession } from "./helpers/native2BackendHarness.mjs";
import { createStatusRepo, git } from "./helpers/native2GitFixture.mjs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * G1: Windows project alias paths (junction / 8.3 spelling) at the Git mutation boundary.
 *
 * The Node oracle keeps the ProjectStore spelling in status rows (`inputProjectRoot`)
 * while the authorization boundary is the canonical root (`realpath`), and its
 * `resolveMutationPaths` canonicalizes every existing Windows request with
 * `realpathSync.native` before matching. The C++ port used `QDir::cleanPath` only, so an
 * existing alias-spelled request never compared equal to the canonical project root:
 * a stale row (externally staged/unstaged in the meantime) was reported as
 * "Git resource is outside the project" instead of being skipped like Node does.
 *
 * Fixtures are throwaway repositories under the OS temp directory plus a non-elevated
 * Windows junction alias of the same tree. The real checkout is never touched.
 */

const executable = resolveBackendExecutable();
const requireBackend = process.env.PIDECK_REQUIRE_BACKEND_TESTS === "1";
const { GitService } = loadTsCommonJs("src/main/git/GitService.ts");
const oracle = new GitService();
const onWindows = process.platform === "win32";

function normalize(value) {
	// JSON round-trip first: the oracle runs in a VM context, so its objects have a
	// different Object.prototype identity and `deepStrictEqual` would reject them.
	return normalizePaths(JSON.parse(JSON.stringify(value ?? null)));
}

function normalizePaths(value) {
	if (typeof value === "string") {
		// Only absolute Windows path strings are compared; file contents keep backslashes.
		return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\") ? value.replaceAll("\\", "/") : value;
	}
	if (Array.isArray(value)) return value.map(normalizePaths);
	if (value && typeof value === "object") {
		const result = {};
		for (const [key, entry] of Object.entries(value)) result[key] = normalizePaths(entry);
		return result;
	}
	return value;
}

/** Throwaway status repository plus a privilege-free junction alias of the same tree. */
function createAliasRepos() {
	const root = mkdtempSync(join(tmpdir(), "pideck-native2-git-alias-"));
	const real = createStatusRepo(join(root, "repos", "status-repo"));
	const alias = join(root, "status-alias");
	symlinkSync(real, alias, "junction");
	writeFileSync(join(root, "sibling.txt"), "sibling\n");
	// A genuine sibling whose name starts with the alias name, used to prove the
	// boundary compares real path components and not a raw string prefix.
	const siblingDir = join(root, "status-alias-sibling");
	mkdirSync(siblingDir, { recursive: true });
	writeFileSync(join(siblingDir, "note.txt"), "sibling\n");
	return { root, real, alias, siblingDir };
}

/**
 * The alias must be a real junction, not a same-name copy: `realpathSync.native` is the
 * same API the Node oracle uses, so this also pins the fixture against a Developer-Mode
 * style symlink that would not exercise junction expansion.
 */
function assertAliasIsJunction(alias, real) {
	const expandedAlias = normalize(realpathSync.native(alias)).toLowerCase();
	const expandedReal = normalize(realpathSync.native(real)).toLowerCase();
	assert.equal(expandedAlias, expandedReal, "junction must resolve to the real project root");
	assert.notEqual(expandedAlias, normalize(alias).toLowerCase(), "the fixture must be an alias, not the real path");
}

async function start(t, { id, projectPath }) {
	const repos = createAliasRepos();
	const session = await startBackendSession(t, { projects: [{ id, path: projectPath(repos) }] });
	// Registered after the backend cleanup so its process is gone before the tree is deleted.
	t.after(() => rmSync(repos.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
	return { ...session, ...repos, id };
}

function statusPorcelain(repo) {
	return git(repo, ["status", "--porcelain"]);
}

if (onWindows) {
	test("git:status keeps alias rows for a junction project while the boundary is canonical", async (t) => {
		const { invoke, alias, real, id } = await start(t, { id: "alias", projectPath: (r) => r.alias });
		assertAliasIsJunction(alias, real);

		const expected = normalize(await oracle.getStatus(alias));
		const actual = await invoke("git:status", [id]);
		assert.equal(actual.payload.ok, true, JSON.stringify(actual.payload));
		assert.deepEqual(normalize(actual.payload.result), expected);

		// The wire keeps the ProjectStore (alias) spelling, exactly like the oracle.
		const tracked = actual.payload.result.workingTree.find((entry) => /tracked\.txt$/.test(entry.path));
		assert.ok(tracked, "the junction project must report its working-tree rows");
		const aliasPrefix = `${normalize(alias).toLowerCase()}/`;
		assert.ok(
			normalize(tracked.path).toLowerCase().startsWith(aliasPrefix),
			`status rows must keep the alias representation, got ${tracked.path}`,
		);
	});

	test("git:stage skips a stale row whose existing alias spelling is inside the project", async (t) => {
		const { invoke, alias, real, id } = await start(t, { id: "real", projectPath: (r) => r.real });
		assertAliasIsJunction(alias, real);
		const aliasPath = normalize(join(alias, "tracked.txt"));

		// Renderer snapshot, then an external tool stages the file: the renderer's row is
		// now stale because tracked.txt moved from the workingTree to the index group.
		const snapshot = await oracle.getStatus(real);
		assert.ok(snapshot.workingTree.some((entry) => /tracked\.txt$/.test(entry.path)));
		git(real, ["add", "--", "tracked.txt"]);
		const before = statusPorcelain(real);
		assert.match(before, /^M  tracked\.txt$/m);

		// The oracle expands the alias spelling and silently skips the stale request.
		await oracle.stageFiles(real, [aliasPath]);
		assert.equal(statusPorcelain(real), before, "the oracle must skip, not stage, the stale row");

		const result = await invoke("git:stage", [id, [aliasPath]]);
		assert.equal(result.payload.ok, true, JSON.stringify(result.payload));
		assert.equal(statusPorcelain(real), before, "a stale alias row must be a no-op, not an outside error");
	});

	test("git:unstage skips a stale row whose existing alias spelling is inside the project", async (t) => {
		const { invoke, alias, real, id } = await start(t, { id: "real", projectPath: (r) => r.real });
		assertAliasIsJunction(alias, real);
		const aliasPath = normalize(join(alias, "staged-new.txt"));

		const snapshot = await oracle.getStatus(real);
		assert.ok(snapshot.index.some((entry) => /staged-new\.txt$/.test(entry.path)));
		git(real, ["restore", "--staged", "--", "staged-new.txt"]);
		const before = statusPorcelain(real);
		assert.match(before, /^\?\? staged-new\.txt$/m);

		await oracle.unstageFiles(real, [aliasPath]);
		assert.equal(statusPorcelain(real), before, "the oracle must skip, not unstage, the stale row");

		const result = await invoke("git:unstage", [id, [aliasPath]]);
		assert.equal(result.payload.ok, true, JSON.stringify(result.payload));
		assert.equal(statusPorcelain(real), before, "a stale alias row must be a no-op, not an outside error");
	});

	test("git:stage accepts a canonical spelling that resolves to an alias status resource", async (t) => {
		const { invoke, alias, real, id } = await start(t, { id: "alias", projectPath: (r) => r.alias });
		assertAliasIsJunction(alias, real);
		const canonicalPath = normalize(realpathSync.native(join(alias, "tracked.txt")));

		const result = await invoke("git:stage", [id, [canonicalPath]]);
		assert.equal(result.payload.ok, true, JSON.stringify(result.payload));

		// "ok" alone is not enough: the trusted status resource itself must reach git.
		const expected = normalize(await oracle.getStatus(alias));
		const actual = await invoke("git:status", [id]);
		assert.equal(actual.payload.ok, true, JSON.stringify(actual.payload));
		assert.deepEqual(normalize(actual.payload.result), expected);
		const staged = actual.payload.result.index.find((entry) => /tracked\.txt$/.test(entry.path));
		assert.ok(staged, "the intended alias resource must actually be staged");
		assert.ok(normalize(staged.path).toLowerCase().startsWith(`${normalize(alias).toLowerCase()}/`));
		assert.match(statusPorcelain(real), /^M  tracked\.txt$/m);
	});

	test("git:stage skips the stale alias row of an alias-registered project end to end", async (t) => {
		const { invoke, alias, real, id } = await start(t, { id: "alias", projectPath: (r) => r.alias });
		assertAliasIsJunction(alias, real);

		const snapshot = await invoke("git:status", [id]);
		assert.equal(snapshot.payload.ok, true, JSON.stringify(snapshot.payload));
		const row = snapshot.payload.result.workingTree.find((entry) => /tracked\.txt$/.test(entry.path));
		assert.ok(row, "the alias project must report tracked.txt before the external stage");

		git(real, ["add", "--", "tracked.txt"]);
		const before = statusPorcelain(real);
		await oracle.stageFiles(alias, [row.path]);
		assert.equal(statusPorcelain(real), before, "the oracle must skip the stale alias row");

		const result = await invoke("git:stage", [id, [row.path]]);
		assert.equal(result.payload.ok, true, JSON.stringify(result.payload));
		assert.equal(statusPorcelain(real), before, "the stale alias row must be a no-op");
	});

	for (const operation of ["discard", "delete-files"]) {
		test(`git:${operation} preserves lexical status matching for destructive alias operations`, async (t) => {
			const { invoke, alias, real, id, trashCalls } = await start(t, { id: "alias", projectPath: (r) => r.alias });
			assertAliasIsJunction(alias, real);
			const canonical = realpathSync.native(join(alias, "tracked.txt"));
			const beforeContent = readFileSync(canonical, "utf8");
			const beforeStatus = statusPorcelain(real);
			// Only stage/unstage canonicalize requests in the Node oracle. Destructive
			// commands must keep matching the exact status representation the user chose.
			if (operation === "discard") {
				await assert.rejects(oracle.discardFile(alias, "workingTree", canonical), /stale or outside/);
			} else {
				await assert.rejects(oracle.deleteFiles(alias, [canonical]), /stale or outside/);
			}
			const args = operation === "discard" ? [id, "workingTree", canonical] : [id, [canonical]];
			const result = await invoke(`git:${operation}`, args);
			assert.equal(result.payload.ok, false, JSON.stringify(result.payload));
			assert.match(result.payload.error.message, /stale or outside/);
			assert.equal(readFileSync(canonical, "utf8"), beforeContent);
			assert.equal(statusPorcelain(real), beforeStatus);
			assert.deepEqual(trashCalls, [], "a rejected alias must never reach the trash service");
		});
	}

	test("git:stage rejects a genuine sibling even when its name shares the alias prefix", async (t) => {
		const { invoke, root, real, siblingDir, id } = await start(t, { id: "real", projectPath: (r) => r.real });
		const requests = [join(root, "sibling.txt"), join(siblingDir, "note.txt")];

		for (const request of requests) {
			await assert.rejects(oracle.stageFiles(real, [request]), /outside the project/, request);
			const result = await invoke("git:stage", [id, [request]]);
			assert.equal(result.payload.ok, false, request);
			assert.match(result.payload.error.message, /outside the project/, request);
		}
	});

	test("git:stage preserves the oracle's missing-alias fallback instead of trusting the raw prefix", async (t) => {
		const { invoke, alias, real, id } = await start(t, { id: "real", projectPath: (r) => r.real });
		assertAliasIsJunction(alias, real);
		// The path does not exist, so neither realpathSync.native nor the C++ canonicalizer
		// can expand the alias. The oracle keeps the lexical spelling and rejects it; a
		// raw prefix check on the ProjectStore spelling would wrongly accept it.
		const missing = join(alias, "deleted-alias-row.txt");
		await assert.rejects(oracle.stageFiles(real, [missing]), /outside the project/);
		const result = await invoke("git:stage", [id, [missing]]);
		assert.equal(result.payload.ok, false);
		assert.match(result.payload.error.message, /outside the project/);
	});
} else {
	test("native2 git alias paths are Windows-specific", { skip: "junction alias semantics are Windows-only" }, () => {});
}

if (!executable && requireBackend) {
	test("native2 git alias paths require a built PiDeckBackend", () => {
		assert.fail("PiDeckBackend executable not found. Build it with: xmake build PiDeckBackend");
	});
} else if (!executable) {
	test("native2 git alias paths", { skip: "PiDeckBackend.exe is not built" }, () => {});
}
