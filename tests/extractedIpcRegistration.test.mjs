import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { createFakeRouter, runBackendRpcWiring } from "./helpers/l3_ipcHarness.mjs";

const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");

test("backend wiring registers the scratch-pad IPC domain on the shared router", () => {
  const { captured, router } = runBackendRpcWiring();
  const scratch = captured.get("scratchPad");
  assert.ok(scratch, "registerScratchPadIpc must be called by registerBackendRpc");
  assert.equal(scratch.router, router);
  assert.equal(scratch.deps.appLogger.__name, "appLogger");
  assert.equal(scratch.deps.userDataDir, "/data");
});

test("backend wiring hands the session IPC domain its services unchanged", () => {
  const { captured, services, router } = runBackendRpcWiring();
  const session = captured.get("session");
  assert.ok(session, "registerSessionIpc must be called by registerBackendRpc");
  assert.equal(session.router, router);
  for (const name of [
    "projectStore",
    "settingsStore",
    "sessionScanner",
    "sessionCatalog",
    "sessionRuntimeCoordinator",
    "agentManager",
    "configManager",
    "terminalManager",
  ]) {
    assert.equal(session.deps[name], services[name], `session IPC must receive the shared ${name}`);
  }
  // replaceAgentSession 来自 runtimeBridge，而不是装配层自己重造
  assert.equal(session.deps.replaceAgentSession, "bridge:replaceAgentSession");
});

test("catalog session loading is served by the registered session IPC handler", async () => {
  const { registerSessionIpc } = loadTsCommonJs("src/main/ipc/sessionIpc.ts");
  const router = createFakeRouter();
  const scanned = [{ id: "s-file", path: "/work/p1/a.jsonl" }];
  const merged = [{ id: "stable-1", projectId: "p1" }];
  const calls = [];
  registerSessionIpc(router, {
    projectStore: { get: (id) => (id === "p1" ? { id, path: "/work/p1" } : undefined) },
    settingsStore: { get: () => ({ wslEnabled: false }) },
    sessionScanner: { list: async (path) => { calls.push(["scan", path]); return scanned; } },
    sessionCatalog: {
      mergeScanned: async (projectId, summaries, options) => {
        calls.push(["merge", projectId, summaries, options]);
        return merged;
      },
      listProjectRecords: () => [],
    },
    sessionRuntimeCoordinator: { attachCatalogRuntimes: () => [] },
    agentManager: { list: () => [] },
    appLogger: { info() {}, warn() {}, error() {} },
    mainCopy: (key) => key,
    emitSessionRuntimeEvent: () => {},
  });

  const result = await router.invoke(ipcChannels.sessionsCatalogList, "p1");

  assert.deepEqual(result, merged);
  // 经 JSON 往返抹平 vm 沙箱内对象的跨 realm 原型差异
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [["scan", "/work/p1"], ["merge", "p1", scanned, {}]]);
});

test("system IPC registers no pi update channels", () => {
  // 回归：0.2.1 移除内置更新系统后，systemIpc 不再注册 pi:update-check / pi:update。
  const { registerSystemIpc } = loadTsCommonJs("src/main/ipc/systemIpc.ts");
  const router = createFakeRouter();
  const inertDep = () => undefined;
  // 宽松假依赖：注册阶段只应读取依赖，不应调用它们
  registerSystemIpc(router, new Proxy({}, { get: () => inertDep }));
  const channels = [...router.handlers.keys()];
  assert.ok(channels.length > 10, "system IPC should register its handlers");
  assert.deepEqual(channels.filter((channel) => /^pi:update/.test(channel)), []);
  assert.equal(Object.keys(ipcChannels).filter((key) => /^piUpdate/.test(key)).length, 0);
});

test("backend wiring does not give system IPC the extension manager", () => {
  // registerSystemIpc 不再吃 extensionManager（扩展 CRUD 归 storeIpc）
  const { captured, services } = runBackendRpcWiring();
  assert.ok(!("extensionManager" in captured.get("system").deps));
  assert.equal(captured.get("store").deps.extensionManager, services.extensionManager);
});

test("extracted IPC modules do not import the native-node entry", () => {
  // 静态分层规则：领域 IPC 模块不得反向依赖入口，文本匹配是此类规则的合适手段。
  for (const file of ["sessionIpc", "scratchPadIpc", "systemIpc"]) {
    const source = readFileSync(`src/main/ipc/${file}.ts`, "utf8");
    assert.doesNotMatch(source, /from\s+["']\.\.\/index["']/, file);
  }
});
