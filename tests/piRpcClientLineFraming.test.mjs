import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { PiRpcClient } = loadTsCommonJs("src/main/pi/PiRpcClient.ts");

/**
 * PiRpcClient 的 JSONL 分帧契约：从 stdout 公开边界写入字节，断言发出的 event /
 * protocol-error，而不是检查内部缓冲结构。
 */
function harness() {
	const stdin = new Writable({ write: (_chunk, _enc, cb) => cb() });
	const stdout = new PassThrough();
	const client = new PiRpcClient(stdin, stdout);
	const events = [];
	const protocolErrors = [];
	client.on("event", (event) => events.push(event));
	client.on("protocol-error", (line) => protocolErrors.push(line));
	/** PassThrough 的 data 事件在下一个 tick 派发；等它排空再断言。 */
	const flush = () => new Promise((resolve) => setImmediate(resolve));
	return { client, stdout, events, protocolErrors, flush };
}

test("a line split across chunks is emitted once, after its newline arrives", async () => {
	const h = harness();
	h.stdout.write(Buffer.from('{"type":"a",'));
	h.stdout.write(Buffer.from('"value":1'));
	await h.flush();
	assert.equal(h.events.length, 0, "no event before the newline");
	h.stdout.write(Buffer.from("}\n"));
	await h.flush();
	assert.deepEqual(JSON.parse(JSON.stringify(h.events)), [{ type: "a", value: 1 }]);
});

test("a multi-byte character split across chunks decodes correctly", async () => {
	const h = harness();
	const bytes = Buffer.from('{"type":"t","text":"中文😀"}\n', "utf8");
	// 在多字节字符中间切开：中文 3 字节、emoji 4 字节。
	const cut = bytes.indexOf(Buffer.from("文", "utf8")) + 1;
	const cut2 = bytes.indexOf(Buffer.from("😀", "utf8")) + 2;
	h.stdout.write(bytes.subarray(0, cut));
	h.stdout.write(bytes.subarray(cut, cut2));
	h.stdout.write(bytes.subarray(cut2));
	await h.flush();
	assert.equal(h.events.length, 1);
	assert.equal(h.events[0].text, "中文😀");
	assert.equal(h.protocolErrors.length, 0);
});

test("several lines in one chunk are emitted in order, CRLF tolerated", async () => {
	const h = harness();
	h.stdout.write(Buffer.from('{"type":"one"}\r\n{"type":"two"}\n\n{"type":"three"}\n{"type":"tail"'));
	await h.flush();
	assert.deepEqual(h.events.map((event) => event.type), ["one", "two", "three"]);
	h.stdout.write(Buffer.from("}\n"));
	await h.flush();
	assert.deepEqual(h.events.map((event) => event.type), ["one", "two", "three", "tail"]);
});

test("a trailing fragment without newline is flushed at end of stream", async () => {
	const h = harness();
	h.stdout.write(Buffer.from('{"type":"x"}\n{"type":'));
	h.stdout.end(Buffer.from('"last"}\r'));
	await new Promise((resolve) => h.stdout.once("end", resolve));
	await h.flush();
	assert.deepEqual(h.events.map((event) => event.type), ["x", "last"]);
});

test("non-JSON lines are reported as protocol errors with the original text", async () => {
	const h = harness();
	h.stdout.write(Buffer.from("not json\n"));
	await h.flush();
	assert.deepEqual(h.protocolErrors, ["not json"]);
});

test("responses resolve pending requests even when split across chunks", async () => {
	const h = harness();
	const pending = h.client.request({ id: "r1", type: "get_state" }, 5_000);
	h.stdout.write(Buffer.from('{"type":"response","id":"r1",'));
	h.stdout.write(Buffer.from('"command":"get_state","success":true}\n'));
	const response = await pending;
	assert.equal(response.success, true);
	assert.equal(h.events.length, 0, "a matched response is not re-emitted as an event");
});

test("a very large single line arriving in many chunks is framed in linear time", async () => {
	const h = harness();
	// 16MB 单行 JSON 以 8KB 小块写入：块越多，每块都从头扫描累积缓冲的实现越慢（O(n²)）。
	const payload = "x".repeat(16 * 1024 * 1024);
	const line = Buffer.from(`{"type":"big","data":"${payload}"}\n`);
	const chunkSize = 8 * 1024;
	const started = Date.now();
	for (let offset = 0; offset < line.length; offset += chunkSize) {
		h.stdout.write(line.subarray(offset, offset + chunkSize));
	}
	await new Promise((resolve) => {
		const check = () => (h.events.length > 0 ? resolve() : setImmediate(check));
		check();
	});
	const elapsed = Date.now() - started;
	assert.equal(h.events[0].data.length, payload.length);
	// 宽松上界：二次方实现在此规模需要数秒到数十秒；线性实现远低于该值。
	assert.ok(elapsed < 2_000, `framing a 16MB line took ${elapsed}ms`);
});
