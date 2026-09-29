import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { writeFileAtomic } = loadTsCommonJs("src/main/utils/atomicWriteFile.ts");

async function withTempDir(run) {
	const dir = await mkdtemp(join(tmpdir(), "pideck-atomic-write-"));
	try {
		await run(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test("writeFileAtomic creates a missing file with the requested content", async () => {
	await withTempDir(async (dir) => {
		const target = join(dir, "created.json");
		await writeFileAtomic(target, '{"ok":true}');
		assert.equal(await readFile(target, "utf8"), '{"ok":true}');
	});
});

test("writeFileAtomic replaces existing content without leaving temp files", async () => {
	await withTempDir(async (dir) => {
		const target = join(dir, "existing.json");
		await writeFile(target, "old", "utf8");
		await writeFileAtomic(target, "new");
		assert.equal(await readFile(target, "utf8"), "new");
		const leftovers = (await readdir(dir)).filter((name) => name.endsWith(".tmp"));
		assert.deepEqual(leftovers, []);
	});
});

test("writeFileAtomic preserves existing file permissions", { skip: process.platform === "win32" ? "Windows 无 POSIX 权限位语义" : false }, async () => {
	await withTempDir(async (dir) => {
		const target = join(dir, "auth.json");
		await writeFile(target, "{}", { encoding: "utf8", mode: 0o600 });
		await writeFileAtomic(target, '{"token":"x"}');
		const mode = (await stat(target)).mode & 0o777;
		assert.equal(mode, 0o600);
	});
});

test("writeFileAtomic creates missing parent directories", async () => {
	await withTempDir(async (dir) => {
		const target = join(dir, "nested", "deeper", "settings.json");
		await writeFileAtomic(target, "{}");
		assert.equal(await readFile(target, "utf8"), "{}");
	});
});
