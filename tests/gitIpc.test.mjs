import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { createFakeRouter, runBackendRpcWiring } from "./helpers/l3_ipcHarness.mjs";

const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");
const { registerGitIpc } = loadTsCommonJs("src/main/ipc/gitIpc.ts");

// runBackendRpcWiring 里 projectStore.list() 返回的项目根
const PROJECT_ROOT_FROM_HARNESS = "/work/p1";
const PROJECT = { id: "p1", path: join(tmpdir(), "pideck-l3-project") };

/** 记录所有方法调用的假服务：每个方法都返回 `result`。 */
function recordingService(calls, result = "service-result") {
  return new Proxy({}, {
    get: (_target, method) => (...args) => {
      calls.push([String(method), ...args]);
      return result;
    },
  });
}

function setup({ maxEditorFileSizeMB = 5, worktreeService, projectStore, gitService } = {}) {
  const calls = [];
  const logs = [];
  const router = createFakeRouter();
  const appLogger = Object.fromEntries(
    ["info", "warn", "error"].map((level) => [level, (...args) => { logs.push([level, ...args]); }]),
  );
  const deps = {
    appLogger,
    mainCopy: (key) => key,
    getLocale: () => "en-US",
    gitService: gitService ?? recordingService(calls),
    piLocator: {},
    projectStore: projectStore ?? { get: (id) => (id === PROJECT.id ? PROJECT : undefined) },
    settingsStore: { get: () => ({ maxEditorFileSizeMB }) },
    worktreeService: worktreeService ?? recordingService(calls, []),
    getAuthorizedRoots: () => [PROJECT.path],
  };
  const dispose = registerGitIpc(router, deps);
  return { router, calls, logs, dispose };
}

test("backend wiring gives Git IPC the shared services and returns its disposer", () => {
  let disposed = 0;
  const { captured, services, router, dispose } = runBackendRpcWiring({ disposeGit: () => { disposed += 1; } });
  const git = captured.get("git");
  assert.ok(git, "registerGitIpc must be called by registerBackendRpc");
  assert.equal(git.router, router);
  for (const name of ["appLogger", "gitService", "piLocator", "projectStore", "settingsStore", "worktreeService"]) {
    assert.equal(git.deps[name], services[name], `Git IPC must receive the shared ${name}`);
  }
  // Git HEAD 读取与普通文件读取共用授权根：项目、提示词、技能、pi agent 目录、应用数据
  assert.deepEqual(
    [...git.deps.getAuthorizedRoots()],
    [PROJECT_ROOT_FROM_HARNESS, "/prompts", "/skills", join("/home/u", ".pi", "agent"), "/data"],
  );
  assert.equal(disposed, 0);
  dispose();
  assert.equal(disposed, 1, "backend disposer must release the Git IPC quick generator");
});

test("Git IPC disposer releases the quick generator it created", () => {
  const events = [];
  const { registerGitIpc: register } = loadTsCommonJs("src/main/ipc/gitIpc.ts", {
    stubs: {
      "../git/QuickGenerator": {
        createQuickGenerator: () => {
          events.push("created");
          return { generate: async () => "", dispose: () => events.push("disposed") };
        },
      },
    },
  });
  const dispose = register(createFakeRouter(), {
    appLogger: { info() {}, warn() {}, error() {} },
    mainCopy: (key) => key,
    getLocale: () => "en-US",
    gitService: {},
    piLocator: {},
    projectStore: {},
    settingsStore: { get: () => ({}) },
    worktreeService: {},
    getAuthorizedRoots: () => [],
  });
  assert.deepEqual(events, ["created"]);
  dispose();
  assert.deepEqual(events, ["created", "disposed"]);
});

