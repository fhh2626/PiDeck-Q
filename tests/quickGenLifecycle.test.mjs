import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// A subprocess is essential: an unhandled ChildProcess error must be asserted as
// process survival, not converted into a test-runner global error.
const script = `
import { loadTsCommonJs } from './tests/helpers/loadTsCommonJs.mjs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
const children = [];
let attempts = 0;
const spawn = () => {
  const child = new EventEmitter();
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, kill() { this.exitCode = 0; queueMicrotask(() => this.emit('exit', 0)); } });
  children.push(child);
  attempts++;
  if (attempts === 1) queueMicrotask(() => child.emit('error', new Error('spawn ENOENT')));
  else child.stdin.on('data', chunk => {
    const request = JSON.parse(chunk.toString());
    queueMicrotask(() => {
      child.stdout.write(JSON.stringify({ id: request.id, type: 'response', command: request.type, success: true }) + '\\n');
      if (request.type === 'prompt') {
        child.stdout.write(JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'retry succeeded' } }) + '\\n');
        child.stdout.write(JSON.stringify({ type: 'agent_end' }) + '\\n');
      }
    });
  });
  return child;
};
const { registerGitIpc } = loadTsCommonJs('src/main/ipc/gitIpc.ts', { stubs: { 'node:child_process': { spawn } } });
const { ipcChannels } = loadTsCommonJs('src/shared/ipc.ts');
const handlers = new Map();
const dispose = registerGitIpc({ handle: (k, fn) => handlers.set(k, fn) }, {
  appLogger: { warn() {}, info() {}, error() {} }, mainCopy: x => x, getLocale: () => 'en-US',
  gitService: { getStagedDiff: async () => 'diff' }, projectStore: { get: () => ({ path: process.cwd() }), list: () => [] },
  settingsStore: { get: () => ({ gitCommitMessageProvider: 'provider', gitCommitMessageModel: 'model', gitCommitMessagePrompt: '{diff}' }) },
  piLocator: { resolveCommand: () => 'pi', createInvocation: () => ({ command: 'pi', args: [], shell: false }), createProcessEnv: () => ({}) },
  worktreeService: {}, getAuthorizedRoots: () => [],
});
const first = await handlers.get(ipcChannels.gitGenerateCommitMessage)('p');
const second = await handlers.get(ipcChannels.gitGenerateCommitMessage)('p');
dispose();
console.log(JSON.stringify({ first, second, allStopped: children.every(x => x.exitCode !== null) }));
`;

test("QuickGen spawn error is structured, retry succeeds, and disposal stops the child", () => {
  const child = spawnSync(process.execPath, ["--input-type=module", "-"], { input: script, cwd: process.cwd(), encoding: "utf8", timeout: 15000 });
  assert.equal(child.status, 0, child.stderr || String(child.error));
  const result = JSON.parse(child.stdout.trim());
  assert.equal(result.first.ok, false);
  assert.equal(result.first.code, "GIT_COMMIT_GENERATE_FAILED");
  assert.match(result.first.message, /ENOENT/);
  assert.deepEqual(result.second, { ok: true, message: "retry succeeded" });
  assert.equal(result.allStopped, true);
});

