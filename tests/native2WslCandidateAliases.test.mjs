import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { nativeBuildPaths } from "./helpers/nativeBuildPaths.mjs";
import { backendTestAvailability, startBackendSession } from "./helpers/native2BackendHarness.mjs";
import { createProbePi } from "./helpers/native2ProbePi.mjs";
import { waitFor } from "./helpers/native2RuntimeEvents.mjs";

const launcher = nativeBuildPaths("PiDeck-FakeWsl").map((path) => join(process.cwd(), path)).find(existsSync);
const availability = backendTestAvailability();
if (process.env.PIDECK_REQUIRE_BACKEND_TESTS === "1") assert.ok(launcher, "Build PiDeck-FakeWsl before required native tests");
const skip = availability.skip || (!launcher ? "PiDeck-FakeWsl executable not found" : false);
const runtimeSkip = skip || (process.platform !== "win32" ? "WSL runtime launch requires Windows" : false);
const linuxHome = "/home/dev";
const rootAlias = `${linuxHome}/root-alias`;
const candidateAlias = `${linuxHome}/candidate-alias`;
const fakeFs = join(process.cwd(), "tests/fixtures/native2-fake-wsl-fs.mjs");
const fileSymlink = (target) => `pideck-fake-wsl-file-symlink:\n${target}`;

test("the fake WSL filesystem distinguishes a file link entry from its referent", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pideck-fake-wsl-link-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scenario = join(root, "wsl.json");
  writeFileSync(scenario, JSON.stringify({ root: realpathSync.native(root), linuxHome, fileSymlinks: true }));
  const target = `${linuxHome}/target.jsonl`;
  const link = `${linuxHome}/link.jsonl`;
  const moved = `${linuxHome}/moved.jsonl`;
  const targetFile = join(root, "target.jsonl");
  writeFileSync(targetFile, "referent content");
  writeFileSync(join(root, "link.jsonl"), fileSymlink(target));
  const run = (args, status = 0) => {
    const result = spawnSync(process.execPath, [fakeFs, "-d", "Ubuntu", "-u", "dev", ...args], {
      encoding: "utf8", timeout: 5_000, env: { ...process.env, FAKE_WSL_SCENARIO: scenario, FAKE_WSL_LOG: "" },
    });
    assert.ifError(result.error);
    assert.equal(result.status, status, result.stderr);
    return result.stdout;
  };
  run(["test", "-L", link]);
  run(["test", "-f", link]);
  assert.equal(run(["cat", link]), "referent content");
  assert.equal(run(["realpath", "-e", "--", link]), `${target}\n`);
  const identityArgs = ["sh", "-c", "# fixture identity probe", "pideck-delete-identities", link];
  assert.equal(run(identityArgs), `${link}\0${target}\0`);
  const { dev, ino } = statSync(targetFile, { bigint: true });
  assert.equal(run(["stat", "-Lc", "%d:%i", "--", link]), `${dev}:${ino}\n`);
  assert.equal(Number(run(["stat", "-c", "%Y %s", link]).trim().split(" ")[1]), Buffer.byteLength(target));
  run(["mv", "--", link, moved]);
  run(["test", "-L", link], 1);
  run(["test", "-L", moved]);
  run(["rm", "--", moved]);
  run(["test", "-L", moved], 1);
  assert.equal(readFileSync(targetFile, "utf8"), "referent content");
  unlinkSync(targetFile);
  writeFileSync(join(root, "link.jsonl"), fileSymlink(target));
  run(["test", "-L", link]);
  run(["test", "-e", link], 1);
  assert.equal(run(identityArgs), `${link}\0\0`);
});

