import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { createStore } from "jotai/vanilla";
import { selectAtom } from "jotai/utils";
import ts from "typescript";
import vm from "node:vm";

const nodeRequire = createRequire(import.meta.url);

const source = readFileSync(
  "src/renderer/src/hooks/useSessionTimelineController.ts",
  "utf8",
);
const timelineComponentSource = readFileSync(
  "src/renderer/src/components/session/SessionMessageTimeline.tsx",
  "utf8",
);

function compileModule(filePath, imports = {}) {
  const output = ts.transpileModule(readFileSync(filePath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    require: (specifier) => imports[specifier] ?? nodeRequire(specifier),
    Date,
  });
  return module.exports;
}

function loadTimelineHelpers() {
  return compileModule("src/renderer/src/hooks/useSessionTimelineController.ts", {
    react: {},
    jotai: { atom: (value) => ({ _mockInit: value }) },
    "jotai/utils": {},
    "../atoms": {},
    "../desktopApi": {},
    "../i18n": { t: (key) => key },
    "../utils/notice": { showNotice: () => {} },
    "../utils/sessionCommands": { toSessionRuntimeTarget: () => undefined },
    "../components/session/timeline/turnRenderWindow": {
      TIMELINE_SCROLLED_TURN_LIMIT: 15,
      TIMELINE_WINDOW_EXPAND_STEP: 10,
    },
  });
}

function loadSessionAtoms() {
  const messageFingerprint = compileModule("src/shared/messageFingerprint.ts");
  return compileModule("src/renderer/src/atoms/session-atoms.ts", {
    "../utils/agentRuntimeState": compileModule(
      "src/renderer/src/utils/agentRuntimeState.ts",
    ),
    "../utils/sessionRecordIdentity": compileModule(
      "src/renderer/src/utils/sessionRecordIdentity.ts",
    ),
    "../../../shared/messageFingerprint": messageFingerprint,
    "../utils/historyTurnWindow": compileModule("src/renderer/src/utils/historyTurnWindow.ts"),
  });
}

test("timeline pagination restores the load-more anchor instead of jumping the viewport", () => {
  const { restoreTimelineAnchor } = loadTimelineHelpers();
  assert.equal(restoreTimelineAnchor(240, 600), 840);
  assert.equal(restoreTimelineAnchor(0, 0), 0);
});

test("timeline auto-scroll only sticks while the reader remains near the bottom", () => {
  const { isTimelineAtBottom } = loadTimelineHelpers();
  assert.equal(isTimelineAtBottom(980, 1100, 120), true);
  assert.equal(isTimelineAtBottom(700, 1100, 120), false);
});