test("native-node entry does not register Git channels itself", () => {
  // “已迁出”的静态约束：入口文件不得再直接 handle git 通道，文本匹配是合适手段。
  const entry = readFileSync("src/native-node/index.ts", "utf8");
  // 入口用 router.handle(...) 注册（native-node 没有 ipcMain）；任何直接 handle git 通道的写法都算违规。
  assert.doesNotMatch(entry, /\.handle(?:<[^>]*>)?\(\s*ipcChannels\.git/);
  assert.match(entry, /router\.handle\(\s*ipcChannels\.nativeClipboardSnapshot/, "the pattern must be able to see this entry's real handler style");
  assert.doesNotMatch(readFileSync("src/main/ipc/gitIpc.ts", "utf8"), /from\s+["']\.\.\/index["']/);
});

const MAX_BYTES = 5 * 1024 * 1024;
// [通道, 渲染层参数, 期望触发的 gitService 调用]
const delegations = [
  ["gitBranches", [], ["getBranches", PROJECT.path]],
  ["gitCheckout", ["feature"], ["checkout", PROJECT.path, "feature"]],
  ["gitCreateBranch", ["topic"], ["createBranch", PROJECT.path, "topic"]],
  ["gitCommitLog", [{ maxEntries: 3 }], ["getCommitLog", PROJECT.path, { maxEntries: 3 }]],
  ["gitRefs", [], ["getRefs", PROJECT.path]],
  ["gitBranchCompare", ["main", "dev"], ["compareBranches", PROJECT.path, "main", "dev"]],
  ["gitCommitDetail", ["abc"], ["getCommitDetail", PROJECT.path, "abc"]],
  ["gitCommitFileDiff", ["abc", "a.ts", "b.ts"], ["getCommitFileDiff", PROJECT.path, "abc", "a.ts", "b.ts", MAX_BYTES]],
  ["gitDiffFileBetween", ["r1", "r2", "a.ts"], ["diffFileBetweenRefs", PROJECT.path, "r1", "r2", "a.ts"]],
  ["gitStatus", [], ["getStatus", PROJECT.path]],
  ["gitWorkspaceFileDiff", ["workingTree", "a.ts"], ["getWorkspaceFileDiff", PROJECT.path, "workingTree", "a.ts", MAX_BYTES]],
  ["gitStage", [["a.ts"]], ["stageFiles", PROJECT.path, ["a.ts"]]],
  ["gitUnstage", [["a.ts"]], ["unstageFiles", PROJECT.path, ["a.ts"]]],
  ["gitDiscard", ["untracked", "a.ts"], ["discardFile", PROJECT.path, "untracked", "a.ts"]],
  ["gitCommit", ["msg"], ["commit", PROJECT.path, "msg"]],
  ["gitCherryPick", ["abc"], ["cherryPick", PROJECT.path, "abc"]],
  ["gitRevert", ["abc"], ["revertCommit", PROJECT.path, "abc"]],
  ["gitPush", [], ["push", PROJECT.path]],
  ["gitPull", [], ["pull", PROJECT.path]],
  ["gitReset", ["abc", "hard"], ["resetToCommit", PROJECT.path, "abc", "hard"]],
  ["gitDropCommit", ["abc"], ["dropCommit", PROJECT.path, "abc"]],
  ["gitInit", [], ["init", PROJECT.path]],
  ["gitFetch", [], ["fetch", PROJECT.path]],
  ["gitAheadBehind", [], ["getAheadBehind", PROJECT.path]],
  ["gitDeleteFiles", [["a.ts"]], ["deleteFiles", PROJECT.path, ["a.ts"]]],
];

for (const [channel, args, expected] of delegations) {
  test(`${channel} resolves the project path and delegates to ${expected[0]}`, async () => {
    const { router, calls } = setup();
    await router.invoke(ipcChannels[channel], PROJECT.id, ...args);
    assert.equal(calls.length, 1);
    // 经 JSON 往返抹平 vm 沙箱内对象的跨 realm 原型差异
    assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), JSON.parse(JSON.stringify(expected)));
  });
}

test("project-scoped Git handlers fail on an unknown project instead of touching a repository", async () => {
  const throwing = [
    "gitBranches", "gitCheckout", "gitCreateBranch", "gitBranchCompare", "gitStage", "gitUnstage",
    "gitDiscard", "gitCommit", "gitCherryPick", "gitRevert", "gitPush", "gitPull", "gitReset",
    "gitDropCommit", "gitFetch", "gitAheadBehind", "gitWorktreeList", "gitWorktreeCreate",
  ];
  for (const channel of throwing) {
    const { router, calls } = setup();
    await assert.rejects(router.invoke(ipcChannels[channel], "missing", "x"), /Project not found: missing/, channel);
    assert.deepEqual(calls, [], `${channel} must not call a service for an unknown project`);
  }
});

test("read-only Git handlers return an empty result for an unknown project", async () => {
  const { router, calls } = setup();
  assert.deepEqual(JSON.parse(JSON.stringify(await router.invoke(ipcChannels.gitStatus, "missing"))), {
    merge: [], index: [], workingTree: [], untracked: [],
  });
  assert.equal(JSON.stringify(await router.invoke(ipcChannels.gitCommitLog, "missing")), "[]");
  assert.equal(await router.invoke(ipcChannels.gitCommitDetail, "missing", "abc"), null);
  assert.equal(await router.invoke(ipcChannels.gitCommitFileDiff, "missing", "abc", "a.ts"), null);
  assert.equal(await router.invoke(ipcChannels.gitDiffFileBetween, "missing", "a", "b", "f"), "");
  assert.deepEqual(calls, []);
});

test("diff size limit follows maxEditorFileSizeMB and never drops below 1 MB", async () => {
  const big = setup({ maxEditorFileSizeMB: 8 });
  await big.router.invoke(ipcChannels.gitCommitFileDiff, PROJECT.id, "abc", "a.ts");
  assert.equal(big.calls[0].at(-1), 8 * 1024 * 1024);

  const zero = setup({ maxEditorFileSizeMB: 0 });
  await zero.router.invoke(ipcChannels.gitWorkspaceFileDiff, PROJECT.id, "index", "a.ts");
  assert.equal(zero.calls[0].at(-1), 1024 * 1024);
});

test("original content reads are bounded by maxEditorFileSizeMB", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pideck-l3-git-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "tracked.txt");
  await writeFile(file, "x");
  const calls = [];
  const router = createFakeRouter();
  registerGitIpc(router, {
    appLogger: { info() {}, warn() {}, error() {} },
    mainCopy: (key) => key,
    getLocale: () => "en-US",
    gitService: { getOriginalContent: async (...args) => { calls.push(args); return "HEAD"; } },
    piLocator: {},
    projectStore: { get: () => undefined },
    settingsStore: { get: () => ({ maxEditorFileSizeMB: 3 }) },
    worktreeService: {},
    getAuthorizedRoots: () => [root],
  });
  assert.equal(await router.invoke(ipcChannels.gitOriginalContent, file), "HEAD");
  assert.equal(calls[0][1], 3 * 1024 * 1024);
});

