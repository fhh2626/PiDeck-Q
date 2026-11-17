import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const compile = (code) => ts.transpileModule(code, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const translate = (key, params) => params ? `${key} ${JSON.stringify(params)}` : key;
function load(path, require = () => ({ t: translate })) {
  const sandbox = { exports: {}, require };
  vm.runInNewContext(compile(readFileSync(path, "utf8")), sandbox);
  return sandbox.exports;
}
const { deleteSessionWithConfirmation } = load("src/renderer/src/hooks/deleteSessionWithConfirmation.ts");
const { createConfirmationQueue } = load("src/renderer/src/utils/confirmationQueue.ts");
const tick = () => new Promise((resolve) => setImmediate(resolve));

function fixture(results) {
  const calls = [], successes = [], errors = [], confirmations = [];
  const input = {
    sessionId: "snapshot-id", sessionTitle: "Captured session title",
    deleteRecord: async (id, options) => {
      calls.push({ id, permanent: options?.permanent });
      const next = results.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    showConfirm: (config) => confirmations.push(config), clearConfirm: () => {},
    onSuccess: () => successes.push(true), onError: (error) => errors.push(error),
  };
  return { input, calls, successes, errors, confirmations };
}

test("ordinary and already absent records finish without another confirmation", async () => {
  for (const result of [true, false]) {
    const f = fixture([result]);
    assert.equal(await deleteSessionWithConfirmation(f.input), "deleted");
    assert.equal(f.confirmations.length, 0);
    assert.equal(f.successes.length, 1);
  }
});
test("successful deletion remains successful when post-delete refresh fails", async () => {
  const f = fixture([true]);
  f.input.onSuccess = async () => { throw new Error("refresh failed"); };
  assert.equal(await deleteSessionWithConfirmation(f.input), "deleted");
  assert.equal(f.errors.length, 1);
});
test("trash refusal remains pending and cancellation performs no retry or cleanup", async () => {
  const f = fixture([{ status: "trash-failed" }]);
  let settled = false;
  const task = deleteSessionWithConfirmation(f.input).then((value) => { settled = true; return value; });
  await tick();
  assert.equal(settled, false);
  assert.match(f.confirmations[0].message, /Captured session title/);
  assert.equal(f.confirmations[0].danger, true);
  f.confirmations[0].onCancel();
  assert.equal(await task, "cancelled");
  assert.equal(f.calls.length, 1); assert.equal(f.successes.length, 0);
});
test("confirmation is once-only and concurrent requests share the same operation", async () => {
  const f = fixture([{ status: "trash-failed" }, true]);
  const first = deleteSessionWithConfirmation(f.input);
  const second = deleteSessionWithConfirmation(f.input);
  assert.equal(first, second);
  await tick();
  f.confirmations[0].onConfirm(); f.confirmations[0].onConfirm();
  assert.equal(await first, "deleted");
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1].permanent, true);
  assert.equal(f.calls[1].id, "snapshot-id"); assert.equal(f.successes.length, 1);
});
test("permanent and unrelated failures never clean up or report success", async () => {
  const f = fixture([{ status: "trash-failed" }, new Error("failed")]);
  const task = deleteSessionWithConfirmation(f.input); await tick();
  f.confirmations[0].onConfirm();
  assert.equal(await task, "failed"); assert.equal(f.errors.length, 1); assert.equal(f.successes.length, 0);
  const other = fixture([new Error("busy")]);
  assert.equal(await deleteSessionWithConfirmation(other.input), "failed");
  assert.equal(other.confirmations.length, 0);
});

