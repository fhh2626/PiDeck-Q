import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { ConfigManager } = loadTsCommonJs("src/main/config/ConfigManager.ts");

test("config reads distinguish a missing file from an unreadable file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pideck-config-read-error-"));
  try {
    // 文件不存在是正常兜底：配置页/模型支持位按「可读但为空」处理。
    const missing = await new ConfigManager(dir).getModelsConfig();
    assert.equal(missing.readError, undefined);
    assert.deepEqual(JSON.parse(JSON.stringify(missing.parsed)), { providers: {} });

    // 文件存在但读不了（这里用目录制造 EISDIR）：必须标记 readError，
    // 否则调用方会把 fallback（空 providers）误当成用户没有勾选 xhigh/max。
    await mkdir(join(dir, "models.json"));
    const unreadable = await new ConfigManager(dir).getModelsConfig();
    assert.equal(unreadable.readError, true);
    assert.deepEqual(JSON.parse(JSON.stringify(unreadable.parsed)), { providers: {} });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
