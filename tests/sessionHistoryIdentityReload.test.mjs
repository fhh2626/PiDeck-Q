import assert from "node:assert/strict";
import test from "node:test";
import { createStore } from "jotai/vanilla";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const atoms = loadTsCommonJs("src/renderer/src/atoms/session-atoms.ts");

function messages(count, agentId, durable = false) {
  return Array.from({ length: count }, (_, index) => ({
    id: durable ? `${agentId}-history-entry-${index}` : `${agentId}-projection-file-${index}-content-${index}`,
    agentId,
    role: index % 2 === 0 ? "user" : "assistant",
    text: `message-${index}`,
    timestamp: 1_000 + index,
    meta: { _piDeckMsgSeq: index, ...(durable ? { entryId: `entry-${index}` } : {}) },
  }));
}

function apply(store, rows, agentId, runtimeGeneration) {
  store.set(atoms.applySessionRuntimeEventAtom, {
    sessionId: "session",
    agentId,
    runtimeGeneration,
    sourceChannel: "agents:message",
    payload: {
      messages: rows,
      totalLength: rows.length,
      fileVersion: "same-file-version",
      preserveHistory: true,
      stickyHistory: true,
      windowStartFilePos: 0,
    },
  });
}

function visible(store) {
  const cache = store.get(atoms.sessionMessagesCacheAtom).session;
  return [...(cache.history?.messages ?? []), ...cache.messages];
}

test("a 50-turn fallback window gains durable identities across runtime activation exactly once", () => {
  const store = createStore();
  const before = messages(100, "before");
  const after = messages(100, "after", true);
  apply(store, before, "before", 1);
  apply(store, after, "after", 2);
  assert.deepEqual(visible(store).map((message) => message.text), before.map((message) => message.text));
  assert.deepEqual(visible(store).map((message) => message.meta.entryId), after.map((message) => message.meta.entryId));
});

test("a compacted long fallback window keeps its archive when a new runtime restores entry IDs", () => {
  const store = createStore();
  const before = messages(160, "before");
  const after = messages(160, "after", true).slice(60);
  apply(store, before, "before", 1);
  apply(store, after, "after", 2);
  assert.deepEqual(visible(store).map((message) => message.text), before.map((message) => message.text));
});

test("a later exact entry reserves its row before earlier anonymous fingerprints are matched", () => {
  const store = createStore();
  const before = messages(2, "agent", true).map((message, index) => ({
    ...message, role: "user", text: "continue", timestamp: 1_000 + index * 1_000,
  }));
  const after = [
    { ...before[0], id: "agent-projection-new-0", meta: { _piDeckMsgSeq: 0 } },
    before[1],
  ];
  apply(store, before, "agent", 1);
  apply(store, after, "agent", 1);
  assert.deepEqual(visible(store).map((message) => message.timestamp), [1_000, 2_000]);
});

test("the fingerprint window leaves older identical rows outside the incoming overlap intact", () => {
  const store = createStore();
  const before = messages(200, "before").map((message) => ({ ...message, text: "continue", timestamp: 1_000 }));
  const after = messages(100, "after", true).map((message) => ({ ...message, text: "continue", timestamp: 1_000 }));
  apply(store, before, "before", 1);
  apply(store, after, "after", 2);
  assert.equal(visible(store).length, before.length);
  assert.deepEqual(visible(store).slice(0, 100).map((message) => message.id), before.slice(0, 100).map((message) => message.id));
});

test("long same-text snapshots never merge different durable entries", () => {
  const store = createStore();
  const before = messages(100, "before", true).map((message) => ({ ...message, text: "continue", timestamp: 1_000 }));
  const after = messages(100, "after", true).map((message, index) => ({
    ...message, text: "continue", timestamp: 1_000, meta: { entryId: `new-entry-${index}` },
  }));
  apply(store, before, "before", 1);
  apply(store, after, "after", 2);
  assert.equal(visible(store).length, before.length + after.length);
  assert.deepEqual(visible(store).map((message) => message.meta.entryId), [...before, ...after].map((message) => message.meta.entryId));
});
