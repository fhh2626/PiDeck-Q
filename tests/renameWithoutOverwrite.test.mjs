import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { renameWithoutOverwrite } = loadTsCommonJs("src/main/fs/renameWithoutOverwrite.ts");
const isExists = (error) => error.code === "RENAME_TARGET_EXISTS";

test("rename refuses an existing file target and keeps both contents", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pideck-rename-"));
	try {
		writeFileSync(join(dir, "a.txt"), "A");
		writeFileSync(join(dir, "b.txt"), "B");
		await assert.rejects(renameWithoutOverwrite(join(dir, "a.txt"), join(dir, "b.txt")), isExists);
		assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "A");
		assert.equal(readFileSync(join(dir, "b.txt"), "utf8"), "B");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("rename moves a file to a free name", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pideck-rename-"));
	try {
		writeFileSync(join(dir, "a.txt"), "A");
		await renameWithoutOverwrite(join(dir, "a.txt"), join(dir, "c.txt"));
		assert.equal(existsSync(join(dir, "a.txt")), false);
		assert.equal(readFileSync(join(dir, "c.txt"), "utf8"), "A");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("rename refuses an existing directory target", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pideck-rename-"));
	try {
		mkdirSync(join(dir, "x"));
		mkdirSync(join(dir, "y"));
		await assert.rejects(renameWithoutOverwrite(join(dir, "x"), join(dir, "y")), isExists);
		assert.ok(existsSync(join(dir, "x")));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a target created during the rename is never clobbered", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pideck-rename-"));
	try {
		writeFileSync(join(dir, "a.txt"), "A");
		const racingOps = {
			...fsp,
			link: async (from, to) => {
				writeFileSync(to, "RACE");
				return fsp.link(from, to);
			},
		};
		await assert.rejects(renameWithoutOverwrite(join(dir, "a.txt"), join(dir, "b.txt"), racingOps), isExists);
		assert.equal(readFileSync(join(dir, "b.txt"), "utf8"), "RACE");
		assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "A");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("case-only rename succeeds on case-insensitive platforms", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pideck-rename-"));
	try {
		writeFileSync(join(dir, "Foo.txt"), "F");
		await renameWithoutOverwrite(join(dir, "Foo.txt"), join(dir, "foo.txt"), undefined, "win32");
		assert.equal(readFileSync(join(dir, "foo.txt"), "utf8"), "F");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("FileSystemService refuses to overwrite and rejects escaping names", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pideck-rename-service-"));
	try {
		const { FileSystemService } = loadTsCommonJs("src/main/fs/FileSystemService.ts");
		const service = new FileSystemService();
		writeFileSync(join(dir, "a.txt"), "A");
		writeFileSync(join(dir, "b.txt"), "B");

		await assert.rejects(
			service.rename(join(dir, "a.txt"), "b.txt"),
			(error) => error.code === "RENAME_TARGET_EXISTS",
		);
		assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "A");
		assert.equal(readFileSync(join(dir, "b.txt"), "utf8"), "B");

		// 名字必须限制为单个目录项，禁止借改名把文件移出父目录。
		for (const name of ["../evil.txt", "sub/evil.txt", "sub\\evil.txt", "..", ".", ""]) {
			await assert.rejects(service.rename(join(dir, "a.txt"), name));
		}
		assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "A");

		// 普通改名仍然可用
		const renamed = await service.rename(join(dir, "a.txt"), "c.txt");
		assert.equal(renamed, join(dir, "c.txt"));
		assert.equal(readFileSync(join(dir, "c.txt"), "utf8"), "A");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
