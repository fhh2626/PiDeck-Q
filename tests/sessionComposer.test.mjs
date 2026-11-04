import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";
import { createStore } from "jotai/vanilla";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

function compile(filePath, stubs = {}) {
  const source = readFileSync(filePath, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
    },
    fileName: filePath,
  }).outputText;
  const module = { exports: {} };
  const localRequire = (specifier) => stubs[specifier] ?? {};
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    require: localRequire,
    console,
    crypto: { randomUUID: () => "request-id" },
    Set,
  }, { filename: filePath });
  return module.exports;
}

const sendSource = () => readFileSync("src/renderer/src/hooks/useSessionSend.ts", "utf8");
const areaSource = () => readFileSync("src/renderer/src/components/session/ComposerArea.tsx", "utf8");
const runtimeUiCoherenceSource = () => readFileSync(
  "src/renderer/src/components/session/runtimeUiCoherence.ts",
  "utf8",
);

function loadSendHelpers() {
  return compile("src/renderer/src/hooks/useSessionSend.ts", {
    react: { useRef: (value) => ({ current: value }) },
    jotai: { useAtomValue: () => undefined, useSetAtom: () => () => undefined },
    "../utils/optimisticSessionCache": loadTsCommonJs(
      "src/renderer/src/utils/optimisticSessionCache.ts",
    ),
    "../i18n": { translateI18nDescriptor: (_descriptor, fallback) => fallback },
  });
}

function loadImageHelpers() {
  return compile("src/renderer/src/utils/composerImages.ts");
}

