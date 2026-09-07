import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const projectSyncSource = readFileSync(
  "src/renderer/src/hooks/useProjectSync.ts",
  "utf8",
);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitForCalls(runtime, count) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (runtime.catalogCalls.length >= count) return;
    await settle();
  }
  assert.equal(runtime.catalogCalls.length, count);
}

/** Execute the hook with minimal React primitives so its public async refresh path is tested. */
function createRuntime() {
  const output = ts.transpileModule(projectSyncSource, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const module = { exports: {} };
  const catalogCalls = [];
  const catalogStates = [];
  const loadingWrites = [];
  const sessionReplacements = [];
  let catalogListener;
  let stateIndex = 0;
  const context = {
    module,
    exports: module.exports,
    require(request) {
      if (request === "react") {
        return {
          useRef: (initial) => ({ current: initial }),
          useState: (initial) => {
            const index = stateIndex;
            stateIndex += 1;
            let value = typeof initial === "function" ? initial() : initial;
            return [
              value,
              (next) => {
                value = typeof next === "function" ? next(value) : next;
                // useProjectSync's fifth state slot is sessionLoadingByProject.
                if (index === 4) loadingWrites.push(value);
              },
            ];
          },
          useEffect: (effect) => {
            effect();
          },
        };
      }
      if (request === "../atoms/session-selectors") {
        return { sessionRecordToSummary: (session) => session };
      }
      if (request === "../utils/projectInventoryRequests") {
        return { requestProjectInventory: (list) => list() };
      }
      throw new Error(`Unexpected runtime import: ${request}`);
    },
    setTimeout,
    clearTimeout,
    Promise,
  };
  vm.runInNewContext(output, context, { filename: "useProjectSync.ts" });

  const input = {
    projects: [],
    activeProjectId: "project-1",
    setProjects: () => undefined,
    setActiveProjectId: () => undefined,
    replaceProjectSessions: (replacement) => sessionReplacements.push(replacement),
    api: {
      projects: { list: async () => [] },
      git: {
        worktreeList: async () => [],
        branches: async () => ({ current: null, branches: [] }),
      },
      sessions: {
        listCatalog: (_projectId, options) => {
          const request = deferred();
          catalogCalls.push({ options, request });
          return request.promise;
        },
        onCatalogRefreshed: (listener) => {
          catalogListener = listener;
          return () => {
            if (catalogListener === listener) catalogListener = undefined;
          };
        },
      },
      files: { list: async () => [] },
    },
    showToast: () => undefined,
    setSessionCatalogLoadState: (state) => catalogStates.push(state),
    t: (key) => key,
  };

  const sync = context.module.exports.useProjectSync(input);
  assert.equal(typeof catalogListener, "function");
  return {
    sync,
    catalogCalls,
    catalogStates,
    loadingWrites,
    sessionReplacements,
    emitCatalogRefreshed: () => catalogListener({ projectId: "project-1" }),
  };
}

const recordA = { id: "session-a", projectId: "project-1", updatedAt: 1 };
const recordB = { id: "session-b", projectId: "project-1", updatedAt: 2 };

test("catalog refresh success cannot be overwritten by a stale foreground failure", async () => {
  const runtime = createRuntime();
  const foreground = runtime.sync.refreshProjectSessions("project-1", false);
  await waitForCalls(runtime, 1);

  runtime.emitCatalogRefreshed();
  await waitForCalls(runtime, 2);
  runtime.catalogCalls[1].request.resolve([recordB]);
  await settle();
  runtime.catalogCalls[0].request.reject(new Error("stale foreground failure"));
  await assert.rejects(foreground, /stale foreground failure/);

  assert.deepEqual(JSON.parse(JSON.stringify(runtime.sessionReplacements)), [
    { projectId: "project-1", sessions: [recordB] },
  ]);
  assert.deepEqual(runtime.catalogStates.map((entry) => entry.state.status), ["loading", "ready"]);
  assert.deepEqual(runtime.loadingWrites.map((entry) => entry["project-1"]), [true, false]);
});

test("a foreground success remains authoritative when the newer refresh fails", async () => {
  const runtime = createRuntime();
  const foreground = runtime.sync.refreshProjectSessions("project-1", false);
  await waitForCalls(runtime, 1);

  runtime.emitCatalogRefreshed();
  await waitForCalls(runtime, 2);
  runtime.catalogCalls[0].request.resolve([recordA]);
  await foreground;
  runtime.catalogCalls[1].request.reject(new Error("newer refresh failure"));
  await settle();

  assert.deepEqual(JSON.parse(JSON.stringify(runtime.sessionReplacements)), [
    { projectId: "project-1", sessions: [recordA] },
  ]);
  assert.deepEqual(runtime.catalogStates.map((entry) => entry.state.status), ["loading", "ready"]);
  assert.deepEqual(runtime.loadingWrites.map((entry) => entry["project-1"]), [true, false]);
});

test("an older background success is accepted after a newer foreground failure", async () => {
  const runtime = createRuntime();
  runtime.emitCatalogRefreshed();
  await waitForCalls(runtime, 1);

  const foreground = runtime.sync.refreshProjectSessions("project-1", false);
  await waitForCalls(runtime, 2);
  runtime.catalogCalls[1].request.reject(new Error("newer foreground failure"));
  await assert.rejects(foreground, /newer foreground failure/);

  runtime.catalogCalls[0].request.resolve([recordB]);
  await settle();

  assert.deepEqual(JSON.parse(JSON.stringify(runtime.sessionReplacements)), [
    { projectId: "project-1", sessions: [recordB] },
  ]);
  assert.deepEqual(runtime.catalogStates.map((entry) => entry.state.status), ["loading", "error", "ready"]);
  assert.deepEqual(runtime.loadingWrites.map((entry) => entry["project-1"]), [true, false]);
});
