import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { nativeBuildPaths } from "./helpers/nativeBuildPaths.mjs";
import { backendTestAvailability, startBackendSession } from "./helpers/native2BackendHarness.mjs";
import { waitFor } from "./helpers/native2RuntimeEvents.mjs";

const launcher = nativeBuildPaths("PiDeck-FakeWsl").map((path) => join(process.cwd(), path)).find(existsSync);
const availability = backendTestAvailability();
const skip = availability.skip || (!launcher ? "PiDeck-FakeWsl executable not found" : false)
  || (process.platform === "win32" ? "The deterministic planning gate requires a POSIX FIFO" : false);
const linuxHome = "/home/dev";
const linuxAlias = `${linuxHome}/configured-root`;

/** Freeze planning after admission using an ordinary project settings read. */
async function retargetDuringPlanning(f, retarget) {
  unlinkSync(f.settingsFile);
  const pipe = spawnSync("mkfifo", [f.settingsFile], { encoding: "utf8" });
  assert.equal(pipe.status, 0, pipe.stderr);
  const deletion = f.invoke("sessions:catalog-delete", ["lease-target"]);
  let writer;
  try {
    writer = await waitFor(() => {
      try { return openSync(f.settingsFile, constants.O_WRONLY | constants.O_NONBLOCK); }
      catch (error) { if (error.code !== "ENXIO") throw error; return false; }
    }, 5000, "WSL deletion planning after admission");
    retarget();
    writeFileSync(writer, JSON.stringify({ sessionDir: linuxAlias }));
  } finally {
    if (writer !== undefined) closeSync(writer);
  }
  const result = await deletion;
  unlinkSync(f.settingsFile);
  writeFileSync(f.settingsFile, JSON.stringify({ sessionDir: linuxAlias }));
  return result;
}

