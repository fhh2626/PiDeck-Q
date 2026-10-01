import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { readRendererStyles } from "./helpers/rendererStyles.mjs";

import { mergeAgentRuntimeState } from "../src/renderer/src/utils/agentRuntimeState.ts";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { setI18nLocale, t } = loadTsCommonJs("src/renderer/src/i18n.ts");

const appSource = readFileSync("src/renderer/src/App.tsx", "utf8");
const sessionViewSource = readFileSync(
  "src/renderer/src/components/session/SessionView.tsx",
  "utf8",
);
const sessionRuntimeInjectorSource = readFileSync(
  "src/renderer/src/components/session/SessionRuntimeInjector.tsx",
  "utf8",
);
const bootstrapSource = readFileSync(
  "src/renderer/src/components/app/AppBootstrap.tsx",
  "utf8",
);
const globalListenersSource = readFileSync(
  "src/renderer/src/hooks/useGlobalAgentListeners.ts",
  "utf8",
);
const composerPanelsSource = readFileSync(
  "src/renderer/src/components/session/ComposerPanels.tsx",
  "utf8",
);
const stylesSource = readRendererStyles();
const i18nSource = [
  readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8"),
  readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8"),
].join("\n");
const runtimeStateSource = readFileSync(
  "src/renderer/src/utils/agentRuntimeState.ts",
  "utf8",
);
const queueStateSource = readFileSync(
  "src/renderer/src/utils/queuedPromptQueue.ts",
  "utf8",
);
const toolRuntimeStateSource = readFileSync(
  "src/shared/toolRuntimeState.ts",
  "utf8",
);
const agentManagerSource = readFileSync("src/main/pi/AgentManager.ts", "utf8");
const webServiceSource = readFileSync(
  "src/main/web/WebServiceManager.ts",
  "utf8",
);
const sharedTypesSource = [
  readFileSync("src/shared/types.ts", "utf8"),
  readFileSync("src/shared/types/session.ts", "utf8"),
].join("\n");
// Queue ownership now lives in useQueuedPrompt.
const queuedPromptHookSource = readFileSync(
  "src/renderer/src/hooks/useQueuedPrompt.ts",
  "utf8",
);
const composerControllerSource = readFileSync(
  "src/renderer/src/hooks/useSessionComposerController.ts",
  "utf8",
);
const sessionSendSource = readFileSync(
  "src/renderer/src/hooks/useSessionSend.ts",
  "utf8",
);
const sessionRuntimeBridgeSource = readFileSync(
  "src/renderer/src/hooks/useSessionRuntimeBridge.ts",
  "utf8",
);
const sessionRuntimeControllerSource = readFileSync(
  "src/renderer/src/hooks/useSessionRuntimeController.ts",
  "utf8",
);

function componentInvocation(source, componentName) {
  const start = source.indexOf(`<${componentName}`);
  const end = source.indexOf("/>", start);
  assert.notEqual(start, -1, `${componentName} invocation must exist`);
  assert.notEqual(end, -1, `${componentName} invocation must be self-closing`);
  return source.slice(start, end + 2);
}

test("pending prompts render inside the composer before composer-box", () => {
  const composerAreaIndex = sessionViewSource.indexOf("<ComposerArea");
  const queuePanelIndex = sessionRuntimeInjectorSource.indexOf("<QueuedPromptPanel");
  assert.ok(composerAreaIndex >= 0, "ComposerArea should exist");
  assert.ok(
    queuePanelIndex >= 0,
    "QueuedPromptPanel should exist in SessionRuntimeInjector",
  );
  assert.match(composerPanelsSource, /className="queued-track flex min-w-0 w-full justify-end p-0 pb-2"/);
});

