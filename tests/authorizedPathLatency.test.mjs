import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

for (const mode of ["read", "write", "link"]) {
	test(`file ${mode} authorization does not probe an unrelated slow root after finding the real owner`, async (t) => {
		const base = await fs.mkdtemp(join(tmpdir(), "pideck-root-latency-"));
		t.after(() => fs.rm(base, { recursive: true, force: true }));
		const root = join(base, "project");
		const slowRoot = join(base, "unrelated-root");
		await Promise.all([fs.mkdir(root), fs.mkdir(slowRoot)]);
		const target = join(root, "document.txt");
		await fs.writeFile(target, "document");
		let slowRootProbes = 0;
		const { assertAuthorizedFilePath } = loadTsCommonJs("src/main/fs/authorizedPaths.ts", {
			stubs: {
				"node:fs/promises": {
					...fs,
					realpath: async (path) => {
						if (resolve(path) === slowRoot) {
							slowRootProbes += 1;
							await new Promise((done) => setTimeout(done, 1_500));
						}
						return fs.realpath(path);
					},
				},
			},
		});
		const started = performance.now();
		const expected = mode === "link" ? resolve(target) : await fs.realpath(target);
		assert.equal(await assertAuthorizedFilePath(target, [slowRoot, root], mode, mode), expected);
		t.diagnostic(`authorization completed in ${Math.round(performance.now() - started)} ms with a controlled 1500 ms unrelated root`);
		assert.equal(slowRootProbes, 0, "an unrelated root must not delay an already authorized local file");
	});

	test(`file ${mode} authorization keeps canonical access through an aliased project root`, async (t) => {
		const base = await fs.mkdtemp(join(tmpdir(), "pideck-root-alias-"));
		t.after(() => fs.rm(base, { recursive: true, force: true }));
		const root = join(base, "project");
		const alias = join(base, "project-alias");
		await fs.mkdir(root);
		await fs.symlink(root, alias, "junction");
		const target = join(root, "document.txt");
		await fs.writeFile(target, "document");
		const { assertAuthorizedFilePath } = loadTsCommonJs("src/main/fs/authorizedPaths.ts");
		const expected = mode === "link" ? resolve(target) : await fs.realpath(target);
		assert.equal(await assertAuthorizedFilePath(target, [alias], mode, mode), expected);
	});
}

test("file authorization rechecks an aliased root after it is retargeted", async (t) => {
	const base = await fs.mkdtemp(join(tmpdir(), "pideck-root-retarget-"));
	t.after(() => fs.rm(base, { recursive: true, force: true }));
	const root = join(base, "project");
	const outside = join(base, "outside");
	const alias = join(base, "project-alias");
	await Promise.all([fs.mkdir(root), fs.mkdir(outside)]);
	const target = join(root, "document.txt");
	await fs.writeFile(target, "document");
	await fs.symlink(root, alias, "junction");
	const { assertAuthorizedFilePath } = loadTsCommonJs("src/main/fs/authorizedPaths.ts");
	assert.equal(await assertAuthorizedFilePath(target, [alias], "read"), await fs.realpath(target));
	await fs.unlink(alias);
	await fs.symlink(outside, alias, "junction");
	await assert.rejects(() => assertAuthorizedFilePath(target, [alias], "read"),
		(error) => error.code === "FILE_PATH_NOT_AUTHORIZED");
});

test("file authorization still rejects a linked leaf and a nonexistent authority root", async (t) => {
	const base = await fs.mkdtemp(join(tmpdir(), "pideck-root-leaf-"));
	t.after(() => fs.rm(base, { recursive: true, force: true }));
	const target = join(base, "document.txt");
	await fs.writeFile(target, "document");
	const { assertAuthorizedFilePath } = loadTsCommonJs("src/main/fs/authorizedPaths.ts", {
		stubs: { "node:fs/promises": { ...fs, lstat: async () => ({ isSymbolicLink: () => true }) } },
	});
	for (const mode of ["read", "write"]) {
		await assert.rejects(() => assertAuthorizedFilePath(target, [base], mode, mode),
			(error) => error.code === "FILE_PATH_NOT_AUTHORIZED");
	}
	const real = loadTsCommonJs("src/main/fs/authorizedPaths.ts");
	const missingRoot = join(base, "missing-root");
	await assert.rejects(() => real.assertAuthorizedFilePath(join(missingRoot, "new.txt"), [missingRoot], "write", "write"),
		(error) => error.code === "FILE_PATH_NOT_AUTHORIZED");
});
