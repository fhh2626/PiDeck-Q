import assert from "node:assert/strict";
import test from "node:test";
import { createStore } from "jotai/vanilla";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

function loadAtoms() {
  return loadTsCommonJs("src/renderer/src/atoms/session-atoms.ts");
}

function loadReconciler() {
  return loadTsCommonJs("src/renderer/src/utils/optimisticUserReconciliation.ts");
}

function message(id, overrides = {}) {
  return {
    id,
    agentId: "agent-1",
    role: "user",
    text: "hello",
    timestamp: 1_000,
    ...overrides,
  };
}

function optimistic(id, overrides = {}) {
  return message(id, {
    meta: { optimistic: true, optimisticRequestId: id },
    ...overrides,
  });
}

test("drops a local optimistic user bubble when the authoritative copy arrives", () => {
  const { reconcileOptimisticUserMessages } = loadReconciler();
  const local = optimistic("local-request", { timestamp: 1_000 });
  const authoritative = message("pi-entry", { timestamp: 1_100 });

  const result = reconcileOptimisticUserMessages([local], [authoritative]);

  assert.deepEqual([...result.messages], []);
  assert.deepEqual([...result.droppedIds], ["local-request"]);
});

test("does not pair an older authoritative user with the same text", () => {
  const { reconcileOptimisticUserMessages } = loadReconciler();
  const local = optimistic("local-request", { timestamp: 10_000 });
  const oldAuthoritative = message("old-entry", { timestamp: 1_000 });

  const result = reconcileOptimisticUserMessages([local], [oldAuthoritative]);

  assert.deepEqual([...result.messages.map((item) => item.id)], ["local-request"]);
  assert.deepEqual([...result.droppedIds], []);
});

test("does not pair a previous identical send that is only two seconds older", () => {
  const { reconcileOptimisticUserMessages } = loadReconciler();
  const local = optimistic("local-request", { timestamp: 5_000 });
  const previousAuthoritative = message("previous-entry", { timestamp: 3_000 });

  const result = reconcileOptimisticUserMessages([local], [previousAuthoritative]);

  assert.deepEqual([...result.messages.map((item) => item.id)], ["local-request"]);
  assert.deepEqual([...result.droppedIds], []);
});

test("accepts an ISO timestamp from a compatible projection", () => {
  const { reconcileOptimisticUserMessages } = loadReconciler();
  const local = optimistic("local-request", { timestamp: 1_000 });
  const authoritative = message("pi-entry", {
    timestamp: new Date(1_100).toISOString(),
  });

  const result = reconcileOptimisticUserMessages([local], [authoritative]);

  assert.deepEqual([...result.messages], []);
  assert.deepEqual([...result.droppedIds], ["local-request"]);
});

test("pairs each authoritative user with the nearest optimistic copy", () => {
  const { reconcileOptimisticUserMessages } = loadReconciler();
  const older = optimistic("older-request", { timestamp: 1_000 });
  const newer = optimistic("newer-request", { timestamp: 3_000 });
  const authoritative = message("pi-entry", { timestamp: 3_100 });

  const result = reconcileOptimisticUserMessages([older, newer], [authoritative]);

  assert.deepEqual([...result.messages.map((item) => item.id)], ["older-request"]);
  assert.deepEqual([...result.droppedIds], ["newer-request"]);
});

test("keeps an optimistic bubble when the authoritative text differs", () => {
  const { reconcileOptimisticUserMessages } = loadReconciler();
  const local = optimistic("local-request", { timestamp: 1_000 });
  const authoritative = message("pi-entry", { text: "different text", timestamp: 1_100 });

  const result = reconcileOptimisticUserMessages([local], [authoritative]);

  assert.deepEqual([...result.messages.map((item) => item.id)], ["local-request"]);
  assert.deepEqual([...result.droppedIds], []);
});

test("matches an image-only submission after the projector adds a placeholder caption", () => {
  const { reconcileOptimisticUserMessages } = loadReconciler();
  const image = { type: "image", data: "A".repeat(200), mimeType: "image/png" };
  const local = optimistic("local-request", {
    text: "",
    timestamp: 1_000,
    images: [image],
  });
  const authoritative = message("pi-entry", {
    text: "Image",
    timestamp: 1_100,
    images: [image],
  });

  const result = reconcileOptimisticUserMessages([local], [authoritative]);

  assert.deepEqual([...result.messages], []);
  assert.deepEqual([...result.droppedIds], ["local-request"]);
});