test("pending prompts share the native content width constraint without hiding composer", () => {
  // queued-track 与 composer 同在会话栏宿主的内容盒内，不再自己减 padding
  assert.match(composerPanelsSource, /queued-track flex min-w-0 w-full justify-end p-0 pb-2/);
  // Outer track is a full-width anchor; the compact panel sits on the right with proportional width.
  assert.match(composerPanelsSource, /justify-end p-0 pb-2/);
  assert.match(composerPanelsSource, /w-\[clamp\(13\.5rem,36%,22\.5rem\)\]/);
  assert.match(composerPanelsSource, /min-h-8 shrink-0 basis-8/);
  assert.match(composerPanelsSource, /truncate text-caption leading-\[18px\]/);
  assert.doesNotMatch(stylesSource, /\.queued-card \{/);
});

test("compact queue panel exposes retract-to-input and discard only", () => {
  const queuedPromptPanel = componentInvocation(sessionRuntimeInjectorSource, "QueuedPromptPanel");

  assert.match(queuedPromptPanel, /onRetract=\{services\.queueRetract\}/);
  assert.match(composerPanelsSource, /app\.retractToInput/);
  assert.match(composerPanelsSource, /app\.retractDiscard/);
  assert.match(sessionRuntimeInjectorSource, /onDiscard=\{services\.queueDiscard\}/);
  assert.match(composerPanelsSource, /queued-behavior-\$\{prompt\.behavior\}/);
  assert.match(composerPanelsSource, /max-h-\[102px\]/);
  assert.match(stylesSource, /\.queued-row\.queued-behavior-steer \{/);
  assert.match(stylesSource, /\.queued-row\.queued-behavior-followUp \{/);
  assert.match(queuedPromptHookSource, /QUEUED_PROMPT_LIMIT/);
  assert.match(i18nSource, /"app\.queuedFull"/);
  assert.doesNotMatch(composerPanelsSource, /app\.queuedRetry/);
  assert.doesNotMatch(composerPanelsSource, /app\.queuedAcknowledge/);
  assert.doesNotMatch(appSource, /retryQueuedPrompt/);
  assert.match(queueStateSource, /export const QUEUED_PROMPT_LIMIT = 10/);
});

test("busy composer keeps stop and queued-send controls separate", () => {
  const composerAreaSource = readFileSync("src/renderer/src/components/session/ComposerArea.tsx", "utf8");
  const sendControls = componentInvocation(composerAreaSource, "ComposerSendControls");

  assert.match(sendControls, /onSendFollowUp=\{composer\.delivery\.followUp\}/);
  assert.match(composerPanelsSource, /composer-bar-btn stop/);
  assert.match(composerPanelsSource, /send-behavior-toggle/);
  assert.match(composerPanelsSource, /send-behavior-primary/);
  assert.match(composerPanelsSource, /send-behavior-chevron/);
  // 发送 toggle 常显：无需输入内容也展示（busy 与否都能并行发送）
  assert.match(composerPanelsSource, /disabled=\{props\.isAgentStarting \|\| !props\.canSend\}/);
  // busy 时显示 stop 圆钮
  assert.match(composerPanelsSource, /\{props\.isAgentBusy \? \(/);
  // pure official：toggle/menu 样式由 ComposerSendControls Tailwind 承担
  assert.match(composerPanelsSource, /send-behavior-toggle inline-flex h-8[\s\S]*bg-primary/);
  assert.match(composerPanelsSource, /send-behavior-menu w-44/);
  assert.match(composerPanelsSource, /send-behavior-primary[\s\S]*onClick=\{props\.onSend\}/);
  // 非受控 DropdownMenu：开关由 Radix 管理，点击外部即时关闭（避免受控+延迟关闭卡住菜单）
  assert.match(composerPanelsSource, /<DropdownMenu>\s*<DropdownMenuTrigger asChild>/);
  assert.match(composerAreaSource, /onSend=\{composer\.delivery\.send\}/);
  // 当前回合/下一轮仅在会话进行中显示（隐藏而非置灰）；并行发送始终可用
  assert.match(composerPanelsSource, /props\.isAgentBusy && \(\s*<DropdownMenuItem[\s\S]*send-behavior-option steer/);
  assert.match(composerPanelsSource, /props\.isAgentBusy && \(\s*<DropdownMenuItem[\s\S]*send-behavior-option follow-up/);
  assert.doesNotMatch(composerPanelsSource, /<span>\{t\("app\.sendSteerDesc"\)\}<\/span>/);
  assert.match(composerPanelsSource, /send-behavior-option-dot size-1\.5/);
});

test("composer keeps native typing inside the Session feature root", () => {
  assert.match(composerControllerSource, /const liveDomDraftRef = useRef\(\{ sessionId, value: draft \}\)/);
  assert.match(composerControllerSource, /liveDomDraftRef\.current = \{ sessionId, value \}/);
  assert.match(composerControllerSource, /setDraft\(value\)/);
  assert.match(composerControllerSource, /canApplyRuntimeEditorText/);
  assert.doesNotMatch(appSource, /currentSessionDraftAtom/);
  assert.doesNotMatch(appSource, /setPromptForAgent\(currentSessionId, editorText\.text\)/);
  assert.match(queuedPromptHookSource, /queuedPrompt\.behavior === "direct" \? undefined : queuedPrompt\.behavior/);
  assert.match(queuedPromptHookSource, /const currentDraft = store\.get\(sessionDraftByIdAtom\)\[sessionId\] \?\? ""/);
  assert.doesNotMatch(queuedPromptHookSource, /promptByAgent/);
  assert.match(appSource, /livePromptByAgentRef\.current = migrateAgentRecord/);
  // 行为菜单非常显受控（Radix 内部状态），菜单项在会话进行中条件渲染
  assert.doesNotMatch(composerPanelsSource, /open=\{\s*props\.sendBehaviorMenuOpen\}/);
  assert.doesNotMatch(composerPanelsSource, /props\.hasComposerContent && \(\s*<DropdownMenu/);
  assert.match(composerPanelsSource, /<DropdownMenuItem[\s\S]*send-behavior-option steer/);
  assert.match(composerPanelsSource, /<DropdownMenuItem[\s\S]*send-behavior-option follow-up/);
});

test("queue drain is serialized and waits for an ordered canonical Session capability event", () => {
  assert.match(appSource, /queueFlushBySessionRef = useRef<Set<string>>/);
  assert.match(
    sessionRuntimeControllerSource,
    /queueFlushBySessionRef\.current\.has\(currentSessionId\)/,
  );
  assert.match(
    sessionRuntimeControllerSource,
    /activeQueuedPrompts\.some\(/,
  );
  assert.doesNotMatch(
    sessionRuntimeControllerSource,
    /queuedPrompts\[activeAgentId\]/,
  );
  assert.doesNotMatch(globalListenersSource, /sessions\.onRuntimeEvent\(/);
  assert.match(sessionRuntimeBridgeSource, /sessions\.onRuntimeEvent\(/);
  assert.match(sessionRuntimeBridgeSource, /event\.sourceChannel !== "agents:runtime-state"/);
  assert.match(
    appSource,
    /previous\?\.isExecutingTool\s*&&\s*!current\.isExecutingTool[\s\S]*?queue\.flushQueuedSteerPrompts\(sessionId\)/,
  );
  assert.match(runtimeStateSource, /incoming\.toolStateSequence < current\.toolStateSequence/);
  assert.match(agentManagerSource, /updateActiveToolCalls/);
  assert.match(toolRuntimeStateSource, /calls\.delete\(event\.toolCallId\)/);
  assert.match(toolRuntimeStateSource, /completedBatch: event\.type === "end" && current\.size > 0 && calls\.size === 0/);
  assert.match(queuedPromptHookSource, /claimIdleHead\(queuedPromptsRef\.current, sessionId\)/);
  assert.match(queuedPromptHookSource, /claimNextSteerPrompt\(queuedPromptsRef\.current, sessionId\)/);
  assert.match(queuedPromptHookSource, /resolveClaimedPrompt/);
  assert.doesNotMatch(appSource, /queuedPrompt\.status === "sending"\s*\? \{ \.\.\.queuedPrompt, status: "pending"/);
  assert.doesNotMatch(queueStateSource, /migrateQueuedPrompts|replacementById/);
});

test("retract edit restores text, attachments, and composer mode to the owning Session", () => {
  assert.match(queuedPromptHookSource, /livePrompt\.displayText/);
  assert.match(queuedPromptHookSource, /store\.set\(setSessionAttachmentsAtom, \{/);
  assert.match(queuedPromptHookSource, /store\.set\(setSessionComposerModeAtom, \{ sessionId, mode: livePrompt\.agentMode \}\)/);
  assert.doesNotMatch(queuedPromptHookSource, /setComposerAgentModeForAgent/);
  assert.match(queuedPromptHookSource, /pendingComposerCaretRef\.current = restoredPrompt\.length/);
  assert.match(queuedPromptHookSource, /setComposerCursor\(restoredPrompt\.length\)/);
  assert.match(queuedPromptHookSource, /editor\.scrollTop = editor\.scrollHeight/);
  assert.match(queuedPromptHookSource, /livePrompt\.status === "sending"/);
});

test("retract edit uses action-oriented copy", () => {
  setI18nLocale("zh-CN");
  assert.equal(t("app.retractToInput"), "撤回修改");
  setI18nLocale("en-US");
  assert.equal(t("app.retractToInput"), "Retract to edit");
});

test("queued image count uses the standard i18n interpolation syntax", () => {
  setI18nLocale("zh-CN");
  assert.equal(t("app.queuedImageCount", { count: 3 }), "3 图");
  setI18nLocale("en-US");
  assert.equal(t("app.queuedImageCount", { count: 3 }), "3 img");
});

test("runtime state merge rejects stale tool edges without losing non-tool fields", () => {
  const current = {
    modelId: "new-model",
    isExecutingTool: false,
    toolStateSequence: 4,
  };
  const merged = mergeAgentRuntimeState(current, {
    modelName: "Updated name",
    isExecutingTool: true,
    executingToolName: "read",
    toolStateSequence: 3,
  });

  assert.equal(merged.modelName, "Updated name");
  assert.equal(merged.modelId, "new-model");
  assert.equal(merged.isExecutingTool, false);
  assert.equal(merged.executingToolName, undefined);
  assert.equal(merged.toolStateSequence, 4);
});

test("indeterminate prompt timeout never becomes a retryable rejection", () => {
  assert.match(
    sharedTypesSource,
    /delivery: "unknown"/,
  );
  assert.match(
    agentManagerSource,
    /catch \(error\)[\s\S]*?delivery: "unknown"/,
  );
  assert.match(
    agentManagerSource,
    /命令接收结果未知[\s\S]*?delivery: "unknown"/,
  );
  assert.match(queuedPromptHookSource, /status: "unknown"/);
  assert.match(sessionSendSource, /status: "unknown"/);
  assert.match(composerPanelsSource, /SessionDeliveryNotice/);
  const runtimeControllerSource = readFileSync(
    "src/renderer/src/hooks/useSessionRuntimeController.ts",
    "utf8",
  );
  assert.match(runtimeControllerSource, /\.status === "unknown"/);
});

test("prompt acceptance is explicit across the main and renderer boundary", () => {
  assert.match(agentManagerSource, /Promise<SendPromptResult>/);
  assert.match(
    agentManagerSource,
    /accepted: false,[\s\S]{0,160}?error: errorMessage,[\s\S]{0,160}?i18nKey: "diagnostic\./,
  );
  assert.match(webServiceSource, /this\.sendJson\(response, \{ result \}\)/);
  assert.doesNotMatch(webServiceSource, /sendError\(response, 409, result\.error\)/);
  assert.match(agentManagerSource, /if \(cancelled\)[\s\S]*?命令已取消[\s\S]*?return \{ accepted: true \}/);
  assert.match(
    appSource,
    /if \(!result\.accepted\)[\s\S]*?translateI18nDescriptor\(result, result\.error\)[\s\S]*?PromptDeliveryUnknownError\(localizedError\)[\s\S]*?throw new Error\(localizedError\)/,
  );
});
