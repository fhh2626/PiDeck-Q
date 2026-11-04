import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { SettingsStore } = loadTsCommonJs("src/main/settings/SettingsStore.ts");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** load() 里的清理落盘是 fire-and-forget；轮询磁盘直到条件成立。 */
async function waitForFile(file, predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const parsed = JSON.parse(await readFile(file, "utf8"));
      if (predicate(parsed)) return parsed;
    } catch {
      // 文件尚未写出（或正在原子替换）：继续轮询
    }
    await sleep(20);
  }
  return JSON.parse(await readFile(file, "utf8"));
}

function createStore(directory) {
  return new SettingsStore({
    desktopSettingsFile: join(directory, "settings.json"),
    piAgentSettingsFile: join(directory, "pi-settings.json"),
    getSystemLocale: () => "en-US",
  });
}

test("legacy Electron sandbox setting is ignored and removed without resetting settings", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pideck-l3-settings-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "settings.json");

  // 先让新版本自己写出一份完整、已迁移的 settings.json（排除其它迁移触发落盘的干扰）
  const seed = createStore(directory);
  await seed.load();
  // update 与 load() 里 fire-and-forget 的清理落盘共用同一条写队列：等到这次 update 返回，
  // 说明此前排队的写入都已完成，之后再注入旧字段就不会被迟到的写入覆盖（不靠 sleep 猜时间）。
  await seed.update({ theme: "dark" });
  const settled = JSON.parse(await readFile(file, "utf8"));
  // 模拟旧版本遗留：同时带着用户自定义项与已删除的 Electron 沙箱开关
  await writeFile(file, JSON.stringify({ ...settled, theme: "dark", electronChromiumSandbox: true }), "utf8");
  // 前置条件自检：旧字段确实在磁盘上，否则后面“被清掉”的断言会空过。
  assert.equal(JSON.parse(await readFile(file, "utf8")).electronChromiumSandbox, true);

  const store = createStore(directory);
  await store.load();

  // 旧字段被忽略，用户的其它设置不能因迁移而被重置
  assert.equal("electronChromiumSandbox" in store.get(), false);
  assert.equal(store.get().theme, "dark");
  // 旧字段必须单独就能触发一次落盘，把磁盘残留清掉
  const rewritten = await waitForFile(file, (value) => !("electronChromiumSandbox" in value));
  assert.equal("electronChromiumSandbox" in rewritten, false);
  assert.equal(rewritten.theme, "dark");
});

test("AppSettings type no longer declares the Electron sandbox option", () => {
  // “已删除功能不得再出现”的静态约束：类型声明里的字段无法靠运行时行为证明缺席。
  assert.doesNotMatch(readFileSync("src/shared/types/settings.ts", "utf8"), /electronChromiumSandbox\s*:/);
});
