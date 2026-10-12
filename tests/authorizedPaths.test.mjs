import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const {
	assertAuthorizedFilePath,
	assertLexicallyAuthorizedFilePath,
	isPathWithinAuthorizedRoots,
	UnauthorizedFilePathError,
} = loadTsCommonJs("src/main/fs/authorizedPaths.ts");

// 授权判定是纯词法边界检查，用临时目录构造绝对路径即可，
// 这样 Windows 与 POSIX 跑的是同一套断言，不需要平台特有的字面量。
const rootDir = join(tmpdir(), "pideck-authorized-fixture", "project");
const rootSiblingDir = join(tmpdir(), "pideck-authorized-fixture", "project-evil");
const unrelatedDir = join(tmpdir(), "pideck-authorized-unrelated");
const rootFile = join(rootDir, "src", "file.ts");
const globalPromptDir = join(tmpdir(), "pideck-authorized-global", ".pi", "agent");

/** 把绝对路径拼上相对路径，避免测试自己重新实现路径拼接规则。 */
function underRoot(...parts) {
	return join(rootDir, ...parts);
}

/**
 * 保留字面量 ".." 的路径必须手写拼接：join() 会在词法上先消掉 ".."，
 * 那样就测不到生产代码自己的 resolve() 归一化行为了。
 */
function rawUnderRoot(...parts) {
	return [rootDir, ...parts].join(sep);
}

test("authorized paths accept descendants and reject adjacent directories", () => {
	assert.equal(isPathWithinAuthorizedRoots(underRoot("src", "file.ts"), [rootDir]), true);
	// 兄弟目录同名前缀不能被误判为子路径
	assert.equal(isPathWithinAuthorizedRoots(join(rootSiblingDir, "file.ts"), [rootDir]), false);
	assert.equal(isPathWithinAuthorizedRoots(join(unrelatedDir, "file.ts"), [rootDir]), false);
	assert.equal(isPathWithinAuthorizedRoots(rootFile, [rootDir]), true);
});

test("authorized paths normalize traversal before checking containment", () => {
	// src/.. 回到根目录，归一化后仍在授权范围内
	assert.equal(
		assertLexicallyAuthorizedFilePath(rawUnderRoot("src", "..", "file.ts"), [rootDir], "read"),
		resolve(underRoot("file.ts")),
	);
	// 两级 .. 逃出授权根目录，必须拒绝
	assert.throws(
		() => assertLexicallyAuthorizedFilePath(rawUnderRoot("..", "..", "secret.txt"), [rootDir], "read"),
		(error) => error instanceof UnauthorizedFilePathError && error.code === "FILE_PATH_NOT_AUTHORIZED",
	);
});

test("authorized paths support multiple roots for project and global resources", () => {
	assert.equal(
		isPathWithinAuthorizedRoots(join(globalPromptDir, "prompts", "review.md"), [rootDir, globalPromptDir]),
		true,
	);
});

test("filesystem-aware authorization rejects a symlink escape for reads and writes", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pideck-authorized-root-"));
	const outside = mkdtempSync(join(tmpdir(), "pideck-authorized-outside-"));
	try {
		const linked = join(root, "linked");
		mkdirSync(outside, { recursive: true });
		writeFileSync(join(outside, "secret.txt"), "secret");
		try {
			symlinkSync(outside, linked, "junction");
		} catch (error) {
			t.skip(`junction creation unavailable: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		await assert.rejects(
			() => assertAuthorizedFilePath(join(linked, "secret.txt"), [root], "read", "read"),
			(error) => error instanceof UnauthorizedFilePathError && error.code === "FILE_PATH_NOT_AUTHORIZED",
		);
		await assert.rejects(
			() => assertAuthorizedFilePath(join(linked, "new.txt"), [root], "write", "write"),
			(error) => error instanceof UnauthorizedFilePathError && error.code === "FILE_PATH_NOT_AUTHORIZED",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	}
});

test("filesystem-aware authorization preserves deleting a link while checking its parent", async () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-authorized-link-root-"));
	const outside = mkdtempSync(join(tmpdir(), "pideck-authorized-link-outside-"));
	try {
		const linked = join(root, "linked");
		symlinkSync(outside, linked, "junction");
		assert.equal(
			await assertAuthorizedFilePath(linked, [root], "delete", "link"),
			linked,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	}
});
