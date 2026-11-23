import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import test from "node:test";
import { backendTestAvailability, startBackendSession } from "./helpers/native2BackendHarness.mjs";
import { waitFor, writeSessionFile } from "./helpers/native2RuntimeEvents.mjs";

const { skip } = backendTestAvailability();

/** Keep the archive's public mutation in flight after the file move and before its catalog commit. */
test("an archive already moving a session settles before competing deletion", {
  skip: skip || (process.platform === "win32" ? "The deterministic archive gate requires a POSIX FIFO" : false),
  timeout: 20_000,
}, async (t) => {
  const f = await startBackendSession(t, {
    projects: [{ id: "archive-delete", path: process.cwd() }],
  });
  const file = writeSessionFile(f.fixture.sessions, process.cwd(), "archive-first");
  const original = readFileSync(file, "utf8");
  const records = (await f.invoke("sessions:catalog-list", ["archive-delete"])).payload.result;
  const record = records.find((item) => item.filePath === file);
  assert.ok(record);
  const archiveDirectory = join(f.fixture.sessions, ".pideck-archive");
  mkdirSync(archiveDirectory);
  const index = join(archiveDirectory, "index.json");
  const pipe = spawnSync("mkfifo", [index], { encoding: "utf8" });
  assert.equal(pipe.status, 0, pipe.stderr);
  const archive = f.invoke("sessions:catalog-archive", [record.id]);
  let writer;
  let deletion;
  try {
    writer = await waitFor(() => {
      try { return openSync(index, constants.O_WRONLY | constants.O_NONBLOCK); }
      catch (error) { if (error.code !== "ENXIO") throw error; return false; }
    }, 5000, "the archive index reader after its file move");
    assert.equal(existsSync(file), false);
    assert.equal(readFileSync(join(archiveDirectory, basename(file)), "utf8"), original);
    deletion = f.invoke("sessions:catalog-delete", [record.id]);
    // Repeated deletion requests must remain refused while the archive owns
    // its file operation, including before the index read can complete.
    const duplicate = await f.invoke("sessions:catalog-delete", [record.id]);
    assert.equal(duplicate.payload.ok, false, JSON.stringify(duplicate.payload));
    assert.match(duplicate.payload.error.message, /delet|删除/i);
  } finally {
    if (writer !== undefined) {
      writeFileSync(writer, "{}");
      closeSync(writer);
    }
  }
  const archived = await archive;
  const deleted = await deletion;
  t.diagnostic(JSON.stringify({ archived: archived.payload, deleted: deleted.payload,
    archivedFileSurvives: existsSync(join(archiveDirectory, basename(file))) }));
  assert.equal(archived.payload.ok, true, JSON.stringify(archived.payload));
  assert.equal(archived.payload.result, true);
  assert.equal(deleted.payload.ok && deleted.payload.result === true, false,
    "a concurrent delete must not claim the archive's file was deleted");
  assert.equal(readFileSync(join(archiveDirectory, basename(file)), "utf8"), original);
});

test("a failed archive releases its catalog reservation before a deletion retry", { skip }, async (t) => {
  const f = await startBackendSession(t, {
    projects: [{ id: "archive-failure-delete", path: process.cwd() }],
  });
  const file = writeSessionFile(f.fixture.sessions, process.cwd(), "archive-failure");
  const original = readFileSync(file, "utf8");
  const records = (await f.invoke("sessions:catalog-list", ["archive-failure-delete"])).payload.result;
  const record = records.find((item) => item.filePath.replaceAll("\\", "/") === file.replaceAll("\\", "/"));
  assert.ok(record);
  writeFileSync(join(f.fixture.sessions, ".pideck-archive"), "archive directory is unavailable");
  const archived = await f.invoke("sessions:catalog-archive", [record.id]);
  assert.equal(archived.payload.ok, false, JSON.stringify(archived.payload));
  assert.equal(readFileSync(file, "utf8"), original);
  const deleted = await f.invoke("sessions:catalog-delete", [record.id, { permanent: true }]);
  assert.equal(deleted.payload.ok, true, JSON.stringify(deleted.payload));
  assert.equal(deleted.payload.result, true);
  assert.equal(existsSync(file), false);
});
