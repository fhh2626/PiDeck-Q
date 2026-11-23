import assert from "node:assert/strict";
import test from "node:test";
import { createStore } from "jotai/vanilla";
import { createRequire } from "node:module";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { withHookHost } from "./helpers/l5_hookHost.mjs";

const atoms = loadTsCommonJs("src/renderer/src/atoms/session-atoms.ts");
const { Provider } = createRequire(import.meta.url)("jotai");
const { refreshStoppedSessionHistory } = loadTsCommonJs("src/renderer/src/utils/stoppedSessionHistory.ts", {
  stubs: { "../atoms/session-atoms": atoms, "./session-atoms": atoms, "../i18n": { t: (key) => key } },
});

function fixture() {
  const store = createStore();
  const target = { kind: "history", sessionId: "stopped", filePath: "/saved.jsonl", runtimeGeneration: 3 };
  store.set(atoms.sessionRecordsAtom, { stopped: { id: "stopped", filePath: target.filePath } });
  store.set(atoms.sessionRuntimeByIdAtom, { stopped: { runtimeGeneration: 3, status: "detached" } });
  store.set(atoms.sessionMessagesCacheAtom, {
    stopped: {
      source: "runtime", revision: 7, agentId: "old-agent", updatedAt: 0,
      messages: [{ id: "live-uuid", agentId: "old-agent", role: "user", text: "same prompt", timestamp: 200 }],
      history: { messages: [{ id: "another-uuid", agentId: "old-agent", role: "user", text: "same prompt", timestamp: 100 }], nextBefore: null },
    },
  });
  return { store, target };
}

function page(entryId, nextBefore) {
  return {
    messages: [{ id: `viewer-history-${entryId}`, agentId: "viewer", role: "user", text: "same prompt", timestamp: 500,
      meta: { entryId } }],
    nextBefore, total: 2, indexVersion: "file-v1", nextBeforeEntryId: nextBefore === null ? null : entryId,
  };
}

test("stopping a live UUID transcript reloads persistent entry identities and keeps its loaded depth", async () => {
  const { store, target } = fixture();
  const pages = [page("entry-new", 1), page("entry-old", null)];
  const before = [];
  assert.equal(await refreshStoppedSessionHistory(target, {
    store,
    readPage: async (sessionId, cursor, size, options) => {
      assert.equal(sessionId, "stopped");
      before.push(options.beforeEntryId);
      return pages.shift();
    },
  }), true);
  const cache = store.get(atoms.sessionMessagesCacheAtom).stopped;
  assert.equal(cache.source, "disk");
  assert.deepEqual(Array.from(cache.messages, (message) => message.meta.entryId), ["entry-old", "entry-new"]);
  assert.equal(cache.messages[0].text, cache.messages[1].text, "repeated text keeps two distinct file identities");
  assert.deepEqual(before, [undefined, "entry-new"]);
  assert.equal(cache.page.nextBefore, null);
});

test("byte-limited history pages can reload every previously visible turn", async () => {
  const { store, target } = fixture();
  store.set(atoms.sessionMessagesCacheAtom, (cache) => ({ stopped: {
    ...cache.stopped, history: undefined,
    messages: Array.from({ length: 25 }, (_, index) => ({ id: `live-${index}`, role: "user", text: `turn ${index}` })),
  } }));
  let remaining = 25;
  assert.equal(await refreshStoppedSessionHistory(target, {
    store,
    // A single large turn can consume the file page's byte budget.
    readPage: async () => page(`entry-${--remaining}`, remaining || null),
  }), true);
  assert.equal(store.get(atoms.sessionMessagesCacheAtom).stopped.messages.length, 25);
});

for (const [kind, content] of [
  ["assistant", { role: "assistant", text: "Already visible answer" }],
  ["tool", { role: "tool", text: "Already visible result", meta: { toolCallId: "older-call" } }],
  ["thinking", { role: "assistant", text: "", thinking: "Already visible reasoning" }],
]) {
  test(`stopped reload preserves a leading ${kind} fragment before fifty complete turns`, async () => {
    const { store, target } = fixture();
    const fragment = {
      id: "live-fragment", agentId: "old-agent", timestamp: 100,
      ...content, meta: { ...content.meta, entryId: "older-fragment" },
    };
    const recent = Array.from({ length: 50 }, (_, index) => ["user", "assistant"].map((role) => ({
      id: `viewer-history-${role}-${index}`, agentId: "viewer", role, text: `${role} ${index}`,
      timestamp: 200 + index, meta: { entryId: `${role}-${index}` },
    }))).flat();
    store.set(atoms.sessionMessagesCacheAtom, (cache) => ({ stopped: {
      ...cache.stopped, messages: recent, history: { messages: [fragment], nextBefore: 1 },
    } }));
    const oldUser = { ...page("older-user", null).messages[0], timestamp: 90 };
    const pages = [
      { messages: recent, nextBefore: 2, nextBeforeEntryId: "user-0", total: 102, indexVersion: "file-v1" },
      { messages: [oldUser, { ...fragment, id: "viewer-history-older-fragment" }], nextBefore: null,
        total: 102, indexVersion: "file-v1" },
    ];
    assert.equal(await refreshStoppedSessionHistory(target, { store, readPage: async () => pages.shift() }), true);
    const result = store.get(atoms.sessionMessagesCacheAtom).stopped;
    assert.deepEqual(Array.from(result.messages, (message) => message.meta.entryId),
      ["older-user", "older-fragment", ...recent.map((message) => message.meta.entryId)]);
    assert.equal(result.page.nextBefore, null);
  });
}

