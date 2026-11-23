import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { resolveBackendExecutable, startBackendSession } from "./helpers/native2BackendHarness.mjs";

const executable = resolveBackendExecutable();
const runId = "11111111-2222-4333-8444-555555555555";

/** Peer enumeration cannot discard ownership when a POSIX filename has no UTF-8 spelling. */
for (const [label, name, invalid] of [
  ["non-UTF-8 bytes", Buffer.concat([Buffer.from("peer"), Buffer.from([0xff]), Buffer.from(".jsonl")]), true],
  ["a literal replacement character", "peer\uFFFD.jsonl", false],
]) test(`native peer filenames containing ${label} preserve shared artifacts`, {
  skip: invalid && process.platform !== "linux" ? "The raw-byte filename fixture requires Linux" : !executable,
}, async (t) => {
  const project = process.cwd();
  const contents = (id) => [
    { type: "session", id, version: 3, cwd: project, timestamp: "2026-01-01T00:00:00.000Z" },
    { type: "message", id: "r1", message: { role: "toolResult", toolName: "subagent", details: { mode: "single", runId } } },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  const f = await startBackendSession(t, { projects: [{ id: "raw-peer", path: project }] });
  const target = join(f.fixture.sessions, "target.jsonl");
  writeFileSync(target, contents("target"));
  const listed = await f.invoke("sessions:catalog-list", ["raw-peer"]);
  const record = listed.payload.result?.find((entry) => entry.filePath.replaceAll("\\", "/") === target.replaceAll("\\", "/"));
  assert.ok(record, JSON.stringify(listed.payload));
  const peer = Buffer.isBuffer(name)
    ? Buffer.concat([Buffer.from(`${f.fixture.sessions}/`), name]) : join(f.fixture.sessions, name);
  const peerContents = contents("peer");
  writeFileSync(peer, peerContents);
  const artifacts = join(f.fixture.sessions, "subagent-artifacts");
  mkdirSync(artifacts);
  const shared = join(artifacts, `${runId}_shared.txt`);
  writeFileSync(shared, "peer-owned output");
  const deleted = await f.invoke("sessions:catalog-delete", [record.id, { permanent: true }]);
  assert.equal(readFileSync(peer, "utf8"), peerContents);
  assert.equal(existsSync(shared), true, `A peer's output must survive deletion: ${JSON.stringify(deleted.payload)}`);
  assert.equal(readFileSync(shared, "utf8"), "peer-owned output");
  assert.equal(deleted.payload.ok, !invalid, JSON.stringify(deleted.payload));
  assert.equal(existsSync(target), invalid);
  if (!invalid) assert.equal(deleted.payload.result, true);
});
