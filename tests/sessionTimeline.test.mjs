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

test("bottom-settle history clear invalidates in-flight runtime history pages", () => {
  // 清理成功后必须推进 load 序号并复位加载标志：迟到页响应被 latestLoadBySession 丢弃，
  // isLoadingMessagePage 也不会卡死后续加载（修复前只有 clearHistory 调用）。
  assert.match(source, /if \(clearHistory\(sessionId\)\)/);
  assert.match(source, /const sequence = \+\+nextLoadSequence;/);
  assert.match(source, /setIsLoadingMessagePage\(false\)/);
  assert.match(source, /trackLatestLoad\(sessionId, sequence\)/);
});

test("prepend scroll compensation is skipped while following bottom and marks programmatic scroll", () => {
  // 跟底中（autoScrollRef=true）不恢复旧锚点：贴底引擎负责生长补偿，避免把用户拽回顶部；
  // 非跟底时标记程序化滚动，防止补偿的 scrollTop 赋值触发 ≤240px 自动加载。
  assert.match(source, /if \(autoScrollRef\.current\) \{\n\s*loadMoreAnchorRef\.current = undefined;\n\s*return;\n\s*\}/);
  assert.match(source, /programmaticScrollRef\.current = true;\n\s*timeline\.scrollTop = nextScrollTop;/);
  assert.match(source, /requestAnimationFrame\(\(\) => \{\n\s*programmaticScrollRef\.current = false;/);
});

test("load-more compensation is skipped at the very top so prepended content stays visible", () => {
  // 2026-02 回归：视口在顶部（≤8px 阈值）时 prepend/展开不补偿 scrollTop——
  // 容器 overflow-anchor:none，插入内容不会自动调整滚动位置，补偿会把新内容推出视口上方，
  // 表现为「点击加载更多/显示更早无反馈」。中部才按高度差补偿保持视口内容不动。
  const { resolveTimelineTopCompensation } = loadTimelineHelpers();
  assert.equal(resolveTimelineTopCompensation(0, 600), null);
  assert.equal(resolveTimelineTopCompensation(8, 600), null);
  assert.equal(resolveTimelineTopCompensation(240, 600), 840);
  assert.equal(resolveTimelineTopCompensation(9, -100), -91);
  assert.equal(resolveTimelineTopCompensation(240, 0), 240);
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
