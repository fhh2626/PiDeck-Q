// 视觉桥块提取的行为测试：从消息文本中识别「视觉桥已查看/转换失败」标记块，
// 返回结构化卡片数据 + 剥除标记后的正文。
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { extractVisionBridgeBlocks } = loadTsCommonJs(
  "src/renderer/src/utils/visionBridgeBlocks.ts",
);

const SUCCESS_BLOCK = (n, desc) =>
  `[图片 #${n}（视觉桥已查看，以下为图片实际内容）]\n${desc}`;
const FAILED_BLOCK = (n, reason) =>
  `[图片 #${n} 视觉桥转换失败：${reason}。请检查视觉桥设置（模型/接口地址/API Key）后重试，此图片内容不可见]`;

test("无视觉桥标记时原样返回文本", () => {
  const result = extractVisionBridgeBlocks("看看这张图，帮我分析一下");
  assert.equal(result.blocks.length, 0);
  assert.equal(result.text, "看看这张图，帮我分析一下");
});

test("识别单个成功块：标记与描述分离，正文剥除标记", () => {
  const text = `看图说话\n\n${SUCCESS_BLOCK(1, "这是一张深色界面的截图，顶部有工具栏。")}`;
  const result = extractVisionBridgeBlocks(text);
  assert.equal(result.blocks.length, 1);
  // 注意：loadTsCommonJs 经 vm 加载，对象原型与测试 realm 不同，
  // deepStrictEqual 会因原型差异失败，故逐字段断言。
  assert.equal(result.blocks[0].kind, "success");
  assert.equal(result.blocks[0].index, 1);
  assert.equal(result.blocks[0].description, "这是一张深色界面的截图，顶部有工具栏。");
  assert.equal(result.text, "看图说话");
});

test("多图连续块按顺序归属各自描述", () => {
  const text = `${SUCCESS_BLOCK(1, "第一张图：浅色背景。")}\n\n${SUCCESS_BLOCK(2, "第二张图：包含一张表格。")}`;
  const result = extractVisionBridgeBlocks(text);
  assert.equal(result.blocks.length, 2);
  assert.equal(result.blocks[0].kind, "success");
  assert.equal(result.blocks[0].index, 1);
  assert.equal(result.blocks[0].description, "第一张图：浅色背景。");
  assert.equal(result.blocks[1].index, 2);
  assert.equal(result.blocks[1].description, "第二张图：包含一张表格。");
  assert.equal(result.text, "");
});

test("识别失败块并保留失败原因", () => {
  const text = `${FAILED_BLOCK(1, "timeout(30000ms)")}`;
  const result = extractVisionBridgeBlocks(text);
  assert.equal(result.blocks.length, 1);
  assert.equal(result.blocks[0].kind, "failed");
  assert.equal(result.blocks[0].index, 1);
  assert.equal(result.blocks[0].reason, "timeout(30000ms)");
  assert.equal(result.text, "");
});

test("成功块与失败块混合时互不串扰", () => {
  const text = `${SUCCESS_BLOCK(1, "第一张能看。")}\n\n${FAILED_BLOCK(2, "HTTP 401: unauthorized")}`;
  const result = extractVisionBridgeBlocks(text);
  assert.equal(result.blocks.length, 2);
  assert.equal(result.blocks[0].kind, "success");
  assert.equal(result.blocks[0].description, "第一张能看。");
  assert.equal(result.blocks[1].kind, "failed");
  assert.equal(result.blocks[1].reason, "HTTP 401: unauthorized");
  assert.equal(result.text, "");
});

test("纯文本消息中混有普通方括号内容不受影响", () => {
  const text = "请看 [图片 #1] 这样的引用方式";
  const result = extractVisionBridgeBlocks(text);
  assert.equal(result.blocks.length, 0);
  assert.equal(result.text, text);
});

test("描述文本包含多行时完整保留", () => {
  const text = `${SUCCESS_BLOCK(1, "第一行描述\n第二行描述\n- 列表项")}`;
  const result = extractVisionBridgeBlocks(text);
  assert.equal(result.blocks[0].description, "第一行描述\n第二行描述\n- 列表项");
});

