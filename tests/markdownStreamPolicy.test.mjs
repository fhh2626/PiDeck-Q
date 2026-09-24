import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const {
	STREAM_LIGHT_MAX_CHARS,
	STREAM_UNFREEZABLE_MIN_CHARS,
	SETTLE_FULL_MAX_CHARS,
	createIncrementalStreamParagraphsSplitter,
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
	const result = splitPlainStreamParagraphs("第一段\n仍在同段\n\n第二段", 0);
	assert.equal(result.paragraphs.length, 2);
	assert.equal(result.paragraphs[0].frozen, "");
	assert.equal(result.paragraphs[0].live, "第一段\n仍在同段");
	assert.equal(result.paragraphs[1].frozen, "");
	assert.equal(result.paragraphs[1].live, "第二段");
	assert.equal(result.frozen.length, 0);
	assert.equal(result.live.length, 2);

	const frozen = splitPlainStreamParagraphs("abcd\n\nefgh", 6);
	assert.equal(frozen.paragraphs.length, 2);
	assert.equal(frozen.paragraphs[0].frozen, "abcd");
	assert.equal(frozen.paragraphs[0].live, "");
	assert.equal(frozen.paragraphs[1].frozen, "");
	assert.equal(frozen.paragraphs[1].live, "efgh");
	assert.equal(frozen.frozen.length, 1);
	assert.equal(frozen.frozen[0], "abcd");
	assert.equal(frozen.live.length, 1);
	assert.equal(frozen.live[0], "efgh");

	const acrossSeparator = splitPlainStreamParagraphs("abcd\n\nefgh", 8);
	assert.equal(acrossSeparator.paragraphs.length, 2);
	assert.equal(acrossSeparator.paragraphs[0].frozen, "abcd");
	assert.equal(acrossSeparator.paragraphs[0].live, "");
	assert.equal(acrossSeparator.paragraphs[1].frozen, "ef");
	assert.equal(acrossSeparator.paragraphs[1].live, "gh");

	const splitNewline = splitPlainStreamParagraphs("段落一\n\n段落二", "段落一\n".length);
	assert.equal(splitNewline.paragraphs.length, 2);
	assert.equal(splitNewline.paragraphs[0].frozen, "段落一");
	assert.equal(splitNewline.paragraphs[0].live, "");
	assert.equal(splitNewline.paragraphs[1].frozen, "");
	assert.equal(splitNewline.paragraphs[1].live, "段落二");
});

test("splitPlainStreamParagraphs：4096 字符边界与单换行/跨边界换行", () => {
	// 1. "a".repeat(4096) + "b\nc"：b\nc 属同一段，单换行不产生新段落
	const text1 = "a".repeat(4096) + "b\nc";
	const res1 = splitPlainStreamParagraphs(text1, 4096);
	assert.equal(res1.paragraphs.length, 1);
	assert.equal(res1.paragraphs[0].frozen, "a".repeat(4096));
	assert.equal(res1.paragraphs[0].live, "b\nc");
	assert.equal(res1.paragraphs[0].frozen + res1.paragraphs[0].live, text1);

	// 2. "a".repeat(4095) + "\n\nb"：跨冻结边界的两个换行确实分成两段
	const text2 = "a".repeat(4095) + "\n\nb";
	const res2 = splitPlainStreamParagraphs(text2, 4096);
	assert.equal(res2.paragraphs.length, 2);
	assert.equal(res2.paragraphs[0].frozen, "a".repeat(4095));
	assert.equal(res2.paragraphs[0].live, "");
	assert.equal(res2.paragraphs[1].frozen, "");
	assert.equal(res2.paragraphs[1].live, "b");

	// 3. 冻结边界位于空行内部（例如 \n\n 处于 4095..4097，frozenEnd 为 4096）
	const text3 = "para1\n\npara2";
	const boundaryInSeparator = splitPlainStreamParagraphs(text3, 6); // "para1" 是 0..5, \n\n 是 5..7
	assert.equal(boundaryInSeparator.paragraphs.length, 2);
	assert.equal(boundaryInSeparator.paragraphs[0].frozen, "para1");
	assert.equal(boundaryInSeparator.paragraphs[0].live, "");
	assert.equal(boundaryInSeparator.paragraphs[1].frozen, "");
	assert.equal(boundaryInSeparator.paragraphs[1].live, "para2");

	// 4. 多行单换行保留在同一段内
	const multiSingleNewline = "line1\nline2\nline3";
	const res4 = splitPlainStreamParagraphs(multiSingleNewline, 5);
	assert.equal(res4.paragraphs.length, 1);
	assert.equal(res4.paragraphs[0].frozen, "line1");
	assert.equal(res4.paragraphs[0].live, "\nline2\nline3");
	assert.equal(res4.paragraphs[0].frozen + res4.paragraphs[0].live, multiSingleNewline);

	// 5. 流式文本逐步增长时，冻结段不丢失不重复
	let streamed = "段落一\n继续\n\n段落二";
	const step1 = splitPlainStreamParagraphs(streamed, 4);
	assert.equal(step1.paragraphs[0].frozen + step1.paragraphs[0].live, "段落一\n继续");
	assert.equal(step1.paragraphs[1].frozen + step1.paragraphs[1].live, "段落二");

	streamed += "更新文字\n同段";
	const step2 = splitPlainStreamParagraphs(streamed, 4);
	assert.equal(step2.paragraphs[0].frozen + step2.paragraphs[0].live, "段落一\n继续");
	assert.equal(step2.paragraphs[1].frozen + step2.paragraphs[1].live, "段落二更新文字\n同段");
});

