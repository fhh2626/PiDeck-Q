import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { resolveBackendExecutable, startBackendSession } from "./helpers/native2BackendHarness.mjs";

const skip = !resolveBackendExecutable() && "PiDeckBackend executable not found";

const quoteStyles = [
  ["curved double quotes", (path) => `“${path}”`],
  ["curved single quotes", (path) => `‘${path}’`],
  ["nested ASCII and curved quotes", (path) => `"  ‘ “ '${path}' ” ’  "`],
];

const backslash = "\\";
const escapedUncPath = backslash.repeat(4) + ["SERVER", "Share", "Runner"].join(backslash.repeat(2));
const pathIdentities = [
  ["UNC versus local POSIX", "//server/share/runner", "/server/share/runner", false],
  ["local POSIX versus UNC", "/server/share/runner", "//server/share/runner", false],
  ["UNC separator aliases", backslash.repeat(2) + ["SERVER", "Share", "Runner"].join(backslash),
    "//server/share/bin/../runner", true],
  ["escaped UNC separator aliases", escapedUncPath,
    backslash.repeat(2) + ["server", "share", "runner"].join(backslash), true],
  ["escaped UNC versus forward-slash UNC", escapedUncPath, "//server/share/bin/../runner", true],
  ["escaped UNC versus local POSIX", escapedUncPath, "/server/share/runner", false],
  ["local POSIX versus escaped UNC", "/server/share/runner", escapedUncPath, false],
  ["ambiguous slash prefix versus UNC", "///server/share/runner", "//server/share/runner", false],
  ["a parent segment cannot cross a UNC share root", "//server/other/../share/runner", "//server/share/runner", false],
  ["a device UNC path stays distinct from an ordinary share", "//?/UNC/server/share/runner", "//server/share/runner", false],
  ["a device drive path stays distinct from an ordinary drive path", "//?/C:/Tools/Runner.exe", "C:/Tools/Runner.exe", false],
  ["ordinary POSIX path aliases", "/server/share/runner", "/server//share/./bin/../runner", true],
];
if (process.platform === "win32") {
  for (const [label, prefix] of [["slash then backslash", "/\\"], ["backslash then slash", "\\/"]]) {
    pathIdentities.push(
      [`mixed UNC prefix (${label})`, `${prefix}SERVER/Share/bin/../runner`, "//server/share/runner", true],
      [`mixed UNC prefix (${label}) cannot cross a share root`, `${prefix}server/other/../share/runner`, "//server/share/runner", false],
    );
  }
} else {
  pathIdentities.push(
    ["three leading slashes are local on POSIX", "///server/share/runner", "/server/share/runner", true],
    ["three leading slashes do not make a POSIX path case-insensitive", "///server/share/Runner", "/server/share/runner", false],
    ["a leading POSIX backslash component is not a mixed UNC prefix", String.raw`/\server/share/runner`, "//server/share/runner", false],
  );
}

test("AppSettings type no longer declares the Electron sandbox option", () => {
  // “已删除功能不得再出现”的静态约束：类型声明里的字段无法靠运行时行为证明缺席。
  assert.doesNotMatch(readFileSync("src/shared/types/settings.ts", "utf8"), /electronChromiumSandbox\s*:/);
});

