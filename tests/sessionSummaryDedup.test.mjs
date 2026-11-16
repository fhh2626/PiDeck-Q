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

  test(`${mode} gives different canonical summaries distinct rows when projection IDs collide`, () => {
    const runtime = summary("agent-meta-1");
    const page = summary("agent-meta-1", { meta: { type: "compaction", compactionId: "compact-0" } });
    const displayed = mergeSummaryPage([runtime], [page], mode);
    assert.deepEqual(Array.from(displayed, (message) => message.meta.compactionId), ["compact-0", "compact-1"]);
    assert.equal(new Set(displayed.map((message) => message.id)).size, 2);
  });

  test(`${mode} uses the event fingerprint when legacy summaries reuse a projection ID`, () => {
    const runtime = summary("agent-meta-1", { meta: { type: "compaction", tokensBefore: 100 } });
    const page = summary("agent-meta-1", { timestamp: 900, meta: { type: "compaction", tokensBefore: 100 } });
    const displayed = mergeSummaryPage([runtime], [page], mode);
    assert.deepEqual(Array.from(displayed, (message) => message.timestamp), [900, 1000]);
    assert.equal(new Set(displayed.map((message) => message.id)).size, 2);
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

  test(`${mode} preserves canonical events when a legacy summary matches more than one identity`, () => {
    const runtime = summary("agent-meta-1", { meta: { type: "compaction", tokensBefore: 100 } });
    const older = summary("agent-meta-1", { meta: { type: "compaction", compactionId: "compact-old", tokensBefore: 100 } });
    const newer = summary("agent-meta-1", { meta: { type: "compaction", compactionId: "compact-new", tokensBefore: 100 } });
    const displayed = mergeSummaryPage([runtime], [older, newer], mode);
    assert.deepEqual(Array.from(displayed, (message) => message.meta.compactionId), ["compact-old", "compact-new", undefined]);
    assert.equal(new Set(displayed.map((message) => message.id)).size, displayed.length);
    assert.equal(runtime.meta.compactionId, undefined, "ambiguous legacy identity must not be guessed or mutated");
    assert.equal(older.id, "agent-meta-1", "row normalization must not mutate the input page");
  });

  test(`${mode} merges a unique canonical event into an immutable runtime card`, () => {
    const runtime = summary("agent-meta-1", { meta: { type: "compaction", tokensBefore: 100 } });
    const canonical = summary("file-meta-1");
    const displayed = mergeSummaryPage([runtime], [canonical], mode);
    assert.deepEqual(Array.from(displayed, (message) => message.meta.compactionId), ["compact-1"]);
    assert.equal(displayed[0].id, runtime.id, "the runtime display row and protocol slot stay stable");
    assert.notEqual(displayed[0], runtime);
    assert.equal(runtime.meta.compactionId, undefined, "identity enrichment must not mutate the incoming runtime card");
  });

  test(`${mode} reserves canonical matches before considering an earlier legacy fingerprint`, () => {
    const runtime = summary("agent-meta-1");
    const legacy = summary("file-legacy", { meta: { type: "compaction", tokensBefore: 100 } });
    const sameEvent = summary("file-canonical");
    const displayed = mergeSummaryPage([runtime], [legacy, sameEvent], mode);
    assert.deepEqual(Array.from(displayed, (message) => message.id), [legacy.id, runtime.id]);
  });

  test(`${mode} consumes each legacy fingerprint match at most once`, () => {
    const legacy = (id) => summary(id, { meta: { type: "compaction", tokensBefore: 100 } });
    const runtime = legacy("agent-meta-1");
    const displayed = mergeSummaryPage([runtime], [legacy("file-meta-1"), legacy("file-meta-2")], mode);
    assert.equal(displayed.length, 2, "one authoritative occurrence cannot remove two anonymous occurrences");
    assert.equal(displayed.at(-1).id, runtime.id);
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

/** Exercise successive public snapshots after older summaries have become visible. */
function runtimeHistory() {
  const store = createStore();
  const entry = () => store.get(atoms.sessionMessagesCacheAtom).session;
  const displayed = () => [...(entry().history?.messages ?? []), ...entry().messages];
  const apply = (messages, options = {}) => store.set(atoms.applySessionRuntimeEventAtom, {
    sessionId: "session", agentId: "agent", runtimeGeneration: 1, sourceChannel: "agents:message",
    payload: { messages, totalLength: messages.length, windowStartFilePos: 8,
      fileVersion: "1:1", preserveHistory: true, ...options },
  });
  const prepend = (messages) => assert.equal(store.set(atoms.prependSessionHistoryPageAtom, {
    sessionId: "session", expectedRevision: entry().revision,
    page: { messages, total: 10, nextBefore: null, indexVersion: "1:1" },
  }), true);
  return { store, apply, prepend, displayed };
}

const retainedUser = {
  id: "agent-history-retained", agentId: "agent", role: "user", text: "Retained turn",
  timestamp: 3000, meta: { entryId: "retained" },
};

test("successive pages and flushes retain distinct canonical identities behind one legacy window card", () => {
  const { store, apply, displayed } = runtimeHistory();
  const runtime = summary("agent-meta-1", { meta: { type: "compaction", tokensBefore: 100 } });
  const newer = summary("file-meta-1", { meta: { type: "compaction", compactionId: "compact-new", tokensBefore: 100 } });
  const older = summary("file-meta-1", { meta: { type: "compaction", compactionId: "compact-old", tokensBefore: 100 } });
  const page = (messages, before, nextBefore) => {
    const entry = store.get(atoms.sessionMessagesCacheAtom).session;
    assert.equal(store.set(atoms.prependSessionHistoryPageAtom, {
      sessionId: "session", expectedRevision: entry.revision, before,
      page: { messages, total: 10, nextBefore, indexVersion: "1:1" },
    }), true);
  };
  const canonicalIds = () => Array.from(displayed().filter((message) => message.role === "system"),
    (message) => message.meta.compactionId);
  apply([runtime, retainedUser]);
  page([newer], undefined, 6);
  assert.deepEqual(canonicalIds(), ["compact-new"]);
  apply([runtime, retainedUser]);
  apply([runtime, retainedUser]);
  assert.deepEqual(canonicalIds(), ["compact-new"]);
  page([older], 6, null);
  const rowIds = Array.from(displayed(), (message) => message.id);
  for (const stickyHistory of [false, true, false]) {
    apply([runtime, retainedUser], { stickyHistory });
    assert.deepEqual(canonicalIds(), ["compact-old", "compact-new"]);
    assert.deepEqual(Array.from(displayed(), (message) => message.id), rowIds);
    assert.equal(new Set(rowIds).size, rowIds.length);
  }
});

test("an incremental legacy payload retains the canonical identity learned from a history page", () => {
  const { store, apply, prepend, displayed } = runtimeHistory();
  const runtime = Object.freeze(summary("agent-meta-1", {
    meta: Object.freeze({ type: "compaction", tokensBefore: 100 }),
  }));
  apply([runtime, retainedUser]);
  prepend([summary("file-meta-1")]);
  const previous = store.get(atoms.sessionMessagesCacheAtom).session;
  Object.freeze(previous.messages[0].meta);
  Object.freeze(previous.messages[0]);
  Object.freeze(previous.messages);
  Object.freeze(previous);
  store.set(atoms.applySessionRuntimeEventAtom, {
    sessionId: "session", agentId: "agent", runtimeGeneration: 1, sourceChannel: "agents:message",
    payload: { messages: [runtime, retainedUser], upsertFrom: 0, totalLength: 2 },
  });
  const entry = store.get(atoms.sessionMessagesCacheAtom).session;
  assert.deepEqual(Array.from(entry.messages, (message) => message.id), [runtime.id, retainedUser.id]);
  assert.equal(entry.messages[0].meta.compactionId, "compact-1");
  assert.equal(entry.cardCount, previous.cardCount);
  assert.equal(entry.windowStartFilePos, previous.windowStartFilePos);
  assert.equal(displayed().filter((message) => message.meta?.type === "compaction").length, 1);
  assert.equal(runtime.meta.compactionId, undefined);
});

test("a first canonical sticky snapshot identifies its old runtime row without archiving a copy", () => {
  const { apply, displayed } = runtimeHistory();
  const legacy = summary("agent-meta-1", { meta: { type: "compaction", tokensBefore: 100 } });
  apply([legacy, retainedUser]);
  apply([summary(legacy.id), retainedUser], { stickyHistory: true, fileVersion: "2:2" });
  assert.deepEqual(Array.from(displayed(), (message) => message.id), [legacy.id, retainedUser.id]);
  assert.equal(displayed()[0].meta.compactionId, "compact-1");
  assert.equal(legacy.meta.compactionId, undefined);
});

for (const stickyCanonical of [false, true]) {
  test(`one canonical page cannot collapse existing legacy occurrences when its first canonical update is ${stickyCanonical ? "sticky" : "ordinary"}`, () => {
    const { store, apply, displayed } = runtimeHistory();
    const legacy = (id) => Object.freeze(summary(id, {
      meta: Object.freeze({ type: "compaction", tokensBefore: 100 }),
    }));
    const runtime = legacy("agent-meta-1");
    const older = legacy("file-meta-2");
    const canonical = summary("file-canonical");
    const page = (messages, before, nextBefore) => {
      const entry = store.get(atoms.sessionMessagesCacheAtom).session;
      assert.equal(store.set(atoms.prependSessionHistoryPageAtom, {
        sessionId: "session", expectedRevision: entry.revision, before,
        page: { messages, total: 10, nextBefore, indexVersion: "1:1" },
      }), true);
    };
    const cards = () => displayed().filter((message) => message.meta?.type === "compaction");
    apply([runtime, retainedUser]);
    page([legacy("file-meta-1"), older], undefined, 6);
    assert.deepEqual(Array.from(cards(), (message) => message.id), [older.id, runtime.id]);
    page([canonical], 6, null);
    for (const stickyHistory of [false, true, false]) {
      assert.deepEqual(Array.from(cards(), (message) => message.meta.compactionId), ["compact-1", undefined, undefined]);
      apply([runtime, retainedUser], { stickyHistory });
    }
    assert.deepEqual(Array.from(cards(), (message) => message.meta.compactionId), ["compact-1", undefined, undefined]);
    const identifiedRuntime = summary(runtime.id);
    apply([identifiedRuntime, retainedUser], { stickyHistory: stickyCanonical });
    for (const stickyHistory of [false, true, false]) {
      assert.deepEqual(Array.from(cards(), (message) => message.id), [older.id, runtime.id]);
      assert.deepEqual(Array.from(cards(), (message) => message.meta.compactionId), [undefined, "compact-1"]);
      apply([runtime, retainedUser], { stickyHistory });
    }
    assert.equal(runtime.meta.compactionId, undefined);
    assert.equal(older.meta.compactionId, undefined);
  });
}

test("later flushes do not weakly consume a legacy occurrence reserved by an exact page match", () => {
  const { apply, prepend, displayed } = runtimeHistory();
  const runtime = summary("agent-meta-1");
  const legacy = summary("file-legacy", { meta: { type: "compaction", tokensBefore: 100 } });
  apply([runtime, retainedUser]);
  prepend([legacy, summary("file-canonical")]);
  for (const stickyHistory of [false, true, false]) {
    assert.deepEqual(Array.from(displayed(), (message) => message.id), [legacy.id, runtime.id, retainedUser.id]);
    apply([runtime, retainedUser], { stickyHistory });
  }
  assert.deepEqual(Array.from(displayed(), (message) => message.id), [legacy.id, runtime.id, retainedUser.id]);
});

test("ordinary runtime flush preserves distinct paged compaction and branch summaries", () => {
  const { apply, prepend, displayed } = runtimeHistory();
  const current = summary("agent-meta-1");
  const older = summary("session-meta-1", { meta: { type: "compaction", compactionId: "compact-0" } });
  const branch = summary("session-meta-2", { meta: { type: "branchSummary", branchSummaryId: "branch-0" } });
  apply([current, retainedUser]);
  prepend([older, branch]);
  apply([current, retainedUser]);
  assert.deepEqual(Array.from(displayed(), (message) => message.id), [older.id, branch.id, current.id, retainedUser.id]);
});

for (const stickyHistory of [false, true]) {
  test(`${stickyHistory ? "sticky compaction" : "ordinary flush"} preserves canonical events behind an ambiguous legacy card`, () => {
    const { store, apply, displayed } = runtimeHistory();
    const runtime = summary("agent-meta-1", { meta: { type: "compaction", tokensBefore: 100 } });
    const older = summary("file-meta-1", { meta: { type: "compaction", compactionId: "compact-old", tokensBefore: 100 } });
    const newer = summary("file-meta-2", { meta: { type: "compaction", compactionId: "compact-new", tokensBefore: 100 } });
    apply([runtime, retainedUser]);
    // Seed a valid existing prefix so this assertion checks the flush itself,
    // independently of the public pagination operation's matching behavior.
    const entry = store.get(atoms.sessionMessagesCacheAtom).session;
    store.set(atoms.cacheSessionMessagesAtom, {
      sessionId: "session", source: "runtime", messages: entry.messages,
      history: { messages: [older, newer], nextBefore: null, exhausted: true, version: "1:1" },
    });
    for (let index = 0; index < 2; index += 1) {
      apply([runtime, retainedUser], { stickyHistory });
      assert.deepEqual(Array.from(displayed().filter((message) => message.role === "system"),
        (message) => message.meta.compactionId), ["compact-old", "compact-new", undefined]);
    }
    assert.equal(runtime.meta.compactionId, undefined);
  });
}

test("sticky compaction preserves distinct summaries from both the prefix and previous window", () => {
  const { apply, prepend, displayed } = runtimeHistory();
  const current = summary("agent-meta-1");
  const older = summary("session-meta-1", { meta: { type: "compaction", compactionId: "compact-0" } });
  const next = summary("agent-meta-next", { meta: { type: "compaction", compactionId: "compact-2" } });
  apply([current, retainedUser]);
  prepend([older]);
  apply([next, retainedUser], { stickyHistory: true, fileVersion: "2:2" });
  assert.deepEqual(Array.from(displayed().filter((message) => message.role === "system"),
    (message) => message.meta.compactionId), ["compact-0", "compact-1", "compact-2"]);
});

test("runtime takeover preserves earlier file summaries while replacing the matching event", () => {
  const { store, apply, displayed } = runtimeHistory();
  const older = summary("session-meta-1", { meta: { type: "compaction", compactionId: "compact-0" } });
  const previous = summary("session-meta-2");
  const current = summary("agent-meta-1", { text: "Completed summary", timestamp: 2000 });
  store.set(atoms.cacheSessionMessagesAtom, {
    sessionId: "session", source: "disk", messages: [older, previous, retainedUser],
    page: { total: 10, nextBefore: null },
  });
  apply([current, retainedUser], { stickyHistory: true });
  assert.deepEqual(Array.from(displayed(), (message) => message.text), [older.text, current.text, retainedUser.text]);
  assert.deepEqual(Array.from(displayed().filter((message) => message.role === "system"),
    (message) => message.meta.compactionId), ["compact-0", "compact-1"]);
});

test("different summary events retain distinct row IDs when native projection reuses its metadata slot", () => {
  const { apply, displayed } = runtimeHistory();
  const previous = summary("agent-meta-1");
  const current = summary("agent-meta-1", { meta: { type: "compaction", compactionId: "compact-2" } });
  apply([previous, retainedUser]);
  apply([current, retainedUser], { stickyHistory: true, fileVersion: "2:2" });
  const summaries = displayed().filter((message) => message.role === "system");
  assert.deepEqual(Array.from(summaries, (message) => message.meta.compactionId), ["compact-1", "compact-2"]);
  assert.equal(new Set(displayed().map((message) => message.id)).size, displayed().length);
  apply([current, retainedUser]);
  assert.deepEqual(Array.from(displayed().filter((message) => message.role === "system"),
    (message) => message.id), Array.from(summaries, (message) => message.id));
});

test("a completed canonical summary replaces its earlier placeholder once", () => {
  const { apply, displayed } = runtimeHistory();
  const previous = summary("agent-meta-1", { text: "Compacting" });
  const current = summary("agent-meta-1", { text: "Completed summary", timestamp: 2000 });
  apply([previous, retainedUser]);
  apply([current, retainedUser], { stickyHistory: true, fileVersion: "2:2" });
  assert.deepEqual(Array.from(displayed(), (message) => message.text), [current.text, retainedUser.text]);
});