function worktreeSetup({ removeResult = true, listAfter = [], removeError } = {}) {
  const removed = [];
  const child = { id: "child-1", path: "/wt/feature" };
  const result = setup({
    worktreeService: {
      remove: async () => {
        if (removeError) throw removeError;
        return removeResult;
      },
      list: async () => listAfter,
    },
    projectStore: {
      get: (id) => (id === PROJECT.id ? PROJECT : undefined),
      findByPath: (path) => (path === child.path ? child : undefined),
      remove: async (id) => { removed.push(id); },
    },
  });
  return { ...result, removed, child };
}

test("worktree removal drops the PiDeck project record once git no longer lists it", async () => {
  const { router, removed, child } = worktreeSetup({ removeResult: true, listAfter: [] });
  assert.equal(await router.invoke(ipcChannels.gitWorktreeRemove, PROJECT.id, child.path), true);
  assert.deepEqual(removed, [child.id]);
});

test("stale worktree cleanup: git already forgot it, so the project record is still removed", async () => {
  // remove 返回 false（用户在外部删过目录），但 git 里已无该 worktree：必须清掉记录，否则重启后“删不掉”
  const { router, removed, child } = worktreeSetup({ removeResult: false, listAfter: [] });
  assert.equal(await router.invoke(ipcChannels.gitWorktreeRemove, PROJECT.id, child.path), true);
  assert.deepEqual(removed, [child.id]);
});

