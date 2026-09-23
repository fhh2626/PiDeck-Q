import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const {
	STREAM_LIGHT_MAX_CHARS,
	STREAM_UNFREEZABLE_MIN_CHARS,
	SETTLE_FULL_MAX_CHARS,
	shouldRenderStreamPlain,
	shouldKeepLightOnSettle,
	splitPlainStreamParagraphs,
} = loadTsCommonJs("src/renderer/src/components/session/markdownStreamPolicy.ts");

test("阈值常量存在且符合治理口径", () => {
	assert.equal(STREAM_LIGHT_MAX_CHARS, 40_000);
	assert.equal(STREAM_UNFREEZABLE_MIN_CHARS, 8_000);
	assert.equal(SETTLE_FULL_MAX_CHARS, 150_000);
});

test("shouldRenderStreamPlain：非流式永不回退纯文本", () => {
	assert.equal(shouldRenderStreamPlain({ isStreaming: false, textLength: 50_000, prefixEnd: 0 }), false);
	assert.equal(shouldRenderStreamPlain({ isStreaming: false, textLength: 10_000, prefixEnd: 0 }), false);
});

test("shouldRenderStreamPlain：流式整体超长（>40K）无条件纯文本，与冻结状态无关", () => {
	assert.equal(shouldRenderStreamPlain({ isStreaming: true, textLength: 50_000, prefixEnd: 0 }), true);
	assert.equal(shouldRenderStreamPlain({ isStreaming: true, textLength: 50_000, prefixEnd: 1024 }), true);
	assert.equal(shouldRenderStreamPlain({ isStreaming: true, textLength: 40_000, prefixEnd: undefined }), false);
});

test("shouldRenderStreamPlain：流式不可冻结（prefixEnd=0）超过小阈值才纯文本（每帧全量重渲染兜底）", () => {
	assert.equal(shouldRenderStreamPlain({ isStreaming: true, textLength: 10_000, prefixEnd: 0 }), true);
	assert.equal(shouldRenderStreamPlain({ isStreaming: true, textLength: 8_001, prefixEnd: 0 }), true);
	// 边界：恰好等于小阈值不触发（富渲染成本可忽略）
	assert.equal(shouldRenderStreamPlain({ isStreaming: true, textLength: 8_000, prefixEnd: 0 }), false);
	// 小消息不可冻结：保持富渲染
	assert.equal(shouldRenderStreamPlain({ isStreaming: true, textLength: 2_000, prefixEnd: 0 }), false);
});

test("shouldRenderStreamPlain：可冻结（prefixEnd>0）或未运行冻结时不回退", () => {
	assert.equal(shouldRenderStreamPlain({ isStreaming: true, textLength: 10_000, prefixEnd: 42 }), false);
	assert.equal(shouldRenderStreamPlain({ isStreaming: true, textLength: 30_000, prefixEnd: undefined }), false);
});

test("splitPlainStreamParagraphs：空白行分段且保留冻结边界", () => {
	const paragraphs = splitPlainStreamParagraphs("第一段\n仍在同段\n\n第二段", 0);
	assert.equal(paragraphs.frozen.length, 0);
	assert.equal(paragraphs.live.length, 2);
	assert.equal(paragraphs.live[0], "第一段\n仍在同段");
	assert.equal(paragraphs.live[1], "第二段");

	const frozen = splitPlainStreamParagraphs("abcd\n\nefgh", 6);
	assert.equal(frozen.frozen.length, 1);
	assert.equal(frozen.frozen[0], "abcd");
	assert.equal(frozen.live.length, 1);
	assert.equal(frozen.live[0], "efgh");

	const acrossSeparator = splitPlainStreamParagraphs("abcd\n\nefgh", 8);
	assert.equal(acrossSeparator.frozen.length, 2);
	assert.equal(acrossSeparator.frozen[0], "abcd");
	assert.equal(acrossSeparator.frozen[1], "efgh");
	assert.equal(acrossSeparator.live.length, 0);

	const splitNewline = splitPlainStreamParagraphs("段落一\n\n段落二", "段落一\n".length);
	assert.equal(splitNewline.frozen.length, 1);
	assert.equal(splitNewline.frozen[0], "段落一");
	assert.equal(splitNewline.live.length, 1);
	assert.equal(splitNewline.live[0], "段落二");
});

test("shouldKeepLightOnSettle：超大内容 settle 后保持轻量插件（防 GB 级 DOM）", () => {
	assert.equal(shouldKeepLightOnSettle(150_000), false);
	assert.equal(shouldKeepLightOnSettle(150_001), true);
	assert.equal(shouldKeepLightOnSettle(10_000), false);
});
