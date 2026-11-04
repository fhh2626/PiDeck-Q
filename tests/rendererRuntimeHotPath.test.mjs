import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as jotai from "jotai/vanilla";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const atoms = loadTsCommonJs("src/renderer/src/atoms/index.ts");
function seed(store, id = "session") {
  store.set(atoms.sessionRecordsAtom, { [id]: { id, projectId: "project", title: "Title", source: "pi", environment: "native", createdAt: 1, updatedAt: 1 } });
  store.set(atoms.sessionRuntimeByIdAtom, { [id]: { agentId: "agent", runtimeGeneration: 1, status: "idle", updatedAt: 1, projectId: "project", cwd: "/project", createdAt: 1 } });
}
const event = (sourceChannel, payload, overrides = {}) => ({ kind: "event", sessionId: "session", agentId: "agent", runtimeGeneration: 1, sourceChannel, payload, ...overrides });

test("inventory preserves identity and does not notify for runtime capability/statistics updates", () => {
  const store = jotai.createStore(); seed(store);
  const before = store.get(atoms.agentInventoryAtom);
  let notifications = 0;
  const unsubscribe = store.sub(atoms.agentInventoryAtom, () => notifications++);
  store.set(atoms.applySessionRuntimeEventAtom, event("agents:runtime-state", { state: { isStreaming: true, contextTokens: 100, cost: 0.2 } }));
  assert.equal(store.get(atoms.agentInventoryAtom), before);
  assert.equal(notifications, 0);
  unsubscribe();
});

test("inventory still publishes every projected field change and remains store-local", () => {
  const store = jotai.createStore(); seed(store);
  const other = jotai.createStore(); seed(other);
  const fields = { agentId: "agent2", projectId: "project2", cwd: "/other", title: "Fallback", status: "running", piSessionId: "pi-session", sessionPath: "/session.jsonl", runtimeGeneration: 2, createdAt: 2, compactionCount: 2, noSession: true };
  // Remove catalog to exercise fallback runtime title as well.
  store.set(atoms.sessionRecordsAtom, {});
  for (const [key, value] of Object.entries(fields)) {
    const before = store.get(atoms.agentInventoryAtom);
    store.set(atoms.sessionRuntimeByIdAtom, (all) => ({ ...all, session: { ...all.session, [key]: value } }));
    assert.notEqual(store.get(atoms.agentInventoryAtom), before, key);
  }
  assert.equal(other.get(atoms.agentInventoryAtom)[0].id, "agent");
  for (const [key, value] of Object.entries({ title: "Renamed", environment: "wsl", source: "claude", wslDistro: "Ubuntu", wslUser: "user", importedSourceId: "imported" })) {
    const before = other.get(atoms.agentInventoryAtom);
    other.set(atoms.sessionRecordsAtom, (all) => ({ ...all, session: { ...all.session, [key]: value } }));
    assert.notEqual(other.get(atoms.agentInventoryAtom), before, key);
  }
});

test("repeated widget text and unrelated events preserve runtime UI map identity", () => {
  const store = jotai.createStore(); seed(store);
  const widget = (lines) => event("agents:ui-request", { requestId: "widget", method: "setWidget", widgetKey: "status", widgetLines: lines });
  store.set(atoms.applySessionRuntimeEventAtom, widget(["line"]));
  const before = store.get(atoms.sessionRuntimeUiByIdAtom);
  assert.equal(before.session.widgets.status[0], "line");
  let notifications = 0;
  const unsubscribe = store.sub(atoms.sessionRuntimeUiByIdAtom, () => notifications++);
  store.set(atoms.applySessionRuntimeEventAtom, widget(["line"]));
  assert.equal(store.get(atoms.sessionRuntimeUiByIdAtom), before);
  store.set(atoms.applySessionRuntimeEventAtom, event("agents:runtime-state", { state: { isStreaming: true } }));
  assert.equal(store.get(atoms.sessionRuntimeUiByIdAtom), before);
  assert.equal(notifications, 0);
  store.set(atoms.applySessionRuntimeEventAtom, widget(["changed"]));
  assert.equal(notifications, 1);
  store.set(atoms.applySessionRuntimeEventAtom, widget([]));
  assert.equal(notifications, 2);
  const cleared = store.get(atoms.sessionRuntimeUiByIdAtom);
  store.set(atoms.applySessionRuntimeEventAtom, widget([]));
  assert.equal(store.get(atoms.sessionRuntimeUiByIdAtom), cleared);
  unsubscribe();
});

