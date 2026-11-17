import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { backendTestAvailability, createFakePi, SseClient, startBackendSession } from "./helpers/native2BackendHarness.mjs";
import { runtimeEnvelopes, waitFor, writeSessionFile } from "./helpers/native2RuntimeEvents.mjs";

const { skip } = backendTestAvailability();

/** A refused reconnect must retire its dead binding while the deletion lease stays held. */
test("a native deletion that refuses automatic reconnect detaches the exited runtime", { skip }, async (t) => {
  let fake, alias, companion;
  const f = await startBackendSession(t, {
    hostHandlers: { "shell.trashItem": () => undefined },
    prepare(directory) {
      const project = join(directory.root, "project");
      mkdirSync(project);
      writeFileSync(join(directory.userData, "projects.json"), JSON.stringify([
        { id: "reconnect-guard", path: project, name: "Reconnect guard", environment: "windows" },
      ]));
      const parent = writeSessionFile(directory.sessions, project, "parent");
      companion = parent.slice(0, -6);
      mkdirSync(companion);
      writeSessionFile(companion, project, "child");
      const outside = join(directory.root, "outside-runtime");
      mkdirSync(outside);
      writeSessionFile(outside, project, "child");
      alias = join(directory.root, "runtime-alias");
      symlinkSync(outside, alias, process.platform === "win32" ? "junction" : "dir");
      const runtimeFile = join(alias, "child.jsonl");
      writeFileSync(join(directory.userData, "session-catalog.json"), JSON.stringify({
        version: 1,
        sessions: [["parent", parent], ["child", runtimeFile]].map(([id, filePath]) => ({
          id, filePath, projectId: "reconnect-guard", title: id, source: "pi", environment: "native",
          originKey: id, status: "active", createdAt: 1, updatedAt: 1,
        })),
      }));
      fake = createFakePi(directory, {
        state: { sessionFile: runtimeFile },
        turns: [{ ack: true, replyGate: "exit", exitCleanlyAfterTurn: true }],
      });
      return {
        settings: { customPiPath: fake.shim },
        env: { FAKE_PI_SCENARIO: fake.scenarioPath, FAKE_PI_LOG: fake.logPath },
      };
    },
  });
  const sse = new SseClient(`${f.baseUrl}__pideck/events?token=${encodeURIComponent(f.token)}`);
  await sse.connect();
  t.after(() => sse.close());
  const activated = await f.invoke("sessions:runtime-activate", ["child"]);
  assert.equal(activated.payload.result.ok, true, JSON.stringify(activated.payload));
  const prompt = f.invoke("sessions:send-prompt", [{ sessionId: "child", requestId: "clean-exit", message: "finish" }]);
  await waitFor(() => fake.readLog().some((entry) => entry.kind === "prompt"), 5000, "pending prompt");
  const deletion = f.invoke("sessions:catalog-delete", ["parent"]);
  const pending = await f.host.waitForRequest("shell.trashItem");
  try {
    unlinkSync(alias);
    symlinkSync(companion, alias, process.platform === "win32" ? "junction" : "dir");
    writeFileSync(`${fake.scenarioPath}.exit`, "release");
    assert.equal((await prompt).payload.result.accepted, true);
    try {
      await waitFor(() => runtimeEnvelopes(sse, "child").some((event) => event.kind === "detach"),
        3000, "the refused reconnect's detach event");
    } catch (error) {
      const listed = await f.invoke("sessions:runtime-list");
      assert.fail(`${error.message}. Current runtimes ${JSON.stringify(listed.payload.result)}`);
    }
    const listed = await f.invoke("sessions:runtime-list");
    assert.equal(listed.payload.result.some((runtime) => runtime.sessionId === "child"), false,
      JSON.stringify(listed.payload));
    assert.equal(fake.readLog().filter((entry) => entry.kind === "spawn").length, 1);
  } finally {
    writeFileSync(`${fake.scenarioPath}.exit`, "release");
    await prompt;
    f.host.respond(pending.id, { status: "trash-failed" });
    assert.equal((await deletion).payload.result.status, "trash-failed");
  }
  const retry = await f.invoke("sessions:runtime-activate", ["child"]);
  assert.equal(retry.payload.result.ok, true, JSON.stringify(retry.payload));
});
