import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { withComposerReact } from "./helpers/composerReactHarness.mjs";

/** Observe the options passed to the editor library under real React rerenders. */
test("draft and callback updates keep editor initialization and DOM configuration stable", async () => {
  await withComposerReact(async (h) => {
    const options = [];
    const keys = [];
    const { useTipTapComposerEditor } = loadTsCommonJs("src/renderer/src/components/session/composer/useTipTapComposerEditor.ts", {
      stubs: {
        react: h.React,
        "@tiptap/react": { useEditor: (input) => { options.push(input); return null; } },
        "./tiptap/createComposerExtensions": { createComposerExtensions: () => [{ name: "fixture-extension" }] },
      },
      globals: h.globals,
    });
    function Fixture({ value, placeholder = "initial", disabled = false, revision = 0 }) {
      const hostRef = h.React.useRef(null);
      useTipTapComposerEditor({
        value, placeholder, disabled, hostRef,
        onChange: () => {}, onCursorChange: () => {},
        onKeyDown: (event) => keys.push([revision, event.key]),
      });
      return null;
    }
    await h.act(() => h.root.render(h.React.createElement(Fixture, { value: "initial" })));
    const first = options.at(-1);
    await h.act(() => h.root.render(h.React.createElement(Fixture, { value: "typed", revision: 1 })));
    const typed = options.at(-1);
    assert.equal(typed.extensions, first.extensions);
    assert.equal(typed.content, first.content);
    assert.equal(typed.editorProps, first.editorProps);
    const event = { key: "x", defaultPrevented: false };
    typed.editorProps.handleKeyDown({}, event);
    assert.deepEqual(keys, [[1, "x"]]);
    await h.act(() => h.root.render(h.React.createElement(Fixture, { value: "typed", placeholder: "new", disabled: true, revision: 2 })));
    const changed = options.at(-1);
    assert.equal(changed.extensions, first.extensions);
    assert.equal(changed.content, first.content);
    assert.notEqual(changed.editorProps, first.editorProps);
    assert.equal(changed.editable, false);
  });
});
