import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { WorktreeService } = loadTsCommonJs("src/main/git/WorktreeService.ts");

test("real git worktree removal also deletes the matching branch", async () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-worktree-real-"));
	try {
		const repo = join(root, "repo");
		const worktree = join(root, "topic");
		mkdirSync(repo);
		execFileSync("git", ["init"], { cwd: repo });
		execFileSync("git", ["-c", "user.name=PiDeck Review", "-c", "user.email=review@example.invalid", "commit", "--allow-empty", "-m", "init"], { cwd: repo });
		execFileSync("git", ["worktree", "add", "-b", "topic", worktree], { cwd: repo });
		writeFileSync(join(worktree, "untracked.txt"), "keep");
		const trashed = [];
		const service = new WorktreeService(() => "failed", async (target) => {
			trashed.push(target);
		});

		const removed = await service.remove(worktree, repo);
		const branches = execFileSync("git", ["branch", "--list", "topic"], { cwd: repo, encoding: "utf8" });

		assert.equal(removed, true);
		assert.deepEqual(trashed, []);
		assert.equal(branches.trim(), "");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
