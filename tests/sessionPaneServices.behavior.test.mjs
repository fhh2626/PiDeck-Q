import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { parseHTML } from "linkedom";
import { atom, createStore, Provider, useAtomValue } from "jotai";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/** Mount real React Context consumers; restore the DOM facade and unmount even on failure. */
async function withReactPane(run, options = {}) {
  const { window } = parseHTML("<html><body><div id='root'></div></body></html>");
  const globals = { window, document: window.document, navigator: window.navigator, location: new URL("http://localhost/"), HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  let root;
  try {
    for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    const { createRoot } = await import("react-dom/client");
    root = createRoot(window.document.getElementById("root"));
    const module = loadTsCommonJs("src/renderer/src/components/session/SessionPaneServices.tsx", { ...options, stubs: {
      "../../atoms/session-selectors": { sessionRuntimeBySessionIdAtomFamily: () => atom(undefined) },
      ...options.stubs,
    } });
    await run({ root, module });
  } finally {
    if (root) await act(() => root.unmount());
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

/** Complete provider fixture: no runtime, user data, network, or real desktop services. */
function services() {
  const noop = () => {};
  return {
    promoteSessionToPermanent: noop, showToast: noop, onOpenFile: noop, onDiffFile: noop, onPreviewImage: noop,
    abortAgent: async () => {}, restartActiveAgent: async () => {}, runCreateSessionDraft: async () => {},
    enqueueSessionPrompt: () => true, insertQuickPrompt: noop, queueRetract: noop, queueDiscard: noop,
    queueFlushBySessionRef: { current: new Set() }, setTerminalOpenForOwner: noop, setTerminalCollapsedForOwner: noop,
    setTerminalHeightByOwner: noop, changeChatPath: async () => {}, showNotice: noop,
    api: { sessions: { sendUiResponse: async () => {} } }, jumpToMessageRef: { current: null }, exitSessionSplit: noop,
    isLanWeb: false, agents: [], queuedPromptsBySession: {}, restartingAgentId: null, sessionDurationByAgent: {},
    activeProjectId: undefined, gitInfo: { isRepo: false, branch: "" }, showThinking: true,
    validCommandNames: new Set(), validFilePaths: new Set(), terminalOpen: false, terminalDockClosing: false,
    terminalDockVisible: false, terminalCollapsed: false, availableTerminalHeight: 120, configOpen: false,
    environmentDialog: false, layoutRefs: { chatHeaderRef: { current: null }, composerRef: { current: null }, composerOffsetHeight: 0, terminalRowHeight: 0 },
  };
}

test("stable action consumer is not woken by render-local commands and dispatches the latest default target", async () => {
  await withReactPane(async ({ root, module }) => {
    let renders = 0;
    let observed;
    const calls = [];
    const Consumer = React.memo(() => {
      renders++;
      observed = module.useSessionPaneActions();
      return React.createElement("span", null, "actions");
    });
    const child = React.createElement(Consumer);
    const base = services();
    const render = async (target) => {
      const value = { ...base, terminalOpen: target === "b", showToast: (text) => calls.push(`${target}:${text}`),
        abortAgent: async (id = target) => { calls.push(id); }, restartActiveAgent: async (id = target) => { calls.push(`restart:${id}`); } };
      await act(() => root.render(React.createElement(React.StrictMode, null,
        React.createElement(module.SessionPaneServicesProvider, { value }, child))));
    };
    await render("a");
    const initialRenders = renders;
    const original = observed;
    await render("b");
    assert.equal(renders, initialRenders, "only state and implementations changed, not the action contract");
    assert.equal(observed.abortAgent, original.abortAgent);
    await original.abortAgent();
    await original.restartActiveAgent();
    original.showToast("latest");
    assert.deepEqual(calls, ["b", "restart:b", "b:latest"]);
  });
});

test("optional action availability changes remain visible while its implementation stays current", async () => {
  await withReactPane(async ({ root, module }) => {
    let observed;
    const calls = [];
    const Consumer = React.memo(() => { observed = module.useSessionPaneActions(); return null; });
    const child = React.createElement(Consumer);
    const base = services();
    const render = async (ensureSessionId) => act(() => root.render(
      React.createElement(module.SessionPaneServicesProvider, { value: { ...base, ensureSessionId } }, child)));
    await render(undefined);
    assert.equal(observed.ensureSessionId, undefined);
    await render(async (id) => { calls.push(id); return "first"; });
    const command = observed.ensureSessionId;
    assert.equal(await command("session-a"), "first");
    await render(async (id) => { calls.push(id); return "second"; });
    assert.equal(observed.ensureSessionId, command);
    assert.equal(await command("session-b"), "second");
    await render(undefined);
    assert.equal(observed.ensureSessionId, undefined);
    assert.deepEqual(calls, ["session-a", "session-b"]);
  });
});

test("production agent inventory rebuilding does not wake an unchanged pane", async () => {
  const records = atom({}), runtimes = atom({});
  const { agentInventoryAtom } = loadTsCommonJs("src/renderer/src/atoms/runtime-atoms.ts", { stubs: {
    "./session-atoms": { sessionRecordsAtom: records, sessionRuntimeByIdAtom: runtimes },
    "./session-selectors": { sessionIdByRuntimeAgentIdAtomFamily: () => atom(undefined) },
  } });
  const bindings = new Map([["A", atom({ agentId: "a" })], ["B", atom({ agentId: "b" })]]);
  const store = createStore();
  const a = { agentId: "a", projectId: "p", cwd: "C:/fixture", title: "A", status: "idle", createdAt: 1, runtimeGeneration: 1 };
  const b = { ...a, agentId: "b", title: "B", createdAt: 2 };
  store.set(runtimes, { A: a, B: b });
  await withReactPane(async ({ root, module }) => {
    let renders = 0;
    const Consumer = React.memo(() => {
      renders++;
      const value = module.useSessionPaneState();
      return React.createElement("span", { id: "production-a" }, value.agents[0]?.title ?? "closed");
    });
    const panes = React.createElement(module.SessionPaneScope, { sessionId: "A" }, React.createElement(Consumer));
    const base = services();
    function Host() {
      const agents = useAtomValue(agentInventoryAtom);
      return React.createElement(module.SessionPaneServicesProvider, { value: { ...base, agents } }, panes);
    }
    await act(() => root.render(React.createElement(Provider, { store }, React.createElement(Host))));
    const before = renders;
    await act(() => store.set(runtimes, { A: a, B: { ...b, status: "running" } }));
    assert.equal(renders, before, "production .map creates fresh AgentTabs, but unchanged A must remain isolated");
    await act(() => store.set(runtimes, { A: { ...a, title: "renamed" }, B: b }));
    assert.ok(renders > before, "a real change to A must not be suppressed");
    assert.equal(globalThis.document.getElementById("production-a").textContent, "renamed");
    const renamedRenders = renders;
    await act(() => store.set(runtimes, { A: { ...a, title: "renamed", sessionPath: "C:/fixture/a.jsonl", runtimeGeneration: 2 }, B: b }));
    assert.ok(renders > renamedRenders, "optional path and runtime identity changes must remain observable");
    const changedRenders = renders;
    await act(() => store.set(runtimes, { A: { ...a, title: "renamed" }, B: b }));
    assert.ok(renders > changedRenders, "removing optional runtime fields must remain observable");
    await act(() => store.set(runtimes, { B: b }));
    assert.equal(globalThis.document.getElementById("production-a").textContent, "closed");
  }, { stubs: { "../../atoms/session-selectors": { sessionRuntimeBySessionIdAtomFamily: (id) => bindings.get(id) } } });
});

test("another session's runtime, duration and queue updates do not wake an idle pane", async () => {
  const bindings = new Map([ ["A", atom({ agentId: "a" })], ["B", atom({ agentId: "b" })] ]);
  await withReactPane(async ({ root, module }) => {
    const renders = { a: 0, b: 0 };
    const Consumer = React.memo(({ id }) => {
      renders[id]++;
      const value = module.useSessionPaneState();
      const status = value.agents.find((agent) => agent.id === id)?.status;
      return React.createElement("span", { id }, `${status}:${value.sessionDurationByAgent[id] ?? 0}`);
    });
    // Without session scoping this is the original outer Context path; it must fail isolation.
    const Scope = module.SessionPaneScope ?? (({ children }) => children);
    const panes = React.createElement(React.Fragment, null,
      React.createElement(Scope, { sessionId: "A" }, React.createElement(Consumer, { id: "a" })),
      React.createElement(Scope, { sessionId: "B" }, React.createElement(Consumer, { id: "b" })));
    const base = services();
    const agentA = { id: "a", projectId: "p", title: "A", status: "idle", createdAt: 1 };
    const agentB = { id: "b", projectId: "p", title: "B", status: "idle", createdAt: 1 };
    const queueA = [];
    await act(() => root.render(React.createElement(module.SessionPaneServicesProvider,
      { value: { ...base, agents: [agentA, agentB], queuedPromptsBySession: { A: queueA, B: [] } } }, panes)));
    const before = { ...renders };
    await act(() => root.render(React.createElement(module.SessionPaneServicesProvider,
      { value: { ...base, agents: [agentA, { ...agentB, status: "running" }],
        sessionDurationByAgent: { b: 10 }, queuedPromptsBySession: { A: queueA, B: [] } } }, panes)));
    assert.equal(renders.a, before.a, "unrelated session data cannot invalidate A's frame");
    assert.ok(renders.b > before.b);
    assert.equal(globalThis.document.getElementById("a").textContent, "idle:0");
    assert.equal(globalThis.document.getElementById("b").textContent, "running:10");
  }, { stubs: { "../../atoms/session-selectors": { sessionRuntimeBySessionIdAtomFamily: (id) => bindings.get(id) } } });
});
