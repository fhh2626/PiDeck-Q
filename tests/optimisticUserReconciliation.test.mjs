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

// ── 发送瞬间回滚一条的回归：旧全量快照不能把刚发出的 user 滑出 ──
// 场景：权威 user 已到达（本地气泡已配对移除），随后又收到一条「快照比本地旧」
// 的全量（SSE 重放 / 事件乱序 / 主进程重载竞态）。旧实现会把它标 slidingOut，
// 280ms 后移除 → scrollHeight 缩短 → 底部 scrollTop 被向上夹取 → 时间线回跳到
// 上一条消息。快照尾之后的 user 只可能来自「快照比本地旧」，必须保留。

function emitFull(atoms, store, messages, extra = {}) {
  store.set(atoms.applySessionRuntimeEventAtom, {
    sessionId: "session-1",
    agentId: "agent-1",
    runtimeGeneration: 1,
    sourceChannel: "agents:message",
    payload: { agentId: "agent-1", messages, totalLength: messages.length, ...extra },
  });
}

test("a stale full snapshot keeps the just-sent user row instead of sliding it out", () => {
  const atoms = loadAtoms();
  const store = createStore();
  const user = message("user-1", { text: "question", timestamp: 1_000 });
  const answer = message("answer-1", {
    role: "assistant",
    text: "answer",
    timestamp: 1_100,
  });
  emitFull(atoms, store, [user, answer]);

  const entry = store.get(atoms.sessionMessagesCacheAtom)["session-1"];
  store.set(atoms.cacheSessionMessagesAtom, {
    sessionId: "session-1",
    messages: [
      ...entry.messages,
      optimistic("local-request", {
        text: "next question",
        timestamp: 5_000,
        meta: { optimistic: true, optimisticRequestId: "local-request", optimisticPending: true },
      }),
    ],
    source: "runtime",
  });

  // 权威 user 到达：本地气泡被精确配对移除
  const authoritative = message("auth-1", {
    text: "next question",
    timestamp: 5_100,
    meta: { optimisticRequestId: "local-request" },
  });
  emitFull(atoms, store, [user, answer, authoritative]);
  assert.deepEqual(
    [...store.get(atoms.sessionMessagesCacheAtom)["session-1"].messages.map((item) => item.id)],
    ["user-1", "answer-1", "auth-1"],
  );

  // 旧快照（不含刚发出的 user）重放
  emitFull(atoms, store, [user, answer]);

  const messages = store.get(atoms.sessionMessagesCacheAtom)["session-1"].messages;
  assert.deepEqual(
    [...messages.map((item) => item.id)],
    ["user-1", "answer-1", "auth-1"],
    "旧快照不得让刚发出的 user 消失",
  );
  assert.equal(
    messages.some((item) => item.meta?.slidingOut === true),
    false,
    "刚发出的 user 不得进入滑出动画（移除会夹取底部 scrollTop）",
  );
});

test("a stale full snapshot still slides out an outdated trailing assistant row", () => {
  const atoms = loadAtoms();
  const store = createStore();
  const user = message("user-1", { text: "question", timestamp: 1_000 });
  const answer = message("answer-1", { role: "assistant", text: "answer", timestamp: 1_100 });
  emitFull(atoms, store, [user, answer]);

  const entry = store.get(atoms.sessionMessagesCacheAtom)["session-1"];
  store.set(atoms.cacheSessionMessagesAtom, {
    sessionId: "session-1",
    messages: [
      ...entry.messages,
      message("partial-1", { role: "assistant", text: "stale partial", timestamp: 1_200 }),
    ],
    source: "runtime",
  });

  emitFull(atoms, store, [user, answer]);
  const messages = store.get(atoms.sessionMessagesCacheAtom)["session-1"].messages;
  assert.equal(
    messages.find((item) => item.id === "partial-1")?.meta?.slidingOut,
    true,
    "assistant 尾部残缺仍按原语义滑出（终态全量替换中间态）",
  );
});

