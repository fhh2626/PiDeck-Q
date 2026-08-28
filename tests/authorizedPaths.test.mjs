import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const nodeRequire = createRequire(import.meta.url);

function compileModule(filePath, imports = {}) {
  const output = ts.transpileModule(readFileSync(filePath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: filePath,
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    require: (specifier) => imports[specifier] ?? nodeRequire(specifier),
  }, { filename: filePath });
  return module.exports;
}

const policy = compileModule("src/main/security/policy.ts");
const {
  assertAuthorizedFilePath,
  assertLexicallyAuthorizedFilePath,
  isPathWithinAuthorizedRoots,
  UnauthorizedFilePathError,
} = compileModule("src/main/fs/authorizedPaths.ts", {
  "../security/policy": policy,
});

test("authorized paths accept descendants and reject adjacent directories", () => {
	assert.equal(
		isPathWithinAuthorizedRoots("C:/work/project/src/file.ts", ["C:/work/project"]),
		true,
	);
	assert.equal(
		isPathWithinAuthorizedRoots("C:/work/project-evil/file.ts", ["C:/work/project"]),
		false,
	);
	assert.equal(
		isPathWithinAuthorizedRoots("C:/outside/file.ts", ["C:/work/project"]),
		false,
	);
});

test("authorized paths normalize traversal before checking containment", () => {
	assert.equal(
		assertLexicallyAuthorizedFilePath("C:/work/project/src/../file.ts", ["C:/work/project"], "read"),
		"C:\\work\\project\\file.ts",
	);
	assert.throws(
		() => assertLexicallyAuthorizedFilePath("C:/work/project/../../secret.txt", ["C:/work/project"], "read"),
		(error) => error instanceof UnauthorizedFilePathError && error.code === "FILE_PATH_NOT_AUTHORIZED",
	);
});

test("authorized paths support multiple roots for project and global resources", () => {
	assert.equal(
		isPathWithinAuthorizedRoots("C:/Users/test/.pi/agent/prompts/review.md", [
			"C:/work/project",
			"C:/Users/test/.pi/agent",
		]),
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
