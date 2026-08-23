import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 渲染层纯函数模块（无 DOM/无 React 依赖），node:test 可直接 import。
import {
  resolveChatTypographyVars,
  CHAT_TYPOGRAPHY_VAR_NAMES,
} from "../src/renderer/src/lib/chatTypography.ts";

test("default typography resolves to current hardcoded values", () => {
  const vars = resolveChatTypographyVars({});
  assert.equal(vars["--chat-body-line-height"], "1.35");
  assert.equal(vars["--chat-block-gap"], "6px");
  assert.equal(vars["--chat-list-block-gap-top"], "4px");
  assert.equal(vars["--chat-list-block-gap-bottom"], "6px");
  assert.equal(vars["--chat-list-item-gap"], "3px");
  assert.equal(vars["--chat-code-line-height"], "1.6");
  assert.equal(vars["--chat-code-block-gap"], "0.85rem");
  assert.equal(vars["--chat-table-cell-padding-y"], "0.45rem");
});

test("explicit modes map to distinct values", () => {
  const compact = resolveChatTypographyVars({
    chatBodyLineHeight: "compact",
    chatBlockGap: "compact",
    chatListDensity: "compact",
    chatCodeDensity: "compact",
  });
  const relaxed = resolveChatTypographyVars({
    chatBodyLineHeight: "relaxed",
    chatBlockGap: "relaxed",
    chatListDensity: "relaxed",
    chatCodeDensity: "relaxed",
  });
  assert.equal(compact["--chat-body-line-height"], "1.2");
  assert.equal(compact["--chat-code-line-height"], "1.45");
  assert.equal(relaxed["--chat-body-line-height"], "1.5");
  assert.equal(relaxed["--chat-code-block-gap"], "1.1rem");
});

test("loose line height maps to 1.65", () => {
  const vars = resolveChatTypographyVars({ chatBodyLineHeight: "loose" });
  assert.equal(vars["--chat-body-line-height"], "1.65");
});

test("invalid or missing modes fall back to default", () => {
  const invalid = resolveChatTypographyVars({
    chatBodyLineHeight: "huge",
    chatBlockGap: "huge",
    chatListDensity: "huge",
    chatCodeDensity: "huge",
  });
  const empty = resolveChatTypographyVars(undefined);
  assert.equal(invalid["--chat-body-line-height"], "1.35");
  assert.equal(invalid["--chat-block-gap"], "6px");
  assert.deepEqual(invalid, empty);
});

test("rendered CSS consumes tokens instead of hardcoded values", () => {
  const timeline = readFileSync("src/renderer/src/styles/timeline.css", "utf8");
  const streamdownChrome = readFileSync("src/renderer/src/styles/streamdownChrome.css", "utf8");
  const foundation = readFileSync("src/renderer/src/styles/foundation.css", "utf8");

  for (const name of CHAT_TYPOGRAPHY_VAR_NAMES) {
    assert.ok(foundation.includes(name), "foundation should define " + name);
  }
  // 正文/段落/列表 token 在 timeline.css 消费
  assert.ok(timeline.includes("--chat-body-line-height"));
  assert.ok(timeline.includes("--chat-list-item-gap"));
  assert.ok(timeline.includes("--chat-block-gap"));
  // 代码/表格 token 在 streamdownChrome.css 消费
  assert.ok(streamdownChrome.includes("--chat-code-line-height"));
  assert.ok(streamdownChrome.includes("--chat-code-block-gap"));
  assert.ok(streamdownChrome.includes("--chat-table-cell-padding-y"));
});

test("streaming Streamdown animation keeps the user chat line-height token", () => {
  const streamdownChrome = readFileSync("src/renderer/src/styles/streamdownChrome.css", "utf8");
  assert.match(streamdownChrome, /\.markdown-body \[data-sd-animate\]/);
  assert.match(streamdownChrome, /line-height:\s*var\(--chat-body-line-height\)/);
  assert.match(streamdownChrome, /\.markdown-body \.space-y-4 > :not\(:last-child\)/);
  assert.match(
    streamdownChrome,
    /\/\* 关掉逐字 slideUp[\s\S]*\.markdown-body \[data-sd-animate\] \{[\s\S]*animation:\s*none;/,
  );
});

test("renderer/App default settings seed all four modes to default", () => {
  const settingsStore = readFileSync("src/main/settings/SettingsStore.ts", "utf8");
  const app = readFileSync("src/renderer/src/App.tsx", "utf8");
  for (const field of [
    "chatBodyLineHeight",
    "chatBlockGap",
    "chatListDensity",
    "chatCodeDensity",
  ]) {
    assert.match(settingsStore, new RegExp(field + ': "default"'));
    assert.match(app, new RegExp(field + ': "default"'));
  }
});

test("chat typography token injection is a useLayoutEffect kept on the existing visual-token effect", () => {
  const app = readFileSync("src/renderer/src/App.tsx", "utf8");
  // 视觉 token（字号/行距/块距/列表密度/代码密度/自定义字体）必须用 useLayoutEffect：
  // 这些 CSS 变量要在 paint 前写入，否则首帧先展示 CSS 默认值再切到用户值（行距 1.35 → 1.2 收缩闪动）。
  assert.match(app, /\s*useLayoutEffect\(\(\) => \{\n    const root = document\.documentElement/);
  // 依赖数组必须覆盖全部行距/字号/字体来源设置项。
  const deps = [
    "settings.fontSize",
    "settings.uiFontSize",
    "settings.chatFontSize",
    "settings.inputFontSize",
    "settings.chatBodyLineHeight",
    "settings.chatBlockGap",
    "settings.chatListDensity",
    "settings.chatCodeDensity",
    "settings.fontFamilyBase",
    "settings.fontFamilyBaseCustom",
    "settings.fontFamilyMono",
    "settings.fontFamilyMonoCustom",
  ];
  for (const dep of deps) {
    assert.ok(app.includes(dep), "typography effect deps must include " + dep);
  }
  assert.match(app, /root\.style\.setProperty\(name, value\)/);
});
