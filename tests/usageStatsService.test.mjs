import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

/**
 * UsageStatsService：双层缓存 / 增量合并 / 目录切换 / 截断重扫。
 * 通过 transpile + vm 沙箱注入 electron stub（sessionScannerSubagents.test.mjs 同款先例）。
 */

const require = createRequire(import.meta.url);
const SERVICE_PATH = "src/main/usageStats/UsageStatsService.ts";
const CACHE_PATH = "src/main/sessions/sessionSummaryCache.ts";

function makeSandboxRequire(userDataDir) {
  return (id) => {
    if (id === "electron") return { app: { getPath: () => userDataDir } };
    // SessionSummaryCache 也 transpile 进 vm（其 electron import 不走 Node ESM loader）
    if (id === "../sessions/sessionSummaryCache") {
      return loadTranspiled(CACHE_PATH, userDataDir);
    }
    if (id.startsWith(".")) {
      // 相对 import 相对 src/main/usageStats/ 解析（CJS require 需显式 .ts 扩展名）
      const resolved = id.endsWith(".ts") ? id : `${id}.ts`;
      return require(join(import.meta.dirname, "../src/main/usageStats", resolved));
    }
    return require(id);
  };
}

function loadTranspiled(filePath, userDataDir) {
  const source = readFileSync(filePath, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const sandbox = {
    exports: {},
    require: makeSandboxRequire(userDataDir),
    process,
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(outputText, sandbox, { filename: filePath });
  return sandbox.exports;
}

function loadService(userDataDir) {
  return loadTranspiled(SERVICE_PATH, userDataDir).UsageStatsService;
}

const line = (tsMs, sid, cost) =>
  JSON.stringify([tsMs, sid, "/proj", "anthropic/claude-sonnet-4", 100, 50, 0, 0, 150, cost, 1]);

async function makeEnv() {
  const base = await mkdtemp(join(tmpdir(), "usage-service-"));
  const agentDir = join(base, "agent");
  const userDataDir = join(base, "userData");
  await mkdir(join(agentDir, "analytics"), { recursive: true });
  const logPath = join(agentDir, "analytics", "usage.jsonl");
  return { base, agentDir, userDataDir, logPath };
}

test("refresh then get roundtrip: first read is full rescan, append is incremental", async () => {
  const { base, agentDir, userDataDir, logPath } = await makeEnv();
  try {
    const Service = loadService(userDataDir);
    const service = new Service({ agentDir, userDataDir });
    const t0 = 1710000000000;
    await writeFile(logPath, line(t0, "s1", 0.01) + "\n");

    const first = await service.refresh();
    assert.equal(first.fullRescan, true);
    assert.equal(first.parsedRecords, 1);

    let view = await service.getAggregated();
    assert.equal(view.totals.tokens, 150);
    assert.equal(view.recordCount, 1);
    assert.equal(view.heatmap.length, 53 * 7);
    assert.match(view.heatmapStart, /^\d{4}-\d{2}-\d{2}$/);

    // 追加后刷新：增量路径，merge 后总量翻倍
    await new Promise((r) => setTimeout(r, 20));
    await writeFile(logPath, line(t0, "s1", 0.01) + "\n" + line(t0 + 1000, "s2", 0.02) + "\n");
    const second = await service.refresh();
    assert.equal(second.fullRescan, false);
    assert.equal(second.parsedRecords, 1);

    view = await service.getAggregated();
    assert.equal(view.totals.tokens, 300);
    assert.equal(view.totals.sessions.length, 2);
    assert.equal(view.recordCount, 2);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("truncate-to-empty replaces state instead of resurrecting stale totals", async () => {
  const { base, agentDir, userDataDir, logPath } = await makeEnv();
  try {
    const Service = loadService(userDataDir);
    const service = new Service({ agentDir, userDataDir });
    await writeFile(logPath, line(1710000000000, "s1", 0.01) + "\n");
    await service.refresh();
    assert.equal((await service.getAggregated()).totals.tokens, 150);

    // 文件被清空（截断）
    await new Promise((r) => setTimeout(r, 20));
    await writeFile(logPath, "");
    const refreshed = await service.refresh();
    assert.equal(refreshed.fullRescan, true);
    assert.equal(refreshed.parsedRecords, 0);

    const view = await service.getAggregated();
    assert.equal(view.recordCount, 0);
    assert.equal(view.totals.tokens, 0, "truncated file must not keep stale totals");

    // 文件重新长出内容：从空态增量合并，无双计
    await new Promise((r) => setTimeout(r, 20));
    await writeFile(logPath, line(1710000000000, "s1", 0.01) + "\n");
    await service.refresh();
    const regrown = await service.getAggregated();
    assert.equal(regrown.totals.tokens, 150, "regrown file must count once, not twice");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("setAgentDir invalidates memory state and rescans the new directory", async () => {
  const { base, agentDir, userDataDir } = await makeEnv();
  try {
    const Service = loadService(userDataDir);
    const service = new Service({ agentDir, userDataDir });
    await writeFile(join(agentDir, "analytics", "usage.jsonl"), line(1710000000000, "s1", 0.01) + "\n");
    await service.refresh();

    const agentDir2 = join(base, "agent2");
    await mkdir(join(agentDir2, "analytics"), { recursive: true });
    await writeFile(join(agentDir2, "analytics", "usage.jsonl"), line(1720000000000, "s9", 0.05) + "\n");
    service.setAgentDir(agentDir2);
    const view = await service.getAggregated();
    assert.equal(view.recordCount, 1);
    assert.equal(view.totals.sessions.length, 1);
    assert.equal(view.totals.tokens, 150, "must read from the new directory, not the old");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("missing log file reports not-installed; non-ENOENT errors throw", async () => {
  const { base, agentDir, userDataDir } = await makeEnv();
  try {
    const Service = loadService(userDataDir);
    const service = new Service({ agentDir, userDataDir });
    const detect = await service.detect();
    assert.equal(detect.installed, false);
    assert.equal(await service.getAggregated(), null);

    // 非 ENOENT 错误（如路径含非法字符 → ERR_INVALID_ARG_VALUE）必须抛，
    // 不能吞成「未安装」；Windows 对目录当路径统一抛 ENOENT，故不用 EISDIR 类断言
    const badAgentDir = join(base, "bad\u0000dir");
    await assert.rejects(
      () => new Service({ agentDir: badAgentDir, userDataDir }).detect(),
      (err) => err && err.code !== "ENOENT",
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("overlapping refreshes are single-flight (no double count)", async () => {
  const { base, agentDir, userDataDir, logPath } = await makeEnv();
  try {
    const Service = loadService(userDataDir);
    const service = new Service({ agentDir, userDataDir });
    const t0 = 1710000000000;
    await writeFile(logPath, line(t0, "s1", 0.01) + "\n");
    // 首次全量
    await service.refresh();
    // 追加后并发两个 refresh：应共享一次执行
    await new Promise((r) => setTimeout(r, 20));
    await writeFile(logPath, line(t0, "s1", 0.01) + "\n" + line(t0 + 1000, "s2", 0.02) + "\n");
    const [r1, r2] = await Promise.all([service.refresh(), service.refresh()]);
    assert.deepEqual(r1, r2, "concurrent refreshes must share one execution");
    const view = await service.getAggregated();
    assert.equal(view.totals.tokens, 300, "records must be counted exactly once");
    assert.equal(view.recordCount, 2);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("legacy cost-bearing cache (schemaVersion 2) is discarded and triggers full rescan", async () => {
  const { base, agentDir, userDataDir, logPath } = await makeEnv();
  try {
    const t0 = 1710000000000;
    await writeFile(logPath, line(t0, "s1", 0.01) + "\n");
    // 手工构造"旧版"缓存：schemaVersion=2 且缺少 byModel/byProject，仍带费用字段。
    // 当前结构版本已升到 3，必须弃用并全量重扫，避免旧费用数据继续经 IPC 下发。
    const { stat } = await import("node:fs/promises");
    const fileStat = await stat(logPath);
    const oldIntermediate = {
      dayBuckets: [
        {
          day: "2024-03-09",
          totals: { tokens: 150, input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.01, turns: 1, sessions: ["s1"] },
          sessions: ["s1"],
          byProvider: [{ provider: "anthropic", tokens: 150, cost: 0.01, turns: 1 }],
        },
      ],
      modelBuckets: [{ model: "anthropic/claude-sonnet-4", provider: "anthropic", tokens: 150, cost: 0.01, turns: 1, sessions: ["s1"] }],
      projectBuckets: [{ project: "/proj", tokens: 150, cost: 0.01, turns: 1, sessions: ["s1"] }],
      totals: { tokens: 150, input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.01, turns: 1, sessions: ["s1"] },
      window: { since: t0, to: t0 },
      costKnown: true,
      recordCount: 1,
    };
    const cachePayload = {
      // 必须与 SessionSummaryCache 当前磁盘版本一致，否则会在磁盘层被丢弃，
      // 测不到 UsageStatsService 对 schemaVersion=2 的失效逻辑。
      version: 4,
      entries: {
        [logPath]: {
          version: { mtimeMs: fileStat.mtimeMs, size: fileStat.size },
          value: {
            schemaVersion: 2,
            fileState: { size: fileStat.size, mtimeMs: fileStat.mtimeMs, count: 1 },
            intermediate: oldIntermediate,
          },
        },
      },
    };
    await mkdir(userDataDir, { recursive: true });
    await writeFile(join(userDataDir, "usage-stats-cache.json"), JSON.stringify(cachePayload), "utf8");

    const Service = loadService(userDataDir);
    const service = new Service({ agentDir, userDataDir });
    // detect 命中旧缓存但结构版本不符 → 弃用且不加载（轻量探测不重扫，recordCount 为 null）
    const detect = await service.detect();
    assert.equal(detect.installed, true);
    assert.equal(detect.recordCount, null);
    const view = await service.getAggregated();
    assert.equal(view.recordCount, 1);
    // 旧缓存里的费用字段不能被新聚合继续下发
    assert.equal("cost" in view.totals, false);
    assert.equal("costKnown" in view, false);
    // 新聚合必须带按天模型/项目明细（旧缓存结构不会提供，证明走了全量重扫）
    assert.equal(view.daily.length, 1);
    assert.ok(Array.isArray(view.daily[0].byModel), "rescan must produce per-day byModel");
    assert.equal(view.daily[0].byModel[0].model, "anthropic/claude-sonnet-4");
    assert.ok(Array.isArray(view.daily[0].byProject), "rescan must produce per-day byProject");
    assert.equal(view.daily[0].byProject[0].project, "/proj");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
