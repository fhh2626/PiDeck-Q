import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/** 在各平台用 Windows 路径语义和受控 realpath 复现 WSL 大小写目录，完全不访问真实 WSL。 */
function loadAuthorization(realpath = async value => value) {
 return loadTsCommonJs("src/main/prompts/promptPathAuthorization.ts", {
  globals: { process: { platform: "win32" } },
  stubs: {
   "node:path": { ...path, ...path.win32 },
   "node:fs/promises": { ...fs, realpath, lstat: async () => ({ isSymbolicLink: () => false }) },
  },
 });
}

test("registered WSL prompt project roots retain Linux path case", async () => {
 const { assertRegisteredProjectRoot } = loadAuthorization();
 const root = "\\\\wsl$\\Ubuntu\\home\\Foo";
 assert.equal(await assertRegisteredProjectRoot(root, [root]), root);
 await assert.rejects(() => assertRegisteredProjectRoot("\\\\wsl$\\Ubuntu\\home\\foo", [root]));
});

test("a WSL intermediate prompt directory link cannot escape into a case-different sibling", async () => {
 const root = "\\\\wsl$\\Ubuntu\\home\\Foo";
 const { assertProjectPromptRoot } = loadAuthorization(async value =>
  value.startsWith(root + "\\.pi") ? value.replace("\\home\\Foo", "\\home\\foo") : value);
 await assert.rejects(() => assertProjectPromptRoot(root));
});

test("registered local Windows prompt project roots remain case-insensitive", async () => {
 const { assertRegisteredProjectRoot } = loadAuthorization();
 assert.equal(await assertRegisteredProjectRoot("c:\\PROJECT", ["C:\\project"]), "c:\\PROJECT");
});
