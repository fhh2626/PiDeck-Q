import assert from "node:assert/strict";
import test from "node:test";
import { atom, createStore } from "jotai/vanilla";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { extractUserPrompts } = loadTsCommonJs("src/renderer/src/composerBehavior.ts");

/** Event-only hook harness: effects never run and desktop mutations are forbidden. */
function controllerHarness({ historyIndex = -1, draft = "draft", composing = false, cursor = 0, savedDraft = "", keyCode = 0 } = {}) {
  const store = createStore();
  let messageReads = 0;
  const messages = Array.from({ length: 1200 }, (_, i) => ({
    role: "tool", id: `tool-${i}`,
    get text() { throw new Error("Tool text must not be inspected for prompt history"); },
  }));
  messages.unshift({ role: "user", id: "user", text: "old question" });
  const atoms = {
    sessionDraftByIdAtom: atom({ session: draft }),
    sessionMessagesCacheAtom: atom({ session: { get messages() { messageReads++; return messages; } } }),
    sessionAttachmentsByIdAtom: atom({}), sessionComposerModeByIdAtom: atom({}),
    sessionRuntimeByIdAtom: atom({}), sessionRecordsAtom: atom({}),
  };
  for (const name of ["setSessionAttachmentsAtom", "setSessionComposerModeAtom", "setSessionSendStateAtom", "bindSessionRuntimeAtom", "upsertSessionAtom"]) atoms[name] = atom(null, () => {});
  atoms.setSessionDraftAtom = atom(null, (get, set, input) => {
    const drafts = get(atoms.sessionDraftByIdAtom);
    set(atoms.sessionDraftByIdAtom, { ...drafts, [input.sessionId]: typeof input.value === "function" ? input.value(drafts[input.sessionId]) : input.value });
  });
  for (const [name, value] of Object.entries({
    sessionRecordByIdAtomFamily: undefined, sessionRuntimeBySessionIdAtomFamily: undefined,
    sessionRuntimeUiBySessionIdAtomFamily: undefined, sessionSummariesByProjectIdAtomFamily: [],
    sessionDraftAtomFamily: draft, sessionAttachmentsAtomFamily: [], sessionComposerModeAtomFamily: "normal",
    sessionSendStateAtomFamily: { status: "idle" },
  })) atoms[name] = () => atom(value);
  let cursorInitialized = false;
  const react = {
    useCallback: (fn) => fn, useMemo: (fn) => fn(), useRef: (value) => ({ current: value }), useEffect: () => {},
    useState: (initial) => {
      const value = typeof initial === "function" ? initial() : initial;
      // Seed the event snapshot: cursor is the first numeric state; -1 is historyIndex.
      if (!cursorInitialized && value === 0) { cursorInitialized = true; return [cursor, () => {}]; }
      return [value === -1 ? historyIndex : value === "" ? savedDraft : value, () => {}];
    },
  };
  const { useSessionComposerController } = loadTsCommonJs("src/renderer/src/hooks/useSessionComposerController.ts", {
    stubs: {
      react,
      jotai: { useAtomValue: (a) => store.get(a), useSetAtom: (a) => (input) => store.set(a, input), useStore: () => store },
      "../atoms": atoms,
      "../desktopApi": { desktopApi: { sessions: { sendPrompt: () => { throw new Error("Forbidden prompt submission"); } } }, isNativeRuntime: false },
      "../i18n": { t: (key) => key, translateI18nDescriptor: (_descriptor, text) => text },
      "./useSessionTimelineController": { isUserFacingSessionStart: () => false },
      "../utils/notice": { showNotice: () => {} },
      "../utils/clipboard": { htmlToPlainText: (text) => text },
    },
    globals: { window: {}, requestAnimationFrame: () => { throw new Error("Unexpected animation request"); } },
  });
  const controller = useSessionComposerController({ sessionId: "session" });
  return {
    press(key) {
      let prevented = false;
      controller.editor.onKeyDown({ key, nativeEvent: { isComposing: composing, keyCode }, ctrlKey: false, metaKey: false, shiftKey: false,
        preventDefault() { prevented = true; } });
      return prevented;
    },
    reads: () => messageReads,
    draft: () => store.get(atoms.sessionDraftByIdAtom).session,
  };
}

for (const key of ["a", "Shift", "Backspace", "ArrowLeft", "ArrowRight", "Escape"]) {
  test(`ordinary ${key} does not read session history`, () => {
    const h = controllerHarness();
    assert.equal(h.press(key), false);
    assert.equal(h.reads(), 0);
  });
}

test("ArrowDown outside history navigation does not read session history", () => {
  const h = controllerHarness();
  assert.equal(h.press("ArrowDown"), false);
  assert.equal(h.reads(), 0);
});

test("IME candidate navigation does not navigate prompt history", () => {
  const h = controllerHarness({ composing: true });
  assert.equal(h.press("ArrowUp"), false);
  assert.equal(h.reads(), 0);
  assert.equal(h.draft(), "draft");
});

test("ArrowUp still navigates to a persisted prompt without reading tool bodies", () => {
  const h = controllerHarness();
  assert.equal(h.press("ArrowUp"), true);
  assert.equal(h.reads(), 1);
  assert.equal(h.draft(), "old question");
});

test("ArrowDown restores the live saved draft without scanning history", () => {
  const h = controllerHarness({ historyIndex: 0, draft: "old question", savedDraft: "unsent live draft" });
  assert.equal(h.press("ArrowDown"), true);
  assert.equal(h.reads(), 0);
  assert.equal(h.draft(), "unsent live draft");
});

test("Escape restores the saved draft without scanning history", () => {
  const h = controllerHarness({ historyIndex: 0, draft: "old question", savedDraft: "unsent live draft" });
  h.press("Escape");
  assert.equal(h.reads(), 0);
  assert.equal(h.draft(), "unsent live draft");
});

test("ArrowUp within a later draft line remains editor navigation", () => {
  const multilineDraft = ["first", "second"].join("\n");
  const h = controllerHarness({ draft: multilineDraft, cursor: 8 });
  assert.equal(h.press("ArrowUp"), false);
  assert.equal(h.reads(), 0);
  assert.equal(h.draft(), multilineDraft);
});

test("Chromium keyCode 229 does not consume IME navigation", () => {
  const h = controllerHarness({ keyCode: 229 });
  assert.equal(h.press("ArrowUp"), false);
  assert.equal(h.reads(), 0);
});

test("prompt extraction never reads non-user text", () => {
  const messages = [{ role: "user", text: "  question  " }, { role: "assistant", get text() { throw new Error("Unrelated body read"); } }];
  assert.deepEqual(Array.from(extractUserPrompts(messages)), ["question"]);
});
