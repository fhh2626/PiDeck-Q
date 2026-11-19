import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { nativeBuildPaths } from "./helpers/nativeBuildPaths.mjs";
import { backendTestAvailability, createFakePi, startBackendSession } from "./helpers/native2BackendHarness.mjs";
import { writeSessionFile } from "./helpers/native2RuntimeEvents.mjs";

const availability = backendTestAvailability();
const launcher = nativeBuildPaths("PiDeck-FakeWsl").map((path) => join(process.cwd(), path)).find(existsSync);
if (process.env.PIDECK_REQUIRE_BACKEND_TESTS === "1") assert.ok(launcher, "Build PiDeck-FakeWsl before required native tests");
const linuxHome = "/home/dev";
const portable = (path) => path.replaceAll("\\", "/");

/** Both physical roots have the same leaf so a lossy canonical path can select real unrelated data. */
async function fixture(t, wsl, raw) {
  let alias, settingsFile, originalFile, replacementFile, replacementRoot, canonicalReplacement;
  const project = process.cwd();
  const cwd = wsl ? portable(project).replace(/^([A-Za-z]):\//, (_, drive) => `/mnt/${drive.toLowerCase()}/`) : project;
  const f = await startBackendSession(t, {
    projects: [{ id: "canonical-encoding", path: project }],
    settings: wsl ? { wslEnabled: true, wslDistro: "Ubuntu", wslUser: "dev" } : {},
    prepare(directory) {
      const uncRoot = join(directory.root, "wsl-unc");
      const home = wsl ? join(uncRoot, "Ubuntu", "home", "dev") : directory.root;
      if (wsl) mkdirSync(join(home, ".pi", "agent", "sessions"), { recursive: true });
      replacementRoot = join(home, "original\uFFFD");
      const originalRoot = raw
        ? Buffer.concat([Buffer.from(join(home, "original")), Buffer.from([0xff])])
        : replacementRoot;
      mkdirSync(originalRoot);
      if (raw) mkdirSync(replacementRoot);
      alias = join(home, "configured-root");
      symlinkSync(originalRoot, alias, process.platform === "win32" ? "junction" : "dir");
      const agentDir = join(directory.home, ".pi", "agent");
      mkdirSync(agentDir, { recursive: true });
      settingsFile = join(agentDir, "settings.json");
      writeFileSync(settingsFile, JSON.stringify({ sessionDir: wsl ? `${linuxHome}/configured-root` : alias }));
      const content = (id) => [
        { type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd },
        { type: "message", id: "u1", message: { role: "user", content: [{ type: "text", text: id }] } },
      ].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
      originalFile = Buffer.isBuffer(originalRoot)
        ? Buffer.concat([originalRoot, Buffer.from("/session.jsonl")]) : join(originalRoot, "session.jsonl");
      replacementFile = join(replacementRoot, "session.jsonl");
      writeFileSync(originalFile, content("original"));
      if (raw) writeFileSync(replacementFile, content("unrelated"));
      canonicalReplacement = wsl ? `${linuxHome}/original\uFFFD` : replacementRoot;
      if (!wsl) return;
      const scenario = join(directory.root, "wsl-canonical-encoding.json");
      writeFileSync(scenario, JSON.stringify({ root: home, linuxHome, home: linuxHome, distros: ["Ubuntu"] }));
      return { env: {
        PIDECK_WSL_EXE: launcher, PIDECK_WSL_UNC_ROOT: uncRoot,
        FAKE_WSL_SCRIPT: join(process.cwd(), "tests/fixtures/native2-fake-wsl-fs.mjs"),
        FAKE_WSL_NODE: process.execPath, FAKE_WSL_SCENARIO: scenario,
      } };
    },
  });
  if (wsl) {
    // renderer.ready precedes the asynchronous startup WSL switch. The settings
    // response settles after its scanner environment is committed, so the first
    // catalog scan cannot be cancelled by that still-pending startup transition.
    const ready = await f.invoke("settings:update", [{ wslEnabled: true, wslDistro: "Ubuntu", wslUser: "dev" }]);
    assert.equal(ready.payload.ok, true, JSON.stringify(ready.payload));
  }
  const expectedPath = wsl ? `${linuxHome}/configured-root/session.jsonl` : portable(join(alias, "session.jsonl"));
  let record;
  const deadline = Date.now() + 10000;
  while (!record && Date.now() < deadline) {
    const listed = await f.invoke("sessions:catalog-list", ["canonical-encoding"]);
    assert.equal(listed.payload.ok, true, JSON.stringify(listed.payload));
    record = listed.payload.result?.find((entry) => portable(entry.filePath) === expectedPath && Boolean(entry.wsl) === wsl);
    if (!record) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(record, "A real scan must discover the configured alias");
  return { ...f, record, alias, settingsFile, originalFile, replacementFile, replacementRoot, canonicalReplacement };
}

test("a native active companion alias with unrepresentable bytes retains its deletion fence", {
  skip: availability.skip || (process.platform !== "linux" ? "Raw byte directory names require the Linux fixture" : false),
}, async (t) => {
  const project = process.cwd();
  const f = await startBackendSession(t, {
    projects: [{ id: "raw-live-alias", path: project }],
    prepare(directory) {
      const fake = createFakePi(directory, {});
      return { settings: { customPiPath: fake.shim }, env: { FAKE_PI_SCENARIO: fake.scenarioPath, FAKE_PI_LOG: fake.logPath } };
    },
  });
  const parent = writeSessionFile(f.fixture.sessions, project, "parent");
  const other = writeSessionFile(f.fixture.sessions, project, "unrelated");
  const companion = parent.slice(0, -6);
  mkdirSync(companion);
  const raw = Buffer.concat([Buffer.from(`${companion}/child`), Buffer.from([0xff])]);
  mkdirSync(raw);
  const sentinel = Buffer.concat([raw, Buffer.from("/live-output.txt")]);
  writeFileSync(sentinel, "active output");
  const listed = await f.invoke("sessions:catalog-list", ["raw-live-alias"]);
  assert.equal(listed.payload.ok, true, JSON.stringify(listed.payload));
  const parentRecord = listed.payload.result.find((entry) => entry.filePath === parent);
  const otherRecord = listed.payload.result.find((entry) => entry.filePath === other);
  assert.ok(parentRecord); assert.ok(otherRecord);
  symlinkSync(raw, other.slice(0, -6), "dir");
  const active = await f.invoke("sessions:runtime-activate", [otherRecord.id]);
  assert.equal(active.payload.result.ok, true, JSON.stringify(active.payload));
  const deleted = await f.invoke("sessions:catalog-delete", [parentRecord.id, { permanent: true }]);
  assert.equal(deleted.payload.ok, false, JSON.stringify(deleted.payload));
  assert.equal(readFileSync(sentinel, "utf8"), "active output");
  assert.equal(existsSync(parent), true);
});

for (const primary of [true, false]) test(`native deletion permits ${primary ? "a dangling primary leaf" : "an unrelated dangling companion"}`, {
  skip: availability.skip || (process.platform === "win32" ? "This dangling file symlink fixture requires POSIX" : false),
}, async (t) => {
  const project = process.cwd();
  const f = await startBackendSession(t, { projects: [{ id: "dangling-entry", path: project }] });
  const file = writeSessionFile(f.fixture.sessions, project, "dangling-entry");
  const listed = await f.invoke("sessions:catalog-list", ["dangling-entry"]);
  const record = listed.payload.result?.find((entry) => entry.filePath === file);
  assert.ok(record, JSON.stringify(listed.payload));
  const link = primary ? file : file.slice(0, -6);
  const missing = join(f.fixture.root, "missing-referent");
  if (primary) unlinkSync(file);
  symlinkSync(missing, link);
  assert.equal(lstatSync(link).isSymbolicLink(), true);
  const deleted = await f.invoke("sessions:catalog-delete", [record.id, { permanent: true }]);
  assert.equal(deleted.payload.result, true, JSON.stringify(deleted.payload));
  assert.equal(existsSync(file), false);
  if (primary) assert.throws(() => lstatSync(link), { code: "ENOENT" });
  else assert.equal(lstatSync(link).isSymbolicLink(), true, "The dangling companion is outside the directory plan");
  assert.equal(existsSync(missing), false);
});

for (const wsl of [false, true]) {
  const platform = wsl ? "WSL" : "native";
  const skip = availability.skip || (wsl && !launcher ? "PiDeck-FakeWsl is unavailable" : false);
  const rawSkip = skip || (process.platform !== "linux" ? "Raw byte directory names require the Linux fixture" : false);

  test(`${platform} deletion rejects a canonical alias with a lossy raw byte referent`, { skip: rawSkip }, async (t) => {
    const f = await fixture(t, wsl, true);
    const original = readFileSync(f.originalFile, "utf8");
    const unrelated = readFileSync(f.replacementFile, "utf8");
    const deleted = await f.invoke("sessions:catalog-delete", [f.record.id, ...(wsl ? [] : [{ permanent: true }])]);
    assert.equal(existsSync(f.replacementFile), true, `Unrelated physical data must survive: ${JSON.stringify(deleted.payload)}`);
    assert.equal(readFileSync(f.replacementFile, "utf8"), unrelated);
    assert.equal(readFileSync(f.originalFile, "utf8"), original);
    assert.equal(deleted.payload.ok, false, JSON.stringify(deleted.payload));
    assert.equal(f.trashCalls.length, 0);
  });

  test(`${platform} deletion accepts an actual replacement character in the canonical root`, { skip }, async (t) => {
    const f = await fixture(t, wsl, false);
    const deleted = await f.invoke("sessions:catalog-delete", [f.record.id, ...(wsl ? [] : [{ permanent: true }])]);
    assert.equal(deleted.payload.result, true, JSON.stringify(deleted.payload));
    assert.equal(existsSync(f.originalFile), false);
  });

  test(`${platform} root history rejects a legacy receipt that lost canonical filename bytes`, { skip: rawSkip }, async (t) => {
    const f = await fixture(t, wsl, true);
    const original = readFileSync(f.originalFile, "utf8");
    const unrelated = readFileSync(f.replacementFile, "utf8");
    const historyPath = join(f.fixture.userData, "session-root-history.json");
    const history = JSON.parse(readFileSync(historyPath, "utf8"));
    // Version 1 was emitted after decoding native/WSL canonical bytes to QString.
    // Reproduce that persisted receipt even after the corrected writer refuses it.
    const root = wsl ? `${linuxHome}/configured-root` : f.alias;
    const defaultRoot = wsl ? `${linuxHome}/.pi/agent/sessions` : portable(f.fixture.sessions);
    const entries = Object.values(history).find((scope) => scope.some((entry) => portable(entry.root) === defaultRoot));
    assert.ok(entries, "The real scan must record the default root in the same environment scope");
    const existing = entries.findIndex((entry) => entry.root === root);
    const legacy = { root, canonical: f.canonicalReplacement, canonicalVersion: 1 };
    if (existing < 0) entries.push(legacy);
    else entries[existing] = legacy;
    writeFileSync(historyPath, JSON.stringify(history));
    writeFileSync(f.settingsFile, "{}");
    unlinkSync(f.alias);
    symlinkSync(f.replacementRoot, f.alias, "dir");
    const deleted = await f.invoke("sessions:catalog-delete", [f.record.id, ...(wsl ? [] : [{ permanent: true }])]);
    assert.equal(existsSync(f.replacementFile), true, `A lossy receipt must not authorize a different root: ${JSON.stringify(deleted.payload)}`);
    assert.equal(readFileSync(f.replacementFile, "utf8"), unrelated);
    assert.equal(readFileSync(f.originalFile, "utf8"), original);
    assert.equal(deleted.payload.ok, false, JSON.stringify(deleted.payload));
  });
}
