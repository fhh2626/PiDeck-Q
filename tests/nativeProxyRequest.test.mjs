import assert from "node:assert/strict";
import test from "node:test";
import { NodeProxy } from "../src/native-node/platform/NodeProxy.ts";

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
