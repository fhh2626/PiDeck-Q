import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { backendTestAvailability, startBackendSession } from "./helpers/native2BackendHarness.mjs";
import { nativeBuildPaths } from "./helpers/nativeBuildPaths.mjs";

const { executable, skip } = backendTestAvailability();
const launcher = nativeBuildPaths("PiDeck-FakeWsl").map((path) => join(process.cwd(), path)).find(existsSync);
if (!executable || !launcher) test("WSL raw deletion path regression", { skip }, () => assert.fail("Build the required native fixtures"));
else test("WSL deletion resolves a symlink followed by dot-dot before choosing the file", async (t) => {
  const home = "/home/dev", root = `${home}/.pi/agent/sessions`;
  const raw = `${root}/alias/../wanted.jsonl`;
  const cwd = process.cwd().replaceAll("\\", "/").replace(/^([A-Za-z]):\//, (_, drive) => `/mnt/${drive.toLowerCase()}/`);
  let wanted, decoy;
  const f = await startBackendSession(t, {
    projects: [{ id: "raw-delete", path: process.cwd() }],
    settings: { wslEnabled: true, wslDistro: "Ubuntu", wslUser: "dev" },
    prepare: (fixture) => {
      const unc = join(fixture.root, "wsl-unc"), physicalHome = join(unc, "Ubuntu", "home", "dev");
      const sessions = join(physicalHome, ".pi", "agent", "sessions"), inside = join(sessions, "inside");
      mkdirSync(join(inside, "deep"), { recursive: true });
      wanted = join(inside, "wanted.jsonl"); decoy = join(sessions, "wanted.jsonl");
      for (const [file, id] of [[wanted, "wanted"], [decoy, "decoy"]])
        writeFileSync(file, JSON.stringify({ type: "session", version: 3, id, cwd }) + "\n");
      symlinkSync(join(inside, "deep"), join(sessions, "alias"), process.platform === "win32" ? "junction" : "dir");
      writeFileSync(join(fixture.userData, "session-catalog.json"), JSON.stringify({ version: 1, sessions: [
        { id: "raw-target", projectId: "raw-delete", source: "pi", environment: "wsl", wslDistro: "Ubuntu", wslUser: "dev", title: "wanted", filePath: raw, status: "active" },
      ] }));
      const scenario = join(fixture.root, "wsl.json");
      writeFileSync(scenario, JSON.stringify({ root: physicalHome, linuxHome: home, home, distros: ["Ubuntu"] }));
      return { env: { PIDECK_WSL_EXE: launcher, PIDECK_WSL_UNC_ROOT: unc, FAKE_WSL_SCRIPT: join(process.cwd(), "tests/fixtures/native2-fake-wsl-fs.mjs"), FAKE_WSL_NODE: process.execPath, FAKE_WSL_SCENARIO: scenario } };
    },
  });
  // The legacy filesystem read observes environment readiness without merging the
  // catalog and normalizing away the raw spelling that this regression exercises.
  const deadline = Date.now() + 10_000;
  let ready = false;
  while (!ready && Date.now() < deadline) {
    const response = await f.invoke("sessions:list", ["raw-delete"]);
    ready = response.payload.result?.length > 0;
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(ready);
  const records = (await f.invoke("sessions:catalog-list", ["raw-delete", { scan: false }])).payload.result;
  assert.equal(records.find((row) => row.id === "raw-target").filePath, raw);
  const original = readFileSync(decoy, "utf8");
  const deleted = await f.invoke("sessions:catalog-delete", ["raw-target"]);
  assert.equal(deleted.payload.result, true, JSON.stringify(deleted.payload));
  assert.equal(existsSync(wanted), false, "delete the file the Linux path actually names");
  assert.equal(readFileSync(decoy, "utf8"), original, "do not delete the lexical dot-dot decoy");
});
