import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function loadGate() {
  const output = ts.transpileModule(
    readFileSync("src/renderer/src/utils/projectInventoryRequests.ts", "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    Promise,
  }, { filename: "projectInventoryRequests.ts" });
  return module.exports;
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test("newer project snapshots invalidate older list responses", async () => {
  const { requestProjectInventory } = loadGate();
  const older = deferred();
  const newer = deferred();
  const oldRequest = requestProjectInventory(() => older.promise);
  const newRequest = requestProjectInventory(() => newer.promise);

  newer.resolve([{ id: "chat", path: "C:/new-chat" }]);
  assert.deepEqual(await newRequest, [{ id: "chat", path: "C:/new-chat" }]);

  older.resolve([{ id: "chat", path: "C:/old-chat" }]);
  assert.equal(await oldRequest, undefined);
});

test("an authoritative push invalidates an in-flight project list", async () => {
  const { invalidateProjectInventoryRequests, requestProjectInventory } = loadGate();
  const pending = deferred();
  const request = requestProjectInventory(() => pending.promise);

  invalidateProjectInventoryRequests();
  pending.resolve([{ id: "chat", path: "C:/old-chat" }]);

  assert.equal(await request, undefined);
});
