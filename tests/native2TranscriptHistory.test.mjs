import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { createStore } from "jotai/vanilla";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { childPathEnvironment, environmentPath, qtBinDirectory } from "./helpers/native2BackendHarness.mjs";
import { joinPathParts } from "./helpers/native2FakeProcess.mjs";
import { nativeBuildPaths } from "./helpers/nativeBuildPaths.mjs";

const pinned = process.env.PIDECK_TRANSCRIPT_TEST_EXECUTABLE;
const candidates = nativeBuildPaths("PiDeck-TranscriptHistoryTest", { pinned });
const sources = [
  "native/tests/TranscriptHistoryTest.cpp",
  "xmake.lua",
  ...["native/backend/domain/runtime", "native/backend/domain/sessions"].flatMap((directory) =>
    readdirSync(directory).filter((name) => /\.(cpp|h)$/.test(name)).map((name) => `${directory}/${name}`)),
];
const executable = candidates.map((path) => resolve(path)).find((path) => existsSync(path)
  && sources.every((source) => statSync(path).mtimeMs >= statSync(source).mtimeMs));
const required = Boolean(pinned) || process.env.PIDECK_REQUIRE_BACKEND_TESTS === "1";

test("native compaction payloads preserve and page history through the real renderer reducer", {
  skip: !executable && !required ? "Build PiDeck-TranscriptHistoryTest to run native history regression" : false,
}, () => {
  assert.ok(executable, "A fresh PiDeck-TranscriptHistoryTest executable is required");
  const env = childPathEnvironment(process.env,
    joinPathParts([qtBinDirectory(), environmentPath(process.env)]));
  const cases = JSON.parse(execFileSync(executable, [], { env, encoding: "utf8", timeout: 30_000 }));
  assert.equal(cases.ordinary.preserveHistory, true,
    "ordinary file-version updates must not discard the loaded history prefix");
  assert.equal(cases.compacted.windowStartFilePos, 8, "cursor uses the complete active branch");
  assert.equal(cases.compacted.preserveHistory, true);
  assert.equal(cases.compacted.stickyHistory, true);
  assert.deepEqual(cases.undelivered, cases.compacted, "a rejected/unbound flush must retain one-shot policy");
  assert.equal(cases.delivered.stickyHistory, undefined);
  assert.equal(cases.delivered.preserveHistory, true);
  assert.equal(cases.withoutEntryIds.windowStartFilePos, 8);
  assert.equal(cases.trimmed.windowStartFilePos, 20);
  assert.equal(cases.trimmed.windowStart, 20);
  assert.equal(cases.trimmed.totalLength, 120);
  assert.equal(cases.trimmed.slideOut.length, 20);
  assert.equal(cases.trimDelivered.slideOut, undefined);
  assert.equal(cases.orphanTrim.windowStartFilePos, 28,
    "missing-result tool cards do not consume file positions when entry IDs are unavailable");
  assert.equal(cases.emptyTrim.windowStartFilePos, 28,
    "empty source messages still consume file positions even when projection hides them");
  assert.equal(cases.bashTail.windowStartFilePos, 0,
    "a hidden trailing bash execution does not invent archived history");
  assert.equal(cases.bashTailTrim.windowStartFilePos, 20);
  assert.equal(cases.bashMiddle.windowStartFilePos, 0);
  assert.equal(cases.bashMiddleTrim.windowStartFilePos, 21,
    "a hidden bash execution inside a trimmed turn still consumes its file position");
  for (const variant of ["bashTailWithIds", "bashMiddleWithIds"]) {
    assert.deepEqual(cases[variant].messages.map((message) => message.meta.entryId),
      cases.beforeTrim.messages.map((message) => message.meta.entryId),
      "bash executions must not shift the entry IDs used by message actions");
  }

  const atoms = loadTsCommonJs("src/renderer/src/atoms/session-atoms.ts");
  const { hasMoreRuntimeHistory } = loadTsCommonJs("src/renderer/src/hooks/useSessionTimelineController.ts", {
    stubs: {
      react: {}, jotai: { atom: (value) => ({ value }) }, "jotai/utils": {},
      "../atoms": atoms, "../desktopApi": {}, "../i18n": {}, "../utils/notice": {},
      "../utils/sessionCommands": {}, "../components/session/timeline/turnRenderWindow": {},
    },
  });
  const store = createStore();
  const sessionId = "history-session";
  const apply = (payload) => store.set(atoms.applySessionRuntimeEventAtom, {
    sessionId, agentId: "history-agent", runtimeGeneration: 1,
    sourceChannel: "agents:message", payload,
  });
  const entry = () => store.get(atoms.sessionMessagesCacheAtom)[sessionId];
  const texts = () => [...(entry().history?.messages ?? []), ...entry().messages]
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => message.text);
  const expected = cases.before.messages.map((message) => message.text);
  apply(cases.before);
  apply(cases.compacted);
  assert.deepEqual(texts(), expected, "compaction retains every previously visible turn");
  assert.equal(entry().messages.some((message) => message.meta?.slidingOut), false);
  assert.equal(hasMoreRuntimeHistory(entry()), true);
  assert.equal(entry().history.nextBefore, 8);
  apply(cases.delivered);
  assert.deepEqual(texts(), expected, "a later ordinary flush keeps the retained prefix");
  apply(cases.secondCompaction);
  assert.deepEqual(texts(), expected, "repeated compaction does not lose the first archive");
  apply(cases.mutation);
  assert.equal(entry().history, undefined, "edit/delete/resend explicitly discard stale history even at the same version");

  const coldStore = createStore();
  coldStore.set(atoms.applySessionRuntimeEventAtom, {
    sessionId, agentId: "history-agent", runtimeGeneration: 1,
    sourceChannel: "agents:message", payload: cases.withoutEntryIds,
  });
  assert.equal(hasMoreRuntimeHistory(coldStore.get(atoms.sessionMessagesCacheAtom)[sessionId]), true,
    "a reopened compacted session exposes older pages even without RPC entry ids");
  const fallbackStore = createStore();
  for (const payload of [cases.beforeWithoutEntryIds, cases.withoutEntryIds, cases.entryIdsRestored]) {
    fallbackStore.set(atoms.applySessionRuntimeEventAtom, {
      sessionId, agentId: "history-agent", runtimeGeneration: 1,
      sourceChannel: "agents:message", payload,
    });
  }
  const fallbackEntry = fallbackStore.get(atoms.sessionMessagesCacheAtom)[sessionId];
  assert.deepEqual([...(fallbackEntry.history?.messages ?? []), ...fallbackEntry.messages]
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => message.text), expected,
  "compaction without get_entries retains every turn exactly once instead of reusing raw-index identities");
  const shiftedStore = createStore();
  for (const payload of [cases.beforeWithoutEntryIds, cases.shiftedCursorEstimate]) {
    shiftedStore.set(atoms.applySessionRuntimeEventAtom, {
      sessionId, agentId: "history-agent", runtimeGeneration: 1,
      sourceChannel: "agents:message", payload,
    });
  }
  const shiftedEntry = shiftedStore.get(atoms.sessionMessagesCacheAtom)[sessionId];
  assert.deepEqual([...(shiftedEntry.history?.messages ?? []), ...shiftedEntry.messages]
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => message.text), expected,
  "an estimated file cursor cannot make a different projected message inherit an old identity");
  const unknownStore = createStore();
  for (const payload of [cases.unknownCursorBefore, cases.unknownCursorCompacted]) {
    unknownStore.set(atoms.applySessionRuntimeEventAtom, {
      sessionId, agentId: "history-agent", runtimeGeneration: 1,
      sourceChannel: "agents:message", payload,
    });
  }
  const unknownEntry = unknownStore.get(atoms.sessionMessagesCacheAtom)[sessionId];
  assert.deepEqual([...(unknownEntry.history?.messages ?? []), ...unknownEntry.messages]
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => message.text), expected,
  "an unavailable file cursor must not turn projection-relative indices into cross-snapshot identities");
  const repeatedStore = createStore();
  for (const payload of [cases.repeated0, cases.repeated8, cases.repeated10]) {
    repeatedStore.set(atoms.applySessionRuntimeEventAtom, {
      sessionId, agentId: "history-agent", runtimeGeneration: 1,
      sourceChannel: "agents:message", payload,
    });
  }
  const repeatedEntry = repeatedStore.get(atoms.sessionMessagesCacheAtom)[sessionId];
  assert.deepEqual([...(repeatedEntry.history?.messages ?? []), ...repeatedEntry.messages]
    .map((message) => message.meta?.entryId), expected,
  "different persisted entries remain distinct even when compactions retain the same text and timestamp");
  apply(cases.beforeTrim);
  apply(cases.trimmed);
  assert.equal(texts().length, 120, "window trimming moves old turns into history");
  assert.equal(new Set(texts()).size, 120, "trimming never duplicates old turns");
});