test("cache history selector ignores other sessions but follows its own history", () => {
  assert.equal(typeof atoms.sessionCacheStatsBySessionIdAtom, "function");
  const store = jotai.createStore();
  const selected = atoms.sessionCacheStatsBySessionIdAtom("session");
  store.set(atoms.sessionCacheStatsAtom, { session: { cacheHitHistory: [10] } });
  const before = store.get(selected);
  let notifications = 0;
  const unsubscribe = store.sub(selected, () => notifications++);
  store.set(atoms.sessionCacheStatsAtom, (all) => ({ ...all, other: { cacheHitHistory: [20] } }));
  assert.equal(store.get(selected), before);
  assert.equal(notifications, 0);
  store.set(atoms.sessionCacheStatsAtom, (all) => ({ ...all, session: { cacheHitHistory: [30] } }));
  assert.equal(store.get(selected).cacheHitHistory[0], 30);
  assert.equal(notifications, 1);
  unsubscribe();
});

test("non-focused runtime controller does not subscribe to global notification/catalog maps", () => {
  const store = jotai.createStore(); seed(store);
  store.set(atoms.currentSessionIdAtom, "other");
  const subscriptions = [];
  const { useSessionRuntimeController } = loadTsCommonJs("src/renderer/src/hooks/useSessionRuntimeController.ts", {
    stubs: {
      react: { useMemo: (fn) => fn(), useEffect: () => {} },
      jotai: { ...jotai, useAtomValue: (a) => { subscriptions.push(a); return store.get(a); } },
      "../atoms/session-atoms": atoms,
      "../atoms/session-selectors": atoms,
      "../atoms/composer-atoms": atoms,
      "./useSessionTimelineController": { isUserFacingSessionStart: () => false },
      "../i18n": { t: (key) => key },
      "../utils/notice": { dismissNotice() {} },
    },
  });
  const options = { sessionId: "session", agents: [], queueFlushBySessionRef: { current: new Set() }, activeQueuedPrompts: [], restartingAgentId: null, sessionDurationByAgent: {}, showNotice() {} };
  useSessionRuntimeController(options);
  assert.equal(subscriptions.includes(atoms.sessionRuntimeUiByIdAtom), false);
  assert.equal(subscriptions.includes(atoms.sessionRecordsAtom), false);
  subscriptions.length = 0;
  store.set(atoms.currentSessionIdAtom, "session");
  useSessionRuntimeController(options);
  assert.equal(subscriptions.includes(atoms.sessionRuntimeUiByIdAtom), true);
  assert.equal(subscriptions.includes(atoms.sessionRecordsAtom), true);
});

// These wiring contracts supplement behavior tests without pretending to measure DOM renders.
test("only the last turn subscribes to pending runtime UI", () => {
  const source = readFileSync("src/renderer/src/components/session/turn/TurnRow.tsx", "utf8");
  assert.match(source, /props\.sessionId\s*&&\s*props\.isLastAgentRun\s*\? sessionRuntimeUiBySessionIdAtomFamily/);
});
test("timeline passes one stable multi-select callback to memoized rows", () => {
  const source = readFileSync("src/renderer/src/components/session/SessionMessageTimeline.tsx", "utf8");
  assert.match(source, /const enterMultiSelect = useCallback\(/);
  assert.ok((source.match(/onEnterMultiSelect=\{enterMultiSelect\}/g) ?? []).length >= 1);
});
test("scroll auto-load uses the latest callback without rebinding for message deltas", () => {
  const source = readFileSync("src/renderer/src/hooks/useSessionTimelineController.ts", "utf8");
  const block = source.slice(source.indexOf('  // ── 滚动接近顶部自动加载历史'), source.indexOf('  useLayoutEffect(() => {', source.indexOf('  // ── 滚动接近顶部自动加载历史')));
  assert.match(block, /loadMoreMessagesRef\.current = loadMoreMessages/);
  assert.match(block, /loadMoreMessagesRef\.current\(\)/);
  assert.doesNotMatch(block, /\}, \[[^\]]*\bloadMoreMessages\b/);
});
