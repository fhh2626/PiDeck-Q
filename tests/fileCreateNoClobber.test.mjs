import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { FileSystemService } = loadTsCommonJs("src/main/fs/FileSystemService.ts");

test("creating a file does not truncate an existing file", async () => {
	const root = await mkdtemp(join(tmpdir(), "pideck-create-"));
	try {
		const service = new FileSystemService(async () => undefined);
		const target = join(root, "existing.txt");
		await writeFile(target, "keep");
		await assert.rejects(() => service.create(root, "existing.txt", "file"), /exists/i);
		assert.equal(await readFile(target, "utf8"), "keep");
		const created = await service.create(root, "new.txt", "file");
		assert.equal(await readFile(created, "utf8"), "");
		await mkdir(join(root, "dir"));
		await assert.rejects(() => service.create(root, "dir", "file"));
		// 已存在的目录也不能静默成功：与新建文件保持一致，否则 UI 会误报“已创建”。
		await assert.rejects(() => service.create(root, "dir", "directory"), /exists/i);
		const concurrent = await Promise.allSettled([
			service.create(root, "race.txt", "file"),
			service.create(root, "race.txt", "file"),
		]);
		assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1);
		assert.equal(await readFile(join(root, "race.txt"), "utf8"), "");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
