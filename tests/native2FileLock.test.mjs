import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";

/** Exercise the public lock lifecycle with real child events, without invoking PowerShell. */
function loadFileLock(spawnLock) {
  const source = readFileSync("tests/helpers/native2FileLock.mjs", "utf8")
    .replace('import { spawn } from "node:child_process";', "")
    .replace("export async function holdExclusiveFileLock", "async function holdExclusiveFileLock");
  return runInNewContext(`${source}\nholdExclusiveFileLock`, {
    spawn: spawnLock, process, setTimeout, clearTimeout,
  });
}

/** Bound failed cleanup so a regression reports an assertion instead of hanging the suite. */
async function completes(promise) {
  let timer;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), 1000); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("file lock teardown settles when its process cannot spawn", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pideck-lock-spawn-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const hold = loadFileLock(() => spawn(join(root, "missing-powershell"), [], { windowsHide: true }));
  let cleanup;
  await assert.rejects(hold({ after: (callback) => { cleanup = callback; } }, join(root, "file")), { code: "ENOENT" });
  assert.equal(await completes(cleanup()), true, "Failed startup must not leave the test after hook waiting for an exit event");
});

test("file lock release and teardown both settle after a successful readiness handshake", async () => {
  const hold = loadFileLock(() => spawn(process.execPath, ["-e", [
    "process.stdout.write('locked\\n');",
    "process.stdin.once('data', () => process.exit(0));",
  ].join("\n")], { windowsHide: true }));
  let cleanup;
  try {
    const release = await hold({ after: (callback) => { cleanup = callback; } }, "unused-fixture-path");
    assert.equal(await completes(release()), true);
  } finally {
    assert.equal(await completes(cleanup()), true);
  }
});
