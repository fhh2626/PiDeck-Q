import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { SessionScanner } = loadTsCommonJs("src/main/sessions/SessionScanner.ts");

/** Real scanner and cache with an empty local session tree and a persisted stale row. */
function fixture(t, Scanner = SessionScanner) {
  const root = mkdtempSync(join(tmpdir(), "pideck-empty-scan-cache-"));
  const home = join(root, "home");
  const userData = join(root, "user-data");
  const sessions = join(home, ".pi", "agent", "sessions");
  mkdirSync(sessions, { recursive: true });
  mkdirSync(userData, { recursive: true });
  const path = join(userData, "session-summary-cache.json");
  const vanished = join(sessions, "vanished.jsonl");
  const otherEnvironment = "\\\\wsl.localhost\\Ubuntu\\home\\dev\\kept.jsonl";
  const seed = () => writeFileSync(path, JSON.stringify({
    version: 4,
    entries: {
      [vanished]: { version: { mtimeMs: 1, size: 1 }, value: null },
      [otherEnvironment]: { version: { mtimeMs: 1, size: 1 }, value: null },
    },
  }));
  const scanner = new Scanner(undefined, home, undefined, join(root, "downloads"), userData);
  t.after(async () => {
    scanner.dispose();
    await scanner.flushSummaryCache();
    rmSync(root, { recursive: true, force: true });
  });
  return { scanner, seed, path, sessions, otherEnvironment };
}

test("the first empty local scan prunes persisted entries for vanished sessions", async (t) => {
  const { scanner, seed, path, otherEnvironment } = fixture(t);
  seed();
  assert.equal((await scanner.list()).length, 0);
  await scanner.flushSummaryCache();
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(path, "utf8")).entries), [otherEnvironment]);
});

test("an empty local scan after an environment reload prunes newly restored stale entries", async (t) => {
  const { scanner, seed, path, otherEnvironment } = fixture(t);
  assert.equal((await scanner.list()).length, 0);
  seed();
  await scanner.configureWsl(null);
  assert.equal((await scanner.list()).length, 0);
  await scanner.flushSummaryCache();
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(path, "utf8")).entries), [otherEnvironment]);
});

test("a superseded Node directory read cannot consume the new environment's first prune", { timeout: 10_000 }, async (t) => {
  let release;
  let markEntered;
  const gate = new Promise((resolve) => { release = resolve; });
  const entered = new Promise((resolve) => { markEntered = resolve; });
  t.after(() => release());
  let sessionRoot;
  let blocked = false;
  const { SessionScanner: GatedScanner } = loadTsCommonJs("src/main/sessions/SessionScanner.ts", {
    stubs: {
      "node:fs/promises": {
        ...fsPromises,
        readdir: async (directory, options) => {
          if (!blocked && directory === sessionRoot) {
            blocked = true;
            markEntered();
            await gate;
          }
          return fsPromises.readdir(directory, options);
        },
      },
    },
  });
  const { scanner, seed, path, sessions, otherEnvironment } = fixture(t, GatedScanner);
  sessionRoot = sessions;
  seed();
  const stale = assert.rejects(scanner.list(), /Session scan environment changed/);
  await entered;
  await scanner.configureWsl(null);
  release();
  await stale;
  assert.equal((await scanner.list()).length, 0);
  await scanner.flushSummaryCache();
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(path, "utf8")).entries), [otherEnvironment]);
});
