import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { nativeBuildPaths } from "./helpers/nativeBuildPaths.mjs";
import { resolveBackendExecutable, startBackendSession } from "./helpers/native2BackendHarness.mjs";

const launcher = nativeBuildPaths("PiDeck-FakeWsl").map((path) => join(process.cwd(), path)).find(existsSync);
const runId = "11111111-2222-4333-8444-555555555555";
const linuxHome = "/home/dev";
const linuxRoot = `${linuxHome}/.pi/agent/sessions`;
const linuxFile = `${linuxRoot}/protected.jsonl`;
const runtimePath = process.cwd().replaceAll("\\", "/").replace(/^([A-Za-z]):\//, (_, drive) => `/mnt/${drive.toLowerCase()}/`);
// The filesystem fixture runs everywhere, but PiLaunch compiles WSL runtime
// creation only on Windows. Those cases must not fail before reaching their
// deletion assertions on a native Linux/macOS backend.
const wslRuntimeSkip = process.platform === "win32" ? false : "WSL runtime launch requires a Windows backend";

/** A fake distribution backed exclusively by this test's temporary directory. */
async function fixture(t, outsideRecord = false, foreignRecord = false, uppercaseTree = false, aliasTree = false, reverseAlias = false, otherUser = false, variant = "", language = "en-US") {
  let home, sessions, log, scenarioPath;
  const f = await startBackendSession(t, {
    projects: [{ id: "wsl-safe", path: process.cwd() }],
    settings: { language, wslEnabled: true, wslDistro: "Ubuntu", wslUser: "dev" },
    prepare: (fixture) => {
      const uncRoot = join(fixture.root, "wsl-unc");
      home = join(uncRoot, "Ubuntu", "home", "dev");
      sessions = join(home, ".pi", "agent", "sessions");
      mkdirSync(sessions, { recursive: true });
      writeFileSync(join(sessions, "protected.jsonl"), [
        { type: "session", id: "wsl-safe", version: 3, cwd: runtimePath, timestamp: "2026-01-01T00:00:00.000Z" },
        { type: "message", id: "u1", message: { role: "user", content: [{ type: "text", text: "protected" }] } },
        { type: "message", id: "r1", message: { role: "toolResult", toolName: "subagent", details: { mode: "single", runId } } },
      ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
      writeFileSync(join(sessions, "unrelated.jsonl"), `${JSON.stringify({ type: "session", id: "unrelated", version: 3, cwd: runtimePath })}\n`);
      if (outsideRecord || foreignRecord) {
        writeFileSync(join(home, "outside.jsonl"), "external data");
        writeFileSync(join(fixture.userData, "session-catalog.json"), JSON.stringify({ version: 1, sessions: [
          { id: foreignRecord ? "foreign" : "outside", projectId: "wsl-safe", environment: "wsl", wslDistro: foreignRecord ? "Debian" : "Ubuntu", wslUser: "dev", title: "outside", status: "active", filePath: foreignRecord ? linuxFile : `${linuxHome}/outside.jsonl` },
        ] }));
      }
      if (uppercaseTree) {
        mkdirSync(join(sessions, "parent"));
        writeFileSync(join(sessions, "parent.JSONL"), '{"type":"session","id":"parent"}\n');
        writeFileSync(join(sessions, "parent", "child.jsonl"), '{"type":"session","id":"child"}\n');
        writeFileSync(join(fixture.userData, "session-catalog.json"), JSON.stringify({ version: 1, sessions: [
          { id: "uppercase-parent", title: "parent", projectId: "wsl-safe", environment: "wsl", wslDistro: "Ubuntu", wslUser: "dev", status: "active", filePath: `${linuxRoot}/parent.JSONL` },
          { id: "uppercase-child", title: "child", projectId: "wsl-safe", environment: "wsl", wslDistro: "Ubuntu", wslUser: "dev", status: "active", filePath: `${linuxRoot}/parent/child.jsonl` },
        ] }));
      }
      if (aliasTree) {
        mkdirSync(join(sessions, "parent"));
        writeFileSync(join(sessions, "parent.jsonl"), '{"type":"session","id":"parent"}\n');
        writeFileSync(join(sessions, "parent", "child.jsonl"), '{"type":"session","id":"child"}\n');
        symlinkSync(sessions, join(home, "sessions-alias"), process.platform === "win32" ? "junction" : "dir");
        writeFileSync(join(fixture.userData, "session-catalog.json"), JSON.stringify({ version: 1, sessions: [
          { id: "alias-parent", title: "parent", projectId: "wsl-safe", environment: "wsl", wslDistro: "Ubuntu", wslUser: "dev", status: "active", filePath: `${reverseAlias ? `${linuxHome}/sessions-alias` : linuxRoot}/parent.jsonl` },
          { id: "alias-child", title: "child", projectId: "wsl-safe", environment: "wsl", wslDistro: "Ubuntu", wslUser: otherUser ? "other-user" : "dev", status: "active", filePath: `${reverseAlias ? linuxRoot : `${linuxHome}/sessions-alias`}/parent/child.jsonl` },
        ] }));
      }
      if (variant) {
        const catalogPath = join(fixture.userData, "session-catalog.json");
        const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
        const child = catalog.sessions.find((row) => row.id === "alias-child");
        if (variant === "dot-alias") {
          mkdirSync(join(sessions, "parent", "deep"));
          symlinkSync(join(sessions, "parent", "deep"), join(sessions, "escape"), process.platform === "win32" ? "junction" : "dir");
          child.filePath = `${linuxRoot}/escape/../child.jsonl`;
        } else if (variant === "companion-alias") {
          mkdirSync(join(sessions, "parent", "live-companion"));
          symlinkSync(join(sessions, "parent", "live-companion"), join(sessions, "unrelated"), process.platform === "win32" ? "junction" : "dir");
          child.filePath = `${linuxRoot}/unrelated.jsonl`;
        }
        if (variant === "distro-case") catalog.sessions.find((row) => row.id === "alias-parent").wslDistro = "ubuntu";
        if (variant === "native-draft") catalog.sessions.push({ id: "native-draft", title: "draft", projectId: "wsl-safe", environment: "native", status: "active" });
        writeFileSync(catalogPath, JSON.stringify(catalog));
      }
      const scenario = join(fixture.root, "wsl-scenario.json");
      scenarioPath = scenario;
      log = join(fixture.root, "wsl.log");
      writeFileSync(scenario, JSON.stringify({ root: home, linuxHome, home: linuxHome, distros: ["Ubuntu"] }));
      return { env: { PIDECK_WSL_EXE: launcher, PIDECK_WSL_UNC_ROOT: uncRoot,
        FAKE_WSL_SCRIPT: join(process.cwd(), "tests/fixtures/native2-fake-wsl-fs.mjs"), FAKE_WSL_NODE: process.execPath,
        FAKE_WSL_SCENARIO: scenario, FAKE_WSL_LOG: log } };
    },
  });
  let record;
  const deadline = Date.now() + 10000;
  while (!record && Date.now() < deadline) {
    const list = await f.invoke("sessions:catalog-list", ["wsl-safe"]);
    record = list.payload.result?.find((entry) => entry.filePath === linuxFile && entry.wsl === true);
    if (!record) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(record, "The real backend scanner must use the isolated WSL environment");
  return { ...f, home, sessions, id: record.id,
    commands: () => readFileSync(log, "utf8").trim().split("\n").map(JSON.parse),
    patchScenario: (patch) => writeFileSync(scenarioPath, JSON.stringify({ ...JSON.parse(readFileSync(scenarioPath, "utf8")), ...patch })),
  };
}

/** Both legacy moves and the descriptor-bound batch are filesystem mutation attempts. */
function isStorageMutation({ argv }) {
  return argv.includes("mv") || argv.some((argument) => argument.includes("# pideck-scoped-trash-v1"));
}

/** Wait for a fixture subprocess boundary without relying on arbitrary sleeps. */
async function waitForCommand(f, previous, command) {
  const deadline = Date.now() + 10000;
  while (!f.commands().slice(previous).some(({ argv }) => argv.includes(command)) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(f.commands().slice(previous).some(({ argv }) => argv.includes(command)), `Expected ${command}`);
}

/** Observe pi's public stdio request boundary while its response is delayed. */
async function waitForRpc(f, previous, command) {
  const deadline = Date.now() + 10000;
  while (!f.commands().slice(previous).some((entry) => entry.rpc === command) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(f.commands().slice(previous).some((entry) => entry.rpc === command), `Expected RPC ${command}`);
}

/** Start deletion while an earlier operation is held. Give the old code a chance to publish its provisional lease. */
async function overlapDeletion(f, sessionId, previous, identityGate, finishEarlier) {
  let settled = false;
  const deletion = f.invoke("sessions:catalog-delete", [sessionId]).finally(() => { settled = true; });
  const sawProbe = () => f.commands().slice(previous).some(({ argv }) => argv.includes("pideck-delete-identities"));
  try {
    const deadline = Date.now() + 5_000;
    while (!settled && !sawProbe() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(settled || sawProbe(), "deletion must reject admission or reach the held identity probe");
    await finishEarlier();
  } finally {
    writeFileSync(identityGate, "");
  }
  return deletion;
}

if (resolveBackendExecutable() && launcher) {
  for (const language of ["en-US", "zh-CN"]) test(`WSL safe-trash capability failure is localized and releases admission (${language})`, async (t) => {
    const f = await fixture(t, false, false, false, false, false, false, "", language);
    f.patchScenario({ safeTrashUnavailable: true });
    const result = await f.invoke("sessions:catalog-delete", [f.id]);
    assert.equal(result.payload.ok, false);
    assert.match(result.payload.error.message, /--no-copy/);
    assert.match(result.payload.error.message, language === "zh-CN" ? /升级/ : /Upgrade/);
    assert.ok(existsSync(join(f.sessions, "protected.jsonl")));
    f.patchScenario({ safeTrashUnavailable: false });
    assert.equal((await f.invoke("sessions:catalog-delete", [f.id])).payload.result, true);
  });
  test("a failed Linux root holder releases catalog and runtime admission for retry", async (t) => {
    const f = await fixture(t);
    f.patchScenario({ rootPinFailure: true });
    assert.equal((await f.invoke("sessions:catalog-delete", [f.id])).payload.ok, false);
    assert.ok(existsSync(join(f.sessions, "protected.jsonl")));
    f.patchScenario({ rootPinFailure: false });
    assert.equal((await f.invoke("sessions:catalog-delete", [f.id])).payload.result, true);
  });
  test("WSL catalog deletion rejects files outside configured session roots", async (t) => {
    const f = await fixture(t, true);
    const result = await f.invoke("sessions:catalog-delete", ["outside"]);
    assert.equal(result.payload.ok, false, JSON.stringify(result.payload));
    assert.equal(readFileSync(join(f.home, "outside.jsonl"), "utf8"), "external data");
  });
  test("WSL deletion cannot reinterpret an old distribution's catalog path in the current distribution", async (t) => {
    const f = await fixture(t, false, true);
    const result = await f.invoke("sessions:catalog-delete", ["foreign"]);
    assert.equal(result.payload.ok, false, JSON.stringify(result.payload));
    assert.ok(existsSync(join(f.sessions, "protected.jsonl")));
  });
  for (const component of ["subagent-artifacts", "outputs", "structured-output", ".pideck-trash"]) {
    test(`WSL deletion refuses a linked ${component} directory without moving outside data`, async (t) => {
      const f = await fixture(t);
      const outside = join(f.home, "outside");
      mkdirSync(outside);
      const sentinel = join(outside, `${runId}_output.txt`);
      writeFileSync(sentinel, "external data");
      const nested = component === "outputs" || component === "structured-output";
      if (nested) mkdirSync(join(f.sessions, "subagent-artifacts"));
      const link = nested ? join(f.sessions, "subagent-artifacts", component) : join(f.sessions, component);
      symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
      const result = await f.invoke("sessions:catalog-delete", [f.id]);
      assert.equal(result.payload.ok, false, JSON.stringify(result.payload));
      assert.equal(readFileSync(sentinel, "utf8"), "external data");
      assert.ok(existsSync(join(f.sessions, "protected.jsonl")));
      assert.deepEqual(readdirSync(outside), [`${runId}_output.txt`]);
    });
  }
  test("uppercase WSL parent reservation blocks child activation", async (t) => {
    const f = await fixture(t, false, false, true);
    f.patchScenario({ realpathDelayMs: 350 });
    const previous = f.commands().length;
    const deletion = f.invoke("sessions:catalog-delete", ["uppercase-parent"]);
    const deadline = Date.now() + 10000;
    while (!f.commands().slice(previous).some(({ argv }) => argv.includes("realpath")) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(f.commands().slice(previous).some(({ argv }) => argv.includes("realpath")));
    const activation = await f.invoke("sessions:runtime-activate", ["uppercase-child"]);
    assert.equal(activation.payload.result.ok, false, JSON.stringify(activation.payload));
    assert.match(activation.payload.result.error.debugDetails, /delet/i);
    await deletion;
  });
  test("WSL reservation blocks activation through a filesystem alias", async (t) => {
    const f = await fixture(t, false, false, false, true);
    f.patchScenario({ realpathDelayMs: 350 });
    const previous = f.commands().length;
    const deletion = f.invoke("sessions:catalog-delete", ["alias-parent"]);
    const deadline = Date.now() + 10000;
    while (!f.commands().slice(previous).some(({ argv }) => argv.includes("realpath")) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(f.commands().slice(previous).some(({ argv }) => argv.includes("realpath")));
    try {
      const activation = await f.invoke("sessions:runtime-activate", ["alias-child"]);
      assert.equal(activation.payload.result.ok, false, JSON.stringify(activation.payload));
      assert.match(activation.payload.result.error.debugDetails, /delet/i);
    } finally {
      await deletion;
    }
  });
  test("WSL reservation blocks canonical child when the parent uses an alias", async (t) => {
    const f = await fixture(t, false, false, false, true, true);
    f.patchScenario({ realpathDelayMs: 350 });
    const previous = f.commands().length;
    const deletion = f.invoke("sessions:catalog-delete", ["alias-parent"]);
    const deadline = Date.now() + 10000;
    while (!f.commands().slice(previous).some(({ argv }) => argv.includes("realpath")) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(f.commands().slice(previous).some(({ argv }) => argv.includes("realpath")));
    try {
      const activation = await f.invoke("sessions:runtime-activate", ["alias-child"]);
      assert.equal(activation.payload.result.ok, false, JSON.stringify(activation.payload));
      assert.match(activation.payload.result.error.debugDetails, /delet/i);
    } finally {
      await deletion;
    }
  });
  for (const [label, flag, target] of [
    ["peer", "-f", `${linuxRoot}/peer.jsonl`],
    ["primary", "-e", linuxFile],
    ["artifact directory", "-d", `${linuxRoot}/subagent-artifacts`],
  ]) {
    test(`failed ${label} probe leaves all session data intact`, async (t) => {
      const f = await fixture(t);
      writeFileSync(join(f.sessions, "peer.jsonl"), JSON.stringify({ type: "message", message: { role: "toolResult", toolName: "subagent", details: { mode: "single", runId } } }) + "\n");
      mkdirSync(join(f.sessions, "subagent-artifacts"));
      const shared = join(f.sessions, "subagent-artifacts", `${runId}_output.txt`);
      writeFileSync(shared, "shared data");
      f.patchScenario({ failTestPath: target, failTestFlag: flag });
      const result = await f.invoke("sessions:catalog-delete", [f.id]);
      assert.equal(result.payload.ok, false, JSON.stringify(result.payload));
      assert.ok(f.commands().some(({ argv }) => argv.includes(flag) && argv.includes(target)));
      assert.equal(readFileSync(shared, "utf8"), "shared data");
      assert.ok(existsSync(join(f.sessions, "protected.jsonl")));
      assert.ok(existsSync(join(f.sessions, "peer.jsonl")));
    });
  }
  test("failed peer companion listing cannot authorize deleting shared artifacts", async (t) => {
    const f = await fixture(t);
    writeFileSync(join(f.sessions, "peer.jsonl"), JSON.stringify({ type: "session", id: "peer" }) + "\n");
    mkdirSync(join(f.sessions, "peer", runId), { recursive: true });
    mkdirSync(join(f.sessions, "subagent-artifacts"));
    const shared = join(f.sessions, "subagent-artifacts", `${runId}_output.txt`);
    writeFileSync(shared, "peer data");
    f.patchScenario({ failListPath: `${linuxRoot}/peer` });
    const result = await f.invoke("sessions:catalog-delete", [f.id]);
    assert.equal(result.payload.ok, false, JSON.stringify(result.payload));
    assert.ok(f.commands().some(({ argv }) => argv.includes("find") && argv.includes("-mindepth") && argv.includes(`${linuxRoot}/peer`)), `peer listing must be attempted: ${JSON.stringify(result.payload)} ${JSON.stringify(f.commands())}`);
    assert.equal(readFileSync(shared, "utf8"), "peer data");
    assert.ok(existsSync(join(f.sessions, "protected.jsonl")));
  });
  test("an environment switch cannot retarget an in-flight WSL deletion", async (t) => {
    const f = await fixture(t);
    f.patchScenario({ realpathDelayMs: 350 });
    // Root provenance may itself resolve paths during the preceding scan; wait for
    // this deletion's authorization rather than a stale command from setup.
    const previousCommands = f.commands().length;
    const deletion = f.invoke("sessions:catalog-delete", [f.id]);
    const deadline = Date.now() + 5000;
    while (!f.commands().slice(previousCommands).some((entry) => entry.argv.includes("realpath")) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(f.commands().slice(previousCommands).some((entry) => entry.argv.includes("realpath")), "Authorization is in flight");
    const change = f.invoke("settings:update", [{ wslEnabled: false }]);
    const result = await deletion;
    await change;
    assert.equal(result.payload.result, true, JSON.stringify(result.payload));
    assert.equal(existsSync(join(f.sessions, "protected.jsonl")), false);
    const buckets = readdirSync(join(f.sessions, ".pideck-trash"));
    assert.equal(buckets.length, 1);
    assert.ok(existsSync(join(f.sessions, ".pideck-trash", buckets[0], "protected.jsonl")));
  });
  for (const reverse of [false, true]) {
    test(`already-live WSL alias child blocks deletion (${reverse ? "aliased parent" : "aliased child"})`, { skip: wslRuntimeSkip }, async (t) => {
      const f = await fixture(t, false, false, false, true, reverse);
      f.patchScenario({ runtimePi: true });
      const activation = await f.invoke("sessions:runtime-activate", ["alias-child"]);
      assert.equal(activation.payload.result.ok, true, JSON.stringify({ result: activation.payload, commands: f.commands().slice(-12) }));
      const deletion = await f.invoke("sessions:catalog-delete", ["alias-parent"]);
      assert.equal(deletion.payload.ok, false, JSON.stringify(deletion.payload));
      assert.ok(existsSync(join(f.sessions, "parent.jsonl")));
      assert.ok(existsSync(join(f.sessions, "parent", "child.jsonl")));
      assert.equal(f.commands().some(isStorageMutation), false);
    });
  }
  test("same-distribution WSL users cannot bypass an active alias child's ownership", { skip: wslRuntimeSkip }, async (t) => {
    const f = await fixture(t, false, false, false, true, false, true);
    f.patchScenario({ runtimePi: true, whoami: "other-user" });
    await f.invoke("settings:update", [{ wslUser: "other-user" }]);
    const activation = await f.invoke("sessions:runtime-activate", ["alias-child"]);
    assert.equal(activation.payload.result.ok, true, JSON.stringify(activation.payload));
    f.patchScenario({ whoami: "dev" });
    await f.invoke("settings:update", [{ wslUser: "dev" }]);
    const result = await f.invoke("sessions:catalog-delete", ["alias-parent"]);
    assert.equal(result.payload.ok, false, JSON.stringify(result.payload));
    assert.ok(existsSync(join(f.sessions, "parent", "child.jsonl")));
  });
  for (const variant of ["dot-alias", "companion-alias"]) {
    test(`WSL deletion protects a live ${variant} identity`, { skip: wslRuntimeSkip }, async (t) => {
      const f = await fixture(t, false, false, false, true, false, false, variant);
      f.patchScenario({ runtimePi: true });
      const activation = await f.invoke("sessions:runtime-activate", ["alias-child"]);
      assert.equal(activation.payload.result.ok, true, JSON.stringify(activation.payload));
      const deletion = await f.invoke("sessions:catalog-delete", ["alias-parent"]);
      assert.equal(deletion.payload.ok, false, JSON.stringify(deletion.payload));
      assert.ok(existsSync(join(f.sessions, "parent", "child.jsonl")));
      assert.equal(f.commands().some(isStorageMutation), false);
    });
  }
  test("WSL activation refuses to reinterpret a catalog session in another distribution", { skip: wslRuntimeSkip }, async (t) => {
    const f = await fixture(t, false, true);
    f.patchScenario({ runtimePi: true });
    const previous = f.commands().length;
    const activation = await f.invoke("sessions:runtime-activate", ["foreign"]);
    assert.equal(activation.payload.result.ok, false, JSON.stringify(activation.payload));
    assert.equal(f.commands().slice(previous).some(({ argv }) => argv.includes("--mode")), false);
    assert.ok(existsSync(join(f.sessions, "protected.jsonl")));
  });
  test("identity resolution is asynchronous and failed resolution releases admission for retry", async (t) => {
    const f = await fixture(t, false, false, false, true);
    const identityGate = join(f.fixture.root, "release-failing-identity");
    f.patchScenario({ identityGate, identityFailure: true });
    const previous = f.commands().length;
    const failed = await overlapDeletion(f, "alias-parent", previous, identityGate, async () => {
      await waitForCommand(f, previous, "pideck-delete-identities");
      const runtimes = await f.invoke("sessions:runtime-list", []);
      assert.equal(runtimes.payload.ok, true, "owner RPC must complete before the WSL probe is released");
      const activation = await f.invoke("sessions:runtime-activate", ["alias-child"]);
      assert.equal(activation.payload.result.ok, false);
      assert.match(activation.payload.result.error.debugDetails, /delet/i);
      assert.equal(existsSync(identityGate), false);
    });
    assert.equal(failed.payload.ok, false);
    assert.match(failed.payload.error.message, /identity/i);
    assert.ok(existsSync(join(f.sessions, "parent", "child.jsonl")));
    f.patchScenario({ identityGate: undefined, identityFailure: false });
    const retry = await f.invoke("sessions:catalog-delete", ["alias-parent"]);
    assert.equal(retry.payload.result, true, JSON.stringify(retry.payload));
  });
  test("an unrelated active WSL session stays usable after scoped alias resolution", { skip: wslRuntimeSkip }, async (t) => {
    const f = await fixture(t);
    f.patchScenario({ runtimePi: true });
    const catalog = await f.invoke("sessions:catalog-list", ["wsl-safe"]);
    const unrelated = catalog.payload.result.find((row) => row.filePath === `${linuxRoot}/unrelated.jsonl`);
    assert.ok(unrelated);
    const activation = await f.invoke("sessions:runtime-activate", [unrelated.id]);
    assert.equal(activation.payload.result.ok, true, JSON.stringify(activation.payload));
    const previous = f.commands().length;
    f.patchScenario({ realpathDelayMs: 200 });
    const deletion = f.invoke("sessions:catalog-delete", [f.id]);
    await waitForCommand(f, previous, "realpath");
    // This activation reuses a live, resolved unrelated identity while the deletion
    // is still authorizing/moving its own tree. A blanket distro lock would fail it.
    const reuse = await f.invoke("sessions:runtime-activate", [unrelated.id]);
    assert.equal(reuse.payload.result.ok, true, JSON.stringify(reuse.payload));
    assert.equal((await deletion).payload.result, true);
    assert.ok(existsSync(join(f.sessions, "unrelated.jsonl")));
  });
  for (const noSession of [false, true]) {
    test(`WSL history deletion ${noSession ? "allows an active in-memory session" : "refuses an unknown persistent runtime"}`, { skip: wslRuntimeSkip }, async (t) => {
      const f = await fixture(t);
      f.patchScenario({ runtimePi: true });
      const created = await f.invoke(noSession ? "sessions:create-anonymous" : "sessions:catalog-create-draft", [
        { projectId: "wsl-safe", title: "Runtime without a session file" },
      ]);
      assert.equal(created.payload.ok, true, JSON.stringify(created.payload));
      const record = noSession ? created.payload.result.session : created.payload.result;
      assert.equal(record.environment, "wsl");
      assert.equal(record.filePath ?? "", "");
      assert.equal(record.noSession ?? false, noSession);
      const activated = await f.invoke("sessions:runtime-activate", [record.id]);
      assert.equal(activated.payload.result.ok, true, JSON.stringify(activated.payload));
      assert.equal(activated.payload.result.value.sessionPath ?? "", "");
      const deletion = await f.invoke("sessions:catalog-delete", [f.id]);
      assert.equal(deletion.payload.ok, noSession, JSON.stringify(deletion.payload));
      if (noSession) {
        assert.equal(deletion.payload.result, true);
        assert.equal(existsSync(join(f.sessions, "protected.jsonl")), false);
        const stillUsable = await f.invoke("sessions:runtime-state", [activated.payload.result.value]);
        assert.equal(stillUsable.payload.result.ok, true, JSON.stringify(stillUsable.payload));
      } else {
        assert.ok(existsSync(join(f.sessions, "protected.jsonl")));
        assert.equal(f.commands().some(isStorageMutation), false);
      }
    });
  }
  test("an alias activation already in flight prevents deletion before binding", { skip: wslRuntimeSkip }, async (t) => {
    const f = await fixture(t, false, false, false, true);
    const runtimeStateGate = join(f.fixture.root, "release-activation-state");
    const identityGate = join(f.fixture.root, "release-deletion-identity");
    f.patchScenario({ runtimePi: true, runtimeReplyGates: { get_state: runtimeStateGate }, identityGate });
    const previous = f.commands().length;
    const activation = f.invoke("sessions:runtime-activate", ["alias-child"]);
    await waitForRpc(f, previous, "get_state");
    const deleted = await overlapDeletion(f, "alias-parent", previous, identityGate, async () => {
      writeFileSync(runtimeStateGate, "");
      await activation;
    });
    assert.equal(deleted.payload.ok, false, JSON.stringify(deleted.payload));
    const activated = await activation;
    assert.equal(activated.payload.result.ok, true, JSON.stringify(activated.payload));
    assert.ok(existsSync(join(f.sessions, "parent.jsonl")));
    assert.ok(existsSync(join(f.sessions, "parent", "child.jsonl")));
    assert.equal(f.commands().some(isStorageMutation), false);
  });
  test("a live reported alias path is protected before any catalog binding owns it", { skip: wslRuntimeSkip }, async (t) => {
    const f = await fixture(t, false, false, false, true);
    const catalog = await f.invoke("sessions:catalog-list", ["wsl-safe"]);
    const unrelated = catalog.payload.result.find((row) => row.filePath === `${linuxRoot}/unrelated.jsonl`);
    const projectionGate = join(f.fixture.root, "release-projection");
    f.patchScenario({ runtimePi: true, runtimeReportedPath: `${linuxHome}/sessions-alias/parent/child.jsonl`, runtimeReplyGates: { get_messages: projectionGate } });
    const previous = f.commands().length;
    const activation = f.invoke("sessions:runtime-activate", [unrelated.id]);
    try {
      await waitForRpc(f, previous, "get_messages");
      const deletion = await f.invoke("sessions:catalog-delete", ["alias-parent"]);
      assert.equal(deletion.payload.ok, false, JSON.stringify(deletion.payload));
      assert.ok(existsSync(join(f.sessions, "parent", "child.jsonl")));
    } finally {
      writeFileSync(projectionGate, "");
    }
    assert.equal((await activation).payload.result.ok, true);
  });
  test("an in-flight WSL replacement's unproven future destination prevents deletion", { skip: wslRuntimeSkip }, async (t) => {
    const f = await fixture(t);
    const catalog = await f.invoke("sessions:catalog-list", ["wsl-safe"]);
    const unrelated = catalog.payload.result.find((row) => row.filePath === `${linuxRoot}/unrelated.jsonl`);
    const cloneGate = join(f.fixture.root, "release-clone");
    const identityGate = join(f.fixture.root, "release-identity");
    f.patchScenario({ runtimePi: true, runtimeReplyGates: { clone: cloneGate }, identityGate });
    const activation = await f.invoke("sessions:runtime-activate", [unrelated.id]);
    assert.equal(activation.payload.result.ok, true);
    const target = activation.payload.result.value;
    const previous = f.commands().length;
    const replacement = f.invoke("sessions:runtime-clone", [target]);
    await waitForRpc(f, previous, "clone");
    const deletion = await overlapDeletion(f, f.id, previous, identityGate, async () => {
      writeFileSync(cloneGate, "");
      await replacement;
    });
    assert.equal(deletion.payload.ok, false, JSON.stringify(deletion.payload));
    assert.ok(existsSync(join(f.sessions, "protected.jsonl")));
    assert.equal((await replacement).payload.result.value?.cancelled, true);
    const runtimes = await f.invoke("sessions:runtime-list", []);
    const restored = runtimes.payload.result.find((runtime) => runtime.sessionId === target.sessionId);
    assert.equal(restored?.agentId, target.agentId, "cancelled clone must keep the original process bound");
    assert.ok(restored.runtimeGeneration > target.runtimeGeneration);
    assert.equal((await f.invoke("sessions:runtime-state", [restored])).payload.result.ok, true);
  });
  test("a fileless WSL activation can finish while an unrelated deletion resolves identities", { skip: wslRuntimeSkip }, async (t) => {
    const f = await fixture(t);
    const created = await f.invoke("sessions:create-anonymous", [{ projectId: "wsl-safe", title: "In memory" }]);
    assert.equal(created.payload.ok, true, JSON.stringify(created.payload));
    const stateGate = join(f.fixture.root, "release-state");
    const identityGate = join(f.fixture.root, "release-identity");
    f.patchScenario({ runtimePi: true, runtimeReplyGates: { get_state: stateGate }, identityGate });
    const previous = f.commands().length;
    const activation = f.invoke("sessions:runtime-activate", [created.payload.result.session.id]);
    await waitForRpc(f, previous, "get_state");
    const deletion = await overlapDeletion(f, f.id, previous, identityGate, async () => {
      writeFileSync(stateGate, "");
      await activation;
    });
    assert.equal(deletion.payload.result, true, JSON.stringify(deletion.payload));
    const activated = await activation;
    assert.equal(activated.payload.result.ok, true, JSON.stringify(activated.payload));
    assert.equal((await f.invoke("sessions:runtime-state", [activated.payload.result.value])).payload.result.ok, true);
  });
  test("a native draft preparing its WSL launch reserves the selected distribution", { skip: wslRuntimeSkip }, async (t) => {
    const f = await fixture(t, false, false, false, true, false, false, "native-draft");
    const versionGate = join(f.fixture.root, "release-version");
    const identityGate = join(f.fixture.root, "release-identity");
    f.patchScenario({ runtimePi: true, versionGate, identityGate });
    const previous = f.commands().length;
    const activation = f.invoke("sessions:runtime-activate", ["native-draft"]);
    await waitForCommand(f, previous, "--version");
    const deletion = await overlapDeletion(f, "alias-parent", previous, identityGate, async () => {
      writeFileSync(versionGate, "");
      await activation;
    });
    assert.equal(deletion.payload.ok, false, JSON.stringify(deletion.payload));
    const activated = await activation;
    assert.equal(activated.payload.result.ok, true, JSON.stringify(activated.payload));
    assert.ok(existsSync(join(f.sessions, "parent", "child.jsonl")));
  });
  test("an alias reconnect already in flight retains its binding during WSL deletion admission", { skip: wslRuntimeSkip }, async (t) => {
    const f = await fixture(t, false, false, false, true);
    const runtimeExitGate = join(f.fixture.root, "exit-initial-pi");
    const stateGate = join(f.fixture.root, "release-reconnect-state");
    const identityGate = join(f.fixture.root, "release-identity");
    f.patchScenario({ runtimePi: true, runtimeExitGate, reconnectReplyGates: { get_state: stateGate }, identityGate });
    const activated = await f.invoke("sessions:runtime-activate", ["alias-child"]);
    assert.equal(activated.payload.result.ok, true, JSON.stringify(activated.payload));
    const previous = f.commands().length;
    writeFileSync(runtimeExitGate, "");
    await waitForRpc(f, previous, "get_state");
    const deletion = await overlapDeletion(f, "alias-parent", previous, identityGate, async () => {
      writeFileSync(stateGate, "");
      await waitForRpc(f, previous, "get_messages");
    });
    assert.equal(deletion.payload.ok, false, JSON.stringify(deletion.payload));
    assert.ok(existsSync(join(f.sessions, "parent", "child.jsonl")));
    assert.equal((await f.invoke("sessions:runtime-state", [activated.payload.result.value])).payload.result.ok, true);
  });
  for (const stop of [false, true]) test(stop
    ? "Stop cancels a deferred WSL reconnect before the deletion lease is released"
    : "an unrelated WSL runtime waits for a deletion lease before reconnecting", { skip: wslRuntimeSkip }, async (t) => {
    const f = await fixture(t);
    const catalog = await f.invoke("sessions:catalog-list", ["wsl-safe"]);
    const unrelated = catalog.payload.result.find((row) => row.filePath === `${linuxRoot}/unrelated.jsonl`);
    const runtimeExitGate = join(f.fixture.root, "exit-initial-pi");
    const identityGate = join(f.fixture.root, "release-identity");
    f.patchScenario({ runtimePi: true, runtimeExitGate, identityGate });
    const activated = await f.invoke("sessions:runtime-activate", [unrelated.id]);
    assert.equal(activated.payload.result.ok, true, JSON.stringify(activated.payload));
    const target = activated.payload.result.value;
    // RPC rows repeat the pi process argv; only raw subprocess rows count as launches.
    const launchedSession = ({ rpc, argv }) => !rpc && argv.includes("--mode") && argv.includes("--session")
      && argv[argv.indexOf("--session") + 1] === unrelated.filePath;
    assert.equal(f.commands().filter(launchedSession).length, 1, "fixture must observe the original pi launch");
    const previous = f.commands().length;
    const deletion = await overlapDeletion(f, f.id, previous, identityGate, async () => {
      await waitForCommand(f, previous, "pideck-delete-identities");
      writeFileSync(runtimeExitGate, "");
      const logs = join(f.fixture.userData, "logs");
      const sawDeferredReconnect = () => readdirSync(logs).filter((name) => name.endsWith(".log"))
        .some((name) => readFileSync(join(logs, name), "utf8").includes("Waiting for WSL deletion before reconnecting runtime"));
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && !sawDeferredReconnect()) {
        const runtimes = await f.invoke("sessions:runtime-list", []);
        assert.ok(runtimes.payload.result.some((runtime) => runtime.agentId === target.agentId), "reconnect must not detach the existing binding");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(sawDeferredReconnect(), "reconnect must wait for the deletion lease");
      assert.equal(f.commands().slice(previous).some((entry) => entry.rpc === "get_state"), false);
      if (stop) {
        const stale = await f.invoke("sessions:runtime-stop", [{ ...target, runtimeGeneration: target.runtimeGeneration + 1 }]);
        assert.equal(stale.payload.result.ok, false, JSON.stringify(stale.payload));
        const stopped = await f.invoke("sessions:runtime-stop", [target]);
        assert.equal(stopped.payload.result.ok, true, JSON.stringify(stopped.payload));
      }
    });
    assert.equal(deletion.payload.result, true, JSON.stringify(deletion.payload));
    assert.equal(existsSync(join(f.sessions, "protected.jsonl")), false);
    assert.ok(existsSync(join(f.sessions, "unrelated.jsonl")));
    if (stop) {
      const runtimes = await f.invoke("sessions:runtime-list", []);
      assert.equal(runtimes.payload.result.some((runtime) => runtime.sessionId === target.sessionId), false);
      const launches = f.commands().slice(previous).filter(launchedSession);
      assert.deepEqual(launches, [], "releasing deletion must not launch the stopped session");
    } else {
      await waitForRpc(f, previous, "get_messages");
      const commands = await f.invoke("sessions:runtime-commands", [target]);
      assert.equal(commands.payload.result.ok, true, JSON.stringify(commands.payload));
    }
  });
  test("WSL distribution casing does not change deletion's filesystem namespace", async (t) => {
    const f = await fixture(t, false, false, false, true, false, false, "distro-case");
    const deletion = await f.invoke("sessions:catalog-delete", ["alias-parent"]);
    assert.equal(deletion.payload.result, true, JSON.stringify(deletion.payload));
  });
  test("a newline-free alias cannot hide a canonical companion name ending in newline", { skip: wslRuntimeSkip }, async (t) => {
    const f = await fixture(t, false, false, false, true);
    const tree = "/real/dir\n";
    f.patchScenario({ runtimePi: true, identityCanonicalOverrides: {
      [`${linuxRoot}/parent`]: tree,
      [`${linuxHome}/sessions-alias/parent/child.jsonl`]: `${tree}/child.jsonl`,
      [`${linuxHome}/sessions-alias/parent/child`]: `${tree}/child`,
    } });
    const activation = await f.invoke("sessions:runtime-activate", ["alias-child"]);
    assert.equal(activation.payload.result.ok, true);
    const deletion = await f.invoke("sessions:catalog-delete", ["alias-parent"]);
    assert.equal(deletion.payload.ok, false, JSON.stringify(deletion.payload));
    assert.ok(existsSync(join(f.sessions, "parent", "child.jsonl")));
    assert.equal(f.commands().some(isStorageMutation), false);
  });
  test("an unresolved other-user alias cannot be treated as an unrelated missing leaf", { skip: wslRuntimeSkip }, async (t) => {
    const f = await fixture(t, false, false, false, true, false, true);
    f.patchScenario({ runtimePi: true, identityUnresolvedPrefix: `${linuxHome}/sessions-alias/parent` });
    const activation = await f.invoke("sessions:runtime-activate", ["alias-child"]);
    assert.equal(activation.payload.result.ok, true);
    const deletion = await f.invoke("sessions:catalog-delete", ["alias-parent"]);
    assert.equal(deletion.payload.ok, false, JSON.stringify(deletion.payload));
    assert.ok(existsSync(join(f.sessions, "parent", "child.jsonl")));
  });
  test("a genuinely missing WSL session leaf remains idempotently deletable", async (t) => {
    const f = await fixture(t);
    rmSync(join(f.sessions, "protected.jsonl"));
    const deletion = await f.invoke("sessions:catalog-delete", [f.id]);
    assert.equal(deletion.payload.result, true, JSON.stringify(deletion.payload));
    assert.ok(existsSync(join(f.sessions, "unrelated.jsonl")));
  });
  test("identity timeout releases WSL admission and leaves data intact for retry", async (t) => {
    const f = await fixture(t, false, false, false, true);
    f.patchScenario({ identityDelayMs: 13000 });
    const deletion = await f.invoke("sessions:catalog-delete", ["alias-parent"]);
    assert.equal(deletion.payload.ok, false);
    assert.ok(existsSync(join(f.sessions, "parent", "child.jsonl")));
    f.patchScenario({ identityDelayMs: 0 });
    const retry = await f.invoke("sessions:catalog-delete", ["alias-parent"]);
    assert.equal(retry.payload.result, true, JSON.stringify(retry.payload));
  });
  test("shutdown quarantines delayed WSL identity work without deleting data", async (t) => {
    const f = await fixture(t, false, false, false, true);
    f.patchScenario({ identityDelayMs: 1500 });
    const previous = f.commands().length;
    const deletion = f.invoke("sessions:catalog-delete", ["alias-parent"]).catch(() => null);
    await waitForCommand(f, previous, "pideck-delete-identities");
    const started = Date.now();
    f.host.emit("application.prepareQuit");
    const result = await Promise.race([f.backend.exited, new Promise((resolve) => setTimeout(() => resolve(null), 3000))]);
    assert.ok(result, "shutdown must not await all queued identity probes");
    assert.equal(result.code, 0, JSON.stringify(result));
    assert.ok(Date.now() - started < 3000);
    assert.ok(existsSync(join(f.sessions, "parent", "child.jsonl")));
    assert.equal(f.commands().some(isStorageMutation), false);
    await deletion;
  });
  test("authorized WSL deletion moves a session into its private trash bucket", async (t) => {
    const f = await fixture(t);
    const result = await f.invoke("sessions:catalog-delete", [f.id]);
    assert.equal(result.payload.result, true, JSON.stringify(result.payload));
    assert.equal(existsSync(join(f.sessions, "protected.jsonl")), false);
    const buckets = readdirSync(join(f.sessions, ".pideck-trash"));
    assert.equal(buckets.length, 1);
    assert.ok(existsSync(join(f.sessions, ".pideck-trash", buckets[0], "protected.jsonl")));
  });
} else {
  test("WSL deletion safety requires fresh backend and fake WSL launcher", { skip: !process.env.PIDECK_REQUIRE_BACKEND_TESTS }, () => {
    assert.fail("Build PiDeckBackend and PiDeck-FakeWsl first");
  });
}