for (const update of [false, true]) {
  for (const [name, retiredPath, customPiPath, sameIdentity] of pathIdentities) {
    test(`${name} retain their filesystem identity on ${update ? "update" : "load"}`, { skip }, async (t) => {
      const values = { piRuntimePreference: "auto", piRustPath: retiredPath, customPiPath,
        piInstall: { command: retiredPath, version: "pi 0.2.0", runtimeKind: "rust" }, piEnvironmentChecked: true };
      const session = await startBackendSession(t, { settings: update ? {} : values });
      const response = await session.invoke(update ? "settings:update" : "settings:get", update ? [values] : []);
      assert.equal(response.payload.ok, true, JSON.stringify(response.payload));
      const disk = JSON.parse(readFileSync(join(session.fixture.userData, "settings.json"), "utf8"));
      for (const snapshot of [response.payload.result, disk]) {
        assert.equal(snapshot.customPiPath, sameIdentity ? "" : customPiPath);
        assert.equal(Object.hasOwn(snapshot, "piRustPath"), false);
        assert.equal(Object.hasOwn(snapshot, "piInstall"), false);
        assert.equal(snapshot.piEnvironmentChecked, false);
      }
    });
  }
  for (const [label, customPiPath, command] of [
    ["an escaped UNC path", escapedUncPath, "//server/share/runner"],
    ["a device drive path", String.raw`\\?\C:\Tools\Runner.exe`, "//?/c:/tools/runner.exe"],
    ["a device UNC path", String.raw`\\?\UNC\SERVER\Share\Runner.exe`, "//?/unc/server/share/runner.exe"],
  ]) {
    test(`a supported install keeps ${label} on ${update ? "update" : "load"}`, { skip }, async (t) => {
      const cache = { command, version: "1.5.2", runtimeKind: "typescript" };
      const values = { piRuntimePreference: "auto", piRustPath: customPiPath, customPiPath,
        piInstall: cache, piEnvironmentChecked: true };
      const session = await startBackendSession(t, { settings: update ? {} : values });
      const response = await session.invoke(update ? "settings:update" : "settings:get", update ? [values] : []);
      assert.equal(response.payload.ok, true, JSON.stringify(response.payload));
      const disk = JSON.parse(readFileSync(join(session.fixture.userData, "settings.json"), "utf8"));
      for (const snapshot of [response.payload.result, disk]) {
        assert.equal(snapshot.customPiPath, customPiPath);
        assert.deepEqual(snapshot.piInstall, cache);
        assert.equal(Object.hasOwn(snapshot, "piRustPath"), false);
        assert.equal(snapshot.piEnvironmentChecked, true);
      }
    });
  }
  test(`a device path with a retired command name is removed on ${update ? "update" : "load"}`, { skip }, async (t) => {
    const values = { customPiPath: String.raw`\\?\C:\Tools\pi-rust.exe`, piRustPath: "" };
    const session = await startBackendSession(t, { settings: update ? {} : values });
    const response = await session.invoke(update ? "settings:update" : "settings:get", update ? [values] : []);
    assert.equal(response.payload.ok, true, JSON.stringify(response.payload));
    const disk = JSON.parse(readFileSync(join(session.fixture.userData, "settings.json"), "utf8"));
    for (const snapshot of [response.payload.result, disk]) {
      assert.equal(snapshot.customPiPath, "");
      assert.equal(Object.hasOwn(snapshot, "piRustPath"), false);
    }
  });
  for (const [label, quote] of quoteStyles) {
    test(`retired custom paths with ${label} are removed on ${update ? "update" : "load"}`, { skip }, async (t) => {
      const command = "/custom/retired-runner";
      const values = { piRuntimePreference: "auto", piRustPath: command, customPiPath: quote(command),
        piInstall: { command, version: "pi 0.2.0 (unknown abc)", runtimeKind: "rust" }, piEnvironmentChecked: true };
      const session = await startBackendSession(t, { settings: update ? {} : values });
      const response = await session.invoke(update ? "settings:update" : "settings:get", update ? [values] : []);
      assert.equal(response.payload.ok, true, JSON.stringify(response.payload));
      const disk = JSON.parse(readFileSync(join(session.fixture.userData, "settings.json"), "utf8"));
      for (const snapshot of [response.payload.result, disk]) {
        assert.equal(snapshot.customPiPath, "");
        assert.equal(Object.hasOwn(snapshot, "piRustPath"), false);
        assert.equal(Object.hasOwn(snapshot, "piInstall"), false);
        assert.equal(snapshot.piEnvironmentChecked, false);
      }
    });

    test(`supported cached identities protect paths with ${label} on ${update ? "update" : "load"}`, { skip }, async (t) => {
      const command = "/custom/current-runner";
      const customPiPath = quote(command);
      const cache = { command, version: "1.5.2", runtimeKind: "typescript" };
      const values = { piRuntimePreference: "auto", piRustPath: customPiPath, customPiPath,
        piInstall: cache, piEnvironmentChecked: true };
      const session = await startBackendSession(t, { settings: update ? {} : values });
      const response = await session.invoke(update ? "settings:update" : "settings:get", update ? [values] : []);
      assert.equal(response.payload.ok, true, JSON.stringify(response.payload));
      const disk = JSON.parse(readFileSync(join(session.fixture.userData, "settings.json"), "utf8"));
      for (const snapshot of [response.payload.result, disk]) {
        assert.equal(snapshot.customPiPath, customPiPath);
        assert.deepEqual(snapshot.piInstall, cache);
        assert.equal(Object.hasOwn(snapshot, "piRustPath"), false);
        assert.equal(snapshot.piEnvironmentChecked, true);
      }
    });
  }
  for (const legacy of [false, true]) {
    test(`a retired command name ${legacy ? "with" : "without"} old setting evidence is migrated conservatively on ${update ? "update" : "load"}`, { skip }, async (t) => {
      // Old settings persisted the dedicated field even when its value was empty.
      // Current custom wrappers can reuse the name after that one-time cleanup.
      const values = { customPiPath: "/custom/pi-rust", ...(legacy ? { piRustPath: "" } : {}) };
      const session = await startBackendSession(t, { settings: update ? {} : values });
      const response = await session.invoke(update ? "settings:update" : "settings:get", update ? [values] : []);
      assert.equal(response.payload.ok, true, JSON.stringify(response.payload));
      const disk = JSON.parse(readFileSync(join(session.fixture.userData, "settings.json"), "utf8"));
      for (const snapshot of [response.payload.result, disk]) {
        assert.equal(snapshot.customPiPath, legacy ? "" : values.customPiPath);
        assert.equal(Object.hasOwn(snapshot, "piRustPath"), false);
      }
    });
  }
  for (const [runtimeKind, version, command] of [
    ["typescript", "1.5.2", "/custom/pi-rust"],
    ["bolt", "1.4.0 (Pi-Bolt 1.0.2)", "C:\\custom\\pi_agent_rust.exe"],
  ]) {
    test(`confirmed ${runtimeKind} keeps a reused retired command name on ${update ? "update" : "load"}`, { skip }, async (t) => {
      const cache = { command, version, runtimeKind };
      const values = { piRuntimePreference: "auto", customPiPath: command, piRustPath: command,
        piInstall: cache, piEnvironmentChecked: true };
      const session = await startBackendSession(t, { settings: update ? {} : values });
      const response = await session.invoke(update ? "settings:update" : "settings:get", update ? [values] : []);
      assert.equal(response.payload.ok, true, JSON.stringify(response.payload));
      const disk = JSON.parse(readFileSync(join(session.fixture.userData, "settings.json"), "utf8"));
      for (const snapshot of [response.payload.result, disk]) {
        assert.equal(snapshot.customPiPath, command);
        assert.deepEqual(snapshot.piInstall, cache);
        assert.equal(snapshot.piEnvironmentChecked, true);
        assert.equal(Object.hasOwn(snapshot, "piRustPath"), false);
      }
    });
  }

  for (const cache of [
    { command: "/custom/runner", version: "1.5.2", runtimeKind: "rust" },
    { command: "/custom/runner", version: "pi 0.2.0 (unknown abc)", runtimeKind: "typescript" },
  ]) {
    test(`explicit retired metadata still clears a conflicting ${cache.runtimeKind} cache on ${update ? "update" : "load"}`, { skip }, async (t) => {
      const values = { piRuntimePreference: "auto", customPiPath: cache.command,
        piInstall: cache, piEnvironmentChecked: true };
      const session = await startBackendSession(t, { settings: update ? {} : values });
      const response = await session.invoke(update ? "settings:update" : "settings:get", update ? [values] : []);
      assert.equal(response.payload.ok, true, JSON.stringify(response.payload));
      const disk = JSON.parse(readFileSync(join(session.fixture.userData, "settings.json"), "utf8"));
      for (const snapshot of [response.payload.result, disk]) {
        assert.equal(snapshot.customPiPath, "");
        assert.equal(Object.hasOwn(snapshot, "piInstall"), false);
        assert.equal(snapshot.piEnvironmentChecked, false);
      }
    });
  }
}
