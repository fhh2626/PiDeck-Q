import assert from "node:assert/strict";
import test from "node:test";
import { createStore } from "jotai/vanilla";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const atoms = loadTsCommonJs("src/renderer/src/atoms/session-atoms.ts");

/** Complete renderer summary fixture; transport IDs deliberately differ from event identities. */
function summary(id, overrides = {}) {
  return {
    id, agentId: "agent", role: "system", text: "Summary", timestamp: 1000,
    meta: { type: "compaction", compactionId: "compact-1", tokensBefore: 100 },
    ...overrides,
  };
}

/** Apply a real runtime snapshot followed by a real public history-cache operation. */
function mergeSummaryPage(window, messages, mode = "prepend") {
  const store = createStore();
  const sessionId = "session";
  store.set(atoms.applySessionRuntimeEventAtom, {
    sessionId, agentId: "agent", runtimeGeneration: 1, sourceChannel: "agents:message",
    payload: { messages: window, totalLength: window.length, windowStartFilePos: 8 },
  });
  const entry = () => store.get(atoms.sessionMessagesCacheAtom)[sessionId];
  const input = {
    sessionId, expectedRevision: entry().revision,
    page: { messages, total: 10, nextBefore: null, indexVersion: "1:1" },
  };
  const command = mode === "rebuild" ? atoms.replaceHistoryPrefixAfterVersionDriftAtom : atoms.prependSessionHistoryPageAtom;
  assert.equal(store.set(command, input), true);
  return [...entry().history.messages, ...entry().messages];
}

for (const mode of ["prepend", "rebuild"]) {
  test(`${mode} deduplicates canonical compaction identity despite different projection IDs`, () => {
    const runtime = summary("agent-meta-1");
    const page = summary("session-meta-1", { text: "Updated canonical summary", timestamp: 2000 });
    const displayed = mergeSummaryPage([runtime], [page], mode);
    assert.deepEqual(Array.from(displayed, (message) => message.id), [runtime.id]);
  });

  test(`${mode} preserves different compaction events even with identical summary text and time`, () => {
    const runtime = summary("agent-meta-1");
    const page = summary("session-meta-1", { meta: { type: "compaction", compactionId: "compact-0", tokensBefore: 100 } });
    const displayed = mergeSummaryPage([runtime], [page], mode);
    assert.deepEqual(Array.from(displayed, (message) => message.id), [page.id, runtime.id]);
  });

  test(`${mode} preserves a branch summary beside a compaction summary`, () => {
    const runtime = summary("agent-meta-1");
    const branch = summary("session-meta-1", { meta: { type: "branchSummary", fromId: "branch-0" } });
    const displayed = mergeSummaryPage([runtime], [branch], mode);
    assert.deepEqual(Array.from(displayed, (message) => message.id), [branch.id, runtime.id]);
  });

  test(`${mode} matches legacy summaries by kind, content, time and token count`, () => {
    const runtime = summary("agent-meta-1", { meta: { type: "compaction", tokensBefore: 100 } });
    const page = summary("session-meta-1", { meta: { type: "compaction", tokensBefore: 100 } });
    assert.deepEqual(Array.from(mergeSummaryPage([runtime], [page], mode), (message) => message.id), [runtime.id]);
  });

  test(`${mode} does not match older legacy compactions with repeated text`, () => {
    const runtime = summary("agent-meta-1", { meta: { type: "compaction", tokensBefore: 100 } });
    const page = summary("session-meta-1", { timestamp: 900, meta: { type: "compaction", tokensBefore: 100 } });
    assert.deepEqual(Array.from(mergeSummaryPage([runtime], [page], mode), (message) => message.id), [page.id, runtime.id]);
  });

  test(`${mode} preserves legacy compactions with different retained-entry boundaries`, () => {
    const runtime = summary("agent-meta-1", { meta: { type: "compaction", firstKeptEntryId: "kept-new", tokensBefore: 100 } });
    const page = summary("session-meta-1", { meta: { type: "compaction", firstKeptEntryId: "kept-old", tokensBefore: 100 } });
    assert.deepEqual(Array.from(mergeSummaryPage([runtime], [page], mode), (message) => message.id), [page.id, runtime.id]);
  });

  test(`${mode} preserves legacy branch summaries from different branch sources`, () => {
    const runtime = summary("agent-meta-1", { meta: { type: "branchSummary", fromId: "branch-new" } });
    const page = summary("session-meta-1", { meta: { type: "branchSummary", fromId: "branch-old" } });
    assert.deepEqual(Array.from(mergeSummaryPage([runtime], [page], mode), (message) => message.id), [page.id, runtime.id]);
  });

  test(`${mode} does not match conflicting legacy token counts`, () => {
    const runtime = summary("agent-meta-1", { meta: { type: "compaction", tokensBefore: 100 } });
    const page = summary("session-meta-1", { meta: { type: "compaction", tokensBefore: 200 } });
    assert.deepEqual(Array.from(mergeSummaryPage([runtime], [page], mode), (message) => message.id), [page.id, runtime.id]);
  });
}

test("prepend deduplicates a previously loaded summary across another projection owner", () => {
  const store = createStore();
  store.set(atoms.cacheSessionMessagesAtom, {
    sessionId: "session", source: "runtime", messages: [],
    history: { messages: [summary("old-session-meta-1")], nextBefore: 8 },
  });
  const entry = () => store.get(atoms.sessionMessagesCacheAtom).session;
  assert.equal(store.set(atoms.prependSessionHistoryPageAtom, {
    sessionId: "session", expectedRevision: entry().revision, before: 8,
    page: { messages: [summary("new-session-meta-1")], total: 10, nextBefore: null },
  }), true);
  assert.equal(entry().history.messages.length, 1);
  assert.equal(entry().history.exhausted, true);
});
