import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { loadSessionScanner } from "./helpers/loadSessionScanner.mjs";
import { createFakeWslExecFile } from "./helpers/fakeWslExecFile.mjs";

const OUTER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ASYNC = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const RESUMED = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const WORKFLOW = "call_example%7Cfc_example";
const WORKFLOW_OUTPUT = "call_example_7Cfc_example";

function result(details, toolName = "subagent") {
  return { type: "message", message: { role: "toolResult", toolName, toolCallId: "call_example|fc_example", content: [], details } };
}
function session(...entries) {
  return [{ type: "session", id: "parent", version: 3, cwd: "/project" }, ...entries].map(JSON.stringify).join("\n") + "\n";
}
function put(path, text = "{}\n") {
  fs.mkdirSync(dirname(path), { recursive: true });
  fs.writeFileSync(path, text);
}

/** Both backends execute production delete; only disposable filesystem boundaries are substituted. */
async function fixture(kind, fault = {}) {
  const home = fs.mkdtempSync(join(tmpdir(), "pideck-delete-regression-"));
  const fake = createFakeWslExecFile(join(home, "wslfs"));
  const root = kind === "wsl" ? "/home/u/.pi/agent/sessions" : join(home, ".pi", "agent", "sessions");
  const host = (path) => kind === "wsl" ? fake.host(path) : path;
  const trashCalls = [];
  let enabled = true;
  const fail = (path) => enabled && (fault.path === path || Boolean(fault.suffix && path?.endsWith(fault.suffix)));
  const execFile = (command, args, options, callback) => {
    const argv = args.slice(4);
    if ((argv[0] === "test" && fail(argv[2])) || (argv[0] === "mv" && fail(argv[3]))) {
      queueMicrotask(() => callback(Object.assign(new Error("WSL launch failed"), { code: fault.code ?? "EAGAIN", killed: fault.killed ?? false }), "", fault.stderr ?? ""));
      return { stdin: null };
    }
    return fake.execFile(command, args, options, callback);
  };
  const { SessionScanner } = loadSessionScanner(home, {
    childProcess: { execFile },
    stubs: { "node:fs/promises": { ...fsp, readdir: async (path, options) => {
      if (kind === "local" && fail(path)) throw Object.assign(new Error("denied"), { code: fault.code ?? "EACCES" });
      return fsp.readdir(path, options);
    } } },
  });
  const scanner = new SessionScanner(undefined, home, async (path) => {
    if (fail(path)) throw new Error("Trash temporarily unavailable");
    const destination = join(home, "trash", String(trashCalls.length));
    fs.mkdirSync(dirname(destination), { recursive: true });
    fs.renameSync(path, destination);
    trashCalls.push(path);
  });
  if (kind === "wsl") await scanner.configureWsl({ distro: "Ubuntu", user: "u", linuxHome: "/home/u", windowsHome: home });
  return { home, root, host, scanner, fake, trashCalls, put: (path, text) => put(host(path), text), disableFault: () => { enabled = false; }, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}

for (const kind of ["local", "wsl"]) {
  test(`${kind}: workflow call-ID output, async ID and revived ID artifacts are deleted`, async () => {
    const f = await fixture(kind);
    try {
      const parent = `${f.root}/parent.jsonl`;
      f.put(parent, session(
        result({ mode: "workflow", runId: WORKFLOW, results: [{ runId: OUTER }] }),
        result({ mode: "single", runId: ASYNC, asyncId: ASYNC, results: [] }),
        result({ mode: "single", runId: RESUMED, results: [{ runId: RESUMED }] }),
        // Neither ordinary tool output nor user-controlled workflow.value is ownership evidence.
        result({ mode: "single", runId: OTHER, results: [] }, "read"),
        result({ mode: "workflow", runId: WORKFLOW, results: [], workflow: { value: { runId: OTHER } } }),
      ));
      f.put(`${f.root}/parent/${OUTER}/run-0/session.jsonl`);
      const owned = [
        `outputs/${WORKFLOW_OUTPUT}/child.md`,
        `${ASYNC}_worker_transcript.jsonl`,
        `${RESUMED}_worker_meta.json`,
        `outputs/${RESUMED}/output.md`,
        `structured-output/${RESUMED}/pi-subagent-structured-123/schema.json`,
      ];
      for (const path of [...owned, `${OTHER}_worker_transcript.jsonl`, `outputs/${OTHER}/output.md`]) f.put(`${f.root}/subagent-artifacts/${path}`);
      await f.scanner.delete(parent);
      assert.equal(fs.existsSync(f.host(parent)), false);
      for (const path of owned) assert.equal(fs.existsSync(f.host(`${f.root}/subagent-artifacts/${path}`)), false, path);
      assert.equal(fs.existsSync(f.host(`${f.root}/subagent-artifacts/${OTHER}_worker_transcript.jsonl`)), true);
      assert.equal(fs.existsSync(f.host(`${f.root}/subagent-artifacts/outputs/${OTHER}/output.md`)), true);
      assert.equal(f.fake.calls.some((args) => args[0] === "rm"), false);
    } finally { f.cleanup(); }
  });

  test(`${kind}: missing parent still cleans matching backups without touching other sessions`, async () => {
    const f = await fixture(kind);
    try {
      const parent = `${f.root}/parent.jsonl`;
      const backup = `${parent}.0000000000001-${OUTER}.edit-backup`;
      f.put(backup);
      f.put(`${f.root}/other.jsonl`, session());
      await f.scanner.delete(parent);
      assert.equal(fs.existsSync(f.host(backup)), false);
      assert.equal(fs.existsSync(f.host(`${f.root}/other.jsonl`)), true);
    } finally { f.cleanup(); }
  });

  test(`${kind}: partial artifact trash failure keeps session ownership for retry`, async () => {
    const f = await fixture(kind, { suffix: `${OUTER}_worker_meta.json` });
    try {
      const parent = `${f.root}/parent.jsonl`;
      f.put(parent, session());
      f.put(`${f.root}/parent/${OUTER}/run-0/session.jsonl`);
      f.put(`${f.root}/subagent-artifacts/${OUTER}_worker_input.md`);
      const remaining = `${f.root}/subagent-artifacts/${OUTER}_worker_meta.json`;
      f.put(remaining);
      await assert.rejects(() => f.scanner.delete(parent), /temporarily unavailable|WSL launch failed/);
      assert.equal(fs.existsSync(f.host(parent)), true);
      assert.equal(fs.existsSync(f.host(`${f.root}/parent`)), true);
      assert.equal(fs.existsSync(f.host(remaining)), true);
      f.disableFault();
      await f.scanner.delete(parent);
      assert.equal(fs.existsSync(f.host(remaining)), false);
      assert.equal(fs.existsSync(f.host(parent)), false);
    } finally { f.cleanup(); }
  });

  test(`${kind}: copied session records do not authorize deleting another live session's shared artifacts`, async () => {
    const f = await fixture(kind);
    try {
      const record = result({ mode: "workflow", runId: WORKFLOW, results: [{ runId: OUTER }] });
      f.put(`${f.root}/parent.jsonl`, session(record));
      f.put(`${f.root}/copy.jsonl`, session(record));
      f.put(`${f.root}/parent/${OUTER}/run-0/session.jsonl`);
      const transcript = `${f.root}/subagent-artifacts/${OUTER}_worker_transcript.jsonl`;
      const output = `${f.root}/subagent-artifacts/outputs/${WORKFLOW_OUTPUT}/child.md`;
      f.put(transcript);
      f.put(output);
      await f.scanner.delete(`${f.root}/copy.jsonl`);
      assert.equal(fs.existsSync(f.host(transcript)), true);
      assert.equal(fs.existsSync(f.host(output)), true);
      await f.scanner.delete(`${f.root}/parent.jsonl`);
      assert.equal(fs.existsSync(f.host(transcript)), false);
      assert.equal(fs.existsSync(f.host(output)), false);
    } finally { f.cleanup(); }
  });
}

test("local: artifact enumeration EACCES rejects before deleting ownership and succeeds on retry", async () => {
  const f = await fixture("local");
  try {
    const parent = join(f.root, "parent.jsonl");
    const artifacts = join(f.root, "subagent-artifacts");
    f.put(parent, session());
    f.put(join(f.root, "parent", OUTER, "run-0", "session.jsonl"));
    const target = join(artifacts, `${OUTER}_worker_transcript.jsonl`);
    f.put(target);
    let fail = true;
    const { SessionScanner } = loadSessionScanner(f.home, { stubs: { "node:fs/promises": { ...fsp, readdir: async (path, options) => {
      if (fail && path === artifacts) throw Object.assign(new Error("denied"), { code: "EACCES" });
      return fsp.readdir(path, options);
    } } } });
    const scanner = new SessionScanner(undefined, f.home, async (path) => fs.rmSync(path, { recursive: true }));
    await assert.rejects(() => scanner.delete(parent), /denied/);
    assert.equal(fs.existsSync(parent), true);
    assert.equal(fs.existsSync(join(f.root, "parent")), true);
    assert.equal(fs.existsSync(target), true);
    fail = false;
    await scanner.delete(parent);
    assert.equal(fs.existsSync(target), false);
  } finally { f.cleanup(); }
});

for (const fault of [{ code: "EAGAIN" }, { code: 1, stderr: "WSL distribution unavailable" }, { code: 1, killed: true }]) {
  test(`WSL: failed directory probe ${JSON.stringify(fault)} rejects and is retryable`, async () => {
    const root = "/home/u/.pi/agent/sessions";
    const f = await fixture("wsl", { path: `${root}/parent/${OUTER}`, ...fault });
    try {
      f.put(`${root}/parent.jsonl`, session());
      f.put(`${root}/parent/${OUTER}/run-0/session.jsonl`);
      const target = `${root}/subagent-artifacts/${OUTER}_worker_transcript.jsonl`;
      f.put(target);
      await assert.rejects(() => f.scanner.delete(`${root}/parent.jsonl`), /WSL launch failed/);
      assert.equal(fs.existsSync(f.host(`${root}/parent.jsonl`)), true);
      assert.equal(fs.existsSync(f.host(`${root}/parent`)), true);
      f.disableFault();
      await f.scanner.delete(`${root}/parent.jsonl`);
      assert.equal(fs.existsSync(f.host(target)), false);
    } finally { f.cleanup(); }
  });
}
