import test from "node:test";
import assert from "node:assert/strict";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { createHookHarness, nodes } from "./helpers/imagePreviewHarness.mjs";

// Run production TurnRow -> ToolStep -> ToolGroupCard -> ToolCard. CollapsibleContent
// deliberately retains children while closed, modelling Radix's exit-presence window.
test("production tool galleries stay single-mounted across outer collapse and forward the same preview owner", () => {
  const h = createHookHarness();
  const stubs = {
    react: { ...h.react, memo: (fn) => fn },
    jotai: { atom: (value) => value, useAtomValue: (value) => value },
    "../../../atoms/session-atoms": {}, "../../../atoms/session-selectors": {},
    "../../../atoms/app-ui-atoms": { turnFlowSettingsAtom: {} },
    "../../../i18n": { t: (key) => key }, "../../i18n": { t: (key) => key },
    "../../ui-shadcn/button": { Button: "Button" }, "../ui-shadcn/button": { Button: "Button" },
    "../ui-shadcn/badge": { Badge: "Badge" },
    "../../ui-shadcn/collapsible": { Collapsible: "Collapsible", CollapsibleContent: "CollapsibleContent" },
    "../SurfaceComponents": { stripMarkdown: (s) => s },
    "../../app/AppUtils": loadTsCommonJs("src/renderer/src/components/app/AppUtils.ts"),
    "../app/AppUtils": loadTsCommonJs("src/renderer/src/components/app/AppUtils.ts"),
    "../MessageCopyMenu": { CopyMenu: "CopyMenu" },
    "./FinalAnswer": { FinalAnswer: "FinalAnswer" },
    "./AssistantMessageImages": { AssistantMessageImages: "AssistantMessageImages" },
    "../MessageImageGallery": { MessageImageGallery: "Gallery" },
    "./MessageImageGallery": { MessageImageGallery: "Gallery" },
    "../AskQuestionResultCard": { AskQuestionResultCard: "AskQuestionResultCard" },
    "./InterimAnswer": { InterimAnswer: "InterimAnswer" },
    "./ProcessSummaryToggle": { ProcessSummaryToggle: "ProcessSummaryToggle" },
    "./ThinkingStep": { ThinkingStep: "ThinkingStep" },
    "./TurnFileChanges": { TurnFileChanges: "TurnFileChanges" },
    "./TimelineMarker": { TimelineMarker: "TimelineMarker" },
    "./LiveDuration": { LiveDuration: "LiveDuration" }, "../LiveDuration": { LiveDuration: "LiveDuration" },
    "../agents/tool-result": { ToolResult: "ToolResult" },
    "../../desktopApi": { desktopApi: {} },
  };
  const cardHarness = createHookHarness();
  stubs["../ToolCallComponents"] = loadTsCommonJs("src/renderer/src/components/session/ToolCallComponents.tsx", {
    stubs: { ...stubs, react: { ...cardHarness.react, memo: (fn) => fn } },
  });
  const { TurnRow } = loadTsCommonJs("src/renderer/src/components/session/turn/TurnRow.tsx", { stubs });
  const img = { type: "image", mimeType: "image/png", data: "abc" };
  const notice = { kind: "too-large", omitted: 1 };
  const message = { id: "tool", agentId: "agent", role: "tool", text: "done", timestamp: 2, images: [img], imageDisplayNotice: notice, meta: { toolName: "read", status: "done" } };
  const run = { kind: "agent-run", id: "run", startedAt: 1, endedAt: 3, items: [{ kind: "tool-group", id: "group", messages: [message] }] };
  const opened = [];
  const props = { run, onPreviewImage: (...args) => opened.push(args), onOpenExternal() {} };
  const render = () => h.render(() => TurnRow(props));
  function galleries(tree) {
    const result = nodes(tree, (n) => n.type === "Gallery");
    for (const step of nodes(tree, (n) => typeof n.type === "function" && n.type.name === "ToolStep")) {
      const stepTree = step.type(step.props);
      const group = nodes(stepTree, (n) => typeof n.type === "function" && n.type.name === "ToolGroupCard")[0];
      const groupTree = group.type(group.props);
      for (const card of nodes(groupTree, (n) => typeof n.type === "function" && n.type.name === "ToolCard")) {
        let cardTree = cardHarness.render(() => card.type(card.props));
        // Tool detail disclosure must not create a second gallery or lose the owner.
        nodes(cardTree, (n) => n.type === "button" && "aria-expanded" in n.props)[0].props.onClick();
        cardTree = cardHarness.render(() => card.type(card.props));
        result.push(...nodes(cardTree, (n) => n.type === "Gallery"));
      }
    }
    return result;
  }
  for (const expanded of [false, true, false, true]) {
    let tree = render();
    nodes(tree, (n) => n.type === "Collapsible")[0].props.onOpenChange(expanded);
    tree = render();
    const mounted = galleries(tree);
    assert.equal(mounted.length, 1, `expanded=${expanded}`);
    assert.equal(mounted[0].props.notice, notice);
    mounted[0].props.onPreviewImage(img, [img]);
    assert.equal(opened.at(-1)[0], img);
  }
});
