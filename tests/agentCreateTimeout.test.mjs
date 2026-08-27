import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync("src/renderer/src/hooks/useSessionActions.ts", "utf8");
const app = readFileSync("src/renderer/src/App.tsx", "utf8");
const agentManager = readFileSync("src/main/pi/AgentManager.ts", "utf8");
const coordinator = readFileSync("src/main/sessions/SessionRuntimeCoordinator.ts", "utf8");

test("new conversation creates a metadata-only Session draft", () => {
  const createDraftSource = source.match(
    /async function createSessionDraft\([\s\S]*?\n  \}\n\n  return \{/,
  )?.[0] ?? "";
  assert.match(createDraftSource, /api\.sessions\.createDraft\(\{/);
  assert.match(
    createDraftSource,
    /commitSessionSelection\(projectId, session\.id, true\)/,
  );
  assert.doesNotMatch(createDraftSource, /setActiveAgentId/);
  assert.doesNotMatch(createDraftSource, /api\.agents\.create/);
});

test("same-session creation waits for the in-flight Promise before reusing a runtime", () => {
  const createBlock = agentManager.match(
    /async create\(rawInput:[\s\S]*?\n\t\treturn createPromise;\n\t\}/,
  )?.[0] ?? "";
  assert.match(createBlock, /const pendingCreate = this\.creatingSessionAgents\.get\(sessionKey\);/);
  assert.match(createBlock, /if \(pendingCreate\) return pendingCreate;/);
  assert.ok(
    createBlock.indexOf("pendingCreate") < createBlock.indexOf("findRuntimeBySessionKey"),
    "in-flight creation must be checked before the starting runtime map",
  );
});

test("startup timeout cleanup and terminal runtime recreation are present", () => {
  assert.match(coordinator, /if \(mappedTab && isTerminalAgent\(mappedTab\)/);
  assert.match(coordinator, /await this\.agents\.stop\(mappedTab\.id\)\.catch\(\(\) => undefined\);/);
  assert.match(coordinator, /if \(tab\.status === "starting" \|\| isTerminalAgent\(tab\)\)/);
  assert.match(coordinator, /await this\.agents\.stop\(initialTab\.id\)\.catch\(\(\) => undefined\);/);
  assert.match(coordinator, /this\.unbindAgentUnchecked\(initialTab\.id\);/);
});

test("renderer has no direct Agent creation path", () => {
  const injector = readFileSync("src/renderer/src/components/session/SessionRuntimeInjector.tsx", "utf8");
  assert.doesNotMatch(app, /async function createAgent\(/);
  assert.doesNotMatch(app, /api\.agents\.create\(/);
  // 新建会话统一走 SessionView 的 createDraft 链路（原 onHeaderTrigger fallback 已随
  // 会话操作 combo 移除，draft 入口改经 services 注入直传 SessionView）
  assert.match(injector, /runCreateSessionDraft=\{services\.runCreateSessionDraft\}/);
});
