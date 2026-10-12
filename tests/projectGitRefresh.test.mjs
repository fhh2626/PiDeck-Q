import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** Drive the production hook without wall-clock delays; measure its public state writes. */
function harness(branches) {
  const states = [];
  const refs = [];
  let stateIndex = 0;
  let refIndex = 0;
  const { useProjectSync } = loadTsCommonJs("src/renderer/src/hooks/useProjectSync.ts", {
    stubs: {
      react: {
        useEffect() {},
        useRef(initial) { const index = refIndex++; return refs[index] ??= { current: initial }; },
        useState(initial) {
          const index = stateIndex++;
          const slot = states[index] ??= { value: initial, writes: 0 };
          return [slot.value, (next) => {
            const value = typeof next === "function" ? next(slot.value) : next;
            if (!Object.is(value, slot.value)) slot.writes++;
            slot.value = value;
          }];
        },
      },
      "../atoms/session-selectors": { sessionRecordToSummary: (x) => x },
      "../utils/projectInventoryRequests": { requestProjectInventory: (list) => list() },
    },
  });
  return {
    states,
    render(projectId = "project-a") {
      stateIndex = refIndex = 0;
      return useProjectSync({
        projects: [], activeProjectId: projectId, setProjects() {}, setActiveProjectId() {},
        replaceProjectSessions() {}, showToast() {}, t: (key) => key,
        api: { projects: { list: async () => [] }, files: { list: async () => [] },
          sessions: { listCatalog: async () => [] }, git: { worktreeList: async () => [], branches } },
      });
    },
  };
}
const main = () => ({ current: "main", branches: ["main"] });
const { ProjectGitRefresh } = loadTsCommonJs("src/renderer/src/utils/projectGitRefresh.ts");

test("poll failures back off while explicit refresh bypasses the delay", async () => {
  let calls = 0; let time = 0;
  const gate = new ProjectGitRefresh(async () => { calls++; throw new Error("offline"); }, () => {}, () => time);
  gate.select("a");
  await assert.rejects(gate.refresh("a", "poll"), /offline/);
  await gate.refresh("a", "poll"); assert.equal(calls, 1);
  await assert.rejects(gate.refresh("a", "explicit"), /offline/); assert.equal(calls, 2);
  time = 20_000;
  await assert.rejects(gate.refresh("a", "poll"), /offline/); assert.equal(calls, 3);
  gate.dispose();
});

test("disposal ignores a late result and refuses late callbacks", async () => {
  const response = deferred(); let applied = 0; let calls = 0;
  const gate = new ProjectGitRefresh(() => { calls++; return response.promise; }, () => applied++);
  gate.select("a"); const pending = gate.refresh("a", "poll");
  gate.dispose(); response.resolve(main()); await pending;
  await gate.refresh("a", "explicit"); assert.equal(applied, 0); assert.equal(calls, 1);
});

test("periodic refreshes coalesce while a slow branch request can still apply", async () => {
  const response = deferred(); let calls = 0;
  const h = harness(() => { calls++; return response.promise; });
  const sync = h.render();
  const first = sync.refreshGitInfo("project-a", "poll");
  const ticks = Array.from({ length: 4 }, () => sync.refreshGitInfo("project-a", "poll"));
  response.resolve(main());
  await Promise.all([first, ...ticks]);
  assert.equal(calls, 1);
  assert.equal(h.states[3].value.current, "main");
});

test("unchanged branch results preserve both branch-map and Git-info identities", async () => {
  const h = harness(async () => main()); const sync = h.render();
  await sync.refreshGitInfo("project-a");
  const info = h.states[3].value; const map = h.states[1].value;
  await sync.refreshGitInfo("project-a");
  assert.equal(h.states[3].value, info);
  assert.equal(h.states[1].value, map);
});

test("explicit mutations during a refresh schedule one non-overlapping follow-up", async () => {
  const responses = [deferred(), deferred()]; let calls = 0;
  const h = harness(() => responses[calls++].promise); const sync = h.render();
  const first = sync.refreshGitInfo("project-a", "poll");
  const explicit = sync.refreshGitInfo("project-a");
  const another = sync.refreshGitInfo("project-a");
  assert.equal(calls, 1);
  responses[0].resolve(main());
  await new Promise(setImmediate);
  assert.equal(calls, 2);
  responses[1].resolve({ current: "feature", branches: ["main", "feature"] });
  await Promise.all([first, explicit, another]);
  assert.equal(h.states[3].value.current, "feature");
});

test("A-to-B-to-A rejects the old epoch while allowing the new A result", async () => {
  const old = deferred(); const next = deferred(); let calls = 0;
  const h = harness(() => ++calls === 1 ? old.promise : next.promise);
  const first = h.render().refreshGitInfo("project-a", "poll");
  h.render("project-b");
  const latest = h.render("project-a").refreshGitInfo("project-a", "poll");
  next.resolve(main()); await latest;
  old.resolve({ current: "stale", branches: ["stale"] }); await first;
  assert.equal(h.states[3].value.current, "main");
});

test("a failed request releases ownership and explicit refresh can recover", async () => {
  let calls = 0;
  const h = harness(async () => { if (++calls === 1) throw new Error("offline"); return main(); });
  const sync = h.render();
  await assert.rejects(sync.refreshGitInfo("project-a"), /offline/);
  await sync.refreshGitInfo("project-a");
  assert.equal(h.states[3].value.current, "main");
});
