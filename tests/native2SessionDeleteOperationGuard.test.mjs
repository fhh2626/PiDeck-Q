import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { backendTestAvailability, encodeFrame, startBackendSession } from "./helpers/native2BackendHarness.mjs";

const { executable, skip } = backendTestAvailability();
if (!executable) test("late native trash parent replacement", { skip }, () => {});
else test("a later trash parent swap is an authorization error, never permanent-delete consent", async (t) => {
  const calls = [];
  const f = await startBackendSession(t, {
    projects: [{ id: "late-parent", path: process.cwd() }],
    hostHandlers: { "shell.trashItem": (params) => { calls.push(params); return undefined; } },
  });
  const file = join(f.fixture.sessions, "late-parent.jsonl");
  const run = "a806d39d-91e8-4b18-9299-8e7884e16df3";
  writeFileSync(file, [
    { type: "session", version: 3, id: "late-parent", cwd: process.cwd() },
    { type: "message", message: { role: "toolResult", toolName: "subagent", details: { mode: "single", runId: run } } },
  ].map(JSON.stringify).join("\n") + "\n");
  const backup = `${file}.1700000000000-3ae3b95b-c5d2-42e1-8e79-72327678b2cb.edit-backup`;
  writeFileSync(backup, "backup");
  const outputs = join(f.fixture.sessions, "subagent-artifacts", "outputs");
  const outside = join(f.fixture.root, "outside");
  mkdirSync(outputs, { recursive: true }); mkdirSync(outside);
  const name = `${run}.md`;
  writeFileSync(join(outputs, name), "owned artifact");
  writeFileSync(join(outside, name), "outside sentinel");
  const record = (await f.invoke("sessions:catalog-list", ["late-parent"])).payload.result.find((row) => row.filePath.replaceAll("\\", "/") === file.replaceAll("\\", "/"));
  assert.ok(record);
  const deletion = f.invoke("sessions:catalog-delete", [record.id]);
  const pending = await f.host.waitForRequest("shell.trashItem");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path.replaceAll("\\", "/"), backup.replaceAll("\\", "/"));
  assert.equal(typeof calls[0].scope.identity, "string");
  renameSync(outputs, `${outputs}.saved`);
  symlinkSync(outside, outputs, process.platform === "win32" ? "junction" : "dir");
  f.host.socket.write(encodeFrame({ type: "response", id: pending.id, ok: true, result: null }));
  const result = await deletion;
  assert.equal(result.payload.ok, false, JSON.stringify(result.payload));
  assert.match(result.payload.error.message, /authoriz/i);
  assert.equal(calls.length, 1);
  assert.equal(readFileSync(join(outside, name), "utf8"), "outside sentinel");
  assert.ok(existsSync(file));
  unlinkSync(outputs); renameSync(`${outputs}.saved`, outputs);
  f.host.handlers["shell.trashItem"] = () => ({ result: { status: "trash-failed" } });
  assert.equal((await f.invoke("sessions:catalog-delete", [record.id])).payload.result.status, "trash-failed");
});

if (executable) test("native deletion carries configured root authority, not an implicit nested-parent grant", async (t) => {
  const calls = [];
  const f = await startBackendSession(t, {
    projects: [{ id: "root-authority", path: process.cwd() }],
    hostHandlers: { "shell.trashItem": (params) => { calls.push(params); return { result: { status: "trash-failed" } }; } },
  });
  const nested = join(f.fixture.sessions, "nested-sessions"); mkdirSync(nested);
  const file = join(nested, "authority.jsonl");
  writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: "authority", cwd: process.cwd() }) + "\n");
  const record = (await f.invoke("sessions:catalog-list", ["root-authority"])).payload.result.find((row) => row.filePath.replaceAll("\\", "/") === file.replaceAll("\\", "/"));
  assert.ok(record);
  assert.equal((await f.invoke("sessions:catalog-delete", [record.id])).payload.result.status, "trash-failed");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].scope.root.replaceAll("\\", "/"), f.fixture.sessions.replaceAll("\\", "/"));
  assert.ok(existsSync(file));
});
