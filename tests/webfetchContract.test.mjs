import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { loadPiCompatibilityModules } from "./helpers/piCompatibilityModules.mjs";

const { Value, makeStrictJsonSchema, loadExtensions } = await loadPiCompatibilityModules();

const webfetchDistPath = resolve("resources/extensions/pideck-q-webfetch/dist/index.mjs");
const webfetchSrcPath = resolve("resources/extensions/pideck-q-webfetch/src/index.mjs");

// 辅助函数：通过真实 extension loader 加载 webfetch 扩展并获取真实注册的 tool
async function getRealWebFetchTool() {
	const { extensions, errors } = await loadExtensions([webfetchDistPath], process.cwd());
	assert.equal(errors.length, 0, `Extension load errors: ${errors.map((e) => e.message).join(", ")}`);
	const ext = extensions.find((e) => e.tools.has("webfetch"));
	assert.ok(ext, "webfetch extension must be loaded");
	return ext.tools.get("webfetch").definition;
}

// 通过真实 extension loader 加载指定入口（src 与 dist 都要守住：dist 是实际随包发布的产物）
async function loadWebFetchTool(entryPath) {
	const { extensions, errors } = await loadExtensions([entryPath], process.cwd());
	assert.equal(errors.length, 0, `Extension load errors: ${errors.map((e) => e.message).join(", ")}`);
	return extensions.find((e) => e.tools.has("webfetch")).tools.get("webfetch").definition;
}

/** 以假 fetch 提供页面内容，避免真实网络；调用结束后必须还原 globalThis.fetch。 */
async function withFakeFetch(handler, run) {
	const original = globalThis.fetch;
	const requested = [];
	globalThis.fetch = async (url) => {
		requested.push(String(url));
		return handler(String(url));
	};
	try {
		return await run(requested);
	} finally {
		globalThis.fetch = original;
	}
}

const HTML_WITH_SCRIPTS = `<!doctype html><html><head><title>t</title></head><body><p>${"hello page body ".repeat(20)}</p>`
	+ `<script>var firstScript = 1;</script><script>var secondScript = 2;</script></body></html>`;
const htmlResponse = () => new Response(HTML_WITH_SCRIPTS, { status: 200, headers: { "content-type": "text/html" } });
const textResponse = (body) => new Response(body, { status: 200, headers: { "content-type": "text/plain" } });

for (const [name, entryPath] of [["src", webfetchSrcPath], ["dist", webfetchDistPath]]) {
	test(`WebFetch execute (${name}): script/offset/max_length null return the normal page, same as omitted`, async () => {
		// 回归：部分模型 / strict schema 会把可选参数显式传 null；null 必须归一化为「默认值」而不是报错或当作脚本索引。
		const tool = await loadWebFetchTool(entryPath);
		const nullParams = { url: "https://null-params.example.com/page", script: null, offset: null, max_length: null };
		const omitted = { url: "https://omitted-params.example.com/page" };
		await withFakeFetch(htmlResponse, async () => {
			const withNull = await tool.execute("call-1", nullParams, undefined, undefined, {});
			const without = await tool.execute("call-2", omitted, undefined, undefined, {});
			assert.equal(withNull.details.offset, 0);
			assert.equal(withNull.details.truncated, false);
			assert.match(withNull.details.content, /hello page body/);
			assert.equal(withNull.details.content, without.details.content);
			assert.equal(withNull.details.total_length, without.details.total_length);
			assert.match(withNull.content[0].text, /Inline scripts \(2/, "页面正文结果必须附带脚本索引");
		});
	});

	test(`WebFetch execute (${name}): script index 0 reads the first inline script instead of the page`, async () => {
		// 回归：0 是合法脚本索引；若把判断写成 if (scriptIndex) 会被当作「未指定」而返回正文。
		const tool = await loadWebFetchTool(entryPath);
		await withFakeFetch(htmlResponse, async () => {
			const first = await tool.execute("c", { url: "https://script-zero.example.com/p", script: 0 }, undefined, undefined, {});
			assert.equal(first.details.content, "var firstScript = 1;");
			assert.match(first.content[0].text, /script 0/);
			const second = await tool.execute("c", { url: "https://script-zero.example.com/p", script: 1 }, undefined, undefined, {});
			assert.equal(second.details.content, "var secondScript = 2;");
		});
	});

	test(`WebFetch execute (${name}): unknown script index fails with guidance to omit script or pass null`, async () => {
		const tool = await loadWebFetchTool(entryPath);
		await withFakeFetch(htmlResponse, async () => {
			await assert.rejects(
				() => tool.execute("c", { url: "https://script-missing.example.com/p", script: 9 }, undefined, undefined, {}),
				(error) => {
					assert.match(error.message, /Script 9 not found\. Available indices: 0, 1\./);
					assert.match(error.message, /omit script or pass null/);
					return true;
				},
			);
		});
	});

	test(`WebFetch execute (${name}): null max_length falls back to the default page size and offset paginates`, async () => {
		const tool = await loadWebFetchTool(entryPath);
		const body = "a".repeat(25_000);
		await withFakeFetch(() => textResponse(body), async () => {
			const firstPage = await tool.execute("c", { url: "https://paging.example.com/big.txt", max_length: null, offset: null }, undefined, undefined, {});
			assert.equal(firstPage.details.returned_length, 20_000, "默认 maxPageLength 为 20000");
			assert.equal(firstPage.details.truncated, true);
			const secondPage = await tool.execute("c", { url: "https://paging.example.com/big.txt", offset: 20_000, max_length: null }, undefined, undefined, {});
			assert.equal(secondPage.details.offset, 20_000);
			assert.equal(secondPage.details.returned_length, 5_000);
			assert.equal(secondPage.details.truncated, false);
			const custom = await tool.execute("c", { url: "https://paging.example.com/big.txt", max_length: 100 }, undefined, undefined, {});
			assert.equal(custom.details.returned_length, 100);
		});
	});
}
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
