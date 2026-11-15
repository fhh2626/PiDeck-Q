import { execFileSync } from "node:child_process";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Deterministic git fixtures for the Native2 parity tests.
 *
 * Every repository is created inside the test's temporary directory, so no user
 * repository is ever touched: the tests only ever mutate throwaway checkouts.
 */

const GIT_ENV = {
	// Keep commits reproducible and independent of the developer's global config.
	GIT_AUTHOR_NAME: "PiDeck Test",
	GIT_AUTHOR_EMAIL: "test@pideck.invalid",
	GIT_COMMITTER_NAME: "PiDeck Test",
	GIT_COMMITTER_EMAIL: "test@pideck.invalid",
	GIT_AUTHOR_DATE: "2024-01-01T00:00:00Z",
	GIT_COMMITTER_DATE: "2024-01-01T00:00:00Z",
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_SYSTEM: "/dev/null",
	GIT_TERMINAL_PROMPT: "0",
};

export function git(cwd, args, { allowFailure = false } = {}) {
	try {
		return execFileSync("git", args, {
			cwd,
			encoding: "utf8",
			env: { ...process.env, ...GIT_ENV },
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (error) {
		if (allowFailure) return "";
		throw error;
	}
}

function write(root, relative, content) {
	const target = join(root, relative);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, content);
}

/**
 * Repository covering every porcelain status shape the Git panel renders:
 * staged-only, worktree-only, both, staged rename with an old path, staged deletion,
 * worktree deletion, untracked, and a nested directory for project scoping.
 */
export function createStatusRepo(root) {
	mkdirSync(root, { recursive: true });
	git(root, ["init", "-q", "-b", "main"]);
	write(root, ".gitignore", "ignored.log\n");
	write(root, "tracked.txt", "tracked v1\n");
	write(root, "both.txt", "both v1\n");
	write(root, "worktree-deleted.txt", "delete me\n");
	write(root, "staged-deleted.txt", "stage delete\n");
	write(root, "rename-source.txt", "rename me\n");
	write(root, "src/nested.txt", "nested v1\n");
	write(root, "with space.txt", "space name\n");
	git(root, ["add", "-A"]);
	git(root, ["commit", "-q", "-m", "initial"]);

	// worktree-only modification
	write(root, "tracked.txt", "tracked v2\n");
	// a second worktree-only change whose name contains a space, proving the NUL
	// parser does not split on whitespace
	write(root, "with space.txt", "space name v2\n");
	// staged addition
	write(root, "staged-new.txt", "staged new\n");
	git(root, ["add", "staged-new.txt"]);
	// staged and then modified again → "MM"
	write(root, "both.txt", "both v2\n");
	git(root, ["add", "both.txt"]);
	write(root, "both.txt", "both v3\n");
	// worktree deletion: the file is gone from disk but still in the index
	unlinkSync(join(root, "worktree-deleted.txt"));
	// staged deletion
	git(root, ["rm", "-q", "--", "staged-deleted.txt"]);
	// staged rename (the porcelain record keeps the old path)
	git(root, ["mv", "rename-source.txt", "rename-target.txt"]);
	// untracked
	write(root, "untracked.txt", "untracked\n");
	// nested modification for project scoping
	write(root, "src/nested.txt", "nested v2\n");
	return root;
}

/** Repository left mid-merge so porcelain emits an unresolved conflict record. */
export function createConflictRepo(root) {
	mkdirSync(root, { recursive: true });
	git(root, ["init", "-q", "-b", "main"]);
	write(root, "conflict.txt", "base\n");
	git(root, ["add", "-A"]);
	git(root, ["commit", "-q", "-m", "base"]);
	git(root, ["checkout", "-q", "-b", "side"]);
	write(root, "conflict.txt", "side\n");
	git(root, ["commit", "-q", "-am", "side"]);
	git(root, ["checkout", "-q", "main"]);
	write(root, "conflict.txt", "main\n");
	git(root, ["commit", "-q", "-am", "main"]);
	// The merge is expected to conflict; the repository stays mid-merge.
	git(root, ["merge", "side"], { allowFailure: true });
	return root;
}

/** Repository with a linear history for log / detail / compare assertions. */
export function createHistoryRepo(root) {
	mkdirSync(root, { recursive: true });
	git(root, ["init", "-q", "-b", "main"]);
	write(root, "a.txt", "one\n");
	git(root, ["add", "-A"]);
	git(root, ["commit", "-q", "-m", "first commit"]);
	write(root, "a.txt", "one\ntwo\n");
	write(root, "b.txt", "new file\n");
	git(root, ["add", "-A"]);
	git(root, ["commit", "-q", "-m", "second commit"]);
	git(root, ["tag", "v1.0"]);
	git(root, ["checkout", "-q", "-b", "feature"]);
	write(root, "c.txt", "feature\n");
	git(root, ["add", "-A"]);
	git(root, ["commit", "-q", "-m", "feature commit"]);
	git(root, ["checkout", "-q", "main"]);
	return root;
}
