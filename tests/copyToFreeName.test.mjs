import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { copyToFreeName, copyCandidateName } = loadTsCommonJs("src/main/fs/copyToFreeName.ts");

test("copyCandidateName follows the explorer numbering rules", () => {
	assert.equal(copyCandidateName("a.txt", 0), "a.txt");
	assert.equal(copyCandidateName("a.txt", 1), "a (1).txt");
	assert.equal(copyCandidateName("a.txt", 2), "a (2).txt");
	// 无扩展名（含目录）不产生空 stem
	assert.equal(copyCandidateName("dir", 1), "dir (1)");
	// 只有扩展名的点文件：extname(".env") 为空，整体当成 stem
	assert.equal(copyCandidateName(".env", 1), ".env (1)");
	// 多段扩展名按最后一段拆分
	assert.equal(copyCandidateName("archive.tar.gz", 1), "archive.tar (1).gz");
});

test("copy into an occupied name writes a numbered copy and keeps the original", async () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-copy-free-"));
	try {
		const source = join(root, "a.txt");
		const targetDir = join(root, "target");
		mkdirSync(targetDir);
		writeFileSync(source, "SOURCE");
		writeFileSync(join(targetDir, "a.txt"), "EXISTING");

		const written = await copyToFreeName(source, targetDir, "a.txt");
		assert.equal(written, join(targetDir, "a (1).txt"));
		assert.equal(readFileSync(join(targetDir, "a.txt"), "utf8"), "EXISTING");
		assert.equal(readFileSync(written, "utf8"), "SOURCE");

		// 再复制一次得到 (2)，已有副本同样不动
		const second = await copyToFreeName(source, targetDir, "a.txt");
		assert.equal(second, join(targetDir, "a (2).txt"));
		assert.equal(readFileSync(join(targetDir, "a (1).txt"), "utf8"), "SOURCE");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("copying a file into its own directory produces a numbered sibling", async () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-copy-same-dir-"));
	try {
		const source = join(root, "a.txt");
		writeFileSync(source, "SOURCE");

		const written = await copyToFreeName(source, root, "a.txt");
		assert.equal(written, join(root, "a (1).txt"));
		assert.equal(readFileSync(source, "utf8"), "SOURCE");
		assert.equal(readFileSync(written, "utf8"), "SOURCE");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a conflicting directory is never merged into the existing one", async () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-copy-dir-"));
	try {
		const source = join(root, "s");
		mkdirSync(source);
		writeFileSync(join(source, "inside.txt"), "FROM-SOURCE");
		mkdirSync(join(root, "dest"));
		mkdirSync(join(root, "dest", "s"));
		writeFileSync(join(root, "dest", "s", "existing.txt"), "KEEP");

		const written = await copyToFreeName(source, join(root, "dest"), "s");
		assert.equal(written, join(root, "dest", "s (1)"));
		// 已有目录必须原样保留，源文件不能写进去
		assert.deepEqual(readdirSync(join(root, "dest", "s")), ["existing.txt"]);
		assert.equal(readFileSync(join(written, "inside.txt"), "utf8"), "FROM-SOURCE");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
