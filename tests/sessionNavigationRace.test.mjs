import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { useSessionActions } = loadTsCommonJs("src/renderer/src/hooks/useSessionActions.ts", {
  stubs: { "../i18n": { t: (key) => key } },
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function record(id, projectId = "p", noSession = false) {
  return {
    id, projectId, title: id, noSession, source: "pi", environment: "windows",
    preview: "", messageCount: 0, status: "draft", createdAt: 1, updatedAt: 1,
  };
}

/** Use real selection actions with controlled IPC completion and a canonical record map. */
function harness() {
  const creation = deferred();
  const refresh = deferred();
  const records = new Map();
  const selection = { projectId: "p", sessionId: undefined };
  const busy = new Set();
  const notices = [];
  let creations = 0;
  const actions = useSessionActions({
    openSessionRequestRef: { current: 0 },
    creatingSessionDraftRef: { current: busy },
    activeProjectId: "p", sessionsProjectId: "p",
    projects: [{ id: "p", name: "Project", path: "/p", lastOpenedAt: 1 }],
    setActiveProjectId: (id) => { selection.projectId = id; },
    setCurrentSessionId: (id) => { selection.sessionId = id; },
    getSessionRecord: (id) => records.get(id),
    getProjectSessionRecords: (id) => [...records.values()].filter((r) => r.projectId === id),
    upsertSession: (r) => records.set(r.id, r),
    removeSessionState: (id) => records.delete(id),
    removeSessionComposerState: () => {},
    refreshProjectSessions: () => refresh.promise,
    api: { sessions: {
      createDraft: () => { creations++; return creation.promise; },
      createAnonymous: async () => { creations++; return { session: await creation.promise }; },
    } },
    showToast: (message) => notices.push(message),
  });
  return { actions, creation, refresh, records, selection, busy, notices, creations: () => creations };
}

for (const method of ["createSessionDraft", "createAnonymousSession"]) {
  test(`${method} keeps a newer sidebar selection while retaining the created record`, async () => {
    const h = harness();
    const pending = h.actions[method]();
    h.actions.selectSession("other", "chosen");
    const created = record("new", "p", method === "createAnonymousSession");
    h.creation.resolve(created);
    assert.equal(await pending, created);
    assert.deepEqual(h.selection, { projectId: "other", sessionId: "chosen" });
    assert.equal(h.records.get("new"), created);
    assert.equal(h.busy.size, 0);
  });

  test(`${method} cancels an older pending history open`, async () => {
    const h = harness();
    const oldOpen = h.actions.openSidebarSessionById("p", "old");
    const pending = h.actions[method]();
    h.records.set("old", record("old"));
    h.refresh.resolve([]);
    assert.equal(await oldOpen, undefined);
    h.creation.resolve(record("new"));
    await pending;
    assert.equal(h.selection.sessionId, "new");
  });

  test(`${method} deduplicates an in-flight create and selects the accepted result`, async () => {
    const h = harness();
    const pending = h.actions[method]();
    assert.equal(await h.actions[method](), undefined);
    assert.equal(h.creations(), 1);
    h.creation.resolve(record("new"));
    await pending;
    assert.equal(h.selection.sessionId, "new");
    assert.equal(h.busy.size, 0);
  });

  test(`${method} releases the creation guard after an IPC failure`, async () => {
    const h = harness();
    const pending = h.actions[method]();
    h.creation.reject(new Error("creation failed"));
    assert.equal(await pending, undefined);
    assert.equal(h.busy.size, 0);
    assert.equal(h.records.size, 0);
    assert.equal(h.notices.length, 1);
  });
}
