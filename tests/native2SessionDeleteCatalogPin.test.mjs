import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveBackendExecutable, startBackendSession } from "./helpers/native2BackendHarness.mjs";
import { writeSessionFile } from "./helpers/native2RuntimeEvents.mjs";

if (resolveBackendExecutable()) {
  for (const refused of [true, false]) {
    test(`deletion pins catalog identity across a competing project scan (${refused ? "refusal" : "commit"})`, async (t) => {
      const f = await startBackendSession(t, {
        projects: [{ id: "pin-a", path: process.cwd() }, { id: "pin-b", path: process.cwd() }],
        hostHandlers: { "shell.trashItem": () => undefined },
      });
      const file = writeSessionFile(f.fixture.sessions, process.cwd(), "catalog-pin");
      const records = (await f.invoke("sessions:catalog-list", ["pin-a"])).payload.result;
      const record = records.find((row) => row.filePath.replaceAll("\\", "/") === file.replaceAll("\\", "/"));
      assert.ok(record);
      const deletion = f.invoke("sessions:catalog-delete", [record.id]);
      const pending = await f.host.waitForRequest("shell.trashItem");
      try {
        const scanned = await f.invoke("sessions:catalog-list", ["pin-b"]);
        assert.equal(scanned.payload.ok, true);
        assert.equal(scanned.payload.result.some((row) => row.id === record.id), false,
          "a scan must not move the reserved identity to another project");
      } finally { f.host.respond(pending.id, refused ? { status: "trash-failed" } : null); }
      const completed = await deletion;
      assert.equal(completed.payload.ok, true, JSON.stringify(completed.payload));
      if (refused) {
        assert.deepEqual(completed.payload.result, { status: "trash-failed" });
        const after = await f.invoke("sessions:catalog-list", ["pin-b"]);
        assert.ok(after.payload.result.some((row) => row.id === record.id && row.projectId === "pin-b"),
          "refusal must release the pin so a later valid scan can update ownership");
      } else {
        assert.equal(completed.payload.result, true);
        for (const projectId of ["pin-a", "pin-b"]) {
          const after = await f.invoke("sessions:catalog-list", [projectId, { scan: false }]);
          assert.equal(after.payload.ok, true);
          assert.equal(after.payload.result.some((row) => row.id === record.id), false);
        }
      }
    });
  }
}
