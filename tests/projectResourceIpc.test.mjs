import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { createFakeRouter, runBackendRpcWiring } from "./helpers/l3_ipcHarness.mjs";

const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");
const { registerProjectResourceIpc } = loadTsCommonJs("src/main/ipc/projectResourceIpc.ts");
const { registerProjectsIpc } = loadTsCommonJs("src/main/ipc/projectsIpc.ts");

const resourceChannels = Object.entries(ipcChannels)
  .filter(([key]) => key.startsWith("projectResources"))
  .map(([, channel]) => channel);

function createManager(calls, overrides = {}) {
  return new Proxy(overrides, {
    get: (target, method) => target[method] ?? ((...args) => {
      calls.push([String(method), ...args]);
      return { name: "result" };
    }),
  });
}

function setup(managerOverrides) {
  const calls = [];
  const logs = [];
  const router = createFakeRouter();
  registerProjectResourceIpc(router, {
    appLogger: { info: (...args) => { logs.push(args); } },
    projectResourceManager: createManager(calls, managerOverrides),
  });
  return { router, calls, logs };
}

test("backend wiring passes the shared resource manager into the projects IPC domain", () => {
  const { captured, services } = runBackendRpcWiring();
  assert.equal(captured.get("projects").deps.projectResourceManager, services.projectResourceManager);
});

test("registerProjectsIpc registers every project-resource channel exactly once", () => {
  const router = createFakeRouter();
  const inert = new Proxy({}, { get: () => () => undefined });
  registerProjectsIpc(router, {
    projectStore: inert,
    settingsStore: inert,
    gitService: inert,
    worktreeService: inert,
    agentManager: inert,
    appLogger: { info() {} },
    projectResourceManager: { list: async (id) => ["listed", id] },
    mainCopy: (key) => key,
    dialogs: inert,
    sendToRenderer: () => {},
  });
  assert.equal(resourceChannels.length, 7);
  for (const channel of resourceChannels) {
    // 恰好一次：projectsIpc 自己不能再重复注册，否则后注册者静默覆盖前者
    assert.equal(router.registrations.get(channel), 1, channel);
  }
});

test("project resource IPC retains one handler per project-resource channel", () => {
  const { router } = setup();
  assert.deepEqual([...router.handlers.keys()].sort(), [...resourceChannels].sort());
});

test("resource handlers forward renderer arguments to the manager untouched", async () => {
  const { router, calls } = setup();
  const input = { projectId: "p1", name: "skill-a" };
  await router.invoke(ipcChannels.projectResourcesList, "p1");
  await router.invoke(ipcChannels.projectResourcesCreateSkill, input);
  await router.invoke(ipcChannels.projectResourcesDeleteSkill, "p1", "/p/.pi/skills/a");
  await router.invoke(ipcChannels.projectResourcesDeleteExtension, "p1", "/p/.pi/extensions/e");
  await router.invoke(ipcChannels.projectResourcesToggleSkill, "p1", "/p/.pi/skills/a", false);
  await router.invoke(ipcChannels.projectResourcesToggleExtension, "p1", "/p/.pi/extensions/e", true);
  await router.invoke(ipcChannels.projectResourcesRenameSkill, "p1", "/p/.pi/skills/a", "b");
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ["list", "p1"],
    ["createSkill", input],
    ["deleteSkill", "p1", "/p/.pi/skills/a"],
    ["deleteExtension", "p1", "/p/.pi/extensions/e"],
    ["toggleSkill", "p1", "/p/.pi/skills/a", false],
    ["toggleExtension", "p1", "/p/.pi/extensions/e", true],
    ["renameSkill", "p1", "/p/.pi/skills/a", "b"],
  ]);
});

test("a manager path-ownership rejection propagates and is not logged as a deletion", async () => {
  // 路径归属由 ProjectResourceManager 校验；IPC 层不得吞掉拒绝，也不得谎报“已删除”。
  const refusal = new Error("Path is outside the project's skill directory");
  const { router, logs } = setup({
    deleteSkill: async () => { throw refusal; },
    deleteExtension: async () => { throw refusal; },
  });
  await assert.rejects(router.invoke(ipcChannels.projectResourcesDeleteSkill, "p1", "/etc/passwd"), /outside the project/);
  await assert.rejects(router.invoke(ipcChannels.projectResourcesDeleteExtension, "p1", "/etc/passwd"), /outside the project/);
  assert.deepEqual(logs, []);
});

test("successful deletion is audited with the project and path", async () => {
  const { router, logs } = setup();
  await router.invoke(ipcChannels.projectResourcesDeleteSkill, "p1", "/p/.pi/skills/a");
  assert.equal(logs.length, 1);
  assert.equal(logs[0][0], "project-resource");
  assert.match(logs[0][1], /deleted/);
  assert.equal(logs[0][2].skillPath, "/p/.pi/skills/a");
});

test("project resource IPC does not import the native-node entry", () => {
  // 静态分层规则：领域 IPC 模块不得反向依赖入口，文本匹配是此类规则的合适手段。
  assert.doesNotMatch(readFileSync("src/main/ipc/projectResourceIpc.ts", "utf8"), /from\s+["']\.\.\/index["']/);
  assert.doesNotMatch(readFileSync("src/main/ipc/projectsIpc.ts", "utf8"), /ipcChannels\.projectResources/);
});
