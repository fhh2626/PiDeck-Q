import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function load(path, require = () => ({}), extra = {}) {
  const sandbox = { exports: {}, require, ...extra };
  const code = ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  vm.runInNewContext(code, sandbox);
  return sandbox.exports;
}
const parser = load("src/shared/sessionDeleteResponse.ts");
const helper = load("src/renderer/src/hooks/deleteSessionWithConfirmation.ts", () => ({ t: (key, params) => params ? `${key} ${params.name}` : key }));
const { createConfirmationQueue } = load("src/renderer/src/utils/confirmationQueue.ts");
const tick = () => new Promise((resolve) => setImmediate(resolve));

for (const choice of ["confirm", "cancel", "unmount"]) {
  test(`standalone Web ${choice} preserves explicit HTTP authorization and cleanup timing`, async () => {
    const requests = [], deleted = [], errors = [];
    let visible;
    const queue = createConfirmationQueue((config) => { visible = config; });
    const api = load("src/renderer/src/web/webApi.ts", (name) => name.endsWith("/sessionDeleteResponse") ? parser : {}, {
      fetch: async (url, init) => {
        requests.push({ url, init });
        return { ok: true, json: async () => ({ deleted: requests.length === 1 ? { status: "trash-failed" } : true }) };
      },
    });
    const { useWebSessionDeletion } = load("src/renderer/src/web/useWebSessionDeletion.tsx", (name) => {
      if (name === "./webApi") return api;
      if (name.endsWith("/deleteSessionWithConfirmation")) return helper;
      if (name.endsWith("/useConfirmationQueue")) return { useConfirmationQueue: () => ({ confirmDialog: visible, ...queue }) };
      return { jsx: () => null, ConfirmDialog: () => null };
    });
    const controller = useWebSessionDeletion({ sessions: [{ id: "web/id", title: "Web snapshot" }],
      onDeleted: (id) => deleted.push(id), onError: (error) => errors.push(error) });
    const task = controller.handleDeleteSession("web/id");
    await tick();
    assert.match(visible.message, /Web snapshot/);
    assert.equal(deleted.length, 0);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].init.body, "{}");
    if (choice === "confirm") visible.onConfirm();
    else if (choice === "cancel") visible.onCancel();
    else queue.dispose();
    await task;
    assert.deepEqual(deleted, choice === "confirm" ? ["web/id"] : []);
    assert.equal(requests.length, choice === "confirm" ? 2 : 1);
    if (choice === "confirm") {
      assert.equal(requests[1].url, "/api/sessions/web%2Fid/delete");
      assert.equal(requests[1].init.body, '{"permanent":true}');
    }
    assert.deepEqual(errors, [null]);
  });
}

test("web deletion handler reports a failed state refresh without retrying deletion", async () => {
  const source = readFileSync("src/renderer/src/web/WebChatApp.tsx", "utf8");
  const refresh = source.match(/const refreshNow = async \([^)]*\) => \{[\s\S]*?\n\t\};/)[0];
  const callback = source.match(/onDeleted: async \(sessionId\) => \{[\s\S]*?\n\t\t\},/)[0].replace(/^onDeleted: /, "const onDeleted = ").replace(/,$/, ";");
  const errors = [], requests = [], dialogs = [];
  const sandbox = { Error, fetchState: async () => { throw new Error("offline"); }, setState: () => {}, syncRuntimeMessages: () => {},
    markWebStateSuccess: () => ({}), markWebStateFailure: () => ({}), connectionRef: { current: {} }, setConnected: () => {},
    activeSessionIdRef: { current: "id" }, messagesBySessionRef: { current: {} }, historyMetaRef: { current: {} },
    loadedSessionsRef: { current: new Set() }, deferredHistoryApplyRef: { current: new Set() }, setActiveSessionId: () => {}, setMessages: () => {} };
  const onDeleted = vm.runInNewContext(`${refresh}\n${callback}\nonDeleted`, sandbox);
  const { useWebSessionDeletion } = load("src/renderer/src/web/useWebSessionDeletion.tsx", (name) => {
    if (name === "./webApi") return { deleteSession: async (...args) => { requests.push(args); return true; } };
    if (name.endsWith("/deleteSessionWithConfirmation")) return helper;
    if (name.endsWith("/useConfirmationQueue")) return { useConfirmationQueue: () => ({ showConfirm: (value) => dialogs.push(value), clearConfirm: () => {} }) };
    return { jsx: () => null, ConfirmDialog: () => null };
  });
  await useWebSessionDeletion({ sessions: [{ id: "id", title: "test" }], onDeleted, onError: (value) => errors.push(value) }).handleDeleteSession("id");
  assert.equal(requests.length, 1);
  assert.equal(dialogs.length, 0);
  assert.match(errors.at(-1), /sessionDeletedRefreshFailed/);
});

test("standalone Web rejects malformed deletion responses", async () => {
  const api = load("src/renderer/src/web/webApi.ts", (name) => name.endsWith("/sessionDeleteResponse") ? parser : {}, {
    fetch: async () => ({ ok: true, json: async () => ({ deleted: { status: "trash-failed", extra: true } }) }),
  });
  await assert.rejects(api.deleteSession("id"), /Invalid session deletion response/);
});