/** Both alias destinations and every referent belong to this disposable fake distro. */
async function fixture(t, variant) {
  let settingsFile, alias, rootA, rootB, originalFile, replacementFile, firstReferent, secondReferent;
  const f = await startBackendSession(t, {
    settings: { wslEnabled: true, wslDistro: "Ubuntu", wslUser: "dev" },
    prepare(directory) {
      const project = join(directory.root, "project");
      mkdirSync(join(project, ".pi"), { recursive: true });
      writeFileSync(join(directory.userData, "projects.json"), JSON.stringify([
        { id: "lease-project", path: project, name: "Lease project", environment: "windows" },
      ]));
      settingsFile = join(project, ".pi", "settings.json");
      writeFileSync(settingsFile, JSON.stringify({ sessionDir: linuxAlias }));
      const uncRoot = join(directory.root, "wsl-unc");
      const home = join(uncRoot, "Ubuntu", "home", "dev");
      rootA = join(home, "original-root"); rootB = join(home, "replacement-root");
      mkdirSync(rootA, { recursive: true }); mkdirSync(rootB);
      mkdirSync(join(home, ".pi", "agent", "sessions"), { recursive: true });
      alias = join(home, "configured-root"); symlinkSync(rootA, alias, "dir");
      originalFile = join(rootA, "target.jsonl"); replacementFile = join(rootB, "target.jsonl");
      const content = (id) => JSON.stringify({ type: "session", version: 3, id, cwd: project }) + "\n";
      writeFileSync(originalFile, content("original-session"));
      writeFileSync(replacementFile, content("replacement-session"));
      if (variant === "same referents" || variant === "primary link") {
        firstReferent = join(home, "first.jsonl"); secondReferent = join(home, "second.jsonl");
        writeFileSync(firstReferent, content("first-referent")); writeFileSync(secondReferent, content("second-referent"));
        unlinkSync(originalFile); symlinkSync(firstReferent, originalFile);
        if (variant === "same referents") {
          unlinkSync(replacementFile); symlinkSync(firstReferent, replacementFile);
          const sharedTree = join(home, "shared-companion"); mkdirSync(sharedTree);
          symlinkSync(sharedTree, join(rootA, "target"), "dir");
          symlinkSync(sharedTree, join(rootB, "target"), "dir");
        }
      } else if (variant === "companion link") {
        firstReferent = join(home, "first-tree"); secondReferent = join(home, "second-tree");
        mkdirSync(firstReferent); mkdirSync(secondReferent);
        writeFileSync(join(firstReferent, "keep.txt"), "first tree");
        writeFileSync(join(secondReferent, "keep.txt"), "second tree");
        symlinkSync(firstReferent, join(rootA, "target"), "dir");
      }
      writeFileSync(join(directory.userData, "session-catalog.json"), JSON.stringify({ version: 1, sessions: [
        { id: "lease-target", projectId: "lease-project", title: "Target", environment: "wsl", source: "pi",
          filePath: `${linuxAlias}/target.jsonl`, wslDistro: "Ubuntu", wslUser: "dev", status: "active",
          originKey: "lease-target", createdAt: 1, updatedAt: 1 },
      ] }));
      const scenario = join(directory.root, "wsl.json");
      writeFileSync(scenario, JSON.stringify({ root: home, linuxHome, home: linuxHome, distros: ["Ubuntu"] }));
      return { env: {
        PIDECK_WSL_EXE: launcher, PIDECK_WSL_UNC_ROOT: uncRoot,
        FAKE_WSL_SCRIPT: join(process.cwd(), "tests/fixtures/native2-fake-wsl-fs.mjs"),
        FAKE_WSL_NODE: process.execPath, FAKE_WSL_SCENARIO: scenario,
      } };
    },
  });
  const ready = await f.invoke("settings:update", [{ wslEnabled: true, wslDistro: "Ubuntu", wslUser: "dev" }]);
  assert.equal(ready.payload.ok, true, JSON.stringify(ready.payload));
  const change = (destination) => {
    const path = variant === "primary link" ? originalFile
      : variant === "companion link" ? join(rootA, "target") : alias;
    unlinkSync(path);
    symlinkSync(destination, path, variant === "primary link" ? "file" : "dir");
  };
  return { ...f, settingsFile, originalFile, replacementFile, firstReferent, secondReferent,
    retarget: () => change(variant.endsWith("link") ? secondReferent : rootB),
    restore: () => change(variant.endsWith("link") ? firstReferent : rootA),
  };
}

for (const variant of ["configured root", "same referents", "primary link", "companion link"]) {
  test(`WSL deletion refuses ${variant} retargeting between admission and planning`, { skip }, async (t) => {
    const f = await fixture(t, variant);
    const original = readFileSync(f.originalFile, "utf8");
    const replacement = readFileSync(f.replacementFile, "utf8");
    const secondContent = variant === "primary link" ? readFileSync(f.secondReferent, "utf8") : undefined;
    const result = await retargetDuringPlanning(f, f.retarget);
    assert.equal(result.payload.ok, false, JSON.stringify(result.payload));
    assert.equal(existsSync(f.originalFile), true);
    assert.equal(readFileSync(f.replacementFile, "utf8"), replacement);
    if (variant === "primary link") {
      assert.equal(readFileSync(f.firstReferent, "utf8"), original);
      assert.equal(readFileSync(f.secondReferent, "utf8"), secondContent);
    }
    if (variant === "companion link") {
      assert.equal(readFileSync(join(f.firstReferent, "keep.txt"), "utf8"), "first tree");
      assert.equal(readFileSync(join(f.secondReferent, "keep.txt"), "utf8"), "second tree");
    }
    f.restore();
    assert.equal(readFileSync(f.originalFile, "utf8"), original);
    // A refused mutation must release both admissions so the original tree can
    // be deleted by an ordinary retry after restoring its configured identity.
    const retry = await f.invoke("sessions:catalog-delete", ["lease-target"]);
    assert.equal(retry.payload.result, true, JSON.stringify(retry.payload));
    assert.equal(existsSync(f.originalFile), false);
    assert.equal(readFileSync(f.replacementFile, "utf8"), replacement);
  });
}
