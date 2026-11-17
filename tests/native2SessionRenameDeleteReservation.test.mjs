import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, constants, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import test from "node:test";
import { backendTestAvailability, startBackendSession } from "./helpers/native2BackendHarness.mjs";
import { waitFor, writeSessionFile } from "./helpers/native2RuntimeEvents.mjs";

const { skip } = backendTestAvailability();

/** Delay a real offline rename before its file write, while owner-thread requests continue. */
test("an offline rename retains its file and catalog commit against competing deletion", {
  skip: skip || (process.platform === "win32" ? "The deterministic rename gate requires a POSIX FIFO" : false),
  timeout: 20_000,
}, async (t) => {
  const f = await startBackendSession(t, {
    projects: [{ id: "rename-delete", path: process.cwd() }],
  });
  const file = writeSessionFile(f.fixture.sessions, process.cwd(), "rename-first");
  const original = readFileSync(file, "utf8");
  const records = (await f.invoke("sessions:catalog-list", ["rename-delete"])).payload.result;
  const record = records.find((item) => item.filePath === file);
  assert.ok(record);
  unlinkSync(file);
  const pipe = spawnSync("mkfifo", [file], { encoding: "utf8" });
  assert.equal(pipe.status, 0, pipe.stderr);
  const rename = f.invoke("sessions:catalog-update", [record.id, { title: "Renamed before deletion" }]);
  let writer;
  let deletion;
  try {
    writer = await waitFor(() => {
      try { return openSync(file, constants.O_WRONLY | constants.O_NONBLOCK); }
      catch (error) { if (error.code !== "ENXIO") throw error; return false; }
    }, 5000, "the rename session reader");
    deletion = f.invoke("sessions:catalog-delete", [record.id, { permanent: true }]);
    const duplicate = await f.invoke("sessions:catalog-delete", [record.id]);
    assert.equal(duplicate.payload.ok, false, JSON.stringify(duplicate.payload));
    assert.match(duplicate.payload.error.message, /delet|删除/i);
  } finally {
    if (writer !== undefined) {
      writeFileSync(writer, original);
      closeSync(writer);
    }
  }
  const renamed = await rename;
  const deleted = await deletion;
  t.diagnostic(JSON.stringify({ renamed: renamed.payload, deleted: deleted.payload, fileSurvives: existsSync(file) }));
  assert.equal(renamed.payload.ok, true, JSON.stringify(renamed.payload));
  assert.equal(renamed.payload.result.title, "Renamed before deletion");
  assert.equal(deleted.payload.ok && deleted.payload.result === true, false,
    "deletion must be refused while the rename owns its file and catalog transaction");
  const infos = readFileSync(file, "utf8").trim().split("\n").map(JSON.parse)
    .filter((entry) => entry.type === "session_info");
  assert.equal(infos.at(-1).name, "Renamed before deletion");
  const current = (await f.invoke("sessions:catalog-list", ["rename-delete", { scan: false }])).payload.result;
  assert.equal(current.find((entry) => entry.id === record.id).title, "Renamed before deletion");
  // A completed rename releases the reservation before the caller can retry.
  const retry = await f.invoke("sessions:catalog-delete", [record.id, { permanent: true }]);
  assert.equal(retry.payload.ok, true, JSON.stringify(retry.payload));
  assert.equal(retry.payload.result, true);
  assert.equal(existsSync(file), false);
});

test("a failed offline rename releases its catalog reservation before a deletion retry", { skip }, async (t) => {
  const f = await startBackendSession(t, {
    projects: [{ id: "rename-failure-delete", path: process.cwd() }],
  });
  const file = writeSessionFile(f.fixture.sessions, process.cwd(), "rename-failure");
  const original = readFileSync(file, "utf8");
  const records = (await f.invoke("sessions:catalog-list", ["rename-failure-delete"])).payload.result;
  const record = records.find((item) => item.filePath.replaceAll("\\", "/") === file.replaceAll("\\", "/"));
  assert.ok(record);
  unlinkSync(file);
  const renamed = await f.invoke("sessions:catalog-update", [record.id, { title: "Must not be committed" }]);
  assert.equal(renamed.payload.ok, false, JSON.stringify(renamed.payload));
  const current = (await f.invoke("sessions:catalog-list", ["rename-failure-delete", { scan: false }])).payload.result;
  assert.equal(current.find((entry) => entry.id === record.id).title, record.title);
  writeFileSync(file, original);
  const deleted = await f.invoke("sessions:catalog-delete", [record.id, { permanent: true }]);
  assert.equal(deleted.payload.ok, true, JSON.stringify(deleted.payload));
  assert.equal(deleted.payload.result, true);
  assert.equal(existsSync(file), false);
});