test("无描述内容（图片转空）时正文为空", () => {
  const result = extractVisionBridgeBlocks(`[图片 #1（视觉桥已查看，以下为图片实际内容）]\n`);
  assert.equal(result.blocks.length, 1);
  assert.equal(result.blocks[0].description, "");
  assert.equal(result.text, "");
});

// ── matchVisionBridgeEvent：实时消息按图片哈希匹配视觉桥事件 ───────────

function makeEvent(ts, kind, items) {
  return { ts, kind, model: "m/m", prompt: "p", totalDurationMs: 1, items };
}

test("matchVisionBridgeEvent: 命中 ts 之后且哈希全中的 input 批次", () => {
  const { matchVisionBridgeEvent } = loadTsCommonJs(
    "src/renderer/src/utils/visionBridgeBlocks.ts",
  );
  const events = [
    makeEvent(1000, "input", [{ index: 1, imageHash: "h-a", ok: true }]),
    makeEvent(2000, "input", [{ index: 1, imageHash: "h-b", ok: true }]),
  ];
  const hit = matchVisionBridgeEvent(events, ["h-b"], 1500);
  assert.equal(hit.ts, 2000, "取发送后最近的匹配批次");
  const miss = matchVisionBridgeEvent(events, ["h-c"], 1500);
  assert.equal(miss, null);
});

test("matchVisionBridgeEvent: 早于发送时间的批次不算", () => {
  const { matchVisionBridgeEvent } = loadTsCommonJs(
    "src/renderer/src/utils/visionBridgeBlocks.ts",
  );
  const events = [makeEvent(1000, "input", [{ index: 1, imageHash: "h-a", ok: true }])];
  assert.equal(matchVisionBridgeEvent(events, ["h-a"], 2000), null);
});

test("matchVisionBridgeEvent: 批次里混入非本消息的图片则不匹配", () => {
  const { matchVisionBridgeEvent } = loadTsCommonJs(
    "src/renderer/src/utils/visionBridgeBlocks.ts",
  );
  const events = [
    makeEvent(1000, "input", [
      { index: 1, imageHash: "h-a", ok: true },
      { index: 2, imageHash: "h-x", ok: true },
    ]),
  ];
  assert.equal(matchVisionBridgeEvent(events, ["h-a"], 500), null, "别人的图混批次不能误配");
});

test("matchVisionBridgeEvent: 无哈希/空输入返回 null", () => {
  const { matchVisionBridgeEvent } = loadTsCommonJs(
    "src/renderer/src/utils/visionBridgeBlocks.ts",
  );
  assert.equal(matchVisionBridgeEvent(undefined, ["h-a"], 0), null);
  assert.equal(matchVisionBridgeEvent([], ["h-a"], 0), null);
  assert.equal(matchVisionBridgeEvent([makeEvent(1000, "input", [])], ["h-a"], 0), null);
  assert.equal(matchVisionBridgeEvent([makeEvent(1000, "input", [{ index: 1, ok: true }])], ["h-a"], 0), null);
});

// 「让路」批次（模型原生支持图片，扩展不转换）必须被识别成 skipped：
// 渲染层据此立刻停止等待，且不渲染任何转换卡片（旧版本会一直显示「视觉桥转换中」）。
test("classifyVisionBridgeMatch: 区分转换成功 / 扩展让路 / 未命中", () => {
  const { classifyVisionBridgeMatch } = loadTsCommonJs(
    "src/renderer/src/utils/visionBridgeBlocks.ts",
  );
  assert.equal(classifyVisionBridgeMatch(null), null);
  assert.equal(classifyVisionBridgeMatch(undefined), null);
  assert.equal(
    classifyVisionBridgeMatch(makeEvent(1000, "input", [{ index: 1, imageHash: "h-a", ok: true }])),
    "converted",
  );
  assert.equal(
    classifyVisionBridgeMatch({
      ...makeEvent(1000, "input", [{ index: 1, imageHash: "h-a", ok: true }]),
      skipped: true,
    }),
    "skipped",
  );
  // skipped 必须是布尔真值才认让路：老版本事件文件没有该字段
  assert.equal(
    classifyVisionBridgeMatch({
      ...makeEvent(1000, "input", [{ index: 1, imageHash: "h-a", ok: true }]),
      skipped: false,
    }),
    "converted",
  );
});
