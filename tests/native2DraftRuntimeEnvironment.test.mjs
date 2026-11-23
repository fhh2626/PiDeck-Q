import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { backendTestAvailability, createFakePi, startBackendSession } from "./helpers/native2BackendHarness.mjs";
import { slash, writeSessionFile } from "./helpers/native2RuntimeEvents.mjs";

const { skip } = backendTestAvailability();
const PROJECT_ID = "draft-runtime-environment";
const SESSION_ID = "draft-from-wsl";

/** A saved empty draft can outlive the environment in which the user created it. */
async function fixture(t, reportFileImmediately) {
  let fake, filePath;
  const f = await startBackendSession(t, {
    prepare(directory) {
      const project = join(directory.root, "project");
      mkdirSync(project);
      writeFileSync(join(directory.userData, "projects.json"), JSON.stringify([
        { id: PROJECT_ID, path: project, name: "Draft environment", environment: "windows" },
      ]));
      // This is a durable draft created before the user returned to native mode.
      // No WSL process is needed to exercise the native activation and recovery.
      writeFileSync(join(directory.userData, "session-catalog.json"), JSON.stringify({
        version: 1,
        sessions: [{
          id: SESSION_ID, projectId: PROJECT_ID, title: "Saved draft", filePath: "",
          originKey: "", source: "pi", environment: "wsl", wslDistro: "Ubuntu", wslUser: "dev",
          status: "active", createdAt: 1, updatedAt: 1,
        }],
      }));
      filePath = writeSessionFile(directory.sessions, project, "native-session");
      fake = createFakePi(directory, { state: { sessionFile: reportFileImmediately ? filePath : "" } });
      return {
        settings: { wslEnabled: false, customPiPath: fake.shim },
        env: { FAKE_PI_SCENARIO: fake.scenarioPath, FAKE_PI_LOG: fake.logPath },
      };
    },
  });
  const stored = () => JSON.parse(readFileSync(join(f.fixture.userData, "session-catalog.json"), "utf8"))
    .sessions.find((entry) => entry.id === SESSION_ID);
  return { ...f, fake, filePath, stored };
}

/** Every runtime command uses the complete public identity returned by activation. */
function target(runtime) {
  return { sessionId: SESSION_ID, agentId: runtime.agentId, runtimeGeneration: runtime.runtimeGeneration };
}

for (const recovery of ["activate", "restart"]) {
  test(`a draft launched in its current native environment can ${recovery} after its file is attached`, { skip }, async (t) => {
    const f = await fixture(t, true);
    const activated = await f.invoke("sessions:runtime-activate", [SESSION_ID]);
    assert.equal(activated.payload.result.ok, true, JSON.stringify(activated.payload));
    const runtime = activated.payload.result.value;
    assert.equal(slash(runtime.sessionPath), slash(f.filePath));
    let resumed;
    if (recovery === "activate") {
      const stopped = await f.invoke("sessions:runtime-stop", [target(runtime)]);
      assert.equal(stopped.payload.result.ok, true, JSON.stringify(stopped.payload));
      resumed = await f.invoke("sessions:runtime-activate", [SESSION_ID]);
    } else {
      resumed = await f.invoke("sessions:runtime-restart", [target(runtime)]);
    }
    assert.equal(resumed.payload.result.ok, true, JSON.stringify(resumed.payload));
    const entry = f.stored();
    assert.equal(entry.environment, "native");
    assert.equal(entry.wslDistro ?? "", "");
    assert.equal(entry.wslUser ?? "", "");
    assert.match(entry.originKey, /^pi:native:/);
  });
}

test("a draft that first reports its file during restart retains the actual runtime environment", { skip }, async (t) => {
  const f = await fixture(t, false);
  const activated = await f.invoke("sessions:runtime-activate", [SESSION_ID]);
  assert.equal(activated.payload.result.ok, true, JSON.stringify(activated.payload));
  assert.equal(activated.payload.result.value.sessionPath ?? "", "");
  writeFileSync(f.fake.scenarioPath, JSON.stringify({ state: { sessionFile: f.filePath } }));
  const restarted = await f.invoke("sessions:runtime-restart", [target(activated.payload.result.value)]);
  assert.equal(restarted.payload.result.ok, true, JSON.stringify(restarted.payload));
  const resumed = await f.invoke("sessions:runtime-restart", [target(restarted.payload.result.value.runtime)]);
  assert.equal(resumed.payload.result.ok, true, JSON.stringify(resumed.payload));
  const entry = f.stored();
  assert.equal(entry.environment, "native");
  assert.equal(entry.wslDistro ?? "", "");
  assert.equal(entry.wslUser ?? "", "");
  assert.match(entry.originKey, /^pi:native:/);
});