function loadControllerHelpers() {
  return compile("src/renderer/src/hooks/useSessionComposerController.ts", {
    react: {},
    jotai: {},
    "../utils/composerPolicies": loadTsCommonJs("src/renderer/src/utils/composerPolicies.ts"),
  });
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createSendHarness(initial = {}) {
  const atoms = {
    sessionDraftByIdAtom: {},
    sessionAttachmentsByIdAtom: {},
    sessionComposerModeByIdAtom: {},
    sessionRuntimeByIdAtom: {},
    sessionRecordsAtom: {},
    sessionMessagesCacheAtom: {},
    cacheSessionMessagesAtom: {},
    setSessionDraftAtom: {},
    setSessionAttachmentsAtom: {},
    setSessionSendStateAtom: {},
    bindSessionRuntimeAtom: {},
    upsertSessionAtom: {},
  };
  const state = new Map([
    [atoms.sessionDraftByIdAtom, { ...(initial.drafts ?? {}) }],
    [atoms.sessionAttachmentsByIdAtom, { ...(initial.attachments ?? {}) }],
    [atoms.sessionComposerModeByIdAtom, { ...(initial.modes ?? {}) }],
    [atoms.sessionRuntimeByIdAtom, { ...(initial.runtimes ?? {}) }],
    [atoms.sessionRecordsAtom, { ...(initial.records ?? {}) }],
    [atoms.sessionMessagesCacheAtom, {}],
  ]);
  const setAtom = (atom, input) => {
    if (atom === atoms.setSessionDraftAtom) {
      const next = { ...state.get(atoms.sessionDraftByIdAtom) };
      const current = next[input.sessionId] ?? "";
      const value = typeof input.value === "function"
        ? input.value(current)
        : input.value;
      if (value) next[input.sessionId] = value;
      else delete next[input.sessionId];
      state.set(atoms.sessionDraftByIdAtom, next);
    } else if (atom === atoms.setSessionAttachmentsAtom) {
      const next = { ...state.get(atoms.sessionAttachmentsByIdAtom) };
      const current = next[input.sessionId] ?? [];
      const value = typeof input.value === "function"
        ? input.value(current)
        : input.value;
      if (value.length) next[input.sessionId] = value;
      else delete next[input.sessionId];
      state.set(atoms.sessionAttachmentsByIdAtom, next);
    } else if (atom === atoms.setSessionSendStateAtom) {
      const next = { ...state.get("sendStates") };
      if (input.state.status === "idle") delete next[input.sessionId];
      else next[input.sessionId] = input.state;
      state.set("sendStates", next);
    } else if (atom === atoms.cacheSessionMessagesAtom) {
      const next = { ...state.get(atoms.sessionMessagesCacheAtom) };
      next[input.sessionId] = {
        ...input,
        messages: [...input.messages],
        revision: (next[input.sessionId]?.revision ?? 0) + 1,
        updatedAt: Date.now(),
      };
      state.set(atoms.sessionMessagesCacheAtom, next);
    }
  };
  const module = compile("src/renderer/src/hooks/useSessionSend.ts", {
    react: { useRef: (value) => ({ current: value }) },
    jotai: {
      useAtomValue: (atom) => state.get(atom),
      useSetAtom: (atom) => (input) => setAtom(atom, input),
      useStore: () => ({ get: (atom) => state.get(atom), set: (atom, input) => setAtom(atom, input) }),
    },
    "../atoms": atoms,
    "../utils/optimisticSessionCache": loadTsCommonJs(
      "src/renderer/src/utils/optimisticSessionCache.ts",
    ),
    "../utils/optimisticUserReconciliation": loadTsCommonJs(
      "src/renderer/src/utils/optimisticUserReconciliation.ts",
    ),
    "../composerBehavior": {
      expandPromptTemplates: (message) => ({ message }),
      buildComposerPromptSubmission: (message) => ({ message }),
    },
    "../utils/composerImages": {
      exceedsComposerImagePayloadBudget: () => false,
    },
    "../i18n": { translateI18nDescriptor: (_descriptor, fallback) => fallback },
  });
  return {
    state,
    atoms,
    send: (options) => module.useSessionSend(options),
  };
}

test("the real send state machine snapshots multiline atom text", async () => {
  const harness = createSendHarness({ drafts: { "session-a": "first\nsecond" } });
  const deferred = createDeferred();
  let submitted;
  const send = harness.send({
    sessionId: "session-a",
    templates: [],
    compact: async () => undefined,
    sendPrompt: async (input) => {
      submitted = input;
      return deferred.promise;
    },
  });
  const pending = send();
  assert.equal(submitted.message, "first\nsecond");
  deferred.resolve({ accepted: true });
  await pending;
});

test("the real send state machine preserves input typed during a rejected delivery", async () => {
  const harness = createSendHarness({ drafts: { "session-a": "first\nsecond" } });
  const deferred = createDeferred();
  const send = harness.send({
    sessionId: "session-a",
    templates: [],
    compact: async () => undefined,
    sendPrompt: async () => deferred.promise,
  });
  const pending = send();
  harness.state.set(harness.atoms.sessionDraftByIdAtom, { "session-a": "new\ninput" });
  deferred.resolve({ accepted: false, delivery: "rejected", error: "rejected" });
  await pending;
  assert.equal(
    harness.state.get(harness.atoms.sessionDraftByIdAtom)["session-a"],
    "first\nsecond\n\nnew\ninput",
  );
  assert.equal(harness.state.get("sendStates")["session-a"].status, "error");
});

test("the real send state machine handles pure images, double clicks, and unknown delivery", async () => {
  const image = { type: "image", data: "x", mimeType: "image/png" };
  const imageHarness = createSendHarness({ attachments: { "session-a": [image] } });
  let imageCalls = 0;
  const imageSend = imageHarness.send({
    sessionId: "session-a",
    templates: [],
    compact: async () => undefined,
    sendPrompt: async (input) => {
      imageCalls += 1;
      assert.deepEqual(JSON.parse(JSON.stringify(input.images)), [image]);
      return { accepted: true };
    },
  });
  await imageSend();
  assert.equal(imageCalls, 1);

  const clickHarness = createSendHarness({ drafts: { "session-a": "once" } });
  const clickDeferred = createDeferred();
  let clickCalls = 0;
  const clickSend = clickHarness.send({
    sessionId: "session-a",
    templates: [],
    compact: async () => undefined,
    sendPrompt: async () => {
      clickCalls += 1;
      return clickDeferred.promise;
    },
  });
  const first = clickSend();
  const second = clickSend();
  assert.equal(clickCalls, 1);
  clickDeferred.resolve({ accepted: true });
  await Promise.all([first, second]);

  const unknownHarness = createSendHarness({ drafts: { "session-a": "maybe" } });
  let unknownCalls = 0;
  const unknownSend = unknownHarness.send({
    sessionId: "session-a",
    templates: [],
    compact: async () => undefined,
    sendPrompt: async () => {
      unknownCalls += 1;
      return { accepted: false, delivery: "unknown", error: "timeout" };
    },
  });
  await unknownSend();
  assert.equal(unknownHarness.state.get(unknownHarness.atoms.sessionDraftByIdAtom)["session-a"], undefined);
  const unknownState = unknownHarness.state.get("sendStates")["session-a"];
  assert.equal(unknownState.status, "unknown");
  assert.equal(unknownState.unknownSnapshot.message, "maybe");
  assert.equal(unknownState.unknownSnapshot.images, undefined);
  assert.equal(unknownCalls, 1, "unknown delivery must never auto-retry");
});

test("/compact releases the session send lock before the next prompt", async () => {
  const harness = createSendHarness({
    drafts: { "session-a": "/compact" },
    runtimes: { "session-a": { agentId: "agent-a", runtimeGeneration: 1 } },
  });
  let compactCalls = 0;
  let promptCalls = 0;
  const send = harness.send({
    sessionId: "session-a",
    templates: [],
    compact: async () => {
      compactCalls += 1;
    },
    sendPrompt: async (input) => {
      promptCalls += 1;
      return { accepted: true, requestId: input.requestId };
    },
  });

  await send();
  assert.equal(compactCalls, 1);

  // The first call clears the submitted snapshot; simulate the user typing again.
  harness.state.set(harness.atoms.sessionDraftByIdAtom, { "session-a": "next prompt" });
  await send();
  assert.equal(promptCalls, 1, "a completed compact command must not block the next prompt");
});

test("a cold /compact command does not publish a pending user bubble", async () => {
  const harness = createSendHarness({ drafts: { "session-a": "/compact" } });
  let submitted;
  const send = harness.send({
    sessionId: "session-a",
    templates: [],
    compact: async () => undefined,
    sendPrompt: async (input) => {
      submitted = input;
      return { accepted: true, requestId: input.requestId };
    },
  });

  await send();
  assert.equal(submitted.message, "/compact");
  assert.equal(
    harness.state.get(harness.atoms.sessionMessagesCacheAtom)["session-a"]?.messages?.length ?? 0,
    0,
    "a runtime command must not leave an optimistic user row behind",
  );
});

test("a pre-send Chat surface promotes once and only sends through its real Session", async () => {
  const bootstrapId = "renderer:chat-bootstrap";
  const realSessionId = "catalog-session";
  const harness = createSendHarness({ drafts: { [bootstrapId]: "start after send" } });
  const promotion = createDeferred();
  let promotionCalls = 0;
  let submitted;
  const send = harness.send({
    sessionId: bootstrapId,
    templates: [],
    compact: async () => undefined,
    ensureSessionId: async (sourceSessionId) => {
      promotionCalls += 1;
      assert.equal(sourceSessionId, bootstrapId);
      return promotion.promise;
    },
    sendPrompt: async (input) => {
      submitted = input;
      return { accepted: true };
    },
  });

  const first = send();
  const second = send();
  assert.equal(promotionCalls, 1, "double-clicking cannot create two Catalog Sessions");
  const sourceCache = harness.state.get(harness.atoms.sessionMessagesCacheAtom)[bootstrapId];
  assert.equal(sourceCache?.messages[0]?.meta?.optimisticPending, true);
  promotion.resolve(realSessionId);
  await Promise.all([first, second]);
  assert.equal(submitted.sessionId, realSessionId);
  assert.equal(submitted.message, "start after send");
  const targetCache = harness.state.get(harness.atoms.sessionMessagesCacheAtom)[realSessionId];
  assert.equal(
    targetCache?.messages.some((message) => message.id === sourceCache?.messages[0]?.id),
    true,
    "the local optimistic bubble must move to the promoted Session",
  );
  const settledSource = harness.state.get(harness.atoms.sessionMessagesCacheAtom)[bootstrapId];
  assert.equal(settledSource?.messages.some((message) => message.meta?.optimistic), false);
});

test("Composer identity is session-only and send snapshots address the captured Session", () => {
  const source = sendSource();
  assert.match(source, /sessionId: string/);
  assert.match(source, /const sourceSessionId = options\.sessionId/);
  assert.match(source, /setSendState\(\{\s*sessionId/);
  assert.match(source, /sendPrompt\(\{\s*sessionId,\s*requestId/);
  assert.match(source, /store\.get\(sessionDraftByIdAtom\)\[sourceSessionId\]/);
  assert.match(source, /store\.get\(sessionAttachmentsByIdAtom\)\[sourceSessionId\]/);
  assert.match(source, /options\.ensureSessionId\s*\? await options\.ensureSessionId\(sourceSessionId\)/);
  assert.doesNotMatch(source, /currentSessionIdAtom|selectedSessionId|getComposerText|liveDraftsRef|runtimeAgentId\?:/);
  assert.doesNotMatch(source, /setActiveAgentId/);
});

test("A/B switching cannot clear or restore the other Session draft", () => {
  const source = sendSource();
  assert.match(source, /clearSnapshot\(sessionId\)/);
  assert.match(source, /restoreRejectedSnapshot\(sessionId, message, imageSnapshot\)/);
  assert.match(source, /setDraft\(\{\s*sessionId: targetSessionId/);
  assert.match(source, /setAttachments\(\{\s*sessionId: targetSessionId/);
});

test("sending-time input is appended after a rejected snapshot without losing images", () => {
  const { mergeRejectedComposerDraft, mergeRejectedComposerImages } = loadSendHelpers();
  assert.equal(mergeRejectedComposerDraft("first", "new input"), "first\n\nnew input");
  const oldImage = { type: "image", data: "old", mimeType: "image/png" };
  const newImage = { type: "image", data: "new", mimeType: "image/png" };
  assert.equal(
    JSON.stringify(mergeRejectedComposerImages([oldImage], [newImage])),
    JSON.stringify([oldImage, newImage]),
  );
});

test("pure image submissions and double-click sends are guarded", () => {
  const { createSessionSendLock, hasComposerSubmission } = loadSendHelpers();
  assert.equal(hasComposerSubmission("", [{ type: "image", data: "x", mimeType: "image/png" }]), true);
  assert.equal(hasComposerSubmission("  ", []), false);
  const lock = createSessionSendLock();
  assert.equal(lock.claim("session-a"), true);
  assert.equal(lock.claim("session-a"), false);
  assert.equal(lock.claim("session-b"), true, "A/B sessions have isolated send locks");
  lock.release("session-a");
  assert.equal(lock.claim("session-a"), true);
});

test("unknown delivery is terminal and is not folded into rejected recovery", () => {
  const { classifySessionPromptResult } = loadSendHelpers();
  assert.equal(classifySessionPromptResult({ accepted: true }), "accepted");
  assert.equal(classifySessionPromptResult({ accepted: false, delivery: "rejected", error: "no" }), "rejected");
  assert.equal(classifySessionPromptResult({ accepted: false, delivery: "unknown", error: "timeout" }), "unknown");
  const source = sendSource();
  const unknownBranch = source.match(/else if \(outcome === "unknown"\) \{[\s\S]*?\n      \} else \{/)?.[0] ?? "";
  assert.doesNotMatch(unknownBranch, /restoreRejectedSnapshot/);
  assert.match(unknownBranch, /unknownSnapshot: \{[\s\S]*?message/);
});

test("ComposerArea keeps legacy runtime queue outside the Session draft leaf", () => {
  assert.match(areaSource(), /queuePanel\?: ReactNode/);
  assert.match(areaSource(), /\{props\.queuePanel\}/);
  assert.doesNotMatch(areaSource(), /queuedPromptQueue/);
  assert.doesNotMatch(areaSource(), /from ["']\.\.\/\.\.\/App["']/);
  assert.doesNotMatch(readFileSync("src/renderer/src/hooks/useSessionComposerController.ts", "utf8"), /queuedPromptQueue/);
});

test("first send publishes activating feedback before Session promotion", () => {
  const source = readFileSync("src/renderer/src/hooks/useSessionSend.ts", "utf8");
  const optimisticIndex = source.indexOf("publishOptimisticSubmission(sourceSessionId)");
  const ensureIndex = source.indexOf("await options.ensureSessionId(sourceSessionId)");
  assert.ok(optimisticIndex >= 0, "first-send optimistic publication must exist");
  assert.ok(ensureIndex >= 0, "Session promotion must remain in the send path");
  assert.ok(optimisticIndex < ensureIndex, "feedback must be published before promotion awaits");
  assert.match(source, /state: \{ status: "activating", requestId \}/);
});

test("runtime widgets require the current Session binding generation", () => {
  const { isCoherentComposerRuntimeUi } = compile(
    "src/renderer/src/components/session/runtimeUiCoherence.ts",
  );
  assert.equal(isCoherentComposerRuntimeUi({ agentId: "a", runtimeGeneration: 2 }, { agentId: "a", runtimeGeneration: 1 }), false);
  assert.equal(isCoherentComposerRuntimeUi({ agentId: "a", runtimeGeneration: 2 }, { agentId: "a", runtimeGeneration: 2 }), true);
  assert.equal(isCoherentComposerRuntimeUi(undefined, { agentId: "a", runtimeGeneration: 2 }), false);
  assert.match(runtimeUiCoherenceSource(), /runtimeUi\.agentId === runtime\.agentId/);
  assert.match(runtimeUiCoherenceSource(), /runtimeUi\.runtimeGeneration === runtime\.runtimeGeneration/);
});

test("a delayed same-generation editor command cannot overwrite a user edit", () => {
  const {
    createComposerDraftGuard,
    markComposerDraftMutation,
    canApplyRuntimeEditorText,
  } = loadControllerHelpers();
  let guard = createComposerDraftGuard({
    sessionId: "session-a",
    agentId: "agent-a",
    runtimeGeneration: 4,
    draft: "",
  });
  assert.equal(canApplyRuntimeEditorText(guard, {
    sessionId: "session-a",
    agentId: "agent-a",
    runtimeGeneration: 4,
    currentDraft: "",
  }), true);
  guard = markComposerDraftMutation(guard);
  assert.equal(canApplyRuntimeEditorText(guard, {
    sessionId: "session-a",
    agentId: "agent-a",
    runtimeGeneration: 4,
    currentDraft: "user edit",
  }), false);
  assert.equal(canApplyRuntimeEditorText(createComposerDraftGuard({
    sessionId: "session-a",
    agentId: "agent-a",
    runtimeGeneration: 5,
    draft: "",
  }), {
    sessionId: "session-a",
    agentId: "agent-a",
    runtimeGeneration: 5,
    currentDraft: "",
  }), true);
});

test("deferred template results are accepted only for the current Session/project key", async () => {
  const { createLatestRequestGate } = loadControllerHelpers();
  const gate = createLatestRequestGate();
  const a = createDeferred();
  const b = createDeferred();
  const aToken = gate.begin("session-a:project-a");
  const bToken = gate.begin("session-b:project-b");
  const accepted = [];
  a.promise.then((value) => { if (gate.isCurrent(aToken)) accepted.push(value); });
  b.promise.then((value) => { if (gate.isCurrent(bToken)) accepted.push(value); });
  a.resolve("templates-a");
  b.resolve("templates-b");
  await Promise.all([a.promise, b.promise]);
  assert.deepEqual(accepted, ["templates-b"]);
});

test("selected Session reference messages zip original indices with compressed messages", () => {
  const {
    createSessionReferenceSelection,
    selectedSessionReferenceMessages,
  } = loadControllerHelpers();
  const selection = createSessionReferenceSelection(
    [1, 4],
    [
      { role: "user", content: "selected one", timestamp: 1 },
      { role: "assistant", content: "selected four", timestamp: 4 },
    ],
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(selectedSessionReferenceMessages(selection))),
    [
      { role: "user", content: "selected one", timestamp: 1 },
      { role: "assistant", content: "selected four", timestamp: 4 },
    ],
  );
  assert.equal(selection.entries[0].index, 1);
  assert.equal(selection.entries[1].index, 4);
});

test("image handling keeps GIFs lossless and rejects unsupported/oversized files", () => {
  const source = readFileSync("src/renderer/src/utils/composerImages.ts", "utf8");
  const helpers = loadImageHelpers();
  assert.equal(
    JSON.stringify(helpers.dataUrlToImageContent("data:image/png;base64,abc", "image/jpeg")),
    JSON.stringify({ type: "image", data: "abc", mimeType: "image/png" }),
  );
  assert.match(source, /file\.type === "image\/gif"\) return fileToImageContent\(file\)/);
  assert.match(source, /COMPOSER_IMAGE_MAX_BYTES/);
});

test("optimistic cache writes preserve the loaded history window and cursor", () => {
  const { buildOptimisticCacheWrite } = loadSendHelpers();
  const history = {
    messages: [{ id: "old", agentId: "agent-1", role: "user", text: "old", timestamp: 1 }],
    nextBefore: 20,
    nextBeforeEntryId: "old-entry",
    exhausted: false,
  };
  const current = {
    messages: [],
    revision: 4,
    source: "runtime",
    updatedAt: 5,
    windowStart: 120,
    cardCount: 2,
    windowStartFilePos: 98,
    history,
  };
  const messages = [{
    id: "request-1",
    agentId: "agent-1",
    role: "user",
    text: "hello",
    timestamp: 10,
  }];

  const write = buildOptimisticCacheWrite("session-a", messages, current);

  assert.equal(write.source, "runtime");
  assert.equal(write.windowStart, 120);
  assert.equal(write.cardCount, 2);
  assert.equal(write.windowStartFilePos, 98);
  assert.equal(write.history, history);
  assert.deepEqual(write.messages, messages);
});

test("optimistic cache writes stay empty when the session has no window metadata", () => {
  const { buildOptimisticCacheWrite } = loadSendHelpers();
  const write = buildOptimisticCacheWrite("session-a", [], undefined);

  assert.equal(write.sessionId, "session-a");
  assert.deepEqual([...write.messages], []);
  assert.equal(write.source, "runtime");
  assert.equal("windowStart" in write, false);
  assert.equal("history" in write, false);
  assert.equal("cardCount" in write, false);
  assert.equal("windowStartFilePos" in write, false);
});

test("the real cache atom retains the history window after an optimistic append", () => {
  const { buildOptimisticCacheWrite } = loadSendHelpers();
  const atoms = loadTsCommonJs("src/renderer/src/atoms/session-atoms.ts");
  const store = createStore();
  const history = {
    messages: [{ id: "old", agentId: "agent-1", role: "user", text: "old", timestamp: 1 }],
    nextBefore: 20,
  };
  store.set(atoms.cacheSessionMessagesAtom, {
    sessionId: "session-a",
    messages: [],
    source: "runtime",
    agentId: "agent-1",
    revision: 1,
    updatedAt: 1,
    windowStart: 120,
    cardCount: 2,
    windowStartFilePos: 98,
    history,
  });
  const write = buildOptimisticCacheWrite("session-a", [{
    id: "request-1",
    agentId: "agent-1",
    role: "user",
    text: "hello",
    timestamp: 10,
  }], store.get(atoms.sessionMessagesCacheAtom)["session-a"]);

  assert.equal(store.set(atoms.cacheSessionMessagesAtom, write), true);
  const entry = store.get(atoms.sessionMessagesCacheAtom)["session-a"];
  assert.equal(entry.windowStart, 120);
  assert.equal(entry.cardCount, 2);
  assert.equal(entry.windowStartFilePos, 98);
  assert.equal(entry.history, history);
  assert.equal(entry.agentId, "agent-1");
});

test("accepted and unknown deliveries keep the optimistic pending marker until the host confirms it", async () => {
  for (const delivery of ["accepted", "unknown"]) {
    const harness = createSendHarness({ drafts: { "session-a": delivery } });
    const send = harness.send({
      sessionId: "session-a",
      templates: [],
      compact: async () => undefined,
      sendPrompt: async () => delivery === "accepted"
        ? { accepted: true }
        : { accepted: false, delivery: "unknown", error: "timeout" },
    });
    await send();

    const cached = harness.state.get(harness.atoms.sessionMessagesCacheAtom)["session-a"];
    assert.equal(
      cached?.messages[0]?.meta?.optimisticPending,
      true,
      `${delivery} is not authoritative; a stale snapshot must not evict the local bubble`,
    );
  }
});

test("a rejected delivery settles the optimistic bubble so cleanup can proceed", async () => {
  const harness = createSendHarness({ drafts: { "session-a": "rejected" } });
  const send = harness.send({
    sessionId: "session-a",
    templates: [],
    compact: async () => undefined,
    sendPrompt: async () => ({ accepted: false, delivery: "rejected", error: "no" }),
  });
  await send();

  const cached = harness.state.get(harness.atoms.sessionMessagesCacheAtom)["session-a"];
  assert.equal(cached?.messages[0]?.meta?.optimisticPending, undefined);
});

test("optimistic cache writes keep a disk page as disk instead of inventing a runtime window", () => {
  const { buildOptimisticCacheWrite } = loadSendHelpers();
  const page = { total: 120, nextBefore: 80 };
  const write = buildOptimisticCacheWrite("session-a", [], {
    messages: [],
    revision: 3,
    source: "disk",
    updatedAt: 1,
    page,
  });

  assert.equal(write.source, "disk");
  assert.deepEqual(write.page, page);
  assert.equal("windowStart" in write, false);
});

test("pre-send failure keeps an authoritative row that reused the optimistic id", async () => {
  const harness = createSendHarness({ drafts: { "session-a": "hello" } });
  harness.state.set(harness.atoms.sessionMessagesCacheAtom, {
    "session-a": {
      messages: [{
        id: "request-id",
        agentId: "agent-1",
        role: "user",
        text: "projected by the host",
        timestamp: 1,
      }],
      revision: 1,
      source: "runtime",
      updatedAt: 1,
    },
  });

  const send = harness.send({
    sessionId: "session-a",
    templates: [],
    compact: async () => undefined,
    ensureSessionId: async () => {
      throw new Error("promotion failed");
    },
    sendPrompt: async () => ({ accepted: true }),
  });
  await send();

  const messages = harness.state.get(harness.atoms.sessionMessagesCacheAtom)["session-a"].messages;
  assert.deepEqual([...messages.map((message) => message.id)], ["request-id"]);
  assert.equal(messages[0].text, "projected by the host");
});

test("promotion only stamps the optimistic row when the host projection reused its id", async () => {
  const harness = createSendHarness({
    drafts: { "session-a": "hello" },
    runtimes: { "session-a": { agentId: "agent-1", runtimeGeneration: 1 } },
  });
  harness.state.set(harness.atoms.sessionMessagesCacheAtom, {
    "session-a": {
      messages: [{
        id: "request-id",
        agentId: "host-agent",
        role: "user",
        text: "projected by the host",
        timestamp: 1,
      }],
      revision: 1,
      source: "runtime",
      updatedAt: 1,
    },
  });

  const send = harness.send({
    sessionId: "session-a",
    templates: [],
    compact: async () => undefined,
    ensureSessionId: async () => "session-a",
    sendPrompt: async () => ({ accepted: true }),
  });
  await send();

  const messages = harness.state.get(harness.atoms.sessionMessagesCacheAtom)["session-a"].messages;
  assert.deepEqual([...messages.map((message) => message.id)], ["request-id", "request-id"]);
  assert.equal(messages[0].agentId, "host-agent");
  assert.equal(messages[1].agentId, "agent-1");
  assert.equal(messages[1].meta?.optimistic, true);
});

test("pre-send failures discard the local optimistic bubble instead of leaving it pending", async () => {
  const promotionHarness = createSendHarness({ drafts: { "session-a": "hello" } });
  const promotionSend = promotionHarness.send({
    sessionId: "session-a",
    templates: [],
    compact: async () => undefined,
    ensureSessionId: async () => {
      throw new Error("promotion failed");
    },
    sendPrompt: async () => ({ accepted: true }),
  });
  await promotionSend();
  assert.deepEqual(
    promotionHarness.state.get(promotionHarness.atoms.sessionMessagesCacheAtom)["session-a"].messages,
    [],
  );
  assert.equal(
    promotionHarness.state.get(promotionHarness.atoms.sessionDraftByIdAtom)["session-a"],
    "hello",
    "a failed ensure must give the cleared draft back",
  );

  const prepareHarness = createSendHarness({ drafts: { "session-a": "hello" } });
  const prepareSend = prepareHarness.send({
    sessionId: "session-a",
    templates: [],
    compact: async () => undefined,
    prepareMessage: async () => {
      throw new Error("prepare failed");
    },
    sendPrompt: async () => ({ accepted: true }),
  });
  await prepareSend();
  assert.deepEqual(
    prepareHarness.state.get(prepareHarness.atoms.sessionMessagesCacheAtom)["session-a"].messages,
    [],
  );
});