test("a successful removal wins over a lagging git listing: the project record is still removed", async () => {
  // remove 返回 true 表示 worktree 已被删除；紧接着的 list 可能因 git 元数据尚未刷新而仍列出它，
  // 此时不能因此保留项目记录（否则 UI 里留下已不存在的项目）。
  const { router, removed, child } = worktreeSetup({ removeResult: true, listAfter: [{ path: "/wt/feature" }] });
  assert.equal(await router.invoke(ipcChannels.gitWorktreeRemove, PROJECT.id, child.path), true);
  assert.deepEqual(removed, [child.id]);
});

test("worktree still tracked by git after a failed removal keeps its project record", async () => {
  const { router, removed, child, logs } = worktreeSetup({ removeResult: false, listAfter: [{ path: "/wt/feature" }] });
  assert.equal(await router.invoke(ipcChannels.gitWorktreeRemove, PROJECT.id, child.path), false);
  assert.deepEqual(removed, []);
  assert.ok(logs.some(([level, , message]) => level === "info" && /skipped/.test(message)));
});

test("worktree removal matches git's path ignoring case on Windows only", { skip: process.platform !== "win32" }, async () => {
  const { router, removed, child } = worktreeSetup({
    removeResult: false,
    listAfter: [{ path: resolve("/WT/Feature") }],
  });
  assert.equal(await router.invoke(ipcChannels.gitWorktreeRemove, PROJECT.id, child.path), false);
  assert.deepEqual(removed, []);
});

test("worktree removal failure is logged and rethrown without removing the record", async () => {
  const failure = new Error("locked");
  const { router, removed, child, logs } = worktreeSetup({ removeError: failure });
  await assert.rejects(router.invoke(ipcChannels.gitWorktreeRemove, PROJECT.id, child.path), /locked/);
  assert.deepEqual(removed, []);
  assert.ok(logs.some(([level]) => level === "error"));
});

test("worktree creation and listing register worktree paths as child projects", async () => {
  const added = [];
  const { router } = setup({
    worktreeService: {
      list: async () => [{ path: "/wt/a" }, { path: "/wt/b" }],
      create: async () => ({ path: "/wt/new" }),
    },
    projectStore: {
      get: (id) => (id === PROJECT.id ? PROJECT : undefined),
      add: async (path, parentId) => { added.push([path, parentId]); },
    },
  });
  await router.invoke(ipcChannels.gitWorktreeList, PROJECT.id);
  await router.invoke(ipcChannels.gitWorktreeCreate, PROJECT.id, "topic");
  assert.deepEqual(added, [["/wt/a", PROJECT.id], ["/wt/b", PROJECT.id], ["/wt/new", PROJECT.id]]);
});

test("gitDeleteFiles rejects malformed path lists before reaching GitService", async () => {
  for (const bad of [[], "a.ts", ["a.ts", ""], ["a.ts", 3]]) {
    const { router, calls } = setup();
    await assert.rejects(router.invoke(ipcChannels.gitDeleteFiles, PROJECT.id, bad), /Invalid paths/);
    assert.deepEqual(calls, []);
  }
});

test("every Git channel in shared ipc has a registered handler", () => {
  const { router } = setup();
  const gitKeys = Object.keys(ipcChannels).filter((key) => /^git[A-Z]/.test(key));
  const missing = gitKeys.filter((key) => !router.handlers.has(ipcChannels[key]));
  assert.deepEqual(missing, []);
  for (const key of gitKeys) assert.equal(router.registrations.get(ipcChannels[key]), 1, key);
});
