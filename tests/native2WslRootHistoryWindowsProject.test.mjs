import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { nativeBuildPaths } from "./helpers/nativeBuildPaths.mjs";
import { backendTestAvailability, startBackendSession } from "./helpers/native2BackendHarness.mjs";

const launcher = nativeBuildPaths("PiDeck-FakeWsl").map((path) => join(process.cwd(), path)).find(existsSync);
const availability = backendTestAvailability();

test("WSL deletion reuses scanned root history for a Windows project path", {
  skip: availability.skip || (!launcher ? "PiDeck-FakeWsl executable not found" : false),
}, async (t) => {
  const hostProject = "C:\\work\\history-project";
  const runtimeProject = "/mnt/c/work/history-project";
  const linuxHome = "/home/dev";
  const linuxRoot = `${linuxHome}/former-sessions`;
  let settingsFile, sessionFile;
  const f = await startBackendSession(t, {
    projects: [{ id: "windows-history", path: hostProject }],
    settings: { wslEnabled: true, wslDistro: "Ubuntu", wslUser: "dev" },
    prepare(fixture) {
      const uncRoot = join(fixture.root, "wsl-unc");
      const home = join(uncRoot, "Ubuntu", "home", "dev");
      const formerRoot = join(home, "former-sessions");
      mkdirSync(formerRoot, { recursive: true });
      mkdirSync(join(home, ".pi", "agent", "sessions"), { recursive: true });
      sessionFile = join(formerRoot, "history.jsonl");
      writeFileSync(sessionFile, [
        { type: "session", id: "windows-history-session", version: 3,
          cwd: runtimeProject, timestamp: "2026-01-01T00:00:00.000Z" },
        { type: "message", id: "u1", message: {
          role: "user", content: [{ type: "text", text: "Windows project root history" }],
        } },
      ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
      const agentDir = join(fixture.home, ".pi", "agent");
      mkdirSync(agentDir, { recursive: true });
      settingsFile = join(agentDir, "settings.json");
      writeFileSync(settingsFile, JSON.stringify({ sessionDir: linuxRoot }));
      const scenario = join(fixture.root, "wsl-history.json");
      writeFileSync(scenario, JSON.stringify({ root: home, linuxHome, home: linuxHome, distros: ["Ubuntu"] }));
      return { env: {
        PIDECK_WSL_EXE: launcher, PIDECK_WSL_UNC_ROOT: uncRoot,
        FAKE_WSL_SCRIPT: join(process.cwd(), "tests/fixtures/native2-fake-wsl-fs.mjs"),
        FAKE_WSL_NODE: process.execPath, FAKE_WSL_SCENARIO: scenario,
      } };
    },
  });
  // Settle the requested WSL environment before recording the scan receipt and
  // changing the configured root.
  const configured = await f.invoke("settings:update", [{
    wslEnabled: true, wslDistro: "Ubuntu", wslUser: "dev",
  }]);
  assert.equal(configured.payload.ok, true, JSON.stringify(configured.payload));
  let record;
  const deadline = Date.now() + 10000;
  while (!record && Date.now() < deadline) {
    const listed = await f.invoke("sessions:catalog-list", ["windows-history"]);
    record = listed.payload.result?.find((row) => row.filePath === `${linuxRoot}/history.jsonl` && row.wsl);
    if (!record) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(record, "A real scan must establish the historical root");
  const history = JSON.parse(readFileSync(join(f.fixture.userData, "session-root-history.json"), "utf8"));
  assert.ok(Object.values(history).some((entries) => entries.some((entry) => entry.root === linuxRoot)),
    "The trusted scan must persist its former root before settings change");
  writeFileSync(settingsFile, "{}");
  const deleted = await f.invoke("sessions:catalog-delete", [record.id]);
  assert.equal(JSON.parse(readFileSync(settingsFile, "utf8")).sessionDir, undefined);
  assert.equal(deleted.payload.result, true, JSON.stringify(deleted.payload));
  assert.equal(existsSync(sessionFile), false);
});
