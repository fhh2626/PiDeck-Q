import React, { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Editor, EditorContent } from "@tiptap/react";
import { useTipTapComposerEditor } from "@/components/session/composer/useTipTapComposerEditor";
import { ComposerMeasuredExtras } from "@/components/session/composer/ComposerMeasuredExtras";
import type { ComposerCaretRequest } from "@/components/session/composer/types";
import "@/styles.css";

export type ComposerInputFixture = {
  reset: () => void;
  snapshot: () => { optionUpdates: number; extraReads: number; value: string; changes: string[]; keys: string[]; reports: number[]; caret: number };
  replace: (value: string, caret?: number) => void;
  configure: (disabled: boolean, placeholder: string) => void;
  callbacks: (revision: string) => void;
  extras: (height: number, attachment: boolean) => void;
  unmount: () => void;
};
declare global { interface Window { composerInputFixture?: ComposerInputFixture } }

const metrics: Omit<ReturnType<ComposerInputFixture["snapshot"]>, "caret"> = {
  optionUpdates: 0, extraReads: 0, value: "", changes: [], keys: [], reports: [],
};
const originalSetOptions = Editor.prototype.setOptions;
Editor.prototype.setOptions = function (...args: Parameters<Editor["setOptions"]>) {
  metrics.optionUpdates++;
  return originalSetOptions.apply(this, args);
};
const offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
if (!offsetHeight?.get) throw new Error("offsetHeight instrumentation is unavailable");
const originalHeight = offsetHeight.get;
Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
  configurable: true,
  get() {
    if (this instanceof HTMLElement && this.parentElement?.dataset.fixtureExtras === "true") metrics.extraReads++;
    return originalHeight.call(this);
  },
});

/** Production hook/DOM and height owner; no desktop API, Agent, network or session data. */
function Fixture() {
  const [value, setValue] = useState("");
  const [disabled, setDisabled] = useState(false);
  const [placeholder, setPlaceholder] = useState("initial");
  const [revision, setRevision] = useState("first");
  const [height, setHeight] = useState(0);
  const [attachment, setAttachment] = useState(false);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const caretRef = useRef<ComposerCaretRequest | null>(null);
  const editor = useTipTapComposerEditor({
    value, disabled, placeholder, hostRef, caretRef,
    onChange: (next) => { metrics.changes.push(`${revision}:${next}`); setValue(next); },
    onCursorChange: () => {},
    onKeyDown: (event) => metrics.keys.push(`${revision}:${event.key}`),
  });
  metrics.value = value;
  useEffect(() => {
    if (!editor) return;
    window.composerInputFixture = {
      reset: () => { metrics.optionUpdates = metrics.extraReads = 0; metrics.changes = []; metrics.keys = []; metrics.reports = []; },
      snapshot: () => ({ ...metrics, caret: editor.state.selection.from }),
      replace: (next, caret) => { if (caret !== undefined) caretRef.current = { forValue: next, pos: caret }; setValue(next); },
      configure: (nextDisabled, nextPlaceholder) => { setDisabled(nextDisabled); setPlaceholder(nextPlaceholder); },
      callbacks: setRevision,
      extras: (nextHeight, nextAttachment) => { setHeight(nextHeight); setAttachment(nextAttachment); },
      unmount: () => root.unmount(),
    };
    return () => { delete window.composerInputFixture; };
  }, [editor]);
  return <>
    <footer data-fixture-extras="true" className="flex flex-col gap-2">
      <ComposerMeasuredExtras widgets={height > 0 ? <div style={{ height }} /> : null}
        queuePanel={null} deliveryNotice={null} attachmentBar={attachment ? <div className="h-8" /> : null}
        onHeightChange={(extra) => metrics.reports.push(extra)} />
    </footer>
    <div ref={hostRef}><EditorContent editor={editor} /></div>
    <output data-testid="draft">{value}</output>
  </>;
}
const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Missing root");
const root = createRoot(rootElement);
root.render(<StrictMode><Fixture /></StrictMode>);
