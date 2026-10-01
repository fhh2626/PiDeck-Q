import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
		// topic 与 init 同一提交，属于已合并分支：可以安全删除。
		assert.equal(branches.trim(), "");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("removing a worktree keeps an unmerged branch instead of forcing the delete", async () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-worktree-unmerged-"));
	try {
		const repo = join(root, "repo");
		const worktree = join(root, "feature");
		mkdirSync(repo);
		execFileSync("git", ["init"], { cwd: repo });
		execFileSync("git", ["-c", "user.name=PiDeck Review", "-c", "user.email=review@example.invalid", "commit", "--allow-empty", "-m", "init"], { cwd: repo });
		execFileSync("git", ["worktree", "add", "-b", "feature", worktree], { cwd: repo });
		// 在 worktree 分支上提交一次且不合并：分支不再能从 HEAD 到达。
		writeFileSync(join(worktree, "feature.txt"), "work");
		execFileSync("git", ["add", "feature.txt"], { cwd: worktree });
		execFileSync("git", ["-c", "user.name=PiDeck Review", "-c", "user.email=review@example.invalid", "commit", "-m", "feature work"], { cwd: worktree });
		const branchBefore = execFileSync("git", ["rev-parse", "feature"], { cwd: repo, encoding: "utf8" }).trim();

		const service = new WorktreeService(() => "failed", async () => {});
		const removed = await service.remove(worktree, repo);

		const branches = execFileSync("git", ["branch", "--list", "feature"], { cwd: repo, encoding: "utf8" });
		const branchAfter = execFileSync("git", ["rev-parse", "feature"], { cwd: repo, encoding: "utf8" }).trim();

		// worktree 目录本身已删除成功，接口必须报成功，否则界面会以为整个操作失败。
		assert.equal(removed, true);
		assert.equal(existsSync(worktree), false, "worktree 目录应已删除");
		// -D 会把未合并提交变成只能靠 reflog 找回的游离对象；-d 会拒绝并保留分支。
		assert.notEqual(branches.trim(), "", "未合并的分支必须保留");
		assert.equal(branchAfter, branchBefore, "保留的分支必须仍指向原来的提交");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
