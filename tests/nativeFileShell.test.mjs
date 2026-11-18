import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import test from "node:test";
import { nativeBuildPaths } from "./helpers/nativeBuildPaths.mjs";
import { childPathEnvironment, environmentPath, qtBinDirectory } from "./helpers/native2BackendHarness.mjs";

const sources = ["xmake.lua", "native/tests/NativeFileShellTest.cpp", "native/src/NativeFileShell.cpp", "native/src/NativeFileShell.h",
  "native/common/ScopedMutation.cpp", "native/common/ScopedMutation.h", "native/common/ScopedMutationPosix.cpp", "native/backend/domain/fs/EntryLink.cpp"];
const executable = nativeBuildPaths("PiDeck-NativeFileShellTest", { pinned: process.env.PIDECK_FILE_SHELL_TEST_EXECUTABLE })
  .find((candidate) => existsSync(candidate) && sources.every((source) => statSync(candidate).mtimeMs >= statSync(source).mtimeMs));
if (!executable && process.env.PIDECK_REQUIRE_BACKEND_TESTS === "1") throw new Error("Build PiDeck-NativeFileShellTest before required native tests");

test("the native shell opens directories themselves, reveals files and reports failures", { skip: !executable }, () => {
  const env = childPathEnvironment(process.env, [qtBinDirectory(), environmentPath()].filter(Boolean).join(process.platform === "win32" ? ";" : ":"));
  const result = spawnSync(executable, [], { env, encoding: "utf8", timeout: 5000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});