test("timeline owns paging, delegated scroll follow, and outline jump lifecycle", () => {
	assert.match(source, /selectAtom\([\s\S]*sessionMessagesCacheAtom/);
	assert.match(source, /readRecordMessagePage\(sessionId/);
	assert.match(timelineComponentSource, /sessionId: props\.controller \? undefined : sessionId/);
	assert.match(source, /prependHistoryPage/);
	// 激活分页（2026-08）：runtime 窗口会话的显示总数 = disk 前缀 + 窗口段的组合长度
	assert.match(source, /totalMessageCount: diskPage \? diskPage\.total : combinedMessages\.length/);
  // 流式跟随由 beUI MessageScroller 负责；controller 只接收跟随状态，避免重复写 scrollTop。
  assert.match(source, /setAutoScrollFromScroller/);
  // 2026-11：100 条分页器已删除，jump 不再扩渲染窗口（数据全量在 atom）
  assert.doesNotMatch(source, /pagination\.loadUntilIncluded\(index\)/);
  assert.match(source, /restoreTimelineAnchor\(/);
});

test("background Session cache changes retain the selected timeline slice", () => {
  const { sessionMessagesCacheAtom } = loadSessionAtoms();
  const store = createStore();
  const currentMessages = [{ id: "current" }];
  const selectedMessages = selectAtom(
    sessionMessagesCacheAtom,
    (cache) => cache.current?.messages,
    Object.is,
  );
  store.set(sessionMessagesCacheAtom, {
    current: { messages: currentMessages },
    background: { messages: [{ id: "old" }] },
  });
  const before = store.get(selectedMessages);
  store.set(sessionMessagesCacheAtom, {
    current: { messages: currentMessages },
    background: { messages: [{ id: "new" }] },
  });
  assert.equal(store.get(selectedMessages), before);
});

test("bottom-settle history release invalidates in-flight runtime history pages", () => {
  // 释放成功后必须推进 load 序号并复位加载标志：迟到页响应被 latestLoadBySession 丢弃，
  // isLoadingMessagePage 也不会卡死后续加载（修复前只有释放调用）。
  // 回底路径用保底 50 轮的 releaseSessionHistoryAtom；无条件作废（mutation 失败兜底）
  // 仍走 clearSessionHistoryAtom。
  assert.match(source, /if \(releaseHistory\(sessionId\)\)/);
  assert.match(source, /const sequence = \+\+nextLoadSequence;/);
  assert.match(source, /setIsLoadingMessagePage\(false\)/);
  assert.match(source, /trackLatestLoad\(sessionId, sequence\)/);
});

test("prepend scroll compensation is skipped while following bottom and marks programmatic scroll", () => {
  // 跟底中（autoScrollRef=true）不恢复旧锚点：贴底引擎负责生长补偿，避免把用户拽回顶部；
  // 非跟底时标记程序化滚动，防止补偿的 scrollTop 赋值触发 ≤240px 自动加载。
  assert.match(source, /if \(autoScrollRef\.current\) \{\n\s*loadMoreAnchorRef\.current = undefined;\n\s*return;\n\s*\}/);
  assert.match(source, /programmaticScrollRef\.current = true;\n\s*timeline\.scrollTop = timeline\.scrollTop \+ heightDelta;/);
  assert.match(source, /requestAnimationFrame\(\(\) => \{\n\s*programmaticScrollRef\.current = false;/);
});

test("load-more compensation also compensates at the very top so the viewport does not change screen", () => {
  // 前插/展开后始终按高度差补偿：贴顶也要加，scrollTop 留在 0 会让新内容占住当前屏
  // （滚轮/拖进度条/按钮加载“乱跳”根因）。不再返回 null。
  const { resolveTimelineTopCompensation } = loadTimelineHelpers();
  assert.equal(resolveTimelineTopCompensation(0, 600), 600);
  assert.equal(resolveTimelineTopCompensation(8, 600), 608);
  assert.equal(resolveTimelineTopCompensation(240, 600), 840);
  assert.equal(resolveTimelineTopCompensation(9, -100), -91);
  assert.equal(resolveTimelineTopCompensation(240, 0), 240);
});

test("history prepend compensates from the landing scrollTop, not the request-time position", () => {
  // 补偿必须用落地那一刻的 scrollTop 加高度差：用请求开始时的 anchor.value.top 写回
  // 会把等待期间继续滚动（或拖进度条）的用户拉回旧位置。
  assert.match(source, /timeline\.scrollTop = timeline\.scrollTop \+ heightDelta/);
  assert.doesNotMatch(source, /anchor\.value\.top/);
  assert.match(source, /const heightDelta = timeline\.scrollHeight - anchor\.value\.height/);
  // 高度差为 0 时不得设置程序化滚动标记：delta=0 不产生 scroll 事件，
  // 留着标记会吞掉下一次真实用户滚动。
  assert.match(source, /if \(heightDelta === 0\) return;/);
});

test("the top-compensation helper no longer has a skip-at-top branch", () => {
  const fnBody = source.slice(
    source.indexOf("export function resolveTimelineTopCompensation"),
    source.indexOf("export function matchesTimelineOwner"),
  );
  assert.ok(fnBody.length > 0);
  assert.doesNotMatch(fnBody, /return null/);
  assert.doesNotMatch(fnBody, /threshold/);
});

test("desktop turn-window compensation defers to a pending history anchor", () => {
  // 补页成功会同时前插消息与 +10 轮（同一帧）：只允许 controller 补偿一次，
  // turn 窗口 effect 让位；无锚点时自己用当前 scrollTop 加高度差补偿（贴顶亦然）。
  assert.match(timelineComponentSource, /controller\.hasPendingLoadMoreAnchor/);
  assert.match(timelineComponentSource, /controller\.refreshLoadMoreAnchorBaseline/);
  assert.match(timelineComponentSource, /timeline\.scrollTop \+ \(nextHeight - prev\.height\)/);
  assert.doesNotMatch(timelineComponentSource, /resolveTimelineTopCompensation/);
});

test("web timeline restores the visible anchor even at the very top", () => {
  const webSource = readFileSync("src/renderer/src/web/useWebTimelineWindow.ts", "utf8");
  assert.doesNotMatch(webSource, /TOP_REVEAL_THRESHOLD/);
  assert.doesNotMatch(webSource, /scrollTop <=/);
  // 磁盘页落地后再捕获锚点的现行为不得退化回点击时捕获
  assert.match(webSource, /pendingAnchorRef\.current = captureVisibleAnchor\(\);/);
});

test("runtime history still has more after a cursor-less slide-out prefix", () => {
  const { hasMoreRuntimeHistory } = loadTimelineHelpers();
  assert.equal(hasMoreRuntimeHistory({
    source: "runtime",
    windowStart: 18,
    windowStartFilePos: 24,
    history: {
      messages: [{ id: "h1" }],
      nextBefore: null,
    },
  }), true);
  assert.equal(hasMoreRuntimeHistory({
    source: "runtime",
    windowStart: 18,
    history: {
      messages: [{ id: "h1" }],
      nextBefore: null,
      exhausted: true,
    },
  }), false);
  assert.equal(hasMoreRuntimeHistory({
    source: "runtime",
    windowStart: 0,
    history: {
      messages: [{ id: "h1" }],
      nextBefore: 12,
    },
  }), true);
  assert.equal(hasMoreRuntimeHistory({
    source: "runtime",
    windowStart: 0,
    windowStartFilePos: 24,
    history: {
      messages: [{ id: "h1" }],
      nextBefore: null,
    },
  }), true);
  assert.equal(hasMoreRuntimeHistory({
    source: "runtime",
    windowStart: 0,
    windowStartFilePos: 0,
  }), false);
  assert.equal(hasMoreRuntimeHistory({
    source: "disk",
    windowStart: 18,
  }), false);
});

test("auto history load ignores programmatic scrolls and only fires on real user scroll", () => {
  // 监听器迁移到 controller：程序化滚动事件先消费 programmaticScrollRef 抑制标记；
  // 组件里不再存在裸的 scrollTop>240 触发（原实现会因补偿滚动连锁翻页）。
  assert.match(source, /if \(programmaticScrollRef\.current\) \{\n\s*programmaticScrollRef\.current = false;\n\s*return;\n\s*\}/);
  assert.match(source, /HISTORY_AUTO_LOAD_THRESHOLD/);
  assert.match(source, /timeline\.addEventListener\("scroll", onScroll, \{ passive: true \}\)/);
});
