import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { backendTestAvailability, createFakePi, startBackendSession } from "./helpers/native2BackendHarness.mjs";
import { waitFor, writeSessionFile } from "./helpers/native2RuntimeEvents.mjs";

const { skip } = backendTestAvailability();
const PROJECT_ID = "unknown-native-runtime";

/** A new persistent runtime has no catalog path until pi publishes its first file. */
async function fixture(t, noSession, holdTrash = false) {
  let fake, parent, child;
  const f = await startBackendSession(t, {
    hostHandlers: holdTrash ? { "shell.trashItem": () => undefined } : {},
    prepare(directory) {
      const project = join(directory.root, "project");
      mkdirSync(project);
      writeFileSync(join(directory.userData, "projects.json"), JSON.stringify([
        { id: PROJECT_ID, path: project, name: "Unknown native runtime", environment: "windows" },
      ]));
      parent = writeSessionFile(directory.sessions, project, "parent");
      mkdirSync(parent.slice(0, -6));
      child = writeSessionFile(parent.slice(0, -6), project, "child");
      fake = createFakePi(directory, {});
      return { settings: { customPiPath: fake.shim }, env: { FAKE_PI_SCENARIO: fake.scenarioPath, FAKE_PI_LOG: fake.logPath } };
    },
  });
  const listed = await f.invoke("sessions:catalog-list", [PROJECT_ID]);
  assert.equal(listed.payload.ok, true, JSON.stringify(listed.payload));
  const record = listed.payload.result.find((entry) => entry.filePath.replaceAll("\\", "/") === parent.replaceAll("\\", "/"));
  assert.ok(record, "the parent is available for public catalog deletion");
  const created = await f.invoke(noSession ? "sessions:create-anonymous" : "sessions:catalog-create-draft", [
    { projectId: PROJECT_ID, title: "Unknown file" },
  ]);
  assert.equal(created.payload.ok, true, JSON.stringify(created.payload));
  const draft = noSession ? created.payload.result.session : created.payload.result;
  assert.equal(draft.filePath ?? "", "");
  assert.equal(draft.noSession ?? false, noSession);
  return { ...f, fake, parent, child, record, draft };
}

for (const noSession of [false, true]) {
  test(`native deletion ${noSession ? "allows an in-memory" : "refuses an unknown persistent"} runtime during get_state`, { skip }, async (t) => {
    const f = await fixture(t, noSession);
    const original = readFileSync(f.child, "utf8");
    writeFileSync(f.fake.scenarioPath, JSON.stringify({
      state: noSession ? {} : { sessionFile: f.child },
      responses: { get_state: { replyGate: "state" } },
    }));
    const activation = f.invoke("sessions:runtime-activate", [f.draft.id]);
    let deletion, activated;
    try {
      await waitFor(() => f.fake.commands().some((entry) => entry.command === "get_state"), 15_000, "pending runtime state");
      deletion = await f.invoke("sessions:catalog-delete", [f.record.id, { permanent: true }]);
    } finally {
      writeFileSync(`${f.fake.scenarioPath}.state`, "release");
      activated = await activation;
    }
    assert.equal(activated.payload.result.ok, true, JSON.stringify(activated.payload));
    assert.equal(deletion.payload.ok, noSession, JSON.stringify(deletion.payload));
    if (noSession) {
      assert.equal(existsSync(f.parent), false);
      assert.equal(existsSync(f.child), false);
    } else {
      assert.equal(readFileSync(f.child, "utf8"), original);
      assert.ok(existsSync(f.parent));
    }
  });

  test(`native deletion ${noSession ? "allows an in-memory" : "blocks an unknown persistent"} activation until its lease settles`, { skip }, async (t) => {
    const f = await fixture(t, noSession, true);
    const deletion = f.invoke("sessions:catalog-delete", [f.record.id]);
    const pending = await f.host.waitForRequest("shell.trashItem");
    try {
      const activation = await f.invoke("sessions:runtime-activate", [f.draft.id]);
      assert.equal(activation.payload.result.ok, noSession, JSON.stringify(activation.payload));
      if (!noSession) assert.equal(f.fake.readLog().some((entry) => entry.kind === "spawn"), false);
    } finally {
      f.host.respond(pending.id, { status: "trash-failed" });
      assert.equal((await deletion).payload.result.status, "trash-failed");
    }
    const retry = await f.invoke("sessions:runtime-activate", [f.draft.id]);
    assert.equal(retry.payload.result.ok, true, JSON.stringify(retry.payload));
    assert.ok(existsSync(f.parent));
    assert.ok(existsSync(f.child));
  });
}

test("native deletion refuses a running persistent draft that has not reported its file yet", { skip }, async (t) => {
  const f = await fixture(t, false);
  const activation = await f.invoke("sessions:runtime-activate", [f.draft.id]);
  assert.equal(activation.payload.result.ok, true, JSON.stringify(activation.payload));
  assert.equal(activation.payload.result.value.sessionPath ?? "", "");
  const deletion = await f.invoke("sessions:catalog-delete", [f.record.id, { permanent: true }]);
  assert.equal(deletion.payload.ok, false, JSON.stringify(deletion.payload));
  assert.ok(existsSync(f.parent));
  assert.ok(existsSync(f.child));
});
