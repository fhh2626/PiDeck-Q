import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { nativeBuildPaths } from "./helpers/nativeBuildPaths.mjs";
import { backendTestAvailability, startBackendSession } from "./helpers/native2BackendHarness.mjs";

const launcher = nativeBuildPaths("PiDeck-FakeWsl").map((path) => join(process.cwd(), path)).find(existsSync);
const availability = backendTestAvailability();
const linuxHome = "/home/dev";
const linuxAlias = `${linuxHome}/former-root`;
const runtimePath = process.cwd().replaceAll("\\", "/").replace(/^([A-Za-z]):\//, (_, drive) => `/mnt/${drive.toLowerCase()}/`);

if (!availability.executable || !launcher) {
  test("WSL root history integration requires native fixtures", {
    skip: availability.skip || "PiDeck-FakeWsl executable not found; run npm run test:native-runtime",
  }, () => {});
} else {
  for (const { suffix, legacy } of [
    { suffix: " ", legacy: false }, { suffix: "\t", legacy: false }, { suffix: "\n", legacy: false },
    { suffix: " ", legacy: true },
  ]) {
    test(`WSL root history distinguishes a canonical target ending in ${JSON.stringify(suffix)}${legacy ? " from a legacy receipt" : ""}`, {
      skip: process.platform === "win32" ? "The fixture needs POSIX names with trailing whitespace" : false,
    }, async (t) => {
      let settingsFile, alias, trustedFile, otherFile, otherRoot;
      const f = await startBackendSession(t, {
        projects: [{ id: "root-history", path: process.cwd() }],
        settings: { wslEnabled: true, wslDistro: "Ubuntu", wslUser: "dev" },
        prepare: (fixture) => {
          const uncRoot = join(fixture.root, "wsl-unc");
          const home = join(uncRoot, "Ubuntu", "home", "dev");
          mkdirSync(join(home, ".pi", "agent", "sessions"), { recursive: true });
          const trustedRoot = join(home, `original${suffix}`);
          otherRoot = join(home, "original");
          mkdirSync(trustedRoot); mkdirSync(otherRoot);
          alias = join(home, "former-root");
          symlinkSync(trustedRoot, alias, "dir");
          const content = [
            { type: "session", id: "history-record", version: 3, cwd: runtimePath, timestamp: "2026-01-01T00:00:00.000Z" },
            { type: "message", id: "u1", message: { role: "user", content: [{ type: "text", text: "Root history" }] } },
          ].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
          trustedFile = join(trustedRoot, "history.jsonl");
          otherFile = join(otherRoot, "history.jsonl");
          writeFileSync(trustedFile, content); writeFileSync(otherFile, content);
          const agentDir = join(fixture.home, ".pi", "agent");
          mkdirSync(agentDir, { recursive: true });
          settingsFile = join(agentDir, "settings.json");
          writeFileSync(settingsFile, JSON.stringify({ sessionDir: linuxAlias }));
          const scenario = join(fixture.root, "wsl-history.json");
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
        const listed = await f.invoke("sessions:catalog-list", ["root-history"]);
        record = listed.payload.result?.find((row) => row.filePath === `${linuxAlias}/history.jsonl` && row.wsl);
        if (!record) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.ok(record, "A real scan must establish the historical root");
      const original = readFileSync(trustedFile, "utf8");
      if (legacy) {
        // The old writer trimmed realpath output. Reproduce that persisted receipt
        // so upgrading the reader cannot silently trust an already-lossy identity.
        const path = join(f.fixture.userData, "session-root-history.json");
        const history = JSON.parse(readFileSync(path, "utf8"));
        for (const entries of Object.values(history)) {
          for (const entry of entries) {
            delete entry.canonicalVersion;
            entry.canonical = entry.canonical.trim();
          }
        }
        writeFileSync(path, JSON.stringify(history));
      }
      // The alias is no longer configured. Its recorded provenance must not grant
      // authority over a different root whose spelling only differs in whitespace.
      writeFileSync(settingsFile, "{}");
      unlinkSync(alias); symlinkSync(otherRoot, alias, "dir");
      const deleted = await f.invoke("sessions:catalog-delete", [record.id]);
      assert.equal(deleted.payload.ok, false, JSON.stringify(deleted.payload));
      assert.equal(readFileSync(trustedFile, "utf8"), original);
      assert.equal(readFileSync(otherFile, "utf8"), original);
      if (legacy) {
        // Only an explicit settings scan may replace the old receipt with current
        // authority. Once verified, history remains usable after unconfiguring it.
        writeFileSync(settingsFile, JSON.stringify({ sessionDir: linuxAlias }));
        assert.equal((await f.invoke("sessions:catalog-list", ["root-history"])).payload.ok, true);
        writeFileSync(settingsFile, "{}");
        const recovered = await f.invoke("sessions:catalog-delete", [record.id]);
        assert.equal(recovered.payload.result, true, JSON.stringify(recovered.payload));
        assert.equal(existsSync(otherFile), false);
        assert.equal(readFileSync(trustedFile, "utf8"), original);
      }
    });
  }
}
