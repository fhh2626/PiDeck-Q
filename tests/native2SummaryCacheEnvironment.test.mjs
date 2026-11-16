import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { resolveBackendExecutable } from "./helpers/native2BackendHarness.mjs";
import { createSharedFixture, readSummaryCache, startBackend, stopBackend, summaryCachePath, waitFor } from "./helpers/native2RestartableBackend.mjs";

// Validate before starting the restartable host so stale/missing builds cannot leave a listener open.
const executable = resolveBackendExecutable();
const platform = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macosx" : process.platform;
const launcher = resolve(`build/${platform}/${process.arch}/debug/PiDeck-FakeWsl${process.platform === "win32" ? ".exe" : ""}`);
const required = process.env.PIDECK_REQUIRE_BACKEND_TESTS === "1";

/** Observe the real owner-thread publication before issuing a WSL scan. */
function environmentWasPublished(userData) {
  const logs = join(userData, "logs");
  return existsSync(logs) && readdirSync(logs).filter((name) => name.endsWith(".log"))
    .some((name) => readFileSync(join(logs, name), "utf8").includes("WSL environment configured"));
}

test("a superseded empty WSL scan cannot mark the new local environment as scanned", {
  skip: (!executable || !existsSync(launcher)) && !required ? "Build PiDeckBackend and PiDeck-FakeWsl to run the environment handoff regression" : false,
}, async (t) => {
  assert.ok(existsSync(launcher), "PiDeck-FakeWsl must be built for this regression");
  assert.ok(statSync(launcher).mtimeMs >= statSync("native/tests/FakeWslLauncher.cpp").mtimeMs,
    "PiDeck-FakeWsl must match its current source");
  const fixture = createSharedFixture();
  const gate = join(fixture.root, "find-gate");
  mkdirSync(gate);
  // Register before backend teardown so even a failed assertion releases the child.
  t.after(() => { if (existsSync(gate)) writeFileSync(join(gate, "released"), "1"); });
  writeFileSync(join(fixture.userData, "projects.json"), JSON.stringify([
    { id: "cache-switch", name: "Cache switch", path: fixture.project, lastOpenedAt: 1, sortOrder: 0, environment: "windows" },
  ]));
  const vanished = join(fixture.sessions, "vanished.jsonl");
  writeFileSync(summaryCachePath(fixture), JSON.stringify({
    version: 4,
    entries: { [vanished]: { version: { mtimeMs: 1, size: 1 }, value: null } },
  }));
  const uncRoot = join(fixture.root, "wsl-unc");
  const linuxHome = "/home/dev";
  const distroHome = join(uncRoot, "Ubuntu", "home", "dev");
  for (const name of ["sessions", "prompts", "skills", "extensions"]) {
    mkdirSync(join(distroHome, ".pi", "agent", name), { recursive: true });
  }
  const scenarioPath = join(fixture.root, "wsl-scenario.json");
  writeFileSync(scenarioPath, JSON.stringify({ root: distroHome, linuxHome, home: linuxHome, distros: ["Ubuntu"] }));
  const script = join(fixture.root, "gated-wsl.mjs");
  const delegate = pathToFileURL(resolve("tests/fixtures/native2-fake-wsl-fs.mjs")).href;
  // Gate only find. Startup resolution and every other command use the existing local fake.
  writeFileSync(script, `
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const command = args.slice(args.indexOf("-u") + 2);
const gate = process.env.FAKE_WSL_FIND_GATE;
if (command[0] === "find" && existsSync(join(gate, "armed"))) {
  writeFileSync(join(gate, "entered"), "1");
  const deadline = Date.now() + 10000;
  while (!existsSync(join(gate, "released"))) {
    if (Date.now() >= deadline) throw new Error("find gate was never released");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
await import(${JSON.stringify(delegate)});
`);
  const session = await startBackend(t, fixture, {
    settings: { language: "en-US", wslEnabled: true, wslDistro: "Ubuntu", wslUser: "dev" },
    env: {
      PIDECK_WSL_EXE: launcher,
      PIDECK_WSL_UNC_ROOT: uncRoot,
      FAKE_WSL_SCRIPT: script,
      FAKE_WSL_NODE: process.execPath,
      FAKE_WSL_SCENARIO: scenarioPath,
      FAKE_WSL_FIND_GATE: gate,
    },
  });
  await waitFor(() => environmentWasPublished(fixture.userData), "WSL environment was never published");
  writeFileSync(join(gate, "armed"), "1");
  const previous = session.invoke("sessions:list", ["cache-switch"]);
  await waitFor(() => existsSync(join(gate, "entered")), "the old environment never entered find");
  const switched = await session.invoke("settings:update", [{ wslEnabled: false }]);
  assert.equal(switched.payload.ok, true, JSON.stringify(switched.payload));
  writeFileSync(join(gate, "released"), "1");
  const stale = await previous;
  assert.equal(stale.payload.ok, false, "the old scan must reject its superseded environment");
  assert.match(stale.payload.error.message, /environment changed/i);
  const current = await session.invoke("sessions:list", ["cache-switch"]);
  assert.equal(current.payload.ok, true, JSON.stringify(current.payload));
  assert.deepEqual(current.payload.result, []);
  await stopBackend(session);
  assert.equal(readSummaryCache(fixture).entries[vanished], undefined,
    "the old empty scan must not consume the new environment's first prune");
});
