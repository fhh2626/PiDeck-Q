import assert from "node:assert/strict";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { backendTestAvailability, createFakePi, startBackendSession } from "./helpers/native2BackendHarness.mjs";
import { writeSessionFile } from "./helpers/native2RuntimeEvents.mjs";

const { skip } = backendTestAvailability();

/** Real bridge requests stay unfinished until this fixture explicitly responds. */
async function fixture(t) {
  let file;
  const f = await startBackendSession(t, {
    hostHandlers: { "shell.trashItem": () => undefined, "shell.openExternal": () => undefined },
    prepare(directory) {
      const project = join(directory.root, "project");
      mkdirSync(project);
      writeFileSync(join(directory.userData, "projects.json"), JSON.stringify([
        { id: "host-timeout", path: project, name: "Host timeout", environment: "windows" },
      ]));
      const agentDir = join(directory.home, ".pi", "agent");
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(join(agentDir, "trust.json"), JSON.stringify({ [project]: true }));
      file = writeSessionFile(directory.sessions, project, "pending-host-trash");
      const fake = createFakePi(directory, {});
      return { settings: { customPiPath: fake.shim }, env: {
        FAKE_PI_SCENARIO: fake.scenarioPath, FAKE_PI_LOG: fake.logPath,
      } };
    },
  });
  const listed = await f.invoke("sessions:catalog-list", ["host-timeout"]);
  const record = listed.payload.result.find((row) => row.filePath.replaceAll("\\", "/") === file.replaceAll("\\", "/"));
  assert.ok(record);
  return { f, file, record };
}

test("a host trash timeout cannot admit a runtime before the pending mutation settles", {
  skip,
  timeout: 60000,
}, async (t) => {
  const { f, file, record } = await fixture(t);
  const deletion = f.invoke("sessions:catalog-delete", [record.id]);
  let earlyResult;
  void deletion.then((result) => { earlyResult = result; });
  const request = await f.host.waitForRequest("shell.trashItem");
  assert.equal(request.params.path.replaceAll("\\", "/"), file.replaceAll("\\", "/"));
  assert.ok(request.params.scope.identity);
  const ordinary = f.invoke("app:open-external", ["https://example.invalid/host-timeout"]);
  await f.host.waitForRequest("shell.openExternal");

  // Exercise the real 30-second transport deadline. The host still owns the
  // already delivered destructive request and has sent no completion or refusal.
  await new Promise((resolve) => setTimeout(resolve, 32000));
  const settledBeforeHost = earlyResult;
  assert.ok(existsSync(file));
  const activation = await f.invoke("sessions:runtime-activate", [record.id]);

  // A busy host can resume the same request after the sidecar's timer. Its move
  // remains valid because the captured root and source entry have not changed.
  const moved = join(f.fixture.root, "late-host-trash.jsonl");
  renameSync(file, moved);
  f.host.respond(request.id, null);
  assert.equal(existsSync(file), false);
  assert.ok(existsSync(moved));
  if (activation.payload.result.ok) {
    const state = await f.invoke("sessions:runtime-state", [activation.payload.result.value]);
    t.diagnostic(`The late trash moved a live runtime's session file. Runtime state remained available: ${state.payload.result.ok}`);
  }
  assert.equal(activation.payload.result.ok, false,
    "A timed-out but unfinished host mutation must continue to fence the session runtime");
  assert.equal(settledBeforeHost, undefined,
    "The deletion must not report failure while its destructive host request remains unfinished");
  assert.equal((await deletion).payload.result, true,
    "The real host completion must finish the reserved catalog deletion");
  const ordinaryResult = await ordinary;
  assert.equal(ordinaryResult.payload.ok, false);
  assert.match(ordinaryResult.payload.error.message, /timed out/i,
    "Unrelated host RPCs must retain the normal request deadline");
});

test("host bridge loss settles pending trash and shuts down the backend", {
  skip,
  timeout: 20000,
}, async (t) => {
  const { f, file, record } = await fixture(t);
  const deletion = f.invoke("sessions:catalog-delete", [record.id])
    .catch((error) => ({ transportError: error.message }));
  await f.host.waitForRequest("shell.trashItem");
  f.host.socket.destroy();
  const exited = await f.backend.exited;
  assert.equal(exited.code, 1, JSON.stringify(exited));
  const settled = await deletion;
  if (settled.payload) assert.equal(settled.payload.ok, false);
  else assert.equal(typeof settled.transportError, "string");
  assert.ok(existsSync(file), "A lost bridge must not fall back to permanent deletion");
});
