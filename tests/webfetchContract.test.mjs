import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Value } from "../node_modules/@earendil-works/pi-coding-agent/node_modules/typebox/build/value/index.mjs";
import { makeStrictJsonSchema } from "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/api/constrained-sampling.js";
import { loadExtensions } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";

const srcSource = readFileSync("resources/extensions/pideck-q-webfetch/src/index.mjs", "utf8");
const distSource = readFileSync("resources/extensions/pideck-q-webfetch/dist/index.mjs", "utf8");
const webfetchDistPath = resolve("resources/extensions/pideck-q-webfetch/dist/index.mjs");

// 辅助函数：通过真实 extension loader 加载 webfetch 扩展并获取真实注册的 tool
async function getRealWebFetchTool() {
	const { extensions, errors } = await loadExtensions([webfetchDistPath], process.cwd());
	assert.equal(errors.length, 0, `Extension load errors: ${errors.map((e) => e.message).join(", ")}`);
	const ext = extensions.find((e) => e.tools.has("webfetch"));
	assert.ok(ext, "webfetch extension must be loaded");
	return ext.tools.get("webfetch").definition;
}

test("WebFetch: source code parameter schema and execute normalization contract", () => {
	for (const [name, source] of [["src", srcSource], ["dist", distSource]]) {
		// script, offset, max_length 必须为 Type.Union
		assert.match(source, /script:\s*Type\.Optional\(\s*Type\.Union\(\[/, `${name}: script 必须为 Type.Union`);
		assert.match(source, /offset:\s*Type\.Optional\(\s*Type\.Union\(\[/, `${name}: offset 必须为 Type.Union`);
		assert.match(source, /max_length:\s*Type\.Optional\(\s*Type\.Union\(\[/, `${name}: max_length 必须为 Type.Union`);

		// execute 入口必须使用 nullish coalescing (??) 归一化
		assert.match(source, /params\.script\s*\?\?\s*(?:undefined|void 0)/, `${name}: scriptIndex 必须归一化为 params.script ?? undefined / void 0`);
		assert.match(source, /params\.offset\s*\?\?\s*0/, `${name}: offset 必须归一化为 params.offset ?? 0`);
		assert.match(source, /params\.max_length\s*\?\?\s*config\.maxPageLength/, `${name}: maxLength 必须使用 ?? 归一化`);

		// 脚本查找条件必须保留 scriptIndex !== undefined / void 0，禁止写成 if (scriptIndex)
		assert.match(source, /if\s*\(\s*scriptIndex\s*!==\s*(?:undefined|void 0)\s*\)/, `${name}: 必须严格判断 scriptIndex !== undefined / void 0`);
		assert.doesNotMatch(source, /if\s*\(\s*scriptIndex\s*\)\s*\{/, `${name}: 禁止改成 if (scriptIndex)`);

		// 不存在脚本时的错误提示必须指导正文请求省略或传 null
		assert.match(source, /For page or file content, omit script or pass null\./, `${name}: 脚本未找到错误必须包含使用指引`);
	}
});

test("WebFetch: real registered tool schema validation under TypeBox and makeStrictJsonSchema", async () => {
	const tool = await getRealWebFetchTool();
	const realSchema = tool.parameters;
	assert.ok(realSchema, "Real tool must have parameters schema");
	assert.equal(realSchema.type, "object");

	// 1. 仅提供 url
	assert.equal(Value.Check(realSchema, { url: "https://example.com" }), true, "仅传 url 必须被接受");

	// 2. script, offset, max_length 分别为 null
	assert.equal(Value.Check(realSchema, { url: "https://example.com", script: null }), true, "script: null 必须被接受");
	assert.equal(Value.Check(realSchema, { url: "https://example.com", offset: null }), true, "offset: null 必须被接受");
	assert.equal(Value.Check(realSchema, { url: "https://example.com", max_length: null }), true, "max_length: null 必须被接受");

	// 3. 三个可选参数全部为 null
	const allNullPayload = {
		url: "https://example.com/raw.txt",
		script: null,
		offset: null,
		max_length: null
	};
	assert.equal(Value.Check(realSchema, allNullPayload), true, "全部为 null 必须被接受");

	// 4. script: 0, offset: 0, 合法 max_length
	const zeroIndexPayload = {
		url: "https://example.com/page.html",
		script: 0,
		offset: 0,
		max_length: 5000
	};
	assert.equal(Value.Check(realSchema, zeroIndexPayload), true, "0 索引与合法数值必须被接受");

	// 5. 数字参数传字符串或对象 -> 拒绝
	assert.equal(Value.Check(realSchema, { url: "https://example.com", script: "0" }), false, "script 字符串必须被拒绝");
	assert.equal(Value.Check(realSchema, { url: "https://example.com", offset: "10" }), false, "offset 字符串必须被拒绝");
	assert.equal(Value.Check(realSchema, { url: "https://example.com", max_length: {} }), false, "max_length 对象必须被拒绝");

	// 6. 缺少 url -> 拒绝
	assert.equal(Value.Check(realSchema, { script: 0 }), false, "缺少 url 必须被拒绝");

	// 7. makeStrictJsonSchema 转换校验
	const strictSchema = makeStrictJsonSchema(realSchema);
	assert.deepEqual(strictSchema.required, ["url", "script", "offset", "max_length"], "strict 模式必须将所有属性设为 required");
	assert.equal(strictSchema.additionalProperties, false);

	// 确认 strictSchema 接受全 null 负载
	assert.equal(Value.Check(strictSchema, allNullPayload), true, "strictSchema 必须接受包含 null 的合法负载");

	// 确认原始 schema 未被破坏（仍只要求 url）
	assert.deepEqual(realSchema.required, ["url"], "原始 realSchema.required 必须保持仅包含 url");
});

test("WebFetch: schema sensitivity test (rejects null if Type.Null is removed)", async () => {
	const tool = await getRealWebFetchTool();
	const realSchema = tool.parameters;

	// 内存派生一个移除了 null 分支的 schema（模拟原 bug 状态）
	const brokenSchema = structuredClone(realSchema);
	// 将 script / offset / max_length 替换为单纯的 number
	brokenSchema.properties.script = { type: "number", description: "Index of an inline script" };
	brokenSchema.properties.offset = { type: "number", description: "Starting position" };
	brokenSchema.properties.max_length = { type: "number", description: "Max chars" };

	// 验证：当没有 Type.Null() 时，传入 null 会被 Value.Check 明确拒绝
	assert.equal(Value.Check(brokenSchema, { url: "https://example.com", script: null }), false, "无 Null 类型的 brokenSchema 必须拒绝 script: null");
	assert.equal(Value.Check(brokenSchema, { url: "https://example.com", offset: null }), false, "无 Null 类型的 brokenSchema 必须拒绝 offset: null");
	assert.equal(Value.Check(brokenSchema, { url: "https://example.com", max_length: null }), false, "无 Null 类型的 brokenSchema 必须拒绝 max_length: null");

	// 而真实 realSchema 必须接受
	assert.equal(Value.Check(realSchema, { url: "https://example.com", script: null }), true, "真实 schema 必须接受 script: null");
	assert.equal(Value.Check(realSchema, { url: "https://example.com", offset: null }), true, "真实 schema 必须接受 offset: null");
	assert.equal(Value.Check(realSchema, { url: "https://example.com", max_length: null }), true, "真实 schema 必须接受 max_length: null");
});