test("an unresolved cyclic file link does not suppress later WSL identities", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pideck-fake-wsl-link-cycle-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scenario = join(root, "wsl.json");
  writeFileSync(scenario, JSON.stringify({ root: realpathSync.native(root), linuxHome, fileSymlinks: true }));
  const link = `${linuxHome}/link.jsonl`;
  const valid = `${linuxHome}/valid.jsonl`;
  writeFileSync(join(root, "link.jsonl"), fileSymlink(link));
  writeFileSync(join(root, "valid.jsonl"), "valid entry");
  const result = spawnSync(process.execPath, [fakeFs, "-d", "Ubuntu", "-u", "dev", "sh", "-c",
    "# fixture identity probe", "pideck-delete-identities", link, valid], {
    encoding: "utf8", timeout: 5_000, env: { ...process.env, FAKE_WSL_SCENARIO: scenario, FAKE_WSL_LOG: "" },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${link}\0\0${valid}\0${valid}\0`);
});

/** Pause the fake mutation itself, retaining the production coordinator's scoped lease. */
async function fixture(t, ancestor, retarget = false, holdAdmission = false) {
  let gate, entered, preserved, changingAlias, companion, outside, parent, runtimeExit, log, probe, versionGate, identityGate;
  const f = await startBackendSession(t, {
    settings: { wslEnabled: true, wslDistro: "Ubuntu", wslUser: "dev" },
    prepare(directory) {
      const project = join(directory.root, "project");
      mkdirSync(join(project, ".pi"), { recursive: true });
      writeFileSync(join(project, ".pi", "settings.json"), JSON.stringify({ sessionDir: rootAlias }));
      writeFileSync(join(directory.userData, "projects.json"), JSON.stringify([
        { id: "wsl-candidate", name: "Candidate aliases", path: project, environment: "windows" },
      ]));
      probe = createProbePi(directory);
      versionGate = join(directory.root, "release-version");
      probe.setScenario({ versionGate });
      const unc = join(directory.root, "wsl-unc");
      const home = join(unc, "Ubuntu", "home", "dev");
      const sessions = join(home, ".pi", "agent", "sessions");
      companion = join(sessions, "parent");
      outside = join(home, "outside");
      mkdirSync(companion, { recursive: true }); mkdirSync(join(outside, "deep"), { recursive: true });
      const content = (id) => JSON.stringify({ type: "session", version: 3, id, cwd: project }) + "\n";
      parent = join(sessions, "parent.jsonl");
      writeFileSync(parent, content("parent"));
      symlinkSync(sessions, join(home, "root-alias"), process.platform === "win32" ? "junction" : "dir");
      symlinkSync(sessions, join(home, "candidate-alias"), process.platform === "win32" ? "junction" : "dir");
      let candidatePath;
      const fileSymlinks = process.platform === "win32" && !ancestor && !retarget;
      if (retarget) {
        preserved = join(outside, "child.jsonl");
        writeFileSync(preserved, content("outside-child"));
        mkdirSync(join(outside, "child"));
        writeFileSync(join(companion, "child.jsonl"), content("inside-child"));
        mkdirSync(join(companion, "child"));
        changingAlias = join(home, "changing-candidate");
        symlinkSync(outside, changingAlias, process.platform === "win32" ? "junction" : "dir");
        candidatePath = `${linuxHome}/changing-candidate/child.jsonl`;
      } else if (ancestor) {
        preserved = join(outside, "deep", "child.jsonl");
        writeFileSync(preserved, content("outside-child"));
        symlinkSync(outside, join(companion, "redirect"), process.platform === "win32" ? "junction" : "dir");
        candidatePath = `${candidateAlias}/parent/redirect/deep/child.jsonl`;
      } else {
        preserved = join(outside, "child.jsonl");
        writeFileSync(preserved, content("outside-child"));
        mkdirSync(join(outside, "child"));
        const child = join(companion, "child.jsonl");
        if (fileSymlinks) writeFileSync(child, fileSymlink(`${linuxHome}/outside/child.jsonl`));
        else symlinkSync(preserved, child);
        symlinkSync(join(outside, "child"), join(companion, "child"), process.platform === "win32" ? "junction" : "dir");
        candidatePath = `${candidateAlias}/parent/child.jsonl`;
      }
      writeFileSync(join(directory.userData, "session-catalog.json"), JSON.stringify({ version: 1, sessions: [
        { id: "candidate-parent", filePath: `${rootAlias}/parent.jsonl` },
        { id: "candidate-child", filePath: candidatePath },
      ].map((entry) => ({ ...entry, projectId: "wsl-candidate", title: entry.id, environment: "wsl", source: "pi",
        wslDistro: "Ubuntu", wslUser: "dev", status: "active", originKey: entry.id, createdAt: 1, updatedAt: 1 })) }));
      const scenario = join(directory.root, "wsl.json");
      identityGate = join(directory.root, "release-identity");
      writeFileSync(scenario, JSON.stringify({ root: home, linuxHome, home: linuxHome, distros: ["Ubuntu"], runtimePi: true, fileSymlinks,
        ...(holdAdmission ? { identityGate, versionGate } : {}) }));
      gate = join(directory.root, "release-trash"); entered = join(directory.root, "trash-entered");
      runtimeExit = join(directory.root, "exit-runtime");
      log = join(directory.root, "wsl.log");
      const script = join(directory.root, "gated-wsl.mjs");
      writeFileSync(script, [
        'import { existsSync, writeFileSync } from "node:fs";',
        'const args = process.argv.slice(2);',
        'if (args.includes("pi") && !args.includes("--version")) {',
        `  setInterval(() => { if (existsSync(${JSON.stringify(runtimeExit)})) process.exit(0); }, 10).unref();`,
        '}',
        `if (args.some((arg) => arg.includes("# pideck-scoped-trash-v1"))) {`,
        `  writeFileSync(${JSON.stringify(entered)}, "entered");`,
        `  while (!existsSync(${JSON.stringify(gate)})) await new Promise((resolve) => setTimeout(resolve, 10));`,
        "}",
        `await import(${JSON.stringify(pathToFileURL(fakeFs).href)});`,
      ].join("\n"));
      return { env: { PIDECK_WSL_EXE: launcher, PIDECK_WSL_UNC_ROOT: unc,
        FAKE_WSL_SCRIPT: script, FAKE_WSL_NODE: process.execPath, FAKE_WSL_SCENARIO: scenario, FAKE_WSL_LOG: log,
        FAKE_PI_SCENARIO: probe.scenarioPath, FAKE_PI_LOG: probe.logPath } };
    },
  });
  const ready = await f.invoke("settings:update", [{ wslEnabled: true, wslDistro: "Ubuntu", wslUser: "dev" }]);
  assert.equal(ready.payload.ok, true, JSON.stringify(ready.payload));
  const commands = () => readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  return { ...f, entered, gate, preserved, changingAlias, companion, outside, parent, runtimeExit, probe, versionGate, identityGate, commands,
    runtimeSpawns: () => commands().filter((entry) => !entry.rpc && entry.argv.includes("pi") && !entry.argv.includes("--version")),
  };
}

function logged(f, message) {
  const logs = join(f.fixture.userData, "logs");
  return readdirSync(logs).filter((name) => name.endsWith(".log"))
    .some((name) => readFileSync(join(logs, name), "utf8").includes(message));
}

/** Hold activation during the real version probe, before the runtime spawn check. */
async function pendingVersionActivation(f) {
  const configured = await f.invoke("settings:update", [{ customPiPath: f.probe.shim, piRuntimePreference: "auto" }]);
  assert.equal(configured.payload.ok, true, JSON.stringify(configured.payload));
  const activation = f.invoke("sessions:runtime-activate", ["candidate-child"]);
  await waitFor(() => f.probe.starts().length > 0, 3000, "activation version probe");
  assert.equal(f.probe.exits().length, 0, "The activation must remain pending until the version gate opens");
  return {
    activation,
    release: () => writeFileSync(f.versionGate, "release"),
    restore: async () => {
      const restored = await f.invoke("settings:update", [{ customPiPath: "" }]);
      assert.equal(restored.payload.ok, true, JSON.stringify(restored.payload));
    },
  };
}

async function assertActivationAfterLease(f) {
  const retry = await f.invoke("sessions:runtime-activate", ["candidate-child"]);
  if (process.platform === "win32") {
    assert.equal(retry.payload.result.ok, true, JSON.stringify(retry.payload));
  } else {
    // Linux cannot launch WSL, but reaching the later platform check proves that
    // the temporary deletion fence was released. It is distinct from admission.
    assert.equal(retry.payload.result.ok, false, JSON.stringify(retry.payload));
    assert.match(retry.payload.result.error.debugDetails, /Session runtime environment does not match the catalog/);
  }
}

test("a WSL deletion fences a previously unrelated candidate alias retargeted after admission", { skip }, async (t) => {
  const f = await fixture(t, false, true);
  const original = readFileSync(f.preserved, "utf8");
  const deletion = f.invoke("sessions:catalog-delete", ["candidate-parent"]);
  try {
    await waitFor(() => existsSync(f.entered), 10000, "WSL scoped trash gate");
    unlinkSync(f.changingAlias);
    symlinkSync(f.companion, f.changingAlias, process.platform === "win32" ? "junction" : "dir");
    const activation = await f.invoke("sessions:runtime-activate", ["candidate-child"]);
    assert.equal(activation.payload.result.ok, false, JSON.stringify(activation.payload));
    assert.match(activation.payload.result.error.debugDetails, /Session deletion is in progress/);
  } finally {
    writeFileSync(f.gate, "release");
    assert.equal((await deletion).payload.result, true);
  }
  assert.equal(readFileSync(f.preserved, "utf8"), original);
  // Restore the unrelated identity and retry after mutation has released its lease.
  unlinkSync(f.changingAlias);
  symlinkSync(f.outside, f.changingAlias, process.platform === "win32" ? "junction" : "dir");
  await assertActivationAfterLease(f);
});

for (const ancestor of [false, true]) {
  test(`an activating WSL candidate's ${ancestor ? "ancestor link" : "leaf links"} prevent deletion during its version probe`, { skip }, async (t) => {
    const f = await fixture(t, ancestor);
    const original = readFileSync(f.preserved, "utf8");
    const pending = await pendingVersionActivation(f);
    let settled;
    const deletion = f.invoke("sessions:catalog-delete", ["candidate-parent"]).then((result) => (settled = result));
    try {
      await waitFor(() => settled || existsSync(f.entered), 10000, "WSL deletion admission");
    } finally {
      writeFileSync(f.gate, "release");
      await deletion;
      pending.release();
      await pending.activation;
      await pending.restore();
    }
    assert.equal(settled.payload.ok, false, JSON.stringify(settled.payload));
    assert.equal(existsSync(f.entered), false, "Admission must refuse before filesystem mutation");
    assert.ok(existsSync(f.parent));
    assert.ok(existsSync(f.companion));
    assert.equal(readFileSync(f.preserved, "utf8"), original);
  });

  test(`an active WSL candidate's ${ancestor ? "ancestor link" : "leaf links"} prevent deletion of its traversal entries`, { skip: runtimeSkip }, async (t) => {
    const f = await fixture(t, ancestor);
    const original = readFileSync(f.preserved, "utf8");
    const activation = await f.invoke("sessions:runtime-activate", ["candidate-child"]);
    assert.equal(activation.payload.result.ok, true, JSON.stringify(activation.payload));
    let settled;
    const deletion = f.invoke("sessions:catalog-delete", ["candidate-parent"]).then((result) => (settled = result));
    try {
      await waitFor(() => settled || existsSync(f.entered), 10000, "WSL deletion admission");
    } finally {
      // A broken guard reaches the gated mutation. Release it so the failure
      // reports the unsafe result instead of leaving a child process hanging.
      writeFileSync(f.gate, "release");
      await deletion;
    }
    assert.equal(settled.payload.ok, false, JSON.stringify(settled.payload));
    assert.ok(existsSync(f.parent));
    assert.ok(existsSync(f.companion));
    assert.equal(readFileSync(f.preserved, "utf8"), original);
  });

  test(`a WSL deletion fences a candidate's ${ancestor ? "ancestor link" : "leaf links"} before runtime launch`, { skip }, async (t) => {
    const f = await fixture(t, ancestor);
    const original = readFileSync(f.preserved, "utf8");
    const deletion = f.invoke("sessions:catalog-delete", ["candidate-parent"]);
    try {
      await waitFor(() => existsSync(f.entered), 10000, "WSL scoped trash gate");
      const activation = await f.invoke("sessions:runtime-activate", ["candidate-child"]);
      assert.equal(activation.payload.result.ok, false, JSON.stringify(activation.payload));
      // This admission check runs before any platform-specific WSL launch. A
      // later environment/launch failure cannot stand in for the deletion fence.
      assert.match(activation.payload.result.error.debugDetails, /Session deletion is in progress/);
    } finally {
      writeFileSync(f.gate, "release");
      assert.equal((await deletion).payload.result, true);
    }
    assert.equal(readFileSync(f.preserved, "utf8"), original);
  });
}

test("an unrelated pending WSL activation permits deletion but its delayed spawn waits for the lease", { skip }, async (t) => {
  const f = await fixture(t, false, true);
  const original = readFileSync(f.preserved, "utf8");
  const pending = await pendingVersionActivation(f);
  const deletion = f.invoke("sessions:catalog-delete", ["candidate-parent"]);
  try {
    // Shared / and /home traversal prefixes must not turn the candidate into an
    // owner of the whole namespace. The unrelated mutation can reach its gate.
    await waitFor(() => existsSync(f.entered), 10000, "unrelated WSL deletion admission");
    pending.release();
    const activation = await pending.activation;
    assert.equal(activation.payload.result.ok, false, JSON.stringify(activation.payload));
    assert.match(activation.payload.result.error.debugDetails, /Session deletion is in progress/);
  } finally {
    writeFileSync(f.gate, "release");
    assert.equal((await deletion).payload.result, true);
    pending.release();
    await pending.activation;
    await pending.restore();
  }
  assert.equal(readFileSync(f.preserved, "utf8"), original);
  await assertActivationAfterLease(f);
});

for (const unrelated of [false, true]) test(`a ${unrelated ? "disjoint" : "colliding"} WSL launch finishes probing during provisional deletion`, { skip: runtimeSkip }, async (t) => {
  const f = await fixture(t, !unrelated, unrelated, true);
  const previous = f.commands().length;
  let activationResult;
  const activation = f.invoke("sessions:runtime-activate", ["candidate-child"])
    .then((result) => (activationResult = result));
  let deletion;
  try {
    await waitFor(() => f.commands().slice(previous).some(({ argv }) => argv.includes("--version")), 5000, "WSL version probe");
    deletion = f.invoke("sessions:catalog-delete", ["candidate-parent"]);
    await waitFor(() => f.commands().slice(previous).some(({ argv }) => argv.includes("pideck-delete-identities")), 5000, "WSL identity probe");
    writeFileSync(f.versionGate, "release");
    const waiting = () => logged(f, "Waiting for WSL identity resolution before launching runtime");
    await waitFor(() => activationResult || waiting(), 5000, "provisional launch verdict");
    assert.equal(activationResult, undefined, "version completion must not settle a launch before alias resolution");
    assert.equal(f.runtimeSpawns().length, 0);
    writeFileSync(f.identityGate, "release");
    if (unrelated) {
      await waitFor(() => existsSync(f.entered), 10000, "WSL trash gate");
      const activated = await activation;
      assert.equal(activated.payload.result.ok, false, JSON.stringify(activated.payload));
      assert.match(activated.payload.result.error.debugDetails, /Session deletion is in progress/);
      assert.equal(f.runtimeSpawns().length, 0);
    } else {
      assert.equal((await deletion).payload.ok, false);
      assert.equal(existsSync(f.entered), false);
      const activated = await activation;
      assert.equal(activated.payload.result.ok, true, JSON.stringify(activated.payload));
      assert.ok(existsSync(f.parent));
    }
  } finally {
    writeFileSync(f.versionGate, "release");
    writeFileSync(f.identityGate, "release");
    writeFileSync(f.gate, "release");
    await Promise.all([activation, deletion]);
  }
  if (unrelated) assert.equal((await deletion).payload.result, true);
});

test("a scoped WSL deletion keeps an unrelated runtime reusable while deferring its restart", { skip: runtimeSkip }, async (t) => {
  const f = await fixture(t, false, true);
  const activation = await f.invoke("sessions:runtime-activate", ["candidate-child"]);
  assert.equal(activation.payload.result.ok, true, JSON.stringify(activation.payload));
  const target = activation.payload.result.value;
  const deletion = f.invoke("sessions:catalog-delete", ["candidate-parent"]);
  try {
    await waitFor(() => existsSync(f.entered), 10000, "WSL scoped trash gate");
    const restart = await f.invoke("sessions:runtime-restart", [target]);
    assert.equal(restart.payload.result.ok, false, JSON.stringify(restart.payload));
    assert.match(restart.payload.result.error.debugDetails, /Session deletion is in progress/);
    const reuse = await f.invoke("sessions:runtime-activate", ["candidate-child"]);
    assert.equal(reuse.payload.result.ok, true, JSON.stringify(reuse.payload));
    assert.equal(reuse.payload.result.value.agentId, target.agentId);
    assert.equal(reuse.payload.result.value.runtimeGeneration, target.runtimeGeneration);
  } finally {
    writeFileSync(f.gate, "release");
    assert.equal((await deletion).payload.result, true);
  }
  const retry = await f.invoke("sessions:runtime-restart", [target]);
  assert.equal(retry.payload.result.ok, true, JSON.stringify(retry.payload));
  const restarted = retry.payload.result.value.runtime;
  assert.ok(restarted.agentId);
  assert.notEqual(restarted.agentId, target.agentId);
  assert.ok(restarted.runtimeGeneration > target.runtimeGeneration);
});

test("a WSL runtime that exits during scoped deletion reconnects only after mutation", { skip: runtimeSkip }, async (t) => {
  const f = await fixture(t, false, true);
  const activation = await f.invoke("sessions:runtime-activate", ["candidate-child"]);
  assert.equal(activation.payload.result.ok, true, JSON.stringify(activation.payload));
  const target = activation.payload.result.value;
  const before = f.runtimeSpawns().length;
  const deletion = f.invoke("sessions:catalog-delete", ["candidate-parent"]);
  try {
    await waitFor(() => existsSync(f.entered), 10000, "WSL scoped trash gate");
    writeFileSync(f.runtimeExit, "exit");
    await waitFor(() => logged(f, "Waiting for WSL deletion before reconnecting runtime"), 5000, "deferred reconnect");
    assert.equal(f.runtimeSpawns().length, before, "A reconnect must wait until deletion releases its lease");
    const reuse = await f.invoke("sessions:runtime-activate", ["candidate-child"]);
    assert.equal(reuse.payload.result.ok, false, JSON.stringify(reuse.payload));
    assert.match(reuse.payload.result.error.debugDetails, /reconnect is already in progress/);
  } finally {
    if (existsSync(f.runtimeExit)) unlinkSync(f.runtimeExit);
    writeFileSync(f.gate, "release");
    assert.equal((await deletion).payload.result, true);
  }
  await waitFor(() => f.runtimeSpawns().length > before, 10000, "reconnected pi spawn");
  const commands = await f.invoke("sessions:runtime-commands", [target]);
  assert.equal(commands.payload.result.ok, true, JSON.stringify(commands.payload));
});