test("a full snapshot replaces the optimistic user row instead of sliding it out", () => {
  const atoms = loadAtoms();
  const store = createStore();
  const emit = (messages) =>
    store.set(atoms.applySessionRuntimeEventAtom, {
      sessionId: "session-1",
      agentId: "agent-1",
      runtimeGeneration: 1,
      sourceChannel: "agents:message",
      payload: { agentId: "agent-1", messages },
    });

  const user = message("user-1", { text: "question", timestamp: 1_000 });
  const answer = message("answer-1", {
    id: "answer-1",
    role: "assistant",
    text: "answer",
    timestamp: 1_100,
  });
  emit([user, answer]);

  const entry = store.get(atoms.sessionMessagesCacheAtom)["session-1"];
  store.set(atoms.cacheSessionMessagesAtom, {
    sessionId: "session-1",
    messages: [
      ...entry.messages,
      optimistic("local-request", { text: "question", timestamp: 1_200 }),
    ],
    source: "runtime",
  });

  const authoritative = message("pi-entry", { text: "question", timestamp: 1_300 });
  emit([user, answer, authoritative]);

  const messages = store.get(atoms.sessionMessagesCacheAtom)["session-1"].messages;
  assert.deepEqual([...messages.map((item) => item.id)], ["user-1", "answer-1", "pi-entry"]);
  assert.equal(messages.some((item) => item.id === "local-request"), false);
  assert.equal(messages.some((item) => item.meta?.slidingOut === true), false);
});

test("a settled optimistic bubble still follows the existing slide-out path", () => {
  const atoms = loadAtoms();
  const store = createStore();
  const emit = (messages) =>
    store.set(atoms.applySessionRuntimeEventAtom, {
      sessionId: "session-1",
      agentId: "agent-1",
      runtimeGeneration: 1,
      sourceChannel: "agents:message",
      payload: { agentId: "agent-1", messages },
    });

  const user = message("user-1", { text: "question", timestamp: 1_000 });
  const answer = message("answer-1", {
    id: "answer-1",
    role: "assistant",
    text: "answer",
    timestamp: 1_100,
  });
  emit([user, answer]);

  const entry = store.get(atoms.sessionMessagesCacheAtom)["session-1"];
  store.set(atoms.cacheSessionMessagesAtom, {
    sessionId: "session-1",
    messages: [
      ...entry.messages,
      optimistic("local-request", { text: "not delivered", timestamp: 1_200 }),
    ],
    source: "runtime",
  });

  // The send result has settled without a runtime confirmation; keep today's
  // cleanup behavior so a failed bubble cannot remain in the timeline forever.
  emit([user, answer]);

  const messages = store.get(atoms.sessionMessagesCacheAtom)["session-1"].messages;
  const local = messages.find((item) => item.id === "local-request");
  assert.equal(local?.meta?.slidingOut, true);
});

test("pairs by requestId even when the submitted text was expanded", () => {
  const { reconcileOptimisticUserMessages } = loadReconciler();
  const local = optimistic("request-1", { text: "/template", timestamp: 10_000 });
  const authoritative = message("main-entry", {
    text: "expanded template body",
    timestamp: 1_000,
    meta: { optimisticRequestId: "request-1" },
  });

  const result = reconcileOptimisticUserMessages([local], [authoritative]);

  assert.deepEqual([...result.messages], []);
  assert.deepEqual([...result.droppedIds], ["request-1"]);
});

test("requestId pairing also applies when the authoritative row already existed", () => {
  const { reconcileOptimisticUserMessages } = loadReconciler();
  const local = optimistic("request-1", { text: "/template", timestamp: 10_000 });
  const authoritative = message("main-entry", {
    text: "expanded template body",
    timestamp: 1_000,
    meta: { optimisticRequestId: "request-1" },
  });

  const result = reconcileOptimisticUserMessages(
    [local, authoritative],
    [authoritative],
  );

  assert.deepEqual([...result.messages.map((item) => item.id)], ["main-entry"]);
  assert.deepEqual([...result.droppedIds], ["request-1"]);
});

test("requestId pairing does not consume a different local request", () => {
  const { reconcileOptimisticUserMessages } = loadReconciler();
  const first = optimistic("request-1", { text: "same", timestamp: 1_000 });
  const second = optimistic("request-2", { text: "same", timestamp: 2_000 });
  const authoritative = message("main-entry", {
    text: "expanded body",
    timestamp: 3_000,
    meta: { optimisticRequestId: "request-1" },
  });

  const result = reconcileOptimisticUserMessages([first, second], [authoritative]);

  assert.deepEqual([...result.messages.map((item) => item.id)], ["request-2"]);
  assert.deepEqual([...result.droppedIds], ["request-1"]);
});

test("optimisticMatchText covers expansion even without a requestId echo", () => {
  const { reconcileOptimisticUserMessages } = loadReconciler();
  const local = optimistic("request-1", {
    text: "/template",
    timestamp: 1_000,
    meta: {
      optimistic: true,
      optimisticRequestId: "request-1",
      optimisticMatchText: "expanded template body",
    },
  });
  const authoritative = message("pi-entry", {
    text: "expanded template body",
    timestamp: 1_100,
  });

  const result = reconcileOptimisticUserMessages([local], [authoritative]);

  assert.deepEqual([...result.messages], []);
  assert.deepEqual([...result.droppedIds], ["request-1"]);
});

