import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

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

test("system IPC no longer carries the pi update channels", () => {
  // 回归：0.2.1 移除内置更新系统后，systemIpc 不再注册 pi:update-check / pi:update，
  // 也不再依赖 extensionManager（那是给更新用的）。
  // 守门：后人若想把更新塞回 systemIpc，应先看这条断言。
  assert.doesNotMatch(systemIpc, /ipcChannels\.piUpdateCheck/);
  assert.doesNotMatch(systemIpc, /ipcChannels\.piUpdate\b/);
  assert.doesNotMatch(systemIpc, /checkForAppUpdate/);
  assert.doesNotMatch(systemIpc, /downloadUpdateAsset/);
  // registerSystemIpc 不再吃 extensionManager（它改由 storeIpc 拥有扩展 CRUD）
  // 从 registerSystemIpc(router, {...}) 块内抽取文本，断言块内没有裸 extensionManager, 简写
  const systemIpcBlock = registerBackendRpc.slice(
    registerBackendRpc.indexOf("registerSystemIpc(router, {"),
    registerBackendRpc.indexOf("registerStoreIpc(router, {"),
  );
  assert.ok(systemIpcBlock.length > 0, "registerSystemIpc block must exist");
  assert.doesNotMatch(
    systemIpcBlock,
    /\n\t\textensionManager,\n/,
    "extensionManager must not be a direct dep of registerSystemIpc",
  );
  assert.doesNotMatch(systemIpc, /from\s+["']\.\.\/index["']/);
});
