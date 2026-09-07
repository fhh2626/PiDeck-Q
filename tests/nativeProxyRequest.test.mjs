import assert from "node:assert/strict";
import test from "node:test";
import { NodeProxy } from "../src/native-node/platform/NodeProxy.ts";

test("NodeProxy always bypasses localhost and loopback addresses", async () => {
	const originalFetch = globalThis.fetch;
	const calls = [];
	globalThis.fetch = async (input, init) => {
		calls.push({ input, init });
		return new Response("ok", { status: 200 });
	};
	const proxy = new NodeProxy();
	try {
		await proxy.apply({ mode: "fixed_servers", proxyRules: "http://proxy.test:8080", proxyBypassRules: "" });
		for (const url of [
			"http://localhost:43123/",
			"http://127.0.0.1:43123/",
			"http://127.42.0.1:43123/",
			"http://[::1]:43123/",
		]) {
			await proxy.fetch(url);
		}
		assert.equal(calls.length, 4);
		assert.equal(calls.every(({ init }) => init?.dispatcher === undefined), true);
	} finally {
		await proxy.apply({ mode: "direct" });
		globalThis.fetch = originalFetch;
	}
});

test("NodeProxy preserves Request method, body, and headers while adding dispatcher", async () => {
	const originalFetch = globalThis.fetch;
	const calls = [];
	globalThis.fetch = async (input, init) => {
		calls.push({ input, init });
		return new Response("ok", { status: 200 });
	};
	try {
		const proxy = new NodeProxy();
		await proxy.fetch(new Request("https://example.test/path", {
			method: "POST",
			headers: { "x-test": "header" },
			body: "request-body",
		}));
		assert.equal(calls.length, 1);
		assert.ok(calls[0].input instanceof Request);
		assert.equal(calls[0].input.method, "POST");
		assert.equal(await calls[0].input.text(), "request-body");
		assert.equal(calls[0].input.headers.get("x-test"), "header");
	} finally {
		globalThis.fetch = originalFetch;
	}
});
