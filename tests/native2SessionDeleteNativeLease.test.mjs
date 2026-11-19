import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { backendTestAvailability, createFakePi, startBackendSession } from "./helpers/native2BackendHarness.mjs";
import { waitFor, writeSessionFile } from "./helpers/native2RuntimeEvents.mjs";

const { skip } = backendTestAvailability();

/** Give catalog rows both configured-alias and physical spellings of one disposable tree. */
async function fixture(t, holdTrash = false, linkedCompanion = false) {
  let alias, otherRoot, parent, child, unrelated, settingsFile, project;
  const f = await startBackendSession(t, {
    projects: [{ id: "native-lease", path: process.cwd() }],
    hostHandlers: holdTrash ? { "shell.trashItem": () => undefined } : {},
    prepare(directory) {
      project = join(directory.root, "project");
      mkdirSync(join(project, ".pi"), { recursive: true });
      writeFileSync(join(directory.userData, "projects.json"), JSON.stringify([
        { id: "native-lease", path: project, name: "Native lease", environment: "windows" },
      ]));
      alias = join(directory.root, "configured-session-root-alias-longer-than-default");
      otherRoot = join(directory.root, "replacement-root");
      mkdirSync(otherRoot);
      symlinkSync(directory.sessions, alias, process.platform === "win32" ? "junction" : "dir");
      settingsFile = join(project, ".pi", "settings.json");
      writeFileSync(settingsFile, JSON.stringify({ sessionDir: alias }));
      parent = writeSessionFile(directory.sessions, project, "parent");
      if (linkedCompanion) {
        const referent = join(directory.root, "first-companion-tree");
        mkdirSync(referent);
        symlinkSync(referent, parent.slice(0, -6), process.platform === "win32" ? "junction" : "dir");
      } else {
        mkdirSync(parent.slice(0, -6));
      }
      child = writeSessionFile(parent.slice(0, -6), project, "child");
      unrelated = writeSessionFile(directory.sessions, project, "unrelated");
      const sessions = [["parent", join(alias, "parent.jsonl")], ["child", child], ["unrelated", unrelated]]
        .map(([id, filePath]) => ({ id, filePath, projectId: "native-lease", title: id,
          environment: "native", source: "pi", originKey: `lease-${id}`, status: "active", createdAt: 1, updatedAt: 1 }));
      writeFileSync(join(directory.userData, "session-catalog.json"), JSON.stringify({ version: 1, sessions }));
      const fake = createFakePi(directory, {});
      return { settings: { customPiPath: fake.shim }, env: { FAKE_PI_SCENARIO: fake.scenarioPath, FAKE_PI_LOG: fake.logPath } };
    },
  });
  const retarget = (root = otherRoot) => {
    unlinkSync(alias);
    symlinkSync(root, alias, process.platform === "win32" ? "junction" : "dir");
  };
  return { ...f, alias, otherRoot, parent, child, unrelated, settingsFile, project, retarget };
}

test("a native deletion retains its physical runtime fence after a configured root alias changes", { skip }, async (t) => {
  const f = await fixture(t, true);
  const deletion = f.invoke("sessions:catalog-delete", ["parent"]);
  const pending = await f.host.waitForRequest("shell.trashItem");
  try {
    assert.equal(pending.params.path.replaceAll("\\", "/"), f.parent.slice(0, -6).replaceAll("\\", "/"));
    assert.equal((await f.invoke("sessions:runtime-activate", ["child"])).payload.result.ok, false);
    f.retarget();
    const blocked = await f.invoke("sessions:runtime-activate", ["child"]);
    assert.equal(blocked.payload.result.ok, false, JSON.stringify(blocked.payload));
    const independent = await f.invoke("sessions:runtime-activate", ["unrelated"]);
    assert.equal(independent.payload.result.ok, true, JSON.stringify(independent.payload));
  } finally {
    f.host.respond(pending.id, { status: "trash-failed" });
    assert.equal((await deletion).payload.result.status, "trash-failed");
  }
  const retry = await f.invoke("sessions:runtime-activate", ["child"]);
  assert.equal(retry.payload.result.ok, true, JSON.stringify(retry.payload));
  assert.ok(existsSync(f.parent));
});

for (const linked of [true, false]) {
  test(`a native lease protects its companion entry after replacement with ${linked ? "another link" : "a real directory"}`, { skip }, async (t) => {
    const f = await fixture(t, true, true);
    const deletion = f.invoke("sessions:catalog-delete", ["parent"]);
    const pending = await f.host.waitForRequest("shell.trashItem");
    try {
      const companion = f.parent.slice(0, -6);
      assert.equal(pending.params.path.replaceAll("\\", "/"), companion.replaceAll("\\", "/"));
      assert.equal((await f.invoke("sessions:runtime-activate", ["child"])).payload.result.ok, false);
      // The planned entry stays inside the old physical root even if both the
      // configured root alias and the companion entry later change their targets.
      f.retarget();
      unlinkSync(companion);
      if (linked) symlinkSync(f.otherRoot, companion, process.platform === "win32" ? "junction" : "dir");
      else mkdirSync(companion);
      writeSessionFile(companion, f.project, "child");
      const activation = await f.invoke("sessions:runtime-activate", ["child"]);
      assert.equal(activation.payload.result.ok, false, JSON.stringify(activation.payload));
    } finally {
      f.host.respond(pending.id, { status: "trash-failed" });
      assert.equal((await deletion).payload.result.status, "trash-failed");
    }
    assert.ok(existsSync(f.child));
  });
}

for (const permanent of [false, true]) {
  for (const caseOnly of [false, true]) test(`native ${permanent ? "permanent" : "trash"} deletion rejects ${caseOnly ? "a case-only" : "a"} root alias change between admission and planning`, {
    skip: skip || (process.platform === "win32" ? "The deterministic settings gate requires a POSIX FIFO" : false),
  }, async (t) => {
    const f = await fixture(t);
    const destination = caseOnly ? join(f.fixture.root, "SESSIONS") : f.otherRoot;
    if (caseOnly) {
      if (existsSync(destination)) return t.skip("The fixture volume is case insensitive");
      mkdirSync(destination);
    }
    const otherFile = writeSessionFile(destination, f.project, "parent");
    const original = readFileSync(otherFile, "utf8");
    // A blocking settings read pauses the ordinary deletionStorage call after its
    // runtime reservation, without adding a test-only hook to production code.
    unlinkSync(f.settingsFile);
    const pipe = spawnSync("mkfifo", [f.settingsFile], { encoding: "utf8" });
    assert.equal(pipe.status, 0, pipe.stderr);
    const deletion = f.invoke("sessions:catalog-delete", ["parent", { permanent }]);
    let writer;
    try {
      writer = await waitFor(() => {
        try { return openSync(f.settingsFile, constants.O_WRONLY | constants.O_NONBLOCK); }
        catch (error) { if (error.code !== "ENXIO") throw error; return false; }
      }, 5000, "deletion settings reader");
      f.retarget(destination);
      writeFileSync(writer, JSON.stringify({ sessionDir: f.alias }));
    } finally {
      if (writer !== undefined) closeSync(writer);
    }
    const result = await deletion;
    assert.equal(result.payload.ok, false, JSON.stringify(result.payload));
    assert.equal(readFileSync(otherFile, "utf8"), original);
    assert.ok(existsSync(f.parent));
    assert.ok(existsSync(f.child));
    assert.equal(f.trashCalls.length, 0);
    unlinkSync(f.settingsFile);
    writeFileSync(f.settingsFile, JSON.stringify({ sessionDir: f.alias }));
  });
}
