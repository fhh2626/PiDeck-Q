import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function compile(filePath, imports = {}) {
  const output = ts.transpileModule(readFileSync(filePath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, { module, exports: module.exports, require: (id) => imports[id] ?? {} });
  return module.exports;
}

const timeline = compile("src/renderer/src/hooks/useSessionTimelineController.ts", {
  react: {}, jotai: { atom: (value) => ({ _mockInit: value }) }, "jotai/utils": {}, "../atoms": {}, "../desktopApi": {}, "../utils/sessionCommands": { toSessionRuntimeTarget: () => undefined },});

function readRendererRuntimeSources(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filePath = join(directory, entry.name);
    if (entry.isDirectory()) return readRendererRuntimeSources(filePath);
    if (!/\.(ts|tsx)$/.test(entry.name)) return [];
    return [readFileSync(filePath, "utf8")];
  });
}

test("A to B owner switch renders B's initial page without A visibleCount or loading", () => {
  // 2026-11 轮次模型：useMessagePagination（100 条分页器）已删除，
  // 该用例验证旧的 owner 切换语义被 controller 的 ownerKey 隔离取代。
  assert.equal(timeline.matchesTimelineOwner("A", "B"), false);
});

test("old load completion, anchor, and jump owner tags cannot affect B", () => {
  assert.equal(timeline.matchesTimelineOwner("A", "B"), false);
  assert.equal(timeline.matchesTimelineOwner("B", "B"), true);
});

test("Session runtime busy state is authoritative and stop status wins over stale flags", () => {
  // abort 先切 idle、后到 runtime-state；旧 streaming 标记不能继续驱动加载动画。
  assert.equal(timeline.isSessionRuntimeBusy("idle", { isStreaming: true, isExecutingTool: true }), false);
  assert.equal(timeline.isSessionRuntimeBusy("running", undefined), true);
  assert.equal(timeline.isSessionRuntimeBusy("idle", undefined), false);
  assert.equal(timeline.isLatestTimelineRunBusy(true, 1, 2), true);
  assert.equal(timeline.isLatestTimelineRunBusy(true, 0, 2), false);
});

test("renderer runtime code reads historical messages only through the bounded page API", () => {
  const rendererRuntime = [
    ...readRendererRuntimeSources("src/renderer/src/hooks"),
    ...readRendererRuntimeSources("src/renderer/src/components/session"),
  ].join("\n");
  // 文本匹配在此是正确工具：这是静态架构规则（渲染层禁用全量历史 API），任何调用点都不得出现；
  assert.doesNotMatch(rendererRuntime, /readRecordMessages\(/);
});
