/**
 * Execute the legacy LAN web page served by the C++ backend.
 *
 * `WebServiceManager.renderPage()` / its C++ port is a self-contained vanilla client:
 * inline CSS, inline script, `fetch` against `/api/*`. Asserting on its HTML string only
 * proves that text exists, so this harness parses the *served* document with a real DOM
 * (linkedom), runs the inline script in a `vm` sandbox and points `fetch` at the real
 * backend, which is what makes "send / stream / abort" observable behaviour.
 *
 * Deliberate fakes (documented so a passing test is not mistaken for a browser test):
 *  - `setInterval` only records the callback; the test drives the 600 ms poll with
 *    `runPoll()` instead of waiting on wall-clock timers;
 *  - layout is absent (linkedom does not compute styles), so nothing here asserts
 *    geometry — only DOM text/structure and HTTP traffic;
 *  - the page's `form.requestSubmit()` is shimmed (linkedom has no form submission),
 *    with the same effect as a submit button click: dispatch a submit event.
 */
import vm from "node:vm";

import { parseHTML } from "linkedom";

/** Yield a few macrotasks so the page's `await` chains and `setTimeout(…, 0)` run. */
export async function settle(rounds = 8) {
	for (let index = 0; index < rounds; index += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

/** Poll `predicate` until it is truthy (bounded), so stream frames can land. */
export async function waitFor(predicate, { timeoutMs = 15_000, label = "condition" } = {}) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await predicate();
		if (value) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

/**
 * Boot the served document.
 *
 * @param {string} html  The document exactly as the backend served it.
 * @param {object} options
 * @param {string} options.baseUrl   `http://127.0.0.1:<port>`
 * @param {string} options.authorization  Value for the `authorization` header.
 * @param {("en-US"|"zh-CN")} [options.locale]  What `navigator.languages` reports.
 */
export function bootServedLegacyPage(html, { baseUrl, authorization, locale = "en-US" }) {
	// The script is cut by index, not read from the DOM: an HTML parser rewrites `<span`
	// and `&` literals inside inline scripts.
	const scriptStart = html.indexOf("<script>");
	const scriptEnd = html.lastIndexOf("</script>");
	if (scriptStart < 0 || scriptEnd < 0) throw new Error("inline web client script not found");
	const script = html.slice(scriptStart + "<script>".length, scriptEnd);
	const markup = html.slice(0, scriptStart) + html.slice(scriptEnd + "</script>".length);
	const { document, window } = parseHTML(markup);

	const form = document.getElementById("composer");
	form.requestSubmit = () => {
		form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
	};

	const requests = [];
	const intervals = [];
	/** Every `fetch` the page makes, with the parsed JSON body for POSTs. */
	const fetchImpl = async (path, init = {}) => {
		const url = new URL(path, baseUrl);
		const headers = { ...(init.headers ?? {}), authorization: `Bearer ${authorization}` };
		const response = await fetch(url, { ...init, headers });
		requests.push({
			path: url.pathname + url.search,
			method: init.method ?? "GET",
			body: typeof init.body === "string" ? JSON.parse(init.body) : null,
			status: response.status,
		});
		return response;
	};

	vm.runInNewContext(
		script,
		{
			document,
			window,
			navigator: { languages: [locale], language: locale },
			fetch: fetchImpl,
			console,
			AbortController,
			TextDecoder,
			TextEncoder,
			crypto: globalThis.crypto,
			setTimeout,
			clearTimeout,
			setInterval: (callback) => {
				intervals.push(callback);
				return intervals.length;
			},
			clearInterval: () => undefined,
		},
		{ filename: "legacy-web-page-inline.js" },
	);

	const text = (id) => document.getElementById(id)?.textContent ?? null;
	const messages = () => document.getElementById("messages");

	return {
		document,
		window,
		requests,
		text,
		messages,
		/** Trimmed text of `#messages` (roles and copy are separate nodes). */
		messagesText: () => (messages()?.textContent ?? "").replace(/\s+/g, " ").trim(),
		/** Inner HTML of `#messages`, for escaping assertions. */
		messagesHtml: () => messages()?.innerHTML ?? "",
		/** Run the page's own 600 ms poll once and let its renders settle. */
		runPoll: async () => {
			for (const callback of intervals) await callback();
			await settle();
		},
		settle,
		waitFor,
		/** Fill the composer and submit it like the submit button does. */
		submitPrompt: async (message) => {
			document.getElementById("prompt").value = message;
			await form.requestSubmit();
			await settle();
		},
		/** Click an element by selector (bubbles a real click through the page's delegate). */
		click: async (selector) => {
			const element = document.querySelector(selector);
			if (!element) throw new Error(`no element for ${selector}`);
			element.click();
			await settle();
		},
	};
}
