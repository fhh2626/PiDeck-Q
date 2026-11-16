import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/** Exercise the production authorization boundary with deterministic Windows filesystem identities. */
function authorization(realpath = async (value) => value) {
  return loadTsCommonJs("src/main/fs/authorizedPaths.ts", {
    globals: { process: { platform: "win32" } },
    stubs: {
      "node:path": { ...path, ...path.win32 },
      "node:fs/promises": { ...fs, realpath, lstat: async () => ({ isSymbolicLink: () => false }) },
    },
  });
}

for (const mode of ["read", "write", "link"]) {
  test(`WSL file ${mode} authorization retains Linux directory case`, async () => {
    const { assertAuthorizedFilePath } = authorization();
    const root = String.raw`\\wsl$\Ubuntu\home\Foo`;
    await assert.rejects(
      () => assertAuthorizedFilePath(String.raw`\\wsl$\Ubuntu\home\foo\private.md`, [root], mode, mode),
      (error) => error.code === "FILE_PATH_NOT_AUTHORIZED",
    );
    const descendant = String.raw`\\wsl$\Ubuntu\home\Foo\docs\guide.md`;
    assert.equal(await assertAuthorizedFilePath(descendant, [root], mode, mode), descendant);
  });

  test(`WSL file ${mode} authorization accepts equivalent host aliases and distro casing`, async () => {
    const { assertAuthorizedFilePath } = authorization();
    const root = String.raw`\\wsl.localhost\Ubuntu\home\Foo`;
    const descendant = String.raw`\\WSL$\ubuntu\home\Foo\docs\guide.md`;
    assert.equal(await assertAuthorizedFilePath(descendant, [root], mode, mode), descendant);
    await assert.rejects(
      () => assertAuthorizedFilePath(descendant.replace("ubuntu", "Debian"), [root], mode, mode),
      (error) => error.code === "FILE_PATH_NOT_AUTHORIZED",
    );
  });
}

test("WSL authorization rejects a canonical parent redirected into a case-different sibling", async () => {
  const root = String.raw`\\wsl.localhost\Ubuntu\home\Foo`;
  const { assertAuthorizedFilePath } = authorization(async (value) => value.startsWith(`${root}\\linked`)
    ? value.replace("\\home\\Foo\\linked", "\\home\\foo") : value);
  await assert.rejects(
    () => assertAuthorizedFilePath(`${root}\\linked\\secret.md`, [root], "read"),
    (error) => error.code === "FILE_PATH_NOT_AUTHORIZED",
  );
});

test("file authorization retains case-insensitive local Windows drive semantics", async () => {
  const { assertAuthorizedFilePath } = authorization();
  const target = String.raw`c:\PROJECT\docs\guide.md`;
  assert.equal(await assertAuthorizedFilePath(target, [String.raw`C:\project`], "read"), target);
});
