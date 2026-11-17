import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { backendTestAvailability, startBackendSession } from "./helpers/native2BackendHarness.mjs";
import { writeSessionFile } from "./helpers/native2RuntimeEvents.mjs";

const { skip } = backendTestAvailability();

test("native deletion preserves Unicode paths across filesystem probes and enumeration", { skip }, async (t) => {
  let file, backup, companion, peer;
  const f = await startBackendSession(t, {
    prepare(directory) {
      const project = join(directory.root, "项目-🌲");
      const history = join(directory.sessions, "历史-😀");
      mkdirSync(project);
      mkdirSync(history);
      writeFileSync(join(directory.userData, "projects.json"), JSON.stringify([
        { id: "unicode-deletion", path: project, name: "Unicode deletion", environment: "windows" },
      ]));
      file = writeSessionFile(history, project, "会话-😀");
      backup = `${file}.1700000000000-11111111-2222-4333-8444-555555555555.edit-backup`;
      writeFileSync(backup, "owned backup");
      companion = file.slice(0, -6);
      mkdirSync(companion);
      writeFileSync(join(companion, "输出-😀.txt"), "owned companion output");
      peer = writeSessionFile(history, project, "保留-🌲");
    },
  });
  const originalPeer = readFileSync(peer, "utf8");
  const listed = await f.invoke("sessions:catalog-list", ["unicode-deletion"]);
  assert.equal(listed.payload.ok, true, JSON.stringify(listed.payload));
  const record = listed.payload.result.find((row) => row.filePath.replaceAll("\\", "/") === file.replaceAll("\\", "/"));
  assert.ok(record);
  const deleted = await f.invoke("sessions:catalog-delete", [record.id, { permanent: true }]);
  assert.equal(deleted.payload.result, true, JSON.stringify(deleted.payload));
  for (const path of [file, backup, companion]) assert.equal(existsSync(path), false);
  assert.equal(readFileSync(peer, "utf8"), originalPeer);
});
