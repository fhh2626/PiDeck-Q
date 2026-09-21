import assert from "node:assert/strict";
import test from "node:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { loadExtensions } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import { Value } from "../node_modules/@earendil-works/pi-coding-agent/node_modules/typebox/build/value/index.mjs";

test("WebFetch: real registered tool parameter check and execution behavior", async () => {
	const webfetchDistPath = resolve("resources/extensions/pideck-q-webfetch/dist/index.mjs");
	const { extensions, errors } = await loadExtensions([webfetchDistPath], process.cwd());
	assert.equal(errors.length, 0);
	const tool = extensions.find((e) => e.tools.has("webfetch")).tools.get("webfetch").definition;

	const originalFetch = globalThis.fetch;
	try {
		// 1. null / 省略参数返回正文（执行前先通过真实 realSchema 参数校验）
		const nullParams = {
			url: "https://example.com/raw.txt",
			script: null,
			offset: null,
			max_length: null
		};
		assert.ok(Value.Check(tool.parameters, nullParams), "nullParams 必须通过真实参数校验");

		globalThis.fetch = async () => ({
			ok: true,
			status: 200,
			statusText: "OK",
			headers: new Headers({ "content-type": "text/plain; charset=utf-8" }),
			async text() {
				return "Hello Plain Text Content";
			}
		});

		const resNull = await tool.execute("call_1", nullParams, undefined, undefined, {});
		assert.ok(resNull.content[0].text.includes("Hello Plain Text Content"));
		assert.equal(resNull.details.offset, 0);

		// 2. 无脚本页面上的 script: 0 返回明确错误
		const script0Params = {
			url: "https://example.com/raw.txt",
			script: 0
		};
		assert.ok(Value.Check(tool.parameters, script0Params), "script0Params 必须通过真实参数校验");

		let failed = false;
		try {
			await tool.execute("call_2", script0Params, undefined, undefined, {});
		} catch (err) {
			failed = true;
			assert.match(err.message, /Script 0 not found\. Available indices: none\. For page or file content, omit script or pass null\./);
		}
		assert.ok(failed, "无脚本页面传 script: 0 必须抛出带指引的错误");

		// 3. 有脚本页面上的 script: 0 返回第一个脚本
		const htmlWithScript = `
			<html>
				<body>
					<article><p>Some main text that is long enough to satisfy readability or fallback.</p></article>
					<script>console.log("Inline Script 0");</script>
					<script>console.log("Inline Script 1");</script>
				</body>
			</html>
		`;
		globalThis.fetch = async () => ({
			ok: true,
			status: 200,
			statusText: "OK",
			headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
			async text() {
				return htmlWithScript;
			}
		});

		const pageScript0Params = {
			url: "https://example.com/page-with-scripts.html",
			script: 0
		};
		assert.ok(Value.Check(tool.parameters, pageScript0Params), "pageScript0Params 必须通过真实参数校验");

		const resScript0 = await tool.execute("call_3", pageScript0Params, undefined, undefined, {});
		assert.ok(resScript0.content[0].text.includes('console.log("Inline Script 0");'));

		// 4. 正文测试：确定的纯文本 fixture 与精准切片、元数据、URL-only 对比
		const plainTextContent = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"; // 长度 36
		globalThis.fetch = async (input) => {
			const urlStr = String(input);
			if (urlStr.includes("plain-text-fixture")) {
				return {
					ok: true,
					status: 200,
					statusText: "OK",
					headers: new Headers({ "content-type": "text/plain; charset=utf-8" }),
					async text() {
						return plainTextContent;
					}
				};
			}
			return {
				ok: true,
				status: 200,
				statusText: "OK",
				headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
				async text() {
					return htmlWithScript;
				}
			};
		};

		const fixtureUrl = "https://example.com/plain-text-fixture.txt";

		// 4.1 仅传 URL 的正文请求（URL-only）
		const urlOnlyParams = { url: fixtureUrl };
		assert.ok(Value.Check(tool.parameters, urlOnlyParams), "urlOnlyParams 必须通过真实参数校验");
		const resUrlOnly = await tool.execute("call_4_url_only", urlOnlyParams, undefined, undefined, {});
		assert.equal(resUrlOnly.details.content, plainTextContent, "URL-only 请求必须返回完整 36 字符正文");
		assert.equal(resUrlOnly.details.offset, 0);
		assert.equal(resUrlOnly.details.returned_length, 36);
		assert.equal(resUrlOnly.details.total_length, 36);
		assert.equal(resUrlOnly.details.truncated, false);

		// 4.2 全部可选参数传 null 的正文请求，断言与 URL-only 完全一致
		const allNullParams = { url: fixtureUrl, script: null, offset: null, max_length: null };
		assert.ok(Value.Check(tool.parameters, allNullParams), "allNullParams 必须通过真实参数校验");
		const resAllNull = await tool.execute("call_4_all_null", allNullParams, undefined, undefined, {});
		assert.equal(resAllNull.details.content, resUrlOnly.details.content);
		assert.equal(resAllNull.details.offset, resUrlOnly.details.offset);
		assert.equal(resAllNull.details.returned_length, resUrlOnly.details.returned_length);
		assert.equal(resAllNull.details.total_length, resUrlOnly.details.total_length);
		assert.equal(resAllNull.details.truncated, resUrlOnly.details.truncated);

		// 4.3 正文精确分页请求
		const pageParams = {
			url: fixtureUrl,
			script: null,
			offset: 5,
			max_length: 10
		};
		assert.ok(Value.Check(tool.parameters, pageParams), "pageParams 必须通过真实参数校验");
		const resPagePaged = await tool.execute("call_4_page", pageParams, undefined, undefined, {});
		assert.equal(resPagePaged.details.content, "56789ABCDE", "正文分页切片必须精确等于 56789ABCDE");
		assert.equal(resPagePaged.details.offset, 5);
		assert.equal(resPagePaged.details.returned_length, 10);
		assert.equal(resPagePaged.details.total_length, 36);
		assert.equal(resPagePaged.details.truncated, true);

		// 4.4 正文最后一页请求
		const pageLastParams = {
			url: fixtureUrl,
			offset: 30,
			max_length: 10
		};
		assert.ok(Value.Check(tool.parameters, pageLastParams), "pageLastParams 必须通过真实参数校验");
		const resPageLast = await tool.execute("call_4_last", pageLastParams, undefined, undefined, {});
		assert.equal(resPageLast.details.content, "UVWXYZ", "正文最后一页切片必须精确等于 UVWXYZ");
		assert.equal(resPageLast.details.offset, 30);
		assert.equal(resPageLast.details.returned_length, 6);
		assert.equal(resPageLast.details.total_length, 36);
		assert.equal(resPageLast.details.truncated, false);

		// 5. 脚本精确选择与分页测试
		const scriptSource = 'window.fixture = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";';
		const htmlWithSpecificScript = `
			<html>
				<body>
					<p>Page body marker</p>
					<script>${scriptSource}</script>
					<script>window.second = true;</script>
				</body>
			</html>
		`;
		globalThis.fetch = async () => ({
			ok: true,
			status: 200,
			statusText: "OK",
			headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
			async text() {
				return htmlWithSpecificScript;
			}
		});

		const scriptFixtureUrl = "https://example.com/page-with-exact-script.html";

		// 5.1 script: 0 严格等于第一个脚本全文
		const scriptFullParams = { url: scriptFixtureUrl, script: 0 };
		assert.ok(Value.Check(tool.parameters, scriptFullParams));
		const resScriptFull = await tool.execute("call_5_full", scriptFullParams, undefined, undefined, {});
		assert.equal(resScriptFull.details.content, scriptSource, "details.content 必须严格等于第一个脚本全文");
		assert.equal(resScriptFull.details.offset, 0);
		assert.equal(resScriptFull.details.returned_length, scriptSource.length);
		assert.equal(resScriptFull.details.total_length, scriptSource.length);
		assert.equal(resScriptFull.details.truncated, false);

		// 5.2 script: null 返回正文且不把脚本正文当成正文
		const pageBodyOnlyParams = { url: scriptFixtureUrl, script: null };
		assert.ok(Value.Check(tool.parameters, pageBodyOnlyParams));
		const resPageBody = await tool.execute("call_5_body", pageBodyOnlyParams, undefined, undefined, {});
		assert.ok(resPageBody.details.content.includes("Page body marker"), "正文必须包含 Page body marker");
		assert.equal(resPageBody.details.content.includes(scriptSource), false, "正文 details.content 不得包含内联脚本全文");

		// 5.3 脚本分页请求
		const scriptPagedParams = {
			url: scriptFixtureUrl,
			script: 0,
			offset: 8,
			max_length: 10
		};
		assert.ok(Value.Check(tool.parameters, scriptPagedParams), "scriptPagedParams 必须通过真实参数校验");
		const resScriptPaged = await tool.execute("call_5_paged", scriptPagedParams, undefined, undefined, {});
		const expectedScriptSlice = scriptSource.slice(8, 18);
		assert.equal(resScriptPaged.details.content, expectedScriptSlice, "脚本分页内容必须严格匹配切片");
		assert.equal(resScriptPaged.details.offset, 8);
		assert.equal(resScriptPaged.details.returned_length, 10);
		assert.equal(resScriptPaged.details.total_length, scriptSource.length);
		assert.equal(resScriptPaged.details.truncated, true);

		// 5.4 脚本最后一页
		const scriptLastOffset = scriptSource.length - 4;
		const scriptLastParams = {
			url: scriptFixtureUrl,
			script: 0,
			offset: scriptLastOffset,
			max_length: 10
		};
		assert.ok(Value.Check(tool.parameters, scriptLastParams));
		const resScriptLast = await tool.execute("call_5_last", scriptLastParams, undefined, undefined, {});
		assert.equal(resScriptLast.details.content, scriptSource.slice(scriptLastOffset), "脚本最后一页切片必须精确匹配末尾 4 字符");
		assert.equal(resScriptLast.details.offset, scriptLastOffset);
		assert.equal(resScriptLast.details.returned_length, 4);
		assert.equal(resScriptLast.details.total_length, scriptSource.length);
		assert.equal(resScriptLast.details.truncated, false);
	} finally {
		globalThis.fetch = originalFetch;
	}
});
