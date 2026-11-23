import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

/**
 * Ask 提问 UI 状态机与应答构造（#ask-ui）：
 * - 纯逻辑：pickActiveAskRequest / buildAskResponse / serializeBatchAnswers
 * - 静态契约：渲染层使用提取的纯逻辑 + shadcn 组件与语义字号 token；
 *   主进程 select 无选项降级为 input（不再静默取消）。
 */

function loadAskUi() {
	const source = readFileSync("src/renderer/src/utils/askUi.ts", "utf8");
	const output = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
		fileName: "askUi.ts",
	}).outputText;
	const sandbox = { exports: {}, require: () => ({}) };
	vm.runInNewContext(output, sandbox, { filename: "askUi.ts" });
	return sandbox.exports;
}

function request(overrides) {
	return {
		agentId: "agent-1",
		requestId: "req-1",
		method: "input",
		title: "问题",
		...overrides,
	};
}

test("pickActiveAskRequest: 无请求返回 undefined", () => {
	const { pickActiveAskRequest } = loadAskUi();
	assert.equal(pickActiveAskRequest(undefined), undefined);
	assert.equal(pickActiveAskRequest({}), undefined);
	assert.equal(pickActiveAskRequest({ a: { status: "completed", request: request() } }), undefined);
});

test("pickActiveAskRequest: 单个 pending 返回该请求", () => {
	const { pickActiveAskRequest } = loadAskUi();
	const req = request({ requestId: "req-1", method: "select" });
	const picked = pickActiveAskRequest({ a: { status: "pending", request: req } });
	assert.equal(picked, req);
});

test("pickActiveAskRequest: 多 pending 返回最新到达的（不被旧请求遮蔽）", () => {
	const { pickActiveAskRequest } = loadAskUi();
	const oldReq = request({ requestId: "req-old", method: "select", title: "旧问题" });
	const newReq = request({ requestId: "req-new", method: "input", title: "新问题" });
	const picked = pickActiveAskRequest({
		old: { status: "pending", request: oldReq },
		new: { status: "pending", request: newReq },
	});
	assert.equal(picked, newReq);
});

test("pickActiveAskRequest: 过滤 responding 与 pending 之外的请求", () => {
	const { pickActiveAskRequest } = loadAskUi();
	const active = request({ requestId: "req-active" });
	const picked = pickActiveAskRequest({
		a: { status: "cancelled", request: request({ requestId: "a" }) },
		b: { status: "completed", request: request({ requestId: "b" }) },
		c: { status: "responding", request: active },
	});
	assert.equal(picked, active);
});

const json = (value) => JSON.stringify(value);

test("buildAskResponse: select/input/editor 回传 value", () => {
	const { buildAskResponse } = loadAskUi();
	assert.equal(json(buildAskResponse("select", "选项A")), json({ value: "选项A" }));
	assert.equal(json(buildAskResponse("input", "文本")), json({ value: "文本" }));
	assert.equal(json(buildAskResponse("editor", "多行\n内容")), json({ value: "多行\n内容" }));
});

test("buildAskResponse: confirm 回传 confirmed + value", () => {
	const { buildAskResponse } = loadAskUi();
	assert.equal(json(buildAskResponse("confirm", true, { confirmed: true })), json({ confirmed: true, value: true }));
	assert.equal(json(buildAskResponse("confirm", false, { confirmed: false })), json({ confirmed: false, value: false }));
});

test("buildAskResponse: 取消回传 cancelled", () => {
	const { buildAskResponse } = loadAskUi();
	assert.equal(json(buildAskResponse("input", undefined, { cancelled: true })), json({ cancelled: true }));
});

test("serializeBatchAnswers: 混合题型序列化并保留 label/wasCustom", () => {
	const { serializeBatchAnswers, batchAnswerLabel } = loadAskUi();
	const questions = [
		{ id: "b1", type: "select" },
		{ id: "b2", type: "confirm" },
		{ id: "b3", type: "input" },
	];
	const answers = {
		b1: "React",
		b2: true,
		b3: undefined,
	};
	const meta = {
		b1: { label: "React", wasCustom: false },
		b3: { label: "自定", wasCustom: true },
	};
	const parsed = JSON.parse(serializeBatchAnswers(questions, answers, meta));
	assert.equal(parsed.answers.length, 3);
	assert.deepEqual(parsed.answers[0], { id: "b1", type: "select", value: "React", label: "React", wasCustom: false });
	assert.deepEqual(parsed.answers[1], { id: "b2", type: "confirm", value: true, label: "true", wasCustom: false });
	assert.deepEqual(parsed.answers[2], { id: "b3", type: "input", value: null, label: "自定", wasCustom: true });
	// 无 meta 时 label 回退 batchAnswerLabel
	assert.equal(batchAnswerLabel(true), "true");
	assert.equal(batchAnswerLabel("x"), "x");
	assert.equal(batchAnswerLabel(undefined), "");
});

// ── 静态契约 ──

test("SessionRuntimeUiOverlay 使用提取的纯逻辑与语义字号 token", () => {
	const source = readFileSync("src/renderer/src/components/overlays/SessionRuntimeUiOverlay.tsx", "utf8");
	assert.match(source, /import \{[^}]*pickActiveAskRequest[^}]*\} from "\.\.\/\.\.\/utils\/askUi"/);
	assert.match(source, /import \{[^}]*buildAskResponse[^}]*\} from "\.\.\/\.\.\/utils\/askUi"/);
	assert.match(source, /import \{[^}]*serializeBatchAnswers[^}]*\} from "\.\.\/\.\.\/utils\/askUi"/);
	// 不再直接构造应答 payload（统一走 askUi.buildAskResponse）
	assert.doesNotMatch(source, /void answer\(\{ value/);
	assert.doesNotMatch(source, /void answer\(\{ confirmed/);
	// 选项按钮 shadcn outline 化 + 字号 token（不再硬编码 text-[13px]）
	assert.match(source, /variant="outline"/);
	assert.doesNotMatch(source, /text-\[13px\]/);
	assert.doesNotMatch(source, /text-\[11px\]/);
});

test("渲染层不再用 find 取第一个 pending 请求", () => {
	const source = readFileSync("src/renderer/src/components/overlays/SessionRuntimeUiOverlay.tsx", "utf8");
	assert.doesNotMatch(source, /Object\.values\(ui\.requests\)\.find/);
	assert.match(source, /pickActiveAskRequest\(ui\.requests\)/);
});