test("shouldKeepLightOnSettle：超大内容 settle 后保持轻量插件（防 GB 级 DOM）", () => {
	assert.equal(shouldKeepLightOnSettle(150_000), false);
	assert.equal(shouldKeepLightOnSettle(150_001), true);
	assert.equal(shouldKeepLightOnSettle(10_000), false);
});

test("createIncrementalStreamParagraphsSplitter：逐步增长结果与基准纯函数严格一致，且复用冻结段对象引用", () => {
	const splitter = createIncrementalStreamParagraphsSplitter();

	// 1. 构建一段多段落逐步增长的流式文本：
	// 段落一（~100 字符）与段落二（~2000 字符）均在 split (4096) 之前闭合；
	// 段落三横跨 split 边界，并在后续增量中继续追加
	const basePara1 = "段落一：第一行\n段落一：第二行\n\n";
	const basePara2 = "段落二：".padEnd(2000, "x") + "\n\n";
	const basePara3 = "段落三：".padEnd(2500, "y");
	let streamed = basePara1 + basePara2 + basePara3;
	const split = 4096;

	let lastRes = splitter.split(streamed, split);
	let baseline = splitPlainStreamParagraphs(streamed, split);
	assert.deepEqual(lastRes, baseline);

	// 记录已闭合段落的对象引用
	const para1Ref = lastRes.paragraphs[0];
	const para2Ref = lastRes.paragraphs[1];

	// 2. 尾部追加若干字符（不改变 split 且在同一区间）
	streamed += "正在流式输入...";
	let newRes = splitter.split(streamed, split);
	baseline = splitPlainStreamParagraphs(streamed, split);
	assert.deepEqual(newRes, baseline);

	// 验证在 split 之前已闭合的冻结段落对象引用完全一致（无 GC 压力、无重复重建）
	assert.equal(newRes.paragraphs[0], para1Ref, "第一段对象引用必须复用");
	assert.equal(newRes.paragraphs[1], para2Ref, "第二段对象引用必须复用");

	// 3. 尾部跨空行追加第四段
	streamed += "\n\n段落四：第四段内容";
	newRes = splitter.split(streamed, split);
	baseline = splitPlainStreamParagraphs(streamed, split);
	assert.deepEqual(newRes, baseline);
	assert.equal(newRes.paragraphs[0], para1Ref);
	assert.equal(newRes.paragraphs[1], para2Ref);

	// 4. 边界处正好拆分换行符：split 在 \n 内部
	const boundarySplitter = createIncrementalStreamParagraphsSplitter();
	const acrossBoundary = "a".repeat(4095) + "\n\nb";
	const resAcross = boundarySplitter.split(acrossBoundary, 4096);
	assert.deepEqual(resAcross, splitPlainStreamParagraphs(acrossBoundary, 4096));

	// 5. 前缀改写时正确失效重建
	const rewritten = "段落改写：" + streamed.slice(5);
	const rewrittenRes = splitter.split(rewritten, split);
	assert.deepEqual(rewrittenRes, splitPlainStreamParagraphs(rewritten, split));
	assert.notEqual(rewrittenRes.paragraphs[0], para1Ref, "前缀改写后不得复用旧引用");
});

test("createIncrementalStreamParagraphsSplitter：覆盖单段超长、无空行与文本重置", () => {
	const splitter = createIncrementalStreamParagraphsSplitter();

	// 单段长于多个 4096 区间但无空行
	const longSingle = "long text ".repeat(1000);
	const r1 = splitter.split(longSingle, 4096);
	assert.deepEqual(r1, splitPlainStreamParagraphs(longSingle, 4096));
	assert.equal(r1.paragraphs.length, 1);

	// 文本重置为空
	const rEmpty = splitter.split("", 0);
	assert.deepEqual(rEmpty, splitPlainStreamParagraphs("", 0));

	// 重新开始流式
	const rNew = splitter.split("新流式开始", 0);
	assert.deepEqual(rNew, splitPlainStreamParagraphs("新流式开始", 0));
});

test("createIncrementalStreamParagraphsSplitter：4096→8192 步进边界跃迁序列增长，且改写旧前缀正确失效", () => {
	const splitter = createIncrementalStreamParagraphsSplitter();

	// 构造包含多段落且跨 4096 和 8192 边界的内容
	const p1 = "段落一：".padEnd(2000, "a") + "\n\n";
	const p2 = "段落二：".padEnd(2000, "b") + "\n\n"; // 到此约 4010 字符
	const p3 = "段落三：".padEnd(4100, "c") + "\n\n"; // 到此约 8120 字符
	const p4 = "段落四：".padEnd(2000, "d");

	const fullText = p1 + p2 + p3 + p4;

	// 覆盖 4095、4096、4097、8191、8192、8193 等关键边界
	const checkpoints = [
		1000,
		4095, 4096, 4097,
		6000,
		8191, 8192, 8193,
		fullText.length,
	];

	for (const len of checkpoints) {
		const currentText = fullText.slice(0, len);
		const split = Math.floor(currentText.length / 4096) * 4096;
		const actual = splitter.split(currentText, split);
		const expected = splitPlainStreamParagraphs(currentText, split);
		assert.deepEqual(
			actual,
			expected,
			`mismatch at text length ${len} with split ${split}`,
		);
	}

	// 跃迁至 8192 之后，改写前缀字符，验证缓存失效重建结果仍与纯函数基准严格一致
	const finalSplit = Math.floor(fullText.length / 4096) * 4096;
	const rewritten = "改写开头：" + fullText.slice(100);
	const rewrittenActual = splitter.split(rewritten, finalSplit);
	const rewrittenExpected = splitPlainStreamParagraphs(rewritten, finalSplit);
	assert.deepEqual(rewrittenActual, rewrittenExpected);
});
