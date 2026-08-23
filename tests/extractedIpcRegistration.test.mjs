import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const entry = readFileSync("src/main/index.ts", "utf8");
const registerBackendRpc = readFileSync("src/main/backend/registerBackendRpc.ts", "utf8");
const sessionIpc = readFileSync("src/main/ipc/sessionIpc.ts", "utf8");
const scratchPadIpc = readFileSync("src/main/ipc/scratchPadIpc.ts", "utf8");

test("extracted session and scratch-pad IPC modules remain registered by the backend", () => {
  assert.match(registerBackendRpc, /registerScratchPadIpc\(router,\s*\{/);
  assert.match(
    registerBackendRpc,
    /registerSessionIpc\(router,\s*\{[\s\S]*projectStore,[\s\S]*settingsStore,[\s\S]*sessionScanner,[\s\S]*sessionCatalog,[\s\S]*sessionRuntimeCoordinator,[\s\S]*agentManager,[\s\S]*configManager,[\s\S]*terminalManager,[\s\S]*replaceAgentSession,[\s\S]*\}\)/,
  );
  assert.doesNotMatch(sessionIpc, /from\s+["']\.\.\/index["']/);
  assert.doesNotMatch(scratchPadIpc, /from\s+["']\.\.\/index["']/);
});

test("catalog session loading remains owned by the registered session IPC module", () => {
  assert.match(sessionIpc, /ipcChannels\.sessionsCatalogList/);
  assert.match(sessionIpc, /sessionCatalog\.mergeScanned/);
});

const systemIpc = readFileSync("src/main/ipc/systemIpc.ts", "utf8");

test("system IPC still registers pi update channels when extensionManager is provided", () => {
  // 回归：Phase 3.7 拆分后若漏传 extensionManager，pi:update-check 会静默不注册。
  assert.match(systemIpc, /ipcChannels\.piUpdateCheck/);
  assert.match(systemIpc, /if \(extensionManager\)/);
  assert.match(
    registerBackendRpc,
    /registerSystemIpc\(router,\s*\{[\s\S]*extensionManager,[\s\S]*testPiProxy,[\s\S]*RELEASES_URL,[\s\S]*\}\)/,
  );
  assert.doesNotMatch(systemIpc, /from\s+["']\.\.\/index["']/);
});
