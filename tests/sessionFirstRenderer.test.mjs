import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync("src/renderer/src/App.tsx", "utf8");
const messageCommandsSource = readFileSync(
  "src/renderer/src/hooks/useSessionMessageCommands.ts",
  "utf8",
);
const sessionViewSource = readFileSync(
  "src/renderer/src/components/session/SessionView.tsx",
  "utf8",
);
const sessionActionsSource = readFileSync(
  "src/renderer/src/hooks/useSessionActions.ts",
  "utf8",
);
const sessionSendSource = readFileSync(
  "src/renderer/src/hooks/useSessionSend.ts",
  "utf8",
);
const composerSource = readFileSync(
  "src/renderer/src/components/session/ComposerArea.tsx",
  "utf8",
);
const drawerSurfaceSource = readFileSync(
  "src/renderer/src/components/workspace/DrawerSurface.tsx",
  "utf8",
);
const outlineAtomsSource = readFileSync(
  "src/renderer/src/atoms/session-outline-atoms.ts",
  "utf8",
);

function functionBody(name, source = appSource) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${name} should exist`);
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(bodyStart + 1, index);
    }
  }
  throw new Error(`Could not parse ${name}`);
}

test("opening a sidebar history selects a SessionRecord without creating an Agent", () => {
  const body = functionBody("openSidebarSession", sessionActionsSource);
  assert.match(body, /await refreshProjectSessions\(projectId, true\)/);
  assert.match(body, /commitSessionSelection\(projectId, record\.id, true\)/);
  assert.doesNotMatch(body, /listCatalog|bindSessionRuntime|createAgent\(/);
});

test("the history drawer uses the lazy Session open path", () => {
  assert.match(
    drawerSurfaceSource,
    /onOpenSession=\{/,
  );
});

test("App routes project and Session selection through the command owner", () => {
  assert.match(appSource, /selectProject: selectProjectCommand/);
  assert.match(appSource, /selectSession: selectSessionCommand/);
  assert.match(appSource, /selectSessionCommand\(session\.projectId, session\.id, false\)/);
  assert.match(appSource, /selectSessionCommand\(projectId, targetSessionId, true\)/);
  assert.match(appSource, /sessionRecordByIdAtomFamily\(target\.sessionId\)/);
  assert.match(
    appSource,
    /select: \(projectId\) => \{\s*selectProjectCommand\(projectId\);[\s\S]*?const loadState = store\.get\(sessionCatalogLoadStateAtom\)\[projectId\];[\s\S]*?loadState\?\.status !== "loading" && loadState\?\.status !== "ready"/,
  );
  assert.doesNotMatch(appSource, /setCurrentSessionId\(/);
});

test("first Session send is request-addressed and restores rejected snapshots", () => {
  assert.match(sessionSendSource, /requestId = crypto\.randomUUID\(\)/);
  assert.match(sessionSendSource, /options\.sendPrompt\(\{/);
  assert.match(
    sessionSendSource,
    /sendingSessionIdsRef\.current\.add\(sourceSessionId\)/,
  );
  assert.match(sessionSendSource, /result\.delivery === "unknown"/);
  assert.match(sessionSendSource, /\[message, current\]/);
  assert.match(sessionSendSource, /\.\.\.imageSnapshot, \.\.\.current/);
});

test("the dev workspace toolbar persists for inactive agents and the empty state", () => {
  // outline 悬浮条常驻：不再被 hasActiveConversation 条件挡住，引导页也有入口
  assert.doesNotMatch(appSource, /outlineContent=\{hasActiveConversation/);
  assert.match(appSource, /outlineContent=\{\s*\/\*/);
  // 悬浮栏的终端入口绑定可用目标（agent 或项目），未激活 agent / 引导页同样可用
  assert.match(appSource, /terminalAction=\{!isLanWeb && terminalTarget \? \{/);
  // 悬浮栏不再暴露 files/git（入口收进抽屉活动栏，files 由标题栏抽屉开关打开）
  assert.match(appSource, /filesAction=\{undefined\}/);
  assert.match(appSource, /gitAction=\{undefined\}/);
});


test("typing in the current Composer prewarms its runtime once", () => {
  assert.match(composerSource, /desktopApi\.sessions\.activateRuntime\(props\.sessionId\)/);
  assert.match(composerSource, /prewarmStartedForSessionRef/);
  assert.match(composerSource, /composer\.draft\.trim\(\)/);
  assert.match(composerSource, /composer\.attachments\.length === 0/);
});


test("forking a user message opens the new session as a permanent tab", () => {
  const body = functionBody("forkFromUserMessage", messageCommandsSource);
  // fork 做于 Tab 栏之前：只刷新列表不切焦点/不登记，新会话会出现但点 Tab 对不上 runtime。
  assert.match(body, /openReplacedRuntimeSession\(/);
  assert.match(body, /result\.targetSessionId \?\? input\.currentSessionIdRef/);
  assert.match(functionBody("openReplacedRuntimeSession"), /registerOpenSession\(targetSessionId, "permanent"\)/);
  assert.match(functionBody("openReplacedRuntimeSession"), /selectSessionCommand\(projectId, targetSessionId, true\)/);
  assert.match(functionBody("cloneAgentSession"), /openReplacedRuntimeSession\(/);
});

test("active Agent identity is derived from the selected Session runtime", () => {
  assert.match(
    appSource,
    /const activeAgentId = useAtomValue\(activeAgentIdAtom\)/,
  );
  assert.doesNotMatch(appSource, /setActiveAgentId/);
  assert.doesNotMatch(
    appSource,
    /useState<[^>]*>\([^)]*\).*activeAgentId/,
  );
});

test("Session messages and composer render without an active Agent", () => {
  // 会话渲染由 currentSessionId 驱动（App 不再持有 hasActiveConversation 变量，
  // 该语义下沉到 SessionView 的 prop），无 active agent 时 composer 仍渲染；
  // 有活动会话时底部 composer 始终渲染；空会话起始页只提供快捷 prompt。
  assert.match(
    sessionViewSource,
    /\{hasActiveConversation && \([\s\S]*<ComposerArea[\s\S]*sessionId=\{sessionId\}/,
  );
  assert.match(composerSource, /useSessionComposerController\(/);
  assert.match(composerSource, /sessionId=\{props\.sessionId\}/);
  // 消息来自当前会话 atom / 栏内 timeline，不再依赖 activeAgent 兜底；
  // 大纲/文件清单消费链（session-outline-atoms）仍以 currentSessionMessagesAtom 为源
  assert.match(outlineAtomsSource, /currentSessionMessagesAtom/);
  assert.doesNotMatch(appSource, /currentSession \|\| activeAgent/);
});
