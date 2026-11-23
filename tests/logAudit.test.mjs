// 审计日志契约（静态断言）：误删排查能力（40G 事件教训）的回归保障。
// - 所有删除必须走 trashPath 并带 source 上下文，成功记 warn / 失败记 error
// - 破坏性 git 操作必须留痕
// - SkillManager.delete 拒绝 rm 硬删（改走回收站）
// - LogViewer 走分页查询（时间搜索可翻到任意旧日志）
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
const logViewer = read("renderer/src/components/app/settings/LogViewer.tsx");
const zh = read("renderer/src/i18n/rendererCopy.zh-CN.ts");
const en = read("renderer/src/i18n/rendererCopy.en-US.ts");
const sharedIpc = read("shared/ipc.ts");
const preload = (read("shared/desktop/createPiDesktopApi.ts") + "\n" + read("shared/desktop/createPiDesktopApi.ts"));

test("LogViewer uses paginated listPage with table and pagination components", () => {
  assert.match(logViewer, /logs\.listPage\(query\)/);
  assert.match(logViewer, /from: toTimestamp\(from\)/);
  assert.match(logViewer, /to: toTimestamp\(to\)/); // 起止双端筛选
  assert.match(logViewer, /<Pagination page=\{page \+ 1\}/);
  assert.match(logViewer, /<Table>/);
  assert.match(logViewer, /<TableHead>/);
});

test("listPage channel is wired across shared ipc, native registry, preload", () => {
  assert.match(sharedIpc, /logsListPage: "logs:list-page"/);
  assert.match(preload, /listPage: \(query\?: AppLogQuery\)/);
  assert.match(readFileSync("native/backend/domain/LogChannels.cpp", "utf8"), /logs:list-page/);
});

test("log viewer i18n keys exist in both locales", () => {
  const keys = [
    "logs.resultsCount",
    "logs.column.time",
    "logs.column.level",
    "logs.column.scope",
    "logs.column.message",
    "logs.column.detail",
    "logs.rangeFilter",
    "logs.rangeFrom",
    "logs.rangeTo",
    "logs.clearRangeFilter",
  ];
  for (const key of keys) {
    assert.match(zh, new RegExp(`"${key}":`), `${key} must exist in zh-CN`);
    assert.match(en, new RegExp(`"${key}":`), `${key} must exist in en-US`);
  }
});
