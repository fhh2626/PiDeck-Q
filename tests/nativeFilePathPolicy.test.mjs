import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { childPathEnvironment, environmentPath, qtBinDirectory } from "./helpers/native2BackendHarness.mjs";
import { joinPathParts } from "./helpers/native2FakeProcess.mjs";
import { nativeBuildPaths } from "./helpers/nativeBuildPaths.mjs";

const pinned = process.env.PIDECK_FILE_PATH_TEST_EXECUTABLE;
const candidates = nativeBuildPaths("PiDeck-FilePathPolicyTest", { pinned });
const sources = [
  "native/tests/FilePathPolicyTest.cpp", "xmake.lua",
  "native/backend/domain/fs/PathPolicy.cpp", "native/backend/domain/fs/PathPolicy.h",
  "native/backend/domain/wsl/WslFilePaths.cpp", "native/backend/domain/wsl/WslFilePaths.h",
  "native/backend/domain/runtime/ProjectionFilePath.h",
];
const executable = candidates.map((value) => resolve(value)).find((candidate) => existsSync(candidate)
  && sources.every((source) => statSync(candidate).mtimeMs >= statSync(source).mtimeMs));
const required = Boolean(pinned) || process.env.PIDECK_REQUIRE_BACKEND_TESTS === "1";
const skip = !executable && !required ? "Build PiDeck-FilePathPolicyTest to run current native file authorization" : false;

/** Call linked production C++ code and fail if an explicitly required fixture is missing or stale. */
function native(fixture) {
  assert.ok(executable, "A fresh PiDeck-FilePathPolicyTest executable is required");
  const env = childPathEnvironment(process.env, joinPathParts([qtBinDirectory(), environmentPath()]));
  const result = spawnSync(executable, [], { env, input: JSON.stringify(fixture), encoding: "utf8", timeout: 20_000 });
  assert.equal(result.status, 0, result.stderr || String(result.error ?? ""));
  return JSON.parse(result.stdout);
}

test("native WSL file mapping uses one host alias for Linux and existing UNC paths", { skip }, () => {
  const inputs = [
    ["/home/Foo/a.md", true, "Ubuntu", String.raw`\\wsl.localhost\Ubuntu\home\Foo\a.md`],
    [String.raw`\\wsl$\Ubuntu\home\Foo\a.md`, true, "Ubuntu", String.raw`\\wsl.localhost\Ubuntu\home\Foo\a.md`],
    ["//WSL.LOCALHOST/Ubuntu/home/Foo/a.md", false, "", String.raw`\\wsl.localhost\Ubuntu\home\Foo\a.md`],
    ["/mnt/c/project/a.md", true, "Ubuntu", String.raw`C:\project\a.md`],
    ["/mnt/c", false, "", "C:\\"],
    ["/C:/project/a.md", false, "", "C:/project/a.md"],
    [String.raw`\\server\share\a.md`, true, "Ubuntu", String.raw`\\server\share\a.md`],
    ["/home/Foo/a.md", false, "Ubuntu", "/home/Foo/a.md"],
  ];
  assert.deepEqual(native({ mappings: inputs.map(([path, enabled, distro]) => ({ path, enabled, distro })) }).mappings,
    inputs.map((entry) => entry[3]));
});

test("native WSL path authorization recognizes aliases while retaining Linux case and boundaries", { skip }, () => {
  const root = "//wsl.localhost/Ubuntu/home/Foo";
  const inputs = [
    ["//wsl$/ubuntu/home/Foo/a.md", true],
    ["//WSL.LOCALHOST/UBUNTU/home/Foo/docs/a.md", true],
    ["//wsl$/Ubuntu/home/Foo", true],
    ["//wsl$/Ubuntu/home/foo/a.md", false],
    ["//wsl.localhost/Ubuntu/home/foo/a.md", false],
    ["//wsl$/Debian/home/Foo/a.md", false],
    ["//wsl$/Ubuntu/home/Foo-other/a.md", false],
    ["//wsl$/Ubuntu/home/Foo/../foo/a.md", false],
    ["//wsl$/Ubuntu/home/Foo/docs/../a.md", true],
    ["//server/Ubuntu/home/Foo/a.md", false],
    ["//wsl$/Ubuntu/home/Foo\u0000/a.md", false],
  ];
  assert.deepEqual(native({ containment: inputs.map(([target]) => ({ target, root })) }).containment,
    inputs.map((entry) => entry[1]));
});

