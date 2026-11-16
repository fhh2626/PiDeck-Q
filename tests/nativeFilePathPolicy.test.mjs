import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
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
