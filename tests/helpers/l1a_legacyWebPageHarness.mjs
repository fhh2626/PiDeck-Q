import { parseHTML } from "linkedom";
import vm from "node:vm";
import { loadTsCommonJs } from "./loadTsCommonJs.mjs";

/** 让出若干轮宏任务，使 await 链 / setTimeout(0) 推进到下一个真正的挂起点。 */
export async function settle(rounds = 8) {
	for (let i = 0; i < rounds; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** 可手动喂数据的 SSE 响应体：push() 写入原始 SSE 文本，close() 结束流。 */
export function createControlledSseBody() {
	const encoder = new TextEncoder();
	let controller;
	const stream = new ReadableStream({ start(c) { controller = c; } });
	return {
		stream,
		pushFrame: (frame) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`)),
		pushDone: () => controller.enqueue(encoder.encode("data: [DONE]\n\n")),
		close: () => controller.close(),
	};
}

/**
 * 取真实 WebServiceManager 生成的内嵌 A1 页面，在 linkedom DOM + vm 沙箱里真正执行其内联脚本。
 * 所有网络都经 `handle(path, init)` 假实现：返回 `{ json }` 作为 JSON 响应，
 * 或 `{ stream }` 作为 SSE 响应体。setInterval 只登记回调（`runPoll()` 手动触发一次轮询），
 * 不产生真实定时器，测试结束不会残留句柄。
 */
export async function bootLegacyWebPage(handle) {
	const { WebServiceManager } = loadTsCommonJs("src/main/web/WebServiceManager.ts", {
		globals: { fetch: globalThis.fetch, Response: globalThis.Response, ReadableStream: globalThis.ReadableStream },
	});
	// renderPage 不依赖运行中的 server；依赖对象只需满足构造函数。
	const manager = new WebServiceManager({
		subscribePiEvents: () => () => undefined,
		getSessionIdForAgent: () => undefined,
	});
	const html = manager.renderPage();
	// 脚本用字符串切片取出而不是经 DOM 读取：HTML 解析器会改写脚本里的 "<span" 等字面量。
	const scriptStart = html.indexOf("<script>");
	const scriptEnd = html.lastIndexOf("</script>");
	if (scriptStart === -1 || scriptEnd === -1) throw new Error("inline web client script not found");
	const script = html.slice(scriptStart + "<script>".length, scriptEnd);
	const { document, window } = parseHTML(html.slice(0, scriptStart) + html.slice(scriptEnd + "</script>".length));
	const fetchCalls = [];
	const intervals = [];
	const fakeFetch = async (path, init = {}) => {
		const url = String(path);
		fetchCalls.push({ url, init });
		const result = await handle(url, init);
		if (result.stream) {
			return { ok: true, status: 200, body: result.stream, json: async () => ({}) };
		}
		return { ok: true, status: 200, statusText: "OK", json: async () => result.json, body: null };
	};

	vm.runInNewContext(script, {
		document,
		window,
		navigator: { languages: ["en-US"], language: "en-US" },
		fetch: fakeFetch,
		console,
		AbortController,
		TextDecoder,
		TextEncoder,
		crypto: globalThis.crypto,
		setTimeout,
		clearTimeout,
		setInterval: (callback) => { intervals.push(callback); return intervals.length; },
		clearInterval: () => undefined,
	}, { filename: "legacy-web-page-inline.js" });

	await settle();
	return {
		document,
		window,
		fetchCalls,
		/** 触发一次页面自己的 600ms 轮询回调。 */
		runPoll: async () => {
			for (const callback of intervals) await callback();
			await settle();
		},
		/** 在输入框填入文本并提交 composer 表单。 */
		submitPrompt: async (text) => {
			document.getElementById("prompt").value = text;
			const form = document.getElementById("composer");
			form.dispatchEvent(new window.Event("submit", { cancelable: true }));
			await settle();
		},
	};
}
