/**
 * ask_question 结果规范化与主进程构造器测试（阶段 A）。
 * 覆盖 shared/askQuestion.ts（normalizer）与 main/pi/askQuestionResult.ts（builder）。
 * 测行为不测实现：从公开函数断言输出结构。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const {
	getAskQuestionResultFromMessage,
	normalizeAskQuestionResultSummary,
	normalizeAgentUiBatchQuestion,
} = loadTsCommonJs("src/shared/askQuestion.ts");

/* ── normalizer：从 ChatMessage.meta._askCard 收窄 ── */

test("getAskQuestionResultFromMessage returns undefined without _askCard", () => {
	assert.equal(getAskQuestionResultFromMessage({ meta: undefined }), undefined);
	assert.equal(getAskQuestionResultFromMessage({ meta: {} }), undefined);
	assert.equal(
		getAskQuestionResultFromMessage({ meta: { _askCard: null } }),
		undefined,
	);
});

test("normalizes a single answered question", () => {
	const summary = normalizeAskQuestionResultSummary({
		question: "Continue?",
		type: "confirm",
		answered: true,
		answer: true,
		answerLabel: "Yes",
	});
	assert.equal(summary.question, "Continue?");
	assert.equal(summary.type, "confirm");
	assert.equal(summary.answered, true);
	assert.equal(summary.answer, true);
	assert.equal(summary.answerLabel, "Yes");
	assert.equal(summary.cancelled, false);
});

test("falls back answered when the field is missing", () => {
	assert.equal(
		normalizeAskQuestionResultSummary({ question: "Q", answer: "A" }).answered,
		true,
	);
	assert.equal(
		normalizeAskQuestionResultSummary({ question: "Q", answer: null }).answered,
		false,
	);
	assert.equal(
		normalizeAskQuestionResultSummary({ question: "Q" }).answered,
		false,
	);
});

test("cancelled forces answered=false and answer=null", () => {
	const summary = normalizeAskQuestionResultSummary({
		question: "Pick",
		answered: true,
		answer: "first",
		answerLabel: "first",
		cancelled: true,
	});
	assert.equal(summary.cancelled, true);
	assert.equal(summary.answered, false);
	assert.equal(summary.answer, null);
	assert.equal(summary.answerLabel, undefined);
});

test("batch keeps every question with its answer", () => {
	const summary = normalizeAskQuestionResultSummary({
		questions: [
			{ question: "Runtime?", type: "select" },
			{ question: "Package manager?", type: "select" },
		],
		answers: [
			{ id: "q1", value: "node", label: "node", wasCustom: false },
			{ id: "q2", value: "pnpm", label: "pnpm", wasCustom: true },
		],
	});
	assert.equal(summary.questions.length, 2);
	assert.equal(summary.questions.map((item) => item.question).join("|"), "Runtime?|Package manager?");
	assert.equal(summary.questions.map((item) => item.answer).join("|"), "node|pnpm");
	assert.equal(summary.questions[0].answerLabel, "node");
});

test("batch aligns when questions outnumber answers", () => {
	const summary = normalizeAskQuestionResultSummary({
		questions: [{ question: "A?" }, { question: "B?" }],
		answers: [{ id: "a", value: "x", label: "x" }],
	});
	assert.equal(summary.questions.length, 2);
	assert.equal(summary.questions[0].answered, true);
	assert.equal(summary.questions[1].answered, false);
});

test("batch with only answers recovers question text from answer.id", () => {
	const summary = normalizeAskQuestionResultSummary({
		answers: [{ id: "q-1", value: "y", label: "y" }],
	});
	assert.equal(summary.questions.length, 1);
	assert.equal(summary.questions[0].question, "q-1");
});

test("keeps false as a valid answered boolean", () => {
	const summary = normalizeAskQuestionResultSummary({
		question: "Ok?",
		type: "confirm",
		answered: true,
		answer: false,
		answerLabel: "false",
	});
	assert.equal(summary.answered, true);
	assert.equal(summary.answer, false);
});

test("normalizes options (string and object forms)", () => {
	const summary = normalizeAskQuestionResultSummary({
		question: "Pick",
		options: ["a", { label: "b", description: "desc" }, 42, ""],
	});
	// cross-realm objects make deepStrictEqual flaky; compare the serialized shape instead.
	assert.equal(JSON.stringify(summary.options), JSON.stringify(["a", { label: "b", description: "desc" }]));
});

test("ignores unknown type and keeps undefined type", () => {
	assert.equal(
		normalizeAskQuestionResultSummary({ question: "Q", type: "weird" })
			.type,
		undefined,
	);
	assert.equal(
		normalizeAskQuestionResultSummary({ question: "Q", type: "select" })
			.type,
		"select",
	);
});

test("returns undefined for malformed structures", () => {
	assert.equal(normalizeAskQuestionResultSummary(undefined), undefined);
	assert.equal(normalizeAskQuestionResultSummary("text"), undefined);
	assert.equal(normalizeAskQuestionResultSummary({}), undefined);
	assert.equal(normalizeAskQuestionResultSummary({ question: "   " }), undefined);
	assert.equal(normalizeAskQuestionResultSummary({ questions: [] }), undefined);
});

/* ── P2：batch_ask 表单条目收窄（coordinator 边界防御） ── */

test("normalizeAgentUiBatchQuestion accepts a valid select question", () => {
	const q = normalizeAgentUiBatchQuestion({
		id: "runtime",
		type: "select",
		question: "Runtime?",
		options: ["node", { label: "deno", value: "deno", description: "fast" }, 42, null],
		allowOther: true,
		placeholder: "or type",
		prefill: "node",
	});
	assert.equal(q.id, "runtime");
	assert.equal(q.type, "select");
	assert.equal(q.question, "Runtime?");
	assert.equal(q.allowOther, true);
	assert.equal(q.placeholder, "or type");
	assert.equal(q.prefill, "node");
	// 选项里非法项（42 / null）被过滤，合法项保留。
	assert.equal(
		JSON.stringify(q.options),
		JSON.stringify(["node", { label: "deno", value: "deno", description: "fast" }]),
	);
});

test("normalizeAgentUiBatchQuestion drops questions missing hard deps", () => {
	// id / question / type 任一缺失 → 整题丢弃。
	assert.equal(normalizeAgentUiBatchQuestion({ id: "a", type: "select" }), undefined);
	assert.equal(normalizeAgentUiBatchQuestion({ id: "a", question: "Q?" }), undefined);
	assert.equal(
		normalizeAgentUiBatchQuestion({ id: "a", question: "Q?", type: "weird" }),
		undefined,
	);
	assert.equal(normalizeAgentUiBatchQuestion("not-a-record"), undefined);
	assert.equal(normalizeAgentUiBatchQuestion(null), undefined);
	assert.equal(normalizeAgentUiBatchQuestion([1, 2]), undefined);
});

test("normalizeAgentUiBatchQuestion tolerates blank-ish and partial options", () => {
	const q = normalizeAgentUiBatchQuestion({
		id: "b",
		type: "input",
		question: "Name?",
	// 空 label / 非字符串 label / 空数组都安全降级。
	options: [{ label: "" }, { label: 7 }, { label: "ok" }, ""],
	allowOther: "yes", // 非 boolean 的 allowOther 不当 true 处理
	placeholder: "",
});
assert.equal(q.type, "input");
// 对象选项保持对象形态（渲染层读 option.label），空/非法项被过滤。
assert.equal(JSON.stringify(q.options), JSON.stringify([{ label: "ok" }]));
assert.equal(q.allowOther, undefined);
assert.equal(q.placeholder, undefined);
});
