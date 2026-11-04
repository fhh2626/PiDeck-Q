import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const nodeRequire = createRequire(import.meta.url);

function loadHelper() {
  const filePath = "src/main/prompts/createUniquePrompt.ts";
  const output = ts.transpileModule(readFileSync(filePath, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: filePath,
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    require: nodeRequire,
  }, { filename: filePath });
  return module.exports;
}

test("unique prompt creation retries only the bounded name-conflict path", async () => {
  const { createUniquePrompt } = loadHelper();
  const calls = [];
  const result = await createUniquePrompt({
    baseName: "review",
    maxAttempts: 4,
    create: async (name) => {
      calls.push(name);
      if (calls.length < 3) throw { code: "already-exists" };
      return { name };
    },
    isAlreadyExists: (error) => error?.code === "already-exists",
  });

  assert.deepEqual(calls, ["review", "review-2", "review-3"]);
  assert.equal(result.name, "review-3");
});

test("unique prompt creation propagates non-conflict errors without retry", async () => {
  const { createUniquePrompt } = loadHelper();
  const failure = new Error("read-only");
  const calls = [];

  await assert.rejects(
    createUniquePrompt({
      baseName: "review",
      create: async (name) => {
        calls.push(name);
        throw failure;
      },
      isAlreadyExists: () => false,
    }),
    (error) => error === failure,
  );

  assert.deepEqual(calls, ["review"]);
});

const { PromptManager, PromptAlreadyExistsError, isPromptAlreadyExistsError } = loadTsCommonJs("src/main/prompts/PromptManager.ts");
const { XuePromptManager } = loadTsCommonJs("src/main/prompts/XuePromptManager.ts");
const { registerStoreIpc } = loadTsCommonJs("src/main/ipc/storeIpc.ts");
const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");

async function createHome(t) {
  const home = await mkdtemp(join(tmpdir(), "pideck-l3-prompt-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  // 模板目录由列表/首次使用流程创建；这里只测创建与导入语义，所以预先建好
  await mkdir(join(home, ".pi", "agent", "prompts"), { recursive: true });
  return home;
}

test("creating a prompt over an existing name fails atomically and keeps the original", async (t) => {
  const manager = new PromptManager(await createHome(t), (key) => key);
  const first = await manager.create({ name: "review", description: "original" });
  await assert.rejects(
    manager.create({ name: "review", description: "clobber" }),
    (error) => error instanceof PromptAlreadyExistsError && isPromptAlreadyExistsError(error),
  );
  assert.match(await readFile(first.path, "utf8"), /description: original/);
});

test("two concurrent creations of the same name cannot both succeed", async (t) => {
  // 存在性检查只是 UX 快速路径；真正的互斥靠 wx 独占创建，防止并发导入互相覆盖。
  const manager = new PromptManager(await createHome(t), (key) => key);
  const results = await Promise.allSettled([
    manager.create({ name: "race", description: "one" }),
    manager.create({ name: "race", description: "two" }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
  const rejected = results.find((r) => r.status === "rejected");
  assert.ok(isPromptAlreadyExistsError(rejected.reason));
});

function registerStore(manager) {
  const handlers = new Map();
  registerStoreIpc(
    { handle: (channel, handler) => handlers.set(channel, handler) },
    {
      promptManager: manager,
      skillManager: {},
      xuePromptManager: {},
      extensionManager: {},
      appLogger: { info() {}, warn() {}, error() {} },
      mainCopy: (key) => key,
    },
  );
  return (payload) => handlers.get(ipcChannels.promptStoreImport)(payload);
}

test("store prompt import picks the next free name instead of overwriting", async (t) => {
  const manager = new PromptManager(await createHome(t), (key) => key);
  const existing = await manager.create({ name: "review", description: "mine" });
  const importPrompt = registerStore(manager);

  const imported = await importPrompt({ title: "Review", description: "from store", content: "Body one" });
  assert.equal(imported.name, "review-2");
  const again = await importPrompt({ title: "Review", description: "from store", content: "Body two" });
  assert.equal(again.name, "review-3");
  assert.match(await readFile(existing.path, "utf8"), /description: mine/);
  assert.match(await readFile(imported.path, "utf8"), /Body one/);
});

test("concurrent store imports of the same title land on distinct files", async (t) => {
  const manager = new PromptManager(await createHome(t), (key) => key);
  const importPrompt = registerStore(manager);
  const [a, b] = await Promise.all([
    importPrompt({ title: "Same", description: "d", content: "A" }),
    importPrompt({ title: "Same", description: "d", content: "B" }),
  ]);
  assert.notEqual(a.path, b.path);
  assert.deepEqual([a.name, b.name].sort(), ["same", "same-2"]);
});

test("xueprompt import picks the next free name instead of overwriting", async (t) => {
  const home = await createHome(t);
  const xue = new XuePromptManager(home);
  // 绕开 sqlite 题库：只替换详情查询，导入链路（命名/落盘）仍是真实实现
  xue.detail = async () => ({ title: "Code Review", description: "desc", promptContent: "XUE BODY" });
  const first = await xue.importToPi("Code Review", "dev");
  const second = await xue.importToPi("Code Review", "dev");
  assert.equal(first.name, "code-review");
  assert.equal(second.name, "code-review-2");
  assert.match(await readFile(first.path, "utf8"), /XUE BODY/);
});