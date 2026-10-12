import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

function loadExtensionManagerModule() {
  return loadTsCommonJs("src/main/extensions/ExtensionManager.ts", {
    stubs: {
      // 删除走系统回收站统一入口；测试环境没有回收站，模拟为真实删除。
      "../fs/trash": { trashPath: async (p) => { await rm(p, { recursive: true, force: true }); } },
      // 共享日志器：测试环境未注册实例，返回 null 让调用方静默跳过
      "../logging/sharedLogger": { getAppLogger: () => null },
    },
  });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

test("a stale lightweight extension scan cannot overwrite a newer force refresh", async () => {
  const { ExtensionManager } = loadExtensionManagerModule();
  const manager = new ExtensionManager({}, () => ({}));
  const lightweight = deferred();
  const forced = deferred();

  // Isolate cache ordering from pi/npm IO. The production method is private in TypeScript,
  // but remains a normal method at runtime and is intentionally replaced only for this test.
  manager.loadList = (includeVersionInfo) => (
    includeVersionInfo ? forced.promise : lightweight.promise
  );

  const lightweightResult = manager.list(false);
  const forceResult = manager.list(true);
  const fresh = { extensions: [{ id: "fresh", source: "npm:fresh" }], raw: "fresh" };
  const stale = { extensions: [{ id: "stale", source: "npm:stale" }], raw: "stale" };

  forced.resolve(fresh);
  assert.equal(await forceResult, fresh);

  lightweight.resolve(stale);
  assert.equal(await lightweightResult, fresh);
  assert.equal(await manager.list(false), fresh);
  assert.equal(await manager.list(true), fresh);
});

test("an explicit extension refresh bypasses a version-enriched cache", async () => {
  const { ExtensionManager } = loadExtensionManagerModule();
  const manager = new ExtensionManager({}, () => ({}));
  let scans = 0;
  manager.loadList = async (includeVersionInfo) => ({
    extensions: [],
    raw: `${includeVersionInfo}:${++scans}`,
  });

  assert.equal((await manager.list(true)).raw, "true:1");
  assert.equal((await manager.list(false)).raw, "true:1");
  assert.equal((await manager.list(true)).raw, "true:2");
});

test("parseListOutput strips the pi list (filtered) suffix so uninstall/update use a clean source", () => {
  const { ExtensionManager } = loadExtensionManagerModule();
  const manager = new ExtensionManager({}, () => ({}));

  const raw = [
    "User packages:",
    "  npm:pi-web-access",
    "    C:\\Users\\demo\\.pi\\agent\\npm\\node_modules\\pi-web-access",
    "  npm:@adrianapan/pikit (filtered)",
    "    C:\\Users\\demo\\.pi\\agent\\npm\\node_modules\\@adrianapan\\pikit",
  ].join("\n");

  const parsed = manager.parseListOutput(raw);
  const pikit = parsed.find((ext) => ext.source.includes("pikit"));

  // source 必须是干净的 npm source：卸载（pi remove）与更新（pi update / npm view）都依赖它
  assert.equal(pikit.source, "npm:@adrianapan/pikit");
  assert.equal(pikit.filtered, true);
  assert.equal(pikit.id, "user:npm:@adrianapan/pikit");
  // 路径行照常解析，不受后缀影响
  assert.equal(
    pikit.path,
    "C:\\Users\\demo\\.pi\\agent\\npm\\node_modules\\@adrianapan\\pikit",
  );
});

test("parseListOutput leaves plain package sources untouched", () => {
  const { ExtensionManager } = loadExtensionManagerModule();
  const manager = new ExtensionManager({}, () => ({}));

  const raw = [
    "User packages:",
    "  npm:pi-web-access",
    "    C:\\Users\\demo\\.pi\\agent\\npm\\node_modules\\pi-web-access",
  ].join("\n");

  const parsed = manager.parseListOutput(raw);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].source, "npm:pi-web-access");
  assert.equal(parsed[0].filtered, undefined);
});

test("uninstall removes a local extension and clears its stale disable entry", async () => {
  const { ExtensionManager } = loadExtensionManagerModule();
  const home = await mkdtemp(join(tmpdir(), "pideck-extension-manager-"));
  try {
    const extensionsDir = join(home, ".pi", "agent", "extensions");
    const settingsPath = join(home, ".pi", "agent", "settings.json");
    await mkdir(extensionsDir, { recursive: true });
    await writeFile(join(extensionsDir, "local-tool.ts"), "export default {};", "utf8");
    await writeFile(settingsPath, JSON.stringify({ disabledExtensions: ["local-tool.ts", "other.ts"] }), "utf8");

    // 拆分后构造签名：(locator, getSettings, getPiDeckSettings, patchPiDeckSettings, translate, trashPath)
    const manager = new ExtensionManager(
      {},
      () => ({}),
      () => ({}),
      async () => ({}),
      (key) => key === "mainExtension.invalidPath" ? "Invalid extension path." : key,
      async (p) => { await rm(p, { recursive: true, force: true }); },
    );
    manager.wslEnvironment = { windowsHome: home };
    await manager.uninstall("local-tool.ts");

    await assert.rejects(readFile(join(extensionsDir, "local-tool.ts"), "utf8"), { code: "ENOENT" });
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.deepEqual(settings.disabledExtensions, ["other.ts"]);
    await assert.rejects(manager.uninstall("../outside.ts"), /Invalid extension path/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