for (const prefix of [[], [{ id: "summary", role: "system", text: "Compacted", timestamp: 100,
  meta: { type: "compaction", compactionId: "compact-1" } }]]) {
  test(`stopped reload does not invent a turn for ${prefix.length ? "a summary-only" : "an empty"} prefix`, async () => {
    const { store, target } = fixture();
    store.set(atoms.sessionMessagesCacheAtom, (cache) => ({ stopped: {
      ...cache.stopped, history: { messages: prefix, nextBefore: 1 },
    } }));
    let reads = 0;
    const newest = page("newest", 1);
    assert.equal(await refreshStoppedSessionHistory(target, {
      store,
      readPage: async () => {
        assert.equal(++reads, 1, "a summary does not extend the visible conversation depth");
        return { ...newest, messages: [...prefix, ...newest.messages] };
      },
    }), true);
    assert.equal(store.get(atoms.sessionMessagesCacheAtom).stopped.page.nextBefore, 1);
  });
}

test("late stopped-session pages cannot overwrite a resumed or replaced runtime", async () => {
  for (const mutation of [
    (store) => store.set(atoms.sessionRuntimeByIdAtom, { stopped: { agentId: "fresh", runtimeGeneration: 4, status: "idle" } }),
    (store) => store.set(atoms.sessionRecordsAtom, { stopped: { id: "stopped", filePath: "/other.jsonl" } }),
    (store) => store.set(atoms.sessionMessagesCacheAtom, (cache) => ({ stopped: { ...cache.stopped, revision: 8 } })),
  ]) {
    const { store, target } = fixture();
    assert.equal(await refreshStoppedSessionHistory(target, {
      store,
      readPage: async () => { mutation(store); return { ...page("fresh-entry", null), total: 1 }; },
    }), false);
    assert.equal(store.get(atoms.sessionMessagesCacheAtom).stopped.source, "runtime");
    assert.equal(store.get(atoms.sessionMessagesCacheAtom).stopped.messages[0].id, "live-uuid");
  }
});

test("adjacent stopped-session pages keep one compaction card at their shared boundary", async () => {
  const { store, target } = fixture();
  const summary = { id: "viewer-meta-1", role: "system", text: "summary", timestamp: 500,
    meta: { type: "compaction", compactionId: "compaction-1", firstKeptEntryId: "entry-new" } };
  const newest = page("entry-new", 1);
  const oldest = page("entry-old", null);
  const pages = [
    { ...newest, messages: [summary, ...newest.messages] },
    { ...oldest, messages: [...oldest.messages, { ...summary, id: "another-viewer-meta-1" }] },
  ];
  assert.equal(await refreshStoppedSessionHistory(target, { store, readPage: async () => pages.shift() }), true);
  const messages = store.get(atoms.sessionMessagesCacheAtom).stopped.messages;
  assert.deepEqual(Array.from(messages, (message) => message.meta?.entryId ?? message.meta?.compactionId),
    ["entry-old", "compaction-1", "entry-new"]);
});

test("a failed or version-drifting stopped-session reload leaves the complete old transcript visible", async () => {
  for (const failWithError of [false, true]) {
    const { store, target } = fixture();
    const original = store.get(atoms.sessionMessagesCacheAtom).stopped;
    let calls = 0;
    await assert.rejects(refreshStoppedSessionHistory(target, {
      store,
      readPage: async () => {
        if (++calls === 1) return page("entry-new", 1);
        if (failWithError) throw new Error("read failed");
        return { ...page("entry-old", null), indexVersion: "changed-file" };
      },
    }));
    assert.equal(store.get(atoms.sessionMessagesCacheAtom).stopped, original);
  }
});

test("the stopped-history hook stays outside live message renders", async () => {
  await withHookHost(async (host) => {
    const { store } = fixture();
    const { useStoppedSessionHistory } = host.load("src/renderer/src/hooks/useStoppedSessionHistory.ts", {
      stubs: {
        "../atoms/session-atoms": atoms, "./session-atoms": atoms,
        "../desktopApi": { desktopApi: { sessions: { readRecordMessagePage: async () => assert.fail("live sessions do not reload stopped history") } } },
        "../i18n": { t: (key) => key },
      },
    });
    const target = { sessionId: "stopped", agentId: "live-agent", runtimeGeneration: 4 };
    const probe = await host.mount(() => useStoppedSessionHistory(target, () => {}), {},
      (node) => host.React.createElement(Provider, { store }, node));
    const initialRenders = probe.renders();
    await host.act(async () => {
      store.set(atoms.sessionMessagesCacheAtom, (cache) => ({ ...cache, stopped: { ...cache.stopped, revision: 8, messages: [] } }));
    });
    assert.equal(probe.renders(), initialRenders, "live message delivery should only rerender timeline subscribers");
  });
});
