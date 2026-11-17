import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { nativeBuildPaths } from "./helpers/nativeBuildPaths.mjs";
import { resolveBackendExecutable, startBackendSession } from "./helpers/native2BackendHarness.mjs";

const launcher = nativeBuildPaths("PiDeck-FakeWsl").map((path) => join(process.cwd(), path)).find(existsSync);
const backend = resolveBackendExecutable();
const skip = !backend || !launcher ? "WSL entry framing requires the native backend and FakeWsl" : false;
const linuxHome = "/home/dev";
const linuxRoot = `${linuxHome}/.pi/agent/sessions`;
const runId = "11111111-2222-4333-8444-555555555555";

/** Create real files behind the fake distribution and discover them through the catalog RPC. */
async function fixture(t) {
  let sessions;
  const project = process.cwd();
  const contents = (id) => [
    { type: "session", id, version: 3, cwd: project, timestamp: "2026-01-01T00:00:00.000Z" },
    { type: "message", id: "r1", message: { role: "toolResult", toolName: "subagent", details: { mode: "single", runId } } },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  const f = await startBackendSession(t, {
    projects: [{ id: "entry-framing", path: project }],
    settings: { wslEnabled: true, wslDistro: "Ubuntu", wslUser: "dev" },
    prepare: (fixture) => {
      const uncRoot = join(fixture.root, "wsl-unc");
      const home = join(uncRoot, "Ubuntu", "home", "dev");
      sessions = join(home, ".pi", "agent", "sessions");
      mkdirSync(sessions, { recursive: true });
      writeFileSync(join(sessions, "target.jsonl"), contents("target"));
      const scenario = join(fixture.root, "wsl-scenario.json");
      writeFileSync(scenario, JSON.stringify({ root: home, linuxHome, home: linuxHome, distros: ["Ubuntu"] }));
      return { env: {
        PIDECK_WSL_EXE: launcher, PIDECK_WSL_UNC_ROOT: uncRoot,
        FAKE_WSL_SCRIPT: join(process.cwd(), "tests/fixtures/native2-fake-wsl-fs.mjs"),
        FAKE_WSL_NODE: process.execPath, FAKE_WSL_SCENARIO: scenario,
      } };
    },
  });
  let record;
  const deadline = Date.now() + 10000;
  while (!record && Date.now() < deadline) {
    const listed = await f.invoke("sessions:catalog-list", ["entry-framing"]);
    record = listed.payload.result?.find((entry) => entry.filePath === `${linuxRoot}/target.jsonl` && entry.wsl);
    if (!record) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(record, "The backend must discover the isolated WSL session");
  const artifacts = join(sessions, "subagent-artifacts");
  mkdirSync(artifacts);
  const shared = join(artifacts, `${runId}_shared.txt`);
  writeFileSync(shared, "peer-owned output");
  return { ...f, sessions, shared, target: join(sessions, "target.jsonl"), id: record.id, peerContents: contents("peer") };
}

for (const [label, name, invalid] of [
  ["newline", "peer\nrecord.jsonl", true],
  ["space and tab", "peer name\trecord.jsonl", false],
  ["non-UTF-8 bytes", Buffer.concat([Buffer.from("peer"), Buffer.from([0xff]), Buffer.from(".jsonl")]), true],
  ["a literal replacement character", "peer\uFFFD.jsonl", false],
]) {
  test(`a WSL peer filename containing ${label} preserves shared artifact ownership`, {
    skip: process.platform === "win32" || (Buffer.isBuffer(name) && process.platform !== "linux")
      ? "This peer filename requires a POSIX fixture filesystem" : skip,
  }, async (t) => {
    const f = await fixture(t);
    const peer = Buffer.isBuffer(name) ? Buffer.concat([Buffer.from(`${f.sessions}/`), name]) : join(f.sessions, name);
    writeFileSync(peer, f.peerContents);
    const deleted = await f.invoke("sessions:catalog-delete", [f.id]);
    assert.equal(readFileSync(peer, "utf8"), f.peerContents);
    assert.equal(existsSync(f.shared), true, `A peer's output must survive deletion: ${JSON.stringify(deleted.payload)}`);
    assert.equal(readFileSync(f.shared, "utf8"), "peer-owned output");
    assert.equal(deleted.payload.ok, !invalid, JSON.stringify(deleted.payload));
    assert.equal(existsSync(f.target), invalid);
    if (!invalid) assert.equal(deleted.payload.result, true);
  });
}