test("an explicit preserveHistory=false snapshot still drops the trailing user row", () => {
  const atoms = loadAtoms();
  const store = createStore();
  const user = message("user-1", { text: "question", timestamp: 1_000 });
  emitFull(atoms, store, [user]);

  const entry = store.get(atoms.sessionMessagesCacheAtom)["session-1"];
  store.set(atoms.cacheSessionMessagesAtom, {
    sessionId: "session-1",
    messages: [...entry.messages, message("user-2", { text: "deleted", timestamp: 2_000 })],
    source: "runtime",
  });

  // 编辑/删除/重发：显式声明旧内容失效
  emitFull(atoms, store, [user], { preserveHistory: false });
  const messages = store.get(atoms.sessionMessagesCacheAtom)["session-1"].messages;
  assert.equal(
    messages.find((item) => item.id === "user-2")?.meta?.slidingOut,
    true,
    "显式删除路径不得被尾部 user 保护挡住",
  );
});

test("a stale snapshot does not keep a trailing user that was persisted under another id", () => {
  // steer 排队等工具结束才落盘：投影副本与运行期副本时间戳差出 5s 容差，
  // stabilizeReloadedMessageIds 不会把 id 稳定化。若渲染层还按“快照尾之后的
  // user 一律保留”，就会同时出现本地副本与投影副本两条同文 user（永久幽灵行）。
  const atoms = loadAtoms();
  const store = createStore();
  const user = message("user-1", { text: "question", timestamp: 1_000 });
  const answer = message("answer-1", { role: "assistant", text: "answer", timestamp: 1_100 });
  emitFull(atoms, store, [user, answer]);

  const entry = store.get(atoms.sessionMessagesCacheAtom)["session-1"];
  store.set(atoms.cacheSessionMessagesAtom, {
    sessionId: "session-1",
    messages: [
      ...entry.messages,
      message("local-1", { text: "next question", timestamp: 5_000 }),
    ],
    source: "runtime",
  });

  // 同一条发送的投影副本：正文一致、id 不同、时间戳差 30s
  emitFull(atoms, store, [
    user,
    answer,
    message("projected-1", { text: "next question", timestamp: 35_000 }),
  ]);

  const messages = store.get(atoms.sessionMessagesCacheAtom)["session-1"].messages;
  const survivors = messages.filter(
    (item) => item.text === "next question" && item.meta?.slidingOut !== true,
  );
  assert.deepEqual(
    [...survivors.map((item) => item.id)],
    ["projected-1"],
    "已落盘的发送只能留投影副本，不得与本地副本并存",
  );
  assert.equal(
    messages.find((item) => item.id === "local-1")?.meta?.slidingOut,
    true,
    "本地副本必须进入滑出清理，而不是被当成未确认尾部保留",
  );
});

test("a stale snapshot keeps a repeated prompt whose earlier twin is clearly older", () => {
  // 连发「继续」：快照最后一条 user 是上一轮的「继续」（明显更早），不是这条
  // 发送的副本。若按“快照里有同文 user 就不保留”，最常见的连发会被误判成已落盘。
  const atoms = loadAtoms();
  const store = createStore();
  const user = message("user-1", { text: "继续", timestamp: 1_000 });
  const answer = message("answer-1", { role: "assistant", text: "上一轮回答", timestamp: 1_100 });
  emitFull(atoms, store, [user, answer]);

  const entry = store.get(atoms.sessionMessagesCacheAtom)["session-1"];
  store.set(atoms.cacheSessionMessagesAtom, {
    sessionId: "session-1",
    messages: [...entry.messages, message("local-1", { text: "继续", timestamp: 5_000 })],
    source: "runtime",
  });

  // 旧快照重放（不含刚发出的「继续」）
  emitFull(atoms, store, [user, answer]);

  const messages = store.get(atoms.sessionMessagesCacheAtom)["session-1"].messages;
  const local = messages.find((item) => item.id === "local-1");
  assert.ok(local, "刚发出的同文 prompt 不得被旧快照滑出");
  assert.notEqual(local.meta?.slidingOut, true);
});
