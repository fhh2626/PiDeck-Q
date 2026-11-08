import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { computeThinkingDisplay } = loadTsCommonJs(
  "src/renderer/src/utils/thinkingDisplay.ts",
);

// vm realm 对象原型与测试 realm 不同，deepStrictEqual 会误判，改用 JSON 比较
function assertDisplay(actual, expected) {
  assert.equal(JSON.stringify(actual), JSON.stringify(expected));
}

/**
 * issue #146：运行中切换思考强度。
 * pi 的 set_thinking_level 在流式生成中也生效（下一轮生成），
 * 因此 UI 需要「xhigh->max」式的待生效指示。本测试锁定：
 * 1) 纯推导函数的行为；
 * 2) 渲染层关键接线（thinking 按钮 busy 时可用、pending 设置/清除契约）。
 */
test("computeThinkingDisplay: 无待生效切换时展示当前档位", () => {
  assertDisplay(computeThinkingDisplay("xhigh", undefined), {
    levels: ["xhigh"],
    pending: false,
  });
});

test("computeThinkingDisplay: 有待生效切换时展示 from->to", () => {
  assertDisplay(
    computeThinkingDisplay("max", { from: "xhigh", to: "max" }),
    { levels: ["xhigh", "max"], pending: true },
  );
});

test("computeThinkingDisplay: 无任何档位信息时返回空序列", () => {
  assertDisplay(computeThinkingDisplay(undefined, undefined), {
    levels: [],
    pending: false,
  });
});

test("computeThinkingDisplay: 待生效切换优先于当前档位展示", () => {
  // 切换成功后 runtime state 立即变为新档位（pi 的 get_state 返回新值），
  // 但飞行中的生成仍用旧档位——展示必须用 pending 的 from/to，而不是 current。
  assertDisplay(
    computeThinkingDisplay("max", { from: "xhigh", to: "max" }),
    { levels: ["xhigh", "max"], pending: true },
  );
});

test("契约: thinking 按钮 busy 时可点（仅 Agent 启动中禁用）", () => {
  const components = readFileSync(
    "src/renderer/src/components/session/ComposerComponents.tsx",
    "utf8",
  );
  // 模板/模式仍随 disabled 禁用；thinking / 模型按钮有独立禁用位
  assert.match(components, /disabled=\{props\.disabled\}/);
  assert.match(components, /disabled=\{props\.thinkingDisabled\}/);
  assert.match(components, /disabled=\{props\.modelDisabled \?\? props\.disabled\}/);
  // 待生效指示必须接入底栏展示
  assert.match(components, /thinkingPending\?: ThinkingLevelPending/);
  assert.match(components, /thinkingDisplay\.levels\.map/);
});

test("契约: ComposerArea 传 thinkingDisabled=isStarting（不含 isBusy）", () => {
  const area = readFileSync(
    "src/renderer/src/components/session/ComposerArea.tsx",
    "utf8",
  );
  // 全局禁用仍含 isBusy（模板/附件等）；思考与模型按钮只被启动中禁用
  assert.match(area, /disabled=\{composer\.isBusy \|\| composer\.isStarting\}/);
  assert.match(area, /thinkingDisabled=\{composer\.isStarting\}/);
  assert.match(area, /modelDisabled=\{composer\.isStarting\}/);
  // 流式结束（没有进行中的生成）时清除待生效指示
  assert.match(area, /!isStreaming && thinkingPendingMap\[props\.sessionId\]/);
});

test("契约: 流式生成中切换才记录待生效指示", () => {
  const picker = readFileSync(
    "src/renderer/src/components/session/ComposerPickerHost.tsx",
    "utf8",
  );
  assert.match(picker, /if \(runtime\?\.state\?\.isStreaming\)/);
  assert.match(picker, /setThinkingPendingMap\(\(prev\) => \(\{ \.\.\.prev, \[sessionId\]: \{ from, to: effectiveLevel \} \}\)/);
  // pi 会按运行中模型快照钳制档位：记录/待生效指示必须使用 pi 实际接受的值
  assert.match(picker, /const reportedLevel = agentState\.thinkingLevel/);
  assert.match(picker, /reportedLevel && reportedLevel\.length > 0 \? reportedLevel : level/);
  // 连续切换时保留首次 from（当前生效档位不变，仍是最初的旧档位）
  assert.match(picker, /thinkingPending\?\.from \?\? runtime\.state\.thinkingLevel/);
});
