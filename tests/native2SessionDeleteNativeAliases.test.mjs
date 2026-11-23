import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { backendTestAvailability, createFakePi, startBackendSession } from "./helpers/native2BackendHarness.mjs";
import { waitFor, writeSessionFile } from "./helpers/native2RuntimeEvents.mjs";

const { skip } = backendTestAvailability();

/** Keep every alias and runtime inside one disposable backend fixture. */
async function fixture(t, holdTrash = false) {
  let fake;
  const f = await startBackendSession(t, {
    projects: [{ id: "native-alias", path: process.cwd() }],
    hostHandlers: holdTrash ? { "shell.trashItem": () => undefined } : {},
    prepare: (directory) => {
      fake = createFakePi(directory, {});
      return { settings: { customPiPath: fake.shim }, env: { FAKE_PI_SCENARIO: fake.scenarioPath, FAKE_PI_LOG: fake.logPath } };
    },
  });
  const parent = writeSessionFile(f.fixture.sessions, process.cwd(), "parent");
  const unrelated = writeSessionFile(f.fixture.sessions, process.cwd(), "unrelated");
  const companion = parent.slice(0, -6);
  mkdirSync(companion);
  const listed = await f.invoke("sessions:catalog-list", ["native-alias"]);
  const record = (path) => listed.payload.result.find((row) => row.filePath.replaceAll("\\", "/") === path.replaceAll("\\", "/"));
  const parentRecord = record(parent), otherRecord = record(unrelated);
  assert.ok(parentRecord); assert.ok(otherRecord);
  return { ...f, fake, parent, unrelated, companion, parentRecord, otherRecord };
}

for (const nested of [false, true]) {
  test(`a live native companion alias protects ${nested ? "a nested" : "the same"} deletion tree`, { skip }, async (t) => {
    const f = await fixture(t);
    const liveCompanion = nested ? join(f.companion, "live-companion") : f.companion;
    mkdirSync(liveCompanion, { recursive: true });
    const sentinel = join(liveCompanion, "live-output.txt");
    writeFileSync(sentinel, "live session data");
    symlinkSync(liveCompanion, f.unrelated.slice(0, -6), process.platform === "win32" ? "junction" : "dir");
    const activated = await f.invoke("sessions:runtime-activate", [f.otherRecord.id]);
    assert.equal(activated.payload.result.ok, true, JSON.stringify(activated.payload));
    const result = await f.invoke("sessions:catalog-delete", [f.parentRecord.id, { permanent: true }]);
    assert.equal(result.payload.ok, false, JSON.stringify(result.payload));
    assert.equal(readFileSync(sentinel, "utf8"), "live session data");
    assert.ok(existsSync(f.parent));
    assert.equal(f.trashCalls.length, 0);
  });
}

test("an in-flight native deletion blocks companion alias activation and releases it after refusal", { skip }, async (t) => {
  const f = await fixture(t, true);
  symlinkSync(f.companion, f.unrelated.slice(0, -6), process.platform === "win32" ? "junction" : "dir");
  const deletion = f.invoke("sessions:catalog-delete", [f.parentRecord.id]);
  const pending = await f.host.waitForRequest("shell.trashItem");
  try {
    const activation = await f.invoke("sessions:runtime-activate", [f.otherRecord.id]);
    assert.equal(activation.payload.result.ok, false, JSON.stringify(activation.payload));
  } finally {
    f.host.respond(pending.id, { status: "trash-failed" });
    assert.equal((await deletion).payload.result.status, "trash-failed");
  }
  const retry = await f.invoke("sessions:runtime-activate", [f.otherRecord.id]);
  assert.equal(retry.payload.result.ok, true, JSON.stringify(retry.payload));
});

test("a native reported alias path protects its live file before catalog binding", { skip }, async (t) => {
  const f = await fixture(t);
  const child = writeSessionFile(f.companion, process.cwd(), "child");
  const alias = join(f.fixture.root, "sessions-alias");
  symlinkSync(f.fixture.sessions, alias, process.platform === "win32" ? "junction" : "dir");
  writeFileSync(f.fake.scenarioPath, JSON.stringify({
    state: { sessionFile: join(alias, "parent", "child.jsonl") },
    responses: { get_messages: { replyGate: "projection" } },
  }));
  const activation = f.invoke("sessions:runtime-activate", [f.otherRecord.id]);
  let deletion;
  try {
    await waitFor(() => f.fake.commands().some((row) => row.command === "get_messages"), 5000, "projection gate");
    deletion = await f.invoke("sessions:catalog-delete", [f.parentRecord.id, { permanent: true }]);
  } finally {
    writeFileSync(`${f.fake.scenarioPath}.projection`, "release");
    assert.equal((await activation).payload.result.ok, true);
  }
  assert.equal(deletion.payload.ok, false, JSON.stringify(deletion.payload));
  assert.ok(existsSync(child));
  assert.ok(existsSync(f.parent));
});
