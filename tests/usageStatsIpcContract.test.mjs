import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 用量统计跨层契约护栏：
 *  - IPC 通道三处同步（shared/ipc.ts ↔ main handler ↔ desktop api ↔ previewApi stub）
 *  - 渲染层 i18n 中英文 key 同步
 *  - 通道命名遵循 domain:action
 */

const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");
const { createPiDesktopApi } = loadTsCommonJs("src/shared/desktop/createPiDesktopApi.ts");
const { createPreviewApi } = loadTsCommonJs("src/renderer/src/previewApi.ts");
const { zhCN } = loadTsCommonJs("src/renderer/src/i18n/rendererCopy.zh-CN.ts");
const { enUS } = loadTsCommonJs("src/renderer/src/i18n/rendererCopy.en-US.ts");

const EXPECTED_CHANNELS = {
  usageStatsDetect: "usage-stats:detect",
  usageStatsRefresh: "usage-stats:refresh",
  usageStatsGet: "usage-stats:get",
};

test("usage-stats channels are declared in shared/ipc.ts with domain:action names", () => {
  for (const [key, channel] of Object.entries(EXPECTED_CHANNELS)) {
    assert.equal(ipcChannels[key], channel, key);
  }
  const declared = Object.keys(ipcChannels).filter((key) => key.startsWith("usageStats"));
  assert.deepEqual(declared.sort(), Object.keys(EXPECTED_CHANNELS).sort(), "no undeclared usage-stats channel");
});

test("desktop api exposes usageStats detect/refresh/get on the matching channels", async () => {
  const invoked = [];
  const transport = {
    invoke: async (channel, ...args) => { invoked.push([channel, args.length]); return channel; },
    subscribe: () => () => undefined,
  };
  const syncHost = {
    readClipboardText: () => "", readClipboardHtml: () => "", readClipboardImage: () => "",
    getPathForFile: () => "", getClipboardPaths: () => [],
  };
  const api = createPiDesktopApi(transport, syncHost);
  assert.deepEqual(Object.keys(api.usageStats).sort(), ["detect", "get", "refresh"]);
  assert.equal(await api.usageStats.detect(), EXPECTED_CHANNELS.usageStatsDetect);
  assert.equal(await api.usageStats.refresh(), EXPECTED_CHANNELS.usageStatsRefresh);
  assert.equal(await api.usageStats.get(), EXPECTED_CHANNELS.usageStatsGet);
  assert.deepEqual(invoked.map(([channel]) => channel), Object.values(EXPECTED_CHANNELS));
});

test("previewApi stub keeps the PiDesktopApi shape (usageStats group present)", async () => {
  const preview = createPreviewApi().usageStats;
  assert.deepEqual(Object.keys(preview).sort(), ["detect", "get", "refresh"]);
  assert.equal((await preview.detect()).installed, false);
  assert.equal(await preview.get(), null);
  assert.equal((await preview.refresh()).parsedRecords, 0);
});

test("i18n zh-CN and en-US dictionaries carry the same usageStats keys", () => {
  const keysOf = (dictionary) => Object.keys(dictionary).filter((key) => key.startsWith("usageStats."));
  const zhKeys = keysOf(zhCN);
  const enKeys = keysOf(enUS);
  assert.ok(zhKeys.length >= 25, `expected a full key set, got ${zhKeys.length}`);
  assert.deepEqual([...zhKeys].sort(), [...enKeys].sort(), "zh-CN and en-US usageStats key sets must match");
  assert.ok(zhKeys.includes("usageStats.cards.totalTokens"));
  assert.ok(zhKeys.includes("usageStats.heatmap.title"));
  for (const key of zhKeys) {
    assert.ok(zhCN[key].trim() && enUS[key].trim(), `${key} must have text in both languages`);
  }
});
