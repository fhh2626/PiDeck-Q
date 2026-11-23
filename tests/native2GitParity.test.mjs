import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveBackendExecutable, startBackendSession } from "./helpers/native2BackendHarness.mjs";
import { createConflictRepo, createHistoryRepo, createStatusRepo, git } from "./helpers/native2GitFixture.mjs";

/** Exercise native Git contracts against isolated repositories and the Git CLI. */

const executable = resolveBackendExecutable();
const requireBackend = process.env.PIDECK_REQUIRE_BACKEND_TESTS === "1";

const PROJECT_STATUS = "project-status";
const PROJECT_CONFLICT = "project-conflict";
const PROJECT_HISTORY = "project-history";

function normalize(value) {
	// Normalize only wire paths, never diff contents or file contents.
	return normalizePaths(JSON.parse(JSON.stringify(value ?? null)));
}

function normalizePaths(value) {
	if (typeof value === "string") {
		// Only absolute Windows paths are rewritten; file contents and diffs keep their
		// own backslashes.
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

/** Commit identities come from the independent Git CLI fixture, not another backend. */
function fixtureLog(cwd) {
	return git(cwd, ["log", "--all", "--format=%H%x09%h%x09%s"]).trim().split("\n")
		.map((line) => { const [hash, shortHash, message] = line.split("\t"); return { hash, shortHash, message }; });
}

function createRepos() {
	const root = mkdtempSync(join(tmpdir(), "pideck-native2-git-"));
	return {
		root,
		statusRepo: createStatusRepo(join(root, "status-repo")),
		conflictRepo: createConflictRepo(join(root, "conflict-repo")),
		historyRepo: createHistoryRepo(join(root, "history-repo")),
	};
}

async function start(t, options = {}) {
	const repos = createRepos();
	t.after(() => rmSync(repos.root, { recursive: true, force: true }));
	const session = await startBackendSession(t, {
		projects: [
			{ id: PROJECT_STATUS, path: repos.statusRepo },
			{ id: PROJECT_CONFLICT, path: repos.conflictRepo },
			{ id: PROJECT_HISTORY, path: repos.historyRepo },
		],
		settings: { maxEditorFileSizeMB: 5 },
		...options,
	});
	return { ...session, repos };
}

if (executable) {
	test("git:status groups every porcelain status shape", async (t) => {
		const { invoke } = await start(t);
		const actual = await invoke("git:status", [PROJECT_STATUS]);
		assert.equal(actual.payload.ok, true, JSON.stringify(actual.payload));

		// Every group must be present, and the rename must carry its old path.
		const result = actual.payload.result;
		for (const group of ["merge", "index", "workingTree", "untracked"]) {
			assert.ok(Array.isArray(result[group]), `missing group ${group}`);
		}
		const renamed = result.index.find((entry) => entry.status === 3);
		assert.ok(renamed, "staged rename missing from the index group");
		assert.match(normalize(renamed.oldPath), /rename-source\.txt$/);
		assert.match(normalize(renamed.path), /rename-target\.txt$/);
		// A staged-and-modified file must appear in both groups.
		assert.ok(result.index.some((entry) => /both\.txt$/.test(entry.path)));
		assert.ok(result.workingTree.some((entry) => /both\.txt$/.test(entry.path)));
		// A name with a space proves the NUL parser does not split on whitespace.
		assert.ok(result.workingTree.some((entry) => /with space\.txt$/.test(entry.path)));
	});

	test("git:status maps an unresolved conflict to the merge group", async (t) => {
		const { invoke } = await start(t);
		const actual = await invoke("git:status", [PROJECT_CONFLICT]);
		assert.equal(actual.payload.ok, true);
		const merge = actual.payload.result.merge;
		assert.equal(merge.length, 1, JSON.stringify(merge));
		assert.equal(merge[0].status, 18, "UU must map to BOTH_MODIFIED");
		assert.equal(merge[0].letter, "!");
	});

	test("git:status scopes a subdirectory project to its own files", async (t) => {
		const repos = createRepos();
		t.after(() => rmSync(repos.root, { recursive: true, force: true }));
		// Reuse the status repo's nested directory as the project root.
		const nested = join(repos.statusRepo, "src");
		const session = await startBackendSession(t, { projects: [{ id: "nested", path: nested }] });
		const actual = await session.invoke("git:status", ["nested"]);
		assert.equal(actual.payload.ok, true);
		// `-- .` keeps sibling resources out of the drawer.
		const all = [
			...actual.payload.result.merge,
			...actual.payload.result.index,
			...actual.payload.result.workingTree,
			...actual.payload.result.untracked,
		];
		assert.ok(all.length > 0);
		for (const entry of all) assert.match(normalize(entry.path), /\/src\/nested\.txt$/);
	});

	test("git:branches and git:checkout preserve branch selection and reject unsafe names", async (t) => {
		const { invoke } = await start(t);
		const branches = await invoke("git:branches", [PROJECT_HISTORY]);
		assert.equal(branches.payload.ok, true);
		assert.equal(branches.payload.result.current, "main");
		assert.ok(branches.payload.result.branches.some((entry) => (typeof entry === "string" ? entry : entry.name) === "feature"));

		const created = await invoke("git:create-branch", [PROJECT_HISTORY, "parity-branch"]);
		assert.equal(created.payload.ok, true, JSON.stringify(created.payload));
		assert.equal(created.payload.result.current, "parity-branch");

		const checkedOut = await invoke("git:checkout", [PROJECT_HISTORY, "main"]);
		assert.equal(checkedOut.payload.ok, true, JSON.stringify(checkedOut.payload));
		assert.equal(checkedOut.payload.result.current, "main");

		const missing = await invoke("git:checkout", [PROJECT_HISTORY, "no-such-branch"]);
		assert.equal(missing.payload.ok, false);
		assert.match(missing.payload.error.message, /failed/i);

		const optionLike = await invoke("git:checkout", [PROJECT_HISTORY, "--force"]);
		assert.equal(optionLike.payload.ok, false);
		assert.match(optionLike.payload.error.message, /Invalid branch name/);
	});

	test("git:branches preserves exact local names and handles detached and unborn HEAD", async (t) => {
		const { invoke, repos } = await start(t);
		const cwd = repos.historyRepo;
		const exact = "topic\u00a0";
		git(cwd, ["checkout", "-b", exact]);
		git(cwd, ["tag", exact]); // Git's :short format would disambiguate with heads/.
		const read = async () => {
			const { payload } = await invoke("git:branches", [PROJECT_HISTORY]);
			assert.equal(payload.ok, true, JSON.stringify(payload));
			return payload.result;
		};
		const attached = await read();
		assert.equal(attached.current, exact);
		assert.equal(attached.branches[0], exact);
		assert.equal(attached.branches.filter((name) => name.includes("topic")).length, 1);
		git(cwd, ["checkout", "--detach"]);
		const detached = await read();
		assert.equal(detached.current, null);
		assert.deepEqual(new Set(detached.branches), new Set(attached.branches));
		git(cwd, ["checkout", "--orphan", "unborn"]);
		const unborn = await read();
		assert.equal(unborn.current, "unborn");
		assert.equal(unborn.branches[0], "unborn");
	});

	test("git:commit-log, git:refs and git:ahead-behind return stable history metadata", async (t) => {
		const { invoke } = await start(t);
		const log = await invoke("git:commit-log", [PROJECT_HISTORY, { maxEntries: 50 }]);
		assert.equal(log.payload.ok, true);
		assert.equal(log.payload.result.length, 3);
		assert.equal(log.payload.result[0].shortHash.length, 7);
		assert.deepEqual(log.payload.result[0].graph, []);
		const refs = await invoke("git:refs", [PROJECT_HISTORY]);
		assert.equal(refs.payload.ok, true);
		const types = new Set(refs.payload.result.map((entry) => entry.type));
		assert.ok(types.has("head"));
		assert.ok(types.has("tag"));

		// A local branch without an upstream has no ahead/behind status.
		const ahead = await invoke("git:ahead-behind", [PROJECT_HISTORY]);
		assert.equal(ahead.payload.ok, true);
		assert.equal(ahead.payload.result, null);
	});

	test("git:commit-detail and git:commit-file-diff describe committed changes", async (t) => {
		const { invoke, repos } = await start(t);
		const log = fixtureLog(repos.historyRepo);
		const second = log.find((entry) => entry.message === "second commit");
		assert.ok(second);
		const detail = await invoke("git:commit-detail", [PROJECT_HISTORY, second.hash]);
		assert.equal(detail.payload.ok, true);
		assert.equal(detail.payload.result.files.length, 2);
		assert.ok(detail.payload.result.commit.shortStat, "shortStat must be parsed from --shortstat");

		const changed = detail.payload.result.files.find((file) => file.path === "a.txt");
		assert.ok(changed);
		const diff = await invoke("git:commit-file-diff", [PROJECT_HISTORY, second.hash, "a.txt"]);
		assert.equal(diff.payload.ok, true);
		assert.equal(diff.payload.result.originalContent, "one\n");
		assert.equal(diff.payload.result.modifiedContent, "one\ntwo\n");

		// A path the commit did not change must not be readable.
		const notInCommit = await invoke("git:commit-file-diff", [PROJECT_HISTORY, second.hash, "c.txt"]);
		assert.equal(notInCommit.payload.ok, true);
		assert.equal(notInCommit.payload.result, null);

		// diff-file-between uses ref1..ref2, never the first two arguments' positions.
		const between = await invoke("git:diff-file-between", [PROJECT_HISTORY, "main", "feature", "c.txt"]);
		assert.equal(between.payload.ok, true);
		assert.match(between.payload.result, /\+feature/);
	});

	test("git:branch-compare returns the symmetric difference", async (t) => {
		const { invoke } = await start(t);
		const actual = await invoke("git:branch-compare", [PROJECT_HISTORY, "main", "feature"]);
		assert.equal(actual.payload.ok, true);
		assert.equal(actual.payload.result.ahead, 1);
		assert.equal(actual.payload.result.behind, 0);
		assert.deepEqual(actual.payload.result.files, [{ path: "c.txt", status: "added" }]);

		const unknown = await invoke("git:branch-compare", [PROJECT_HISTORY, "main", "nope"]);
		assert.equal(unknown.payload.ok, true);
		assert.deepEqual(unknown.payload.result, { files: [], ahead: 0, behind: 0 });
	});

	test("git:workspace-file-diff returns both sides of each resource group", async (t) => {
		const { invoke, repos } = await start(t);
				const cases = [
			["workingTree", join(repos.statusRepo, "tracked.txt"), "tracked v1\n", "tracked v2\n"],
			["index", join(repos.statusRepo, "staged-new.txt"), "", "staged new\n"],
			["index", join(repos.statusRepo, "rename-target.txt"), "rename me\n", "rename me\n"],
			["workingTree", join(repos.statusRepo, "both.txt"), "both v2\n", "both v3\n"],
			["untracked", join(repos.statusRepo, "untracked.txt"), "", "untracked\n"],
			// The panel passes the workingTree group for untracked rows.
			["workingTree", join(repos.statusRepo, "untracked.txt"), "", "untracked\n"],
		];
		for (const [group, filePath, originalContent, modifiedContent] of cases) {
			const actual = await invoke("git:workspace-file-diff", [PROJECT_STATUS, group, filePath]);
			assert.equal(actual.payload.ok, true, `${group} ${filePath}: ${JSON.stringify(actual.payload)}`);
			assert.equal(actual.payload.result.originalContent, originalContent, `${group} ${filePath}`);
			assert.equal(actual.payload.result.modifiedContent, modifiedContent, `${group} ${filePath}`);
		}

		// A path that is not a current resource yields null instead of an error.
		const stale = await invoke("git:workspace-file-diff", [
			PROJECT_STATUS,
			"workingTree",
			join(repos.statusRepo, "not-changed.txt"),
		]);
		assert.equal(stale.payload.ok, true);
		assert.equal(stale.payload.result, null);

		// An invalid group is rejected as null, not as a crash.
		const badGroup = await invoke("git:workspace-file-diff", [PROJECT_STATUS, "bogus", "x"]);
		assert.equal(badGroup.payload.ok, true);
		assert.equal(badGroup.payload.result, null);
	});

	test("git:original-content reads HEAD and handles untracked files", async (t) => {
		const { invoke, repos } = await start(t);
				const tracked = join(repos.statusRepo, "tracked.txt");
		const actual = await invoke("git:original-content", [tracked]);
		assert.equal(actual.payload.ok, true, JSON.stringify(actual.payload));
		assert.equal(actual.payload.result, "tracked v1\n");

		// An untracked file has no HEAD version: "" rather than an error.
		const untracked = join(repos.statusRepo, "untracked.txt");
		const missing = await invoke("git:original-content", [untracked]);
		assert.equal(missing.payload.ok, true);
		assert.equal(missing.payload.result, "");

		const empty = await invoke("git:original-content", [""]);
		assert.equal(empty.payload.ok, false);
		assert.match(empty.payload.error.message, /non-empty string/);

		// A path outside every authorized root must be rejected, not read.
		const outside = join(repos.root, "outside.txt");
		const rejected = await invoke("git:original-content", [outside]);
		assert.equal(rejected.payload.ok, false);
		assert.match(rejected.payload.error.message, /not authorized/i);
	});

	test("git mutations stage, unstage and commit through the native service", async (t) => {
		const { invoke, repos } = await start(t);
		const staged = await invoke("git:stage", [
			PROJECT_STATUS,
			[join(repos.statusRepo, "tracked.txt"), join(repos.statusRepo, "untracked.txt")],
		]);
		assert.equal(staged.payload.ok, true, JSON.stringify(staged.payload));


		const actualStage = await invoke("git:status", [PROJECT_STATUS]);
		assert.equal(actualStage.payload.ok, true);
		const afterStage = actualStage.payload.result;
		assert.match(git(repos.statusRepo, ["diff", "--cached", "--name-only"]), /^untracked\.txt$/m);
		assert.ok(afterStage.index.some((entry) => /tracked\.txt$/.test(entry.path)));
		assert.ok(afterStage.index.some((entry) => /untracked\.txt$/.test(entry.path)));

		const unstaged = await invoke("git:unstage", [PROJECT_STATUS, [join(repos.statusRepo, "untracked.txt")]]);
		assert.equal(unstaged.payload.ok, true, JSON.stringify(unstaged.payload));
		const statusAfterUnstage = await invoke("git:status", [PROJECT_STATUS]);
		assert.equal(statusAfterUnstage.payload.ok, true);
		const afterUnstage = statusAfterUnstage.payload.result;
		assert.doesNotMatch(git(repos.statusRepo, ["diff", "--cached", "--name-only"]), /^untracked\.txt$/m);
		assert.ok(afterUnstage.untracked.some((entry) => /untracked\.txt$/.test(entry.path)));

		const committed = await invoke("git:commit", [PROJECT_STATUS, "parity commit"]);
		assert.equal(committed.payload.ok, true, JSON.stringify(committed.payload));
		const log = fixtureLog(repos.statusRepo);
		assert.equal(log[0].message, "parity commit");

		// A path outside the project is an authorization failure, not a silent no-op.
		const outside = await invoke("git:stage", [PROJECT_STATUS, [join(repos.root, "elsewhere.txt")]]);
		assert.equal(outside.payload.ok, false);
		assert.match(outside.payload.error.message, /outside the project/);
	});

	test("git:discard restores tracked files and trashes untracked ones", async (t) => {
		const { invoke, repos, trashCalls } = await start(t);
		const tracked = join(repos.statusRepo, "tracked.txt");
		const restored = await invoke("git:discard", [PROJECT_STATUS, "workingTree", tracked]);
		assert.equal(restored.payload.ok, true, JSON.stringify(restored.payload));
		assert.deepEqual(trashCalls, [], "a tracked discard must not touch the recycle bin");
		const status = await invoke("git:status", [PROJECT_STATUS]);
		assert.ok(!status.payload.result.workingTree.some((entry) => /tracked\.txt$/.test(entry.path)));

		// Untracked discard deletes user content, so it must go through the recycle bin.
		const untracked = join(repos.statusRepo, "untracked.txt");
		const discarded = await invoke("git:discard", [PROJECT_STATUS, "untracked", untracked]);
		assert.equal(discarded.payload.ok, true, JSON.stringify(discarded.payload));
		assert.deepEqual(normalize(trashCalls), [normalize(untracked)]);

		// The fake host only records the trash call, so remove the file ourselves to
		// simulate a real recycle-bin move and prove the stale guard fires.
		unlinkSync(untracked);
		const stale = await invoke("git:discard", [PROJECT_STATUS, "untracked", untracked]);
		assert.equal(stale.payload.ok, false);
		assert.match(stale.payload.error.message, /stale or outside the project/);

		const badGroup = await invoke("git:discard", [PROJECT_STATUS, "index", tracked]);
		assert.equal(badGroup.payload.ok, false);
		assert.match(badGroup.payload.error.message, /cannot be discarded/);
	});

	test("git:delete-files moves status-listed files to the recycle bin, never git rm", async (t) => {
		const { invoke, repos, trashCalls } = await start(t);
		const target = join(repos.statusRepo, "staged-new.txt");
		const deleted = await invoke("git:delete-files", [PROJECT_STATUS, [target]]);
		assert.equal(deleted.payload.ok, true, JSON.stringify(deleted.payload));
		assert.deepEqual(normalize(trashCalls), [normalize(target)]);

		const invalid = await invoke("git:delete-files", [PROJECT_STATUS, []]);
		assert.equal(invalid.payload.ok, false);
		assert.match(invalid.payload.error.message, /Invalid paths/);

		const outside = await invoke("git:delete-files", [PROJECT_STATUS, [join(repos.root, "nope.txt")]]);
		assert.equal(outside.payload.ok, false);
		assert.match(outside.payload.error.message, /stale or outside the project/);
	});

	test("git:reset honours the requested mode and rejects an unknown one", async (t) => {
		const { invoke, repos } = await start(t);
		const log = fixtureLog(repos.historyRepo);
		const first = log[log.length - 1];

		const invalid = await invoke("git:reset", [PROJECT_HISTORY, first.hash, "explode"]);
		assert.equal(invalid.payload.ok, false);
		assert.match(invalid.payload.error.message, /Invalid reset mode/);

		const soft = await invoke("git:reset", [PROJECT_HISTORY, first.hash, "soft"]);
		assert.equal(soft.payload.ok, true, JSON.stringify(soft.payload));
		// soft keeps the index, so the later commits' files stay staged.
		const status = await invoke("git:status", [PROJECT_HISTORY]);
		assert.equal(status.payload.ok, true);
		assert.ok(status.payload.result.index.length > 0, JSON.stringify(status.payload.result));
		assert.equal(git(repos.historyRepo, ["rev-parse", "--short", "HEAD"]).trim(), first.shortHash);
	});

	test("git:init initializes a repository through the project catalog", async (t) => {
		const plain = mkdtempSync(join(tmpdir(), "pideck-native2-plain-"));
		t.after(() => rmSync(plain, { recursive: true, force: true }));
		const session = await startBackendSession(t, { projects: [{ id: "plain", path: plain }] });

		const before = await session.invoke("git:status", ["plain"]);
		assert.equal(before.payload.ok, false, "a non-repository must surface the git error");
		assert.match(before.payload.error.message, /not a git repository/i);

		const init = await session.invoke("git:init", ["plain"]);
		assert.equal(init.payload.ok, true, JSON.stringify(init.payload));
		const after = await session.invoke("git:status", ["plain"]);
		assert.equal(after.payload.ok, true);
		assert.deepEqual(after.payload.result, { merge: [], index: [], workingTree: [], untracked: [] });

		const empty = await session.invoke("git:init", ["  "]);
		assert.equal(empty.payload.ok, false);
		assert.match(empty.payload.error.message, /projectId must be a non-empty string/);
	});

	test("git:generate-commit-message reports the structured model-required code", async (t) => {
		const { invoke } = await start(t);
		// The fixture has staged content, so the backend reaches the model check and
		// returns its structured code instead of calling pi.
		const required = await invoke("git:generate-commit-message", [PROJECT_STATUS]);
		assert.equal(required.payload.ok, true, JSON.stringify(required.payload));
		assert.equal(required.payload.result.ok, false);
		assert.equal(required.payload.result.code, "GIT_COMMIT_MODEL_REQUIRED");
		assert.equal(typeof required.payload.result.message, "string");
		assert.ok(required.payload.result.message.length > 0);

		const missingProject = await invoke("git:generate-commit-message", ["nope"]);
		assert.equal(missingProject.payload.ok, true);
		assert.deepEqual(missingProject.payload.result, { ok: true, message: "" });
	});

	test("git:generate-commit-message returns an empty message when nothing is staged", async (t) => {
		const clean = mkdtempSync(join(tmpdir(), "pideck-native2-clean-"));
		t.after(() => rmSync(clean, { recursive: true, force: true }));
		git(clean, ["init", "-q", "-b", "main"]);
		const session = await startBackendSession(t, { projects: [{ id: "clean", path: clean }] });
		const result = await session.invoke("git:generate-commit-message", ["clean"]);
		assert.equal(result.payload.ok, true, JSON.stringify(result.payload));
		assert.deepEqual(result.payload.result, { ok: true, message: "" });
	});

	test("git channels report a missing project exactly like the Node handlers", async (t) => {
		const { invoke } = await start(t);
		const missing = "does-not-exist";

		const branches = await invoke("git:branches", [missing]);
		assert.equal(branches.payload.ok, false);
		assert.equal(branches.payload.error.message, `Project not found: ${missing}`);

		const log = await invoke("git:commit-log", [missing, { maxEntries: 5 }]);
		assert.equal(log.payload.ok, true);
		assert.deepEqual(log.payload.result, []);

		const refs = await invoke("git:refs", [missing]);
		assert.equal(refs.payload.ok, true);
		assert.deepEqual(refs.payload.result, []);

		const status = await invoke("git:status", [missing]);
		assert.equal(status.payload.ok, true);
		assert.deepEqual(status.payload.result, { merge: [], index: [], workingTree: [], untracked: [] });

		const detail = await invoke("git:commit-detail", [missing, "HEAD"]);
		assert.equal(detail.payload.ok, true);
		assert.equal(detail.payload.result, null);

		const between = await invoke("git:diff-file-between", [missing, "a", "b", "c"]);
		assert.equal(between.payload.ok, true);
		assert.equal(between.payload.result, "");

		const compare = await invoke("git:branch-compare", [missing, "a", "b"]);
		assert.equal(compare.payload.ok, false);
		assert.equal(compare.payload.error.message, `Project not found: ${missing}`);
	});

	test("git:cherry-pick, git:revert and git:drop-commit apply commits safely", async (t) => {
		const repos = createRepos();
		t.after(() => rmSync(repos.root, { recursive: true, force: true }));
		const repo = repos.historyRepo;
		const log = fixtureLog(repo);
		const featureCommit = log.find((entry) => entry.message === "feature commit");
		assert.ok(featureCommit, "fixture must contain the feature commit");
		const session = await startBackendSession(t, { projects: [{ id: PROJECT_HISTORY, path: repo }] });
		const { invoke } = session;

		const picked = await invoke("git:cherry-pick", [PROJECT_HISTORY, featureCommit.hash]);
		assert.equal(picked.payload.ok, true, JSON.stringify(picked.payload));
		assert.equal(picked.payload.result, null);
		// Verify the resulting tree independently through Git.
		assert.equal(git(repo, ["log", "-1", "--format=%s"]).trim(), "feature commit");
		assert.equal(git(repo, ["rev-parse", "HEAD^{tree}"]), git(repo, ["rev-parse", `${featureCommit.hash}^{tree}`]));

		const reverted = await invoke("git:revert", [PROJECT_HISTORY, "HEAD"]);
		assert.equal(reverted.payload.ok, true, JSON.stringify(reverted.payload));
		assert.equal(reverted.payload.result, null);
		assert.match(git(repo, ["log", "-1", "--format=%s"]).trim(), /^Revert "feature commit"/m);

		// Drop a non-HEAD commit using rebase --onto <parent> <hash>.
		// rewrites the commits after <hash>, so the assertion is that the dropped commit
		// is gone and the worktree is left clean (no half-finished rebase).
		const target = git(repo, ["rev-parse", "HEAD^"]).trim();
		const targetSubject = git(repo, ["log", "-1", "--format=%s", target]).trim();
		const dropped = await invoke("git:drop-commit", [PROJECT_HISTORY, target]);
		assert.equal(dropped.payload.ok, true, JSON.stringify(dropped.payload));
		assert.equal(dropped.payload.result, null);
		assert.ok(!git(repo, ["log", "--format=%s"]).includes(targetSubject), "dropped commit must be gone");
		assert.equal(git(repo, ["status", "--porcelain"]).trim(), "", "rebase must not leave the tree dirty");
		assert.ok(!existsSync(join(repo, ".git", "rebase-merge")), "no rebase in progress");

		const missing = "no-such-project";
		for (const channel of ["git:cherry-pick", "git:revert", "git:drop-commit"]) {
			const result = await invoke(channel, [missing, "HEAD"]);
			assert.equal(result.payload.ok, false, channel);
			assert.equal(result.payload.error.message, `Project not found: ${missing}`);
		}
	});

	test("git:push, git:pull and git:fetch use the plain git commands", async (t) => {
		const repos = createRepos();
		t.after(() => rmSync(repos.root, { recursive: true, force: true }));
		const repo = repos.historyRepo;
		// A local bare remote keeps the test offline and leaves no user repository touched.
		const remote = join(repos.root, "remote.git");
		git(repos.root, ["init", "-q", "--bare", remote]);
		git(repo, ["remote", "add", "origin", remote]);
		git(repo, ["push", "-q", "-u", "origin", "main"]);

		const session = await startBackendSession(t, { projects: [{ id: PROJECT_HISTORY, path: repo }] });
		const { invoke } = session;

		writeFileSync(join(repo, "pushed.txt"), "pushed\n");
		git(repo, ["add", "-A"]);
		git(repo, ["commit", "-q", "-m", "pushed commit"]);
		const pushed = await invoke("git:push", [PROJECT_HISTORY]);
		assert.equal(pushed.payload.ok, true, JSON.stringify(pushed.payload));
		assert.equal(pushed.payload.result, null);
		assert.equal(git(remote, ["rev-parse", "main"]).trim(), git(repo, ["rev-parse", "HEAD"]).trim());

		const fetched = await invoke("git:fetch", [PROJECT_HISTORY]);
		assert.equal(fetched.payload.ok, true, JSON.stringify(fetched.payload));
		assert.equal(fetched.payload.result, null);

		const pulled = await invoke("git:pull", [PROJECT_HISTORY]);
		assert.equal(pulled.payload.ok, true, JSON.stringify(pulled.payload));
		assert.equal(pulled.payload.result, null);

		// A repository without a remote must surface the git failure, not a silent success.
		const bare = join(repos.root, "no-remote");
		git(repos.root, ["init", "-q", "-b", "main", bare]);
		const other = await startBackendSession(t, { projects: [{ id: "no-remote", path: bare }] });
		const failed = await other.invoke("git:push", ["no-remote"]);
		assert.equal(failed.payload.ok, false);
		assert.match(failed.payload.error.message, /remote|push/i);
	});

	test("git:worktree-list, git:worktree-create and git:worktree-remove maintain worktree membership", async (t) => {
		const repos = createRepos();
		t.after(() => rmSync(repos.root, { recursive: true, force: true }));
		const repo = repos.historyRepo;
		const session = await startBackendSession(t, { projects: [{ id: PROJECT_HISTORY, path: repo }] });
		const { invoke } = session;

		const empty = await invoke("git:worktree-list", [PROJECT_HISTORY]);
		assert.equal(empty.payload.ok, true, JSON.stringify(empty.payload));
		assert.deepEqual(normalize(empty.payload.result), []);

		const created = await invoke("git:worktree-create", [PROJECT_HISTORY, "worktree-branch"]);
		assert.equal(created.payload.ok, true, JSON.stringify(created.payload));
		const createdPath = normalize(created.payload.result.path);
		assert.equal(normalize(created.payload.result.branch), "worktree-branch");
		// Worktrees live next to the project, named after the slugified branch.
		assert.equal(createdPath, normalize(join(repos.root, "worktree-branch")));
		assert.ok(existsSync(join(repos.root, "worktree-branch")));

		const listed = await invoke("git:worktree-list", [PROJECT_HISTORY]);
		assert.equal(listed.payload.ok, true);
		assert.deepEqual(normalize(listed.payload.result), [{ path: createdPath, branch: "worktree-branch" }]);

		const duplicate = await invoke("git:worktree-create", [PROJECT_HISTORY, "worktree-branch"]);
		assert.equal(duplicate.payload.ok, false);
		assert.match(duplicate.payload.error.message, /already exists/i);

		const removed = await invoke("git:worktree-remove", [PROJECT_HISTORY, created.payload.result.path]);
		assert.equal(removed.payload.ok, true, JSON.stringify(removed.payload));
		const after = await invoke("git:worktree-list", [PROJECT_HISTORY]);
		assert.deepEqual(normalize(after.payload.result), []);
	});

} else if (requireBackend) {
	test("native2 git parity requires a built PiDeckBackend", () => {
		assert.fail("PiDeckBackend executable not found. Build it with: xmake build PiDeckBackend");
	});
} else {
	test("native2 git parity", { skip: "PiDeckBackend.exe is not built (run: xmake build PiDeckBackend)" }, () => {});
}