test("runtime file projection chooses the host path from its own session environment", { skip }, () => {
  const inputs = [
    ["/home/Foo/session.jsonl", "wsl", "Ubuntu", true, String.raw`\\wsl.localhost\Ubuntu\home\Foo\session.jsonl`],
    ["/home/Foo/session.jsonl", "wsl", "Debian", true, String.raw`\\wsl.localhost\Debian\home\Foo\session.jsonl`],
    ["/mnt/C/sessions/a.jsonl", "wsl", "Ubuntu", true, String.raw`C:\sessions\a.jsonl`],
    [String.raw`\\wsl$\Debian\home\Foo\session.jsonl`, "wsl", "Ubuntu", true,
      String.raw`\\wsl.localhost\Debian\home\Foo\session.jsonl`],
    [String.raw`C:\sessions\a.jsonl`, "native", "Ubuntu", true, String.raw`C:\sessions\a.jsonl`],
    ["/home/Foo/session.jsonl", "native", "Ubuntu", true, "/home/Foo/session.jsonl"],
    ["/home/Foo/session.jsonl", "wsl", "", true, "/home/Foo/session.jsonl"],
    ["/home/Foo/session.jsonl", "wsl", "Ubuntu", false, "/home/Foo/session.jsonl"],
    ["/mnt/C/sessions/a.jsonl", "wsl", "Ubuntu", false, "/mnt/C/sessions/a.jsonl"],
  ];
  const result = native({ projectionPaths: inputs.map(([path, environment, distro, windowsHost]) =>
    ({ path, environment, distro, windowsHost })) });
  assert.deepEqual(result.projectionPaths, inputs.map((entry) => entry[4]));
});

for (const mode of ["read", "write", "link"]) {
  test(`native ${mode} authorization skips unrelated slow roots and keeps canonical aliases`, { skip }, (t) => {
    const base = mkdtempSync(join(tmpdir(), "pideck-native-root-latency-"));
    t.after(() => rmSync(base, { recursive: true, force: true }));
    const root = join(base, "project");
    const unrelated = join(base, "unrelated-root");
    const alias = join(base, "project-alias");
    mkdirSync(root);
    mkdirSync(unrelated);
    symlinkSync(root, alias, "junction");
    const target = join(root, "document.txt");
    writeFileSync(target, "document");
    const [local, canonicalAlias] = native({ authorizations: [
      { target, roots: [unrelated, root], mode, slowRoot: unrelated.replaceAll("\\", "/"), rootDelayMs: 1500 },
      { target, roots: [alias], mode },
    ] }).authorizations;
    t.diagnostic(`authorization completed in ${local.elapsedMs} ms with a controlled 1500 ms unrelated root`);
    assert.equal(local.ok, true, JSON.stringify(local));
    assert.equal(local.rootProbes.some((path) => path === unrelated.replaceAll("\\", "/")), false);
    assert.equal(canonicalAlias.ok, true, JSON.stringify(canonicalAlias));
    const expected = mode === "link" ? resolve(target) : realpathSync(target);
    assert.equal(local.path.replaceAll("\\", "/"), expected.replaceAll("\\", "/"));
    assert.equal(canonicalAlias.path.replaceAll("\\", "/"), expected.replaceAll("\\", "/"));
  });
}

test("native lazy root authorization preserves redirected-parent and missing-path boundaries", { skip }, (t) => {
  const base = mkdtempSync(join(tmpdir(), "pideck-native-root-boundary-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, "project");
  const outside = join(base, "project-other");
  const missingRoot = join(base, "missing-root");
  mkdirSync(root);
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.txt"), "outside");
  const linked = join(root, "linked");
  symlinkSync(outside, linked, "junction");
  const fixtures = [
    { target: join(linked, "secret.txt"), roots: [root], mode: "read", allowed: false },
    { target: join(linked, "new.txt"), roots: [root], mode: "write", allowed: false },
    { target: join(linked, "secret.txt"), roots: [root], mode: "link", allowed: false },
    { target: linked, roots: [root], mode: "link", allowed: true },
    { target: join(root, "new-directory", "new.txt"), roots: [root], mode: "write", allowed: true },
    { target: join(missingRoot, "new.txt"), roots: [missingRoot], mode: "write", allowed: false },
    { target: join(outside, "secret.txt"), roots: [root], mode: "read", allowed: false },
  ];
  const result = native({ authorizations: fixtures }).authorizations;
  assert.deepEqual(result.map((entry) => entry.ok), fixtures.map((entry) => entry.allowed));
  assert.equal(result[3].path.replaceAll("\\", "/"), linked.replaceAll("\\", "/"));
  assert.equal(result[4].path.replaceAll("\\", "/"), fixtures[4].target.replaceAll("\\", "/"));
});