/** Real JSONL RPC streams with controlled child events; no actual Pi/model/network. */
function generatorHarness(onCommand = () => true, globals = {}) {
  const children = [];
  const spawn = () => {
    const child = new EventEmitter();
    Object.assign(child, {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null,
      kill() { this.exitCode = 0; queueMicrotask(() => { this.emit("exit", 0, null); this.emit("close", 0, null); }); },
    });
    child.stdin.on("data", chunk => {
      const command = JSON.parse(chunk.toString());
      queueMicrotask(() => {
        if (onCommand(command, child) === false) return;
        child.stdout.write(JSON.stringify({ id: command.id, type: "response", command: command.type, success: true }) + "\n");
      });
    });
    children.push(child);
    return child;
  };
  const { createQuickGenerator } = loadTsCommonJs("src/main/git/QuickGenerator.ts", { stubs: { "node:child_process": { spawn } }, globals });
  const generator = createQuickGenerator({
    piLocator: { resolveCommand: () => "pi", createInvocation: () => ({ command: "pi", args: [], shell: false }), createProcessEnv: () => ({}) },
    settingsStore: { get: () => ({}) }, appLogger: { warn() {} },
  });
  return { generator, children, generate: (modelId = "model") => generator.generate("project", "diff", { provider: "provider", modelId }) };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test("QuickGen exit during model selection rejects without waiting for RPC timeout", async t => {
  const h = generatorHarness(() => false); t.after(() => h.generator.dispose());
  const failed = assert.rejects(h.generate(), /QuickGen exited/);
  await tick();
  h.children[0].exitCode = 2; h.children[0].emit("exit", 2, null);
  await failed;
});

test("QuickGen exit after prompt acknowledgement rejects the active generation", async t => {
  const h = generatorHarness(); t.after(() => h.generator.dispose());
  const failed = assert.rejects(h.generate(), /QuickGen exited/);
  await tick();
  h.children[0].exitCode = 2; h.children[0].emit("exit", 2, null);
  await failed;
});

test("QuickGen disposal cancels acknowledged work and prevents new spawns", async () => {
  const h = generatorHarness();
  const failed = assert.rejects(h.generate(), /disposed/);
  await tick(); h.generator.dispose(); await failed;
  await assert.rejects(h.generate(), /disposed/);
  assert.equal(h.children[0].exitCode, 0);
});

test("QuickGen rejects concurrent generation without interrupting the active request", async t => {
  const h = generatorHarness(); t.after(() => h.generator.dispose());
  const pending = h.generate(); await tick();
  await assert.rejects(h.generate(), /already processing/);
  h.children[0].stdout.write(JSON.stringify({ type: "agent_end" }) + "\n");
  assert.equal(await pending, "");
});

test("QuickGen timeout stops the child and permits a clean retry", async t => {
  const timers = new Set();
  let complete = false;
  const h = generatorHarness((command, child) => {
    if (complete && command.type === "prompt") queueMicrotask(() => child.stdout.write(JSON.stringify({ type: "agent_end" }) + "\n"));
  }, {
    setTimeout: (callback, delay) => { const timer = { callback, delay, unref() {} }; timers.add(timer); return timer; },
    clearTimeout: timer => timers.delete(timer),
  });
  t.after(() => h.generator.dispose());
  const failed = assert.rejects(h.generate(), /timed out/);
  await tick();
  const timeout = Array.from(timers).find(timer => timer.delay === 60000);
  assert.ok(timeout); timeout.callback(); await failed;
  assert.equal(h.children[0].exitCode, 0);
  complete = true;
  assert.equal(await h.generate(), "");
});

test("QuickGen lost prompt acknowledgement stops uncertain work before retry", async t => {
  const timers = new Set();
  let complete = false;
  const h = generatorHarness((command, child) => {
    if (command.type !== "prompt") return;
    if (!complete) return false;
    queueMicrotask(() => child.stdout.write(JSON.stringify({ type: "agent_end" }) + "\n"));
  }, {
    setTimeout: (callback, delay) => { const timer = { callback, delay, unref() {} }; timers.add(timer); return timer; },
    clearTimeout: timer => timers.delete(timer),
  });
  t.after(() => h.generator.dispose());
  const failed = assert.rejects(h.generate(), /timed out/);
  await tick();
  const timeout = Array.from(timers).find(timer => timer.delay === 30000);
  assert.ok(timeout); timeout.callback(); await failed;
  assert.equal(h.children[0].exitCode, 0);
  complete = true;
  assert.equal(await h.generate(), "");
});

test("late exit of a replaced model's process does not stop the current generator", async t => {
  const h = generatorHarness((command, child) => {
    if (command.type === "prompt") queueMicrotask(() => child.stdout.write(JSON.stringify({ type: "agent_end" }) + "\n"));
  });
  t.after(() => h.generator.dispose());
  await h.generate("first");
  const oldChild = h.children[0];
  await h.generate("second");
  oldChild.emit("exit", 0, null);
  assert.equal(await h.generate("second"), "");
  assert.equal(h.children.at(-1).exitCode, null);
});