test("an incremental tail update also removes the matched optimistic row", () => {
  const atoms = loadAtoms();
  const store = createStore();
  const emit = (payload) =>
    store.set(atoms.applySessionRuntimeEventAtom, {
      sessionId: "session-1",
      agentId: "agent-1",
      runtimeGeneration: 1,
      sourceChannel: "agents:message",
      payload: { agentId: "agent-1", ...payload },
    });

  const user = message("user-1", { text: "question", timestamp: 1_000 });
  const answer = message("answer-1", {
    role: "assistant",
    text: "answer",
    timestamp: 1_100,
  });
  emit({ messages: [user, answer] });

  const entry = store.get(atoms.sessionMessagesCacheAtom)["session-1"];
  store.set(atoms.cacheSessionMessagesAtom, {
    sessionId: "session-1",
    messages: [
      ...entry.messages,
      optimistic("request-1", { text: "/template", timestamp: 1_200 }),
    ],
    source: "runtime",
  });

  emit({
    upsertFrom: 2,
    totalLength: 3,
    messages: [message("main-entry", {
      text: "expanded template body",
      timestamp: 1_300,
      meta: { optimisticRequestId: "request-1" },
    })],
  });

  const messages = store.get(atoms.sessionMessagesCacheAtom)["session-1"].messages;
  assert.deepEqual([...messages.map((item) => item.id)], ["user-1", "answer-1", "main-entry"]);
  assert.equal(messages.some((item) => item.id === "request-1"), false);
});

test("an exact requestId match does not also consume a same-text local bubble", () => {
  const { reconcileOptimisticUserMessages } = loadReconciler();
  const first = optimistic("request-1", { text: "same", timestamp: 1_000 });
  const second = optimistic("request-2", { text: "same", timestamp: 2_000 });
  const authoritative = message("main-entry", {
    text: "same",
    timestamp: 2_100,
    meta: { optimisticRequestId: "request-1" },
  });

  const result = reconcileOptimisticUserMessages([first, second], [authoritative]);

  assert.deepEqual([...result.messages.map((item) => item.id)], ["request-2"]);
  assert.deepEqual([...result.droppedIds], ["request-1"]);
});

test("compaction history candidates drop the locally matched optimistic row", () => {
  const atoms = loadAtoms();
  const store = createStore();
  const emit = (payload) =>
    store.set(atoms.applySessionRuntimeEventAtom, {
      sessionId: "session-1",
      agentId: "agent-1",
      runtimeGeneration: 1,
      sourceChannel: "agents:message",
      payload: { agentId: "agent-1", ...payload },
    });

  const user = message("user-1", { text: "question", timestamp: 1_000 });
  const answer = message("answer-1", {
    role: "assistant",
    text: "answer",
    timestamp: 1_100,
  });
  emit({ messages: [user, answer] });

  const entry = store.get(atoms.sessionMessagesCacheAtom)["session-1"];
  store.set(atoms.cacheSessionMessagesAtom, {
    sessionId: "session-1",
    messages: [
      ...entry.messages,
      optimistic("request-1", { text: "hello", timestamp: 1_200 }),
    ],
    source: "runtime",
  });

  emit({
    messages: [
      user,
      answer,
      message("main-entry", {
        text: "hello",
        timestamp: 1_300,
        meta: { optimisticRequestId: "request-1" },
      }),
    ],
    totalLength: 3,
    windowStart: 0,
    preserveHistory: true,
    stickyHistory: true,
  });

  const cacheEntry = store.get(atoms.sessionMessagesCacheAtom)["session-1"];
  assert.equal(cacheEntry.messages.some((item) => item.id === "request-1"), false);
  assert.equal(cacheEntry.history?.messages.some((item) => item.id === "request-1") ?? false, false);
});

test("settleOptimisticMessage clears only the matching pending request", () => {
  const { settleOptimisticMessage } = loadReconciler();
  const messages = [
    optimistic("request-1", { meta: { optimistic: true, optimisticRequestId: "request-1", optimisticPending: true } }),
    optimistic("request-2", { meta: { optimistic: true, optimisticRequestId: "request-2", optimisticPending: true } }),
  ];

  const settled = settleOptimisticMessage(messages, "request-1");

  assert.equal(settled.changed, true);
  assert.equal(settled.messages[0].meta?.optimisticPending, undefined);
  assert.equal(settled.messages[1].meta?.optimisticPending, true);
  assert.equal(messages[0].meta?.optimisticPending, true, "settle must not mutate the input");
});

test("settleOptimisticMessage is a no-op for an unknown or already settled request", () => {
  const { settleOptimisticMessage } = loadReconciler();
  const messages = [optimistic("request-1")];

  const unknown = settleOptimisticMessage(messages, "request-2");
  assert.equal(unknown.changed, false);
  assert.equal(unknown.messages, messages);

  const alreadySettled = settleOptimisticMessage(messages, "request-1");
  assert.equal(alreadySettled.changed, false);
  assert.equal(alreadySettled.messages, messages);
});

test("pairs a bash prompt whose host text normalized command spacing", () => {
  const { reconcileOptimisticUserMessages } = loadReconciler();
  const local = optimistic("request-bash", { text: "!   ls", timestamp: 1_000 });
  const authoritative = message("host-bash", { text: "!ls", timestamp: 1_100 });

  const result = reconcileOptimisticUserMessages([local], [authoritative]);

  assert.deepEqual([...result.messages], []);
  assert.deepEqual([...result.droppedIds], ["request-bash"]);
});
