import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";
import { createStore } from "jotai/vanilla";

const nodeRequire = createRequire(import.meta.url);

function compileModule(filePath, imports = {}) {
  const source = readFileSync(filePath, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: filePath,
  }).outputText;
  const module = { exports: {} };
  const localRequire = (specifier) => imports[specifier] ?? nodeRequire(specifier);
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    require: localRequire,
    console,
    Date,
    Set,
  }, { filename: filePath });
  return module.exports;
}

function loadAtoms() {
  const runtimeState = compileModule("src/renderer/src/utils/agentRuntimeState.ts");
  const sessionRecordIdentity = compileModule("src/renderer/src/utils/sessionRecordIdentity.ts");
  const messageFingerprint = compileModule("src/shared/messageFingerprint.ts");
  const sessions = compileModule("src/renderer/src/atoms/session-atoms.ts", {
    "../utils/agentRuntimeState": runtimeState,
    "../utils/sessionRecordIdentity": sessionRecordIdentity,
    "../../../shared/messageFingerprint": messageFingerprint,
  });
  return sessions;
}

test("replaceSessionHistoryAfterMutationAtom: replaces history while keeping runtime window intact", () => {
  const atoms = loadAtoms();
  const store = createStore();
  const entryA = () => store.get(atoms.sessionMessagesCacheAtom)["session-a"];
  const entryB = () => store.get(atoms.sessionMessagesCacheAtom)["session-b"];

  // 初始化 session-a (runtime 来源，带旧历史)
  store.set(atoms.cacheSessionMessagesAtom, {
    sessionId: "session-a",
    source: "runtime",
    messages: [
      { id: "r1", role: "user", text: "recent-q", meta: { entryId: "e3" } },
      { id: "r2", role: "assistant", text: "recent-a", meta: { entryId: "e4" } },
    ],
    windowStart: 2,
    cardCount: 0,
    windowStartFilePos: 2,
    mutationSequence: 1,
    history: {
      messages: [
        { id: "h1", role: "user", text: "old-q-original", meta: { entryId: "e1" } },
        { id: "h2", role: "assistant", text: "old-a-original", meta: { entryId: "e2" } },
      ],
      nextBefore: 0,
      nextBeforeEntryId: "e1",
      exhausted: true,
      version: "100:1000",
    },
  });

  // 初始化 session-b (其他会话)
  store.set(atoms.cacheSessionMessagesAtom, {
    sessionId: "session-b",
    source: "runtime",
    messages: [{ id: "b1", role: "user", text: "b-msg" }],
    mutationSequence: 1,
  });

  const bSnapshotBefore = entryB();
  const aRevision = entryA().revision;

  // 执行 mutation 原子替换（编辑了 h1 消息）
  const success = store.set(atoms.replaceSessionHistoryAfterMutationAtom, {
    sessionId: "session-a",
    expectedRevision: aRevision,
    messages: [
      { id: "h1", role: "user", text: "old-q-EDITED", meta: { entryId: "e1" } },
      { id: "h2", role: "assistant", text: "old-a-original", meta: { entryId: "e2" } },
    ],
    nextBefore: null,
    nextBeforeEntryId: null,
    exhausted: true,
    version: "101:1050",
  });

  assert.equal(success, true, "atomic replacement must succeed");
  const aAfter = entryA();
  assert.equal(aAfter.history.messages[0].text, "old-q-EDITED", "edited message text must reflect");
  assert.equal(aAfter.history.messages[1].text, "old-a-original");
  assert.equal(aAfter.history.version, "101:1050");
  assert.equal(aAfter.history.exhausted, true);

  // runtime window 段保持不变
  assert.equal(aAfter.messages.length, 2);
  assert.equal(aAfter.messages[0].text, "recent-q");
  assert.equal(aAfter.windowStart, 2);
  assert.equal(aAfter.windowStartFilePos, 2);

  // session-b 引用和内容完全不受影响
  assert.equal(entryB(), bSnapshotBefore, "session-b cache entry reference must be preserved");
});

test("replaceSessionHistoryAfterMutationAtom: handles deletion (fewer history messages)", () => {
  const atoms = loadAtoms();
  const store = createStore();
  const entry = () => store.get(atoms.sessionMessagesCacheAtom)["session-a"];

  store.set(atoms.cacheSessionMessagesAtom, {
    sessionId: "session-a",
    source: "runtime",
    messages: [{ id: "r1", role: "user", text: "recent" }],
    mutationSequence: 2,
    history: {
      messages: [
        { id: "h1", role: "user", text: "to-delete", meta: { entryId: "e1" } },
        { id: "h2", role: "assistant", text: "keep-me", meta: { entryId: "e2" } },
      ],
      nextBefore: null,
      exhausted: true,
    },
  });

  const success = store.set(atoms.replaceSessionHistoryAfterMutationAtom, {
    sessionId: "session-a",
    expectedRevision: entry().revision,
    messages: [{ id: "h2", role: "assistant", text: "keep-me", meta: { entryId: "e2" } }],
    nextBefore: null,
    exhausted: true,
    version: "200:500",
  });

  assert.equal(success, true);
  assert.equal(entry().history.messages.length, 1);
  assert.equal(entry().history.messages[0].id, "h2");
});

test("replaceSessionHistoryAfterMutationAtom: guards reject invalid requests", () => {
  const atoms = loadAtoms();
  const store = createStore();
  const entry = () => store.get(atoms.sessionMessagesCacheAtom)["session-a"];

  store.set(atoms.cacheSessionMessagesAtom, {
    sessionId: "session-a",
    source: "runtime",
    messages: [{ id: "r1", role: "user", text: "recent" }],
    mutationSequence: 5,
    history: { messages: [], nextBefore: null },
  });

  // 1. 不存在的会话
  assert.equal(store.set(atoms.replaceSessionHistoryAfterMutationAtom, {
    sessionId: "non-existent",
    expectedRevision: 0,
    messages: [],
    nextBefore: null,
  }), false);

  // 2. expectedRevision 不匹配
  assert.equal(store.set(atoms.replaceSessionHistoryAfterMutationAtom, {
    sessionId: "session-a",
    expectedRevision: entry().revision + 99,
    messages: [{ id: "h1", role: "user", text: "bad" }],
    nextBefore: null,
  }), false);

  // 3. disk 来源会话被拒绝
  store.set(atoms.cacheSessionMessagesAtom, {
    sessionId: "session-disk",
    source: "disk",
    messages: [{ id: "d1", role: "user", text: "disk" }],
  });
  assert.equal(store.set(atoms.replaceSessionHistoryAfterMutationAtom, {
    sessionId: "session-disk",
    expectedRevision: store.get(atoms.sessionMessagesCacheAtom)["session-disk"].revision,
    messages: [{ id: "d0", role: "user", text: "disk-old" }],
    nextBefore: null,
  }), false);
});