test("late confirmations queue behind existing operations and stale callbacks cannot clear successors", async () => {
  let visible;
  const queue = createConfirmationQueue((dialog) => { visible = dialog; });
  queue.showConfirm({ title: "Other operation", message: "Other", onConfirm: () => queue.clearConfirm() });
  const previous = visible;
  const f = fixture([{ status: "trash-failed" }, true]);
  const task = deleteSessionWithConfirmation({ ...f.input, showConfirm: queue.showConfirm, clearConfirm: queue.clearConfirm });
  await tick(); assert.equal(visible.title, "Other operation");
  previous.onConfirm();
  assert.match(visible.message, /Captured session title/);
  previous.onCancel(); previous.onConfirm();
  assert.match(visible.message, /Captured session title/);
  visible.onConfirm();
  assert.equal(await task, "deleted");
});
test("unmount cancellation settles current and queued deletion promises without retries", async () => {
  const queue = createConfirmationQueue(() => {});
  const a = fixture([{ status: "trash-failed" }]), b = fixture([{ status: "trash-failed" }]);
  const run = (f) => deleteSessionWithConfirmation({ ...f.input, showConfirm: queue.showConfirm, clearConfirm: queue.clearConfirm });
  const tasks = [run(a), run(b)]; await tick(); queue.dispose();
  assert.deepEqual(await Promise.all(tasks), ["cancelled", "cancelled"]);
  assert.equal(a.calls.length + b.calls.length, 2);
  const after = fixture([{ status: "trash-failed" }]);
  assert.equal(await run(after), "cancelled", "late failures after unmount also settle without a dialog");
});

/** Execute the real panel action body with observable notices/loading, without DOM dependencies. */
function historyPanelAction(notices, loading) {
  const path = "src/renderer/src/components/session/WorkspaceSurface.tsx";
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let action;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "runSessionAction") action = node;
    ts.forEachChild(node, visit);
  }
  visit(source); assert.ok(action);
  const sandbox = { showNotice: (text) => notices.push(text), setSessionActionLoading: (state) => loading.push(state), t: translate };
  vm.createContext(sandbox); vm.runInContext(compile(action.getText(source)), sandbox);
  return sandbox.runSessionAction;
}
test("history reports committed deletion and a distinct refresh warning", async () => {
  const f = fixture([true]);
  const { useSessionActions } = load("src/renderer/src/hooks/useSessionActions.ts", (path) =>
    path.endsWith("/deleteSessionWithConfirmation") ? { deleteSessionWithConfirmation } : { t: translate });
  const removed = [], warnings = [], notices = [];
  const history = useSessionActions({ api: { sessions: { deleteRecord: f.input.deleteRecord } },
    sessionsProjectId: "project", showConfirm: f.input.showConfirm, clearConfirm: f.input.clearConfirm,
    removeSessionState: (id) => removed.push(id), removeSessionComposerState: () => {},
    showToast: (message) => warnings.push(message), refreshProjectSessions: async () => { throw new Error("offline"); } });
  const run = historyPanelAction(notices, []);
  await run({ filePath: "fixture.jsonl" }, "delete", () => history.deleteHistorySession({ id: "history-id" }), "deleted-notice");
  assert.deepEqual(removed, ["history-id"]);
  assert.ok(notices.includes("deleted-notice"));
  assert.match(warnings[0], /sessionDeletedRefreshFailed/);
});
for (const outcome of ["confirm", "cancel", "error"]) {
  test(`history panel retains loading until ${outcome} and only reports real deletion`, async () => {
    const f = fixture([{ status: "trash-failed" }, outcome === "error" ? new Error("blocked") : true]);
    const { useSessionActions } = load("src/renderer/src/hooks/useSessionActions.ts", (path) =>
      path.endsWith("/deleteSessionWithConfirmation") ? { deleteSessionWithConfirmation } : { t: translate });
    const removed = [];
    const history = useSessionActions({ api: { sessions: { deleteRecord: f.input.deleteRecord } },
      sessionsProjectId: "project", showConfirm: f.input.showConfirm, clearConfirm: f.input.clearConfirm,
      removeSessionState: (id) => removed.push(id), removeSessionComposerState: () => {},
      showToast: () => {}, refreshProjectSessions: async () => {} });
    const notices = [], loading = [];
    const run = historyPanelAction(notices, loading);
    const task = run({ filePath: "fixture.jsonl" }, "delete", () => history.deleteHistorySession({ id: "history-id", name: "History name" }), "deleted-notice");
    await tick();
    assert.equal(notices.includes("deleted-notice"), false);
    assert.notEqual(loading.at(-1), null);
    if (outcome === "cancel") f.confirmations[0].onCancel(); else f.confirmations[0].onConfirm();
    await task;
    assert.equal(notices.includes("deleted-notice"), outcome === "confirm");
    assert.equal(loading.at(-1), null);
    assert.equal(removed.length, outcome === "confirm" ? 1 : 0);
  });
}
