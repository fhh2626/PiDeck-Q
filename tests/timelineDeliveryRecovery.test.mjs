import assert from "node:assert/strict";
import test from "node:test";
import { createStore } from "jotai/vanilla";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const atoms = loadTsCommonJs("src/renderer/src/atoms/session-atoms.ts");
const sessionId = "session-1";
const agentId = "agent-1";
const row = (id, role, text, timestamp) => ({ id, agentId, role, text, timestamp, meta: { entryId: id } });
const old = [row("u1", "user", "old question", 1000), row("a1", "assistant", "old answer", 2000)];
const question = row("u2", "user", "question", 3000);
const reply = row("a2", "assistant", "streamed reply", 4000);
const skeleton = { ...reply, text: "" };

function fixture() {
  const store = createStore();
  const cache = () => store.get(atoms.sessionMessagesCacheAtom)[sessionId];
  const emit = (sourceChannel, payload, runtimeGeneration = 1) => store.set(atoms.applySessionRuntimeEventAtom, {
    sessionId, agentId, runtimeGeneration, sourceChannel, payload,
  });
  return {
    cache, emit,
    bind(generation) {
      store.set(atoms.replaceSessionRuntimesAtom, [{ sessionId, agentId, runtimeGeneration: generation, status: "running" }]);
    },
    snapshot(messages, fields, generation) { emit("agents:message", { messages, preserveHistory: true, ...fields }, generation); },
    stream(message, done = false, generation) { emit("agents:text-stream", { messageId: message.id, text: message.text, done }, generation); },
    block() { emit("sessions:message-delivery-status", { status: "blocked", code: "MESSAGE_DELIVERY_TOO_LARGE" }); },
    live: () => store.get(atoms.streamingTextByIdAtom)[sessionId],
    visible() {
      const sliding = cache().messages.filter((message) => message.meta?.slidingOut).map((message) => message.id);
      if (sliding.length) store.set(atoms.removeSessionSlidingOutMessagesAtom, { sessionId, messageIds: sliding });
      return [...(cache().history?.messages ?? []), ...cache().messages];
    },
  };
}

test("blocked assistant handoff keeps displayed text without keeping the stream active", () => {
  const f = fixture();
  f.snapshot([question, skeleton], { windowStart: 2, totalLength: 4 });
  f.stream(reply);
  f.block();
  assert.equal(f.live().content, reply.text);
  f.stream(reply, true);
  assert.equal(f.live(), undefined);
  assert.equal(f.visible().at(-1).text, reply.text);
  assert.equal(f.cache().windowStart, 2);
  f.snapshot([question, { ...reply, text: "canonical reply" }], { windowStart: 2, totalLength: 4 });
  assert.equal(f.visible().at(-1).text, "canonical reply");
});

test("a blocked handoff can precede the pending final live frame", () => {
  const f = fixture();
  f.snapshot([question, skeleton]);
  f.block();
  f.stream(reply);
  f.stream(reply, true);
  assert.equal(f.visible().at(-1).text, reply.text);
  assert.equal(f.live(), undefined);
});

test("a terminal live frame cannot replace a nonempty authoritative answer", () => {
  const f = fixture();
  const canonical = { ...reply, text: "canonical text" };
  f.snapshot([question, canonical]);
  f.stream(reply);
  f.block();
  f.stream(reply, true);
  assert.equal(f.visible().at(-1).text, canonical.text);
});

test("terminal frame from an older answer cannot clear the newer stream", () => {
  const f = fixture();
  const newer = row("a3", "assistant", "next stream", 5000);
  f.snapshot([question, skeleton]);
  f.stream(reply);
  f.block();
  f.stream(newer);
  f.stream(reply, true);
  assert.equal(f.live().messageId, newer.id);
  assert.equal(f.live().content, newer.text);
});

test("a new runtime cannot settle the old runtime's partial assistant row", () => {
  const f = fixture();
  f.snapshot([question, skeleton]);
  f.stream(reply);
  f.block();
  f.emit("agents:runtime-state", { isStreaming: false }, 2);
  assert.equal(f.live(), undefined);
  f.stream(reply, true, 2);
  assert.equal(f.visible().at(-1).text, "");
});

test("the authoritative runtime list also retires live text before the new instance emits", () => {
  const f = fixture();
  f.snapshot([question, skeleton]);
  f.stream(reply);
  f.bind(2);
  assert.equal(f.live(), undefined);
  f.stream(reply, true, 2);
  assert.equal(f.visible().at(-1).text, "");
});

test("resync after missing a preserving projection keeps cached older messages", () => {
  const f = fixture();
  f.snapshot([...old, question, reply], { fileVersion: "before" });
  // The initial sticky snapshot was lost; the next authoritative window only
  // carries the durable identity of the preserving projection.
  f.snapshot([question, reply], { fileVersion: "after", preservedProjectionId: "projection-2" });
  assert.deepEqual(f.visible().map((message) => message.id), ["u1", "a1", "u2", "a2"]);
  assert.deepEqual([...f.cache().history.compactionRetainedKeys], ["e:u1", "e:a1"]);
});

test("resync after missing trim metadata recovers the displaced prefix, not a removed tail", () => {
  const f = fixture();
  const removedTail = row("stale", "assistant", "abandoned row", 5000);
  f.snapshot([...old, question, reply, removedTail], { totalLength: 5, preservedProjectionId: "projection-1" });
  f.snapshot([question, reply], { windowStart: 2, totalLength: 4, preservedProjectionId: "projection-1" });
  assert.deepEqual(f.visible().map((message) => message.id), ["u1", "a1", "u2", "a2"]);
});

test("a fresh slide-out can accompany a second trim after an earlier snapshot was missed", () => {
  const f = fixture();
  const newer = row("u3", "user", "newest question", 5000);
  f.snapshot([...old, question, reply, newer], { totalLength: 5, preservedProjectionId: "projection-1" });
  f.snapshot([newer], {
    windowStart: 4, totalLength: 5, preservedProjectionId: "projection-1",
    slideOut: [question, { ...reply, text: "latest settled text" }],
  });
  assert.deepEqual(f.visible().map((message) => message.id), ["u1", "a1", "u2", "a2", "u3"]);
  assert.equal(f.visible().find((message) => message.id === "a2").text, "latest settled text");
});

test("a missed mutation overrides a later preserving projection", () => {
  const f = fixture();
  f.snapshot([...old, question, reply], { preservedProjectionId: "projection-1" });
  f.snapshot([question, reply], { historyMutationRevision: 1, preservedProjectionId: "projection-2" });
  assert.deepEqual(f.visible().map((message) => message.id), ["u2", "a2"]);
});
