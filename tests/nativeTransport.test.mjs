import assert from "node:assert/strict";
import test from "node:test";
import { hangingFetch, loadNativeTransport, okJsonResponse } from "./helpers/l1b_nativeTransportHarness.mjs";

const BASE_URL = "http://127.0.0.1:1234/";
/** 与生产 NATIVE_READ_RPC_TIMEOUT_MS 对应；只读 RPC 的截止时间是用户可感知的契约。 */
const READ_TIMEOUT_MS = 60_000;

/** 显式只读白名单（键为 ipcChannels 字段名）；其余通道一律不设超时。 */
const READONLY_CHANNEL_KEYS = [
	"projectsList",
	"sessionsCatalogList",
	"sessionsCatalogListArchived",
	"sessionsCatalogReadMessages",
	"sessionsCatalogReadMessagePage",
	"sessionsCatalogReadProcessEvents",
	"sessionsCatalogReadReferenceMessages",
	"sessionsCatalogGetContextControllerState",
	"sessionsCatalogReadMessageFullText",
	"filesList",
	"filesReadContent",
	"filesReadBase64",
	"filesReadBase64External",
];

function createTransport(harness) {
	const transport = new harness.NativeDesktopTransport(BASE_URL, "secret");
	return transport;
}

test("bounded read RPC aborts the in-flight fetch and reports a timeout naming the channel", async () => {
	const harness = loadNativeTransport();
	harness.setFetch(hangingFetch());
	const transport = createTransport(harness);
	const channel = harness.ipcChannels.sessionsCatalogList;

	const pending = transport.invoke(channel, "p1");
	const [deadline] = harness.pendingTimers(READ_TIMEOUT_MS);
	assert.ok(deadline, "read RPC must arm a 60s deadline");
	assert.equal(harness.fetchCalls[0].init.signal.aborted, false);

	harness.fireTimer(deadline);
	assert.equal(harness.fetchCalls[0].init.signal.aborted, true, "deadline must abort the request");
	await assert.rejects(pending, new RegExp(`Native RPC timed out after ${READ_TIMEOUT_MS}ms: ${channel}`));
	transport.dispose();
});

test("bounded RPC clears its deadline timer after a successful response", async () => {
	const harness = loadNativeTransport();
	harness.setFetch(async () => okJsonResponse(["x"]));
	const transport = createTransport(harness);

	const result = await transport.invoke(harness.ipcChannels.projectsList);
	assert.deepEqual(Array.from(result), ["x"]);
	const deadlines = harness.timers.filter((t) => t.ms === READ_TIMEOUT_MS);
	assert.equal(deadlines.length, 1);
	assert.equal(deadlines[0].cleared, true, "finished call must not leave a live deadline timer");
	transport.dispose();
});

test("bounded RPC clears its deadline timer when the request fails", async () => {
	const harness = loadNativeTransport();
	harness.setFetch(async () => ({ ok: false, status: 500, json: async () => ({ ok: false, error: { message: "boom" } }) }));
	const transport = createTransport(harness);

	await assert.rejects(transport.invoke(harness.ipcChannels.filesList, "/x"), /boom/);
	const deadlines = harness.timers.filter((t) => t.ms === READ_TIMEOUT_MS);
	assert.equal(deadlines.length, 1);
	assert.equal(deadlines[0].cleared, true);
	transport.dispose();
});

test("non-timeout failures keep their own error instead of a timeout message", async () => {
	const harness = loadNativeTransport();
	harness.setFetch(async () => {
		throw new Error("connection refused");
	});
	const transport = createTransport(harness);
	await assert.rejects(transport.invoke(harness.ipcChannels.projectsList), /connection refused/);
	transport.dispose();
});

test("mutating RPC is never bounded: no deadline timer, no abort", async () => {
	const harness = loadNativeTransport();
	harness.setFetch(async () => okJsonResponse(true));
	const transport = createTransport(harness);

	await transport.invoke(harness.ipcChannels.sessionsCatalogDelete, "s1");
	assert.equal(harness.timers.filter((t) => t.ms === READ_TIMEOUT_MS).length, 0);
	assert.equal(harness.fetchCalls[0].init.signal.aborted, false);
	transport.dispose();
});

test("nativeRpcTimeoutMs bounds exactly the explicit read-only allowlist", () => {
	const harness = loadNativeTransport();
	for (const key of READONLY_CHANNEL_KEYS) {
		const channel = harness.ipcChannels[key];
		assert.equal(typeof channel, "string", `unknown channel key ${key}`);
		assert.equal(harness.nativeRpcTimeoutMs(channel), READ_TIMEOUT_MS, key);
	}
	assert.equal(
		harness.nativeRpcTimeoutMs(harness.ipcChannels.nativeClipboardSnapshot),
		harness.NATIVE_CLIPBOARD_SNAPSHOT_TIMEOUT_MS,
	);
	assert.equal(harness.NATIVE_CLIPBOARD_SNAPSHOT_TIMEOUT_MS, 5_000);
});

test("only allowlisted channels are bounded; every other channel in the contract stays unbounded", () => {
	// 遍历全部 IPC 通道而不只是同前缀的几条：把一个写操作（如 projects:remove）加进只读超时白名单，
	// 会让本地 abort 把“结果不明的变更”报成普通失败，必须在这里被发现。
	const harness = loadNativeTransport();
	const bounded = new Map([
		...READONLY_CHANNEL_KEYS.map((key) => [harness.ipcChannels[key], READ_TIMEOUT_MS]),
		[harness.ipcChannels.nativeClipboardSnapshot, harness.NATIVE_CLIPBOARD_SNAPSHOT_TIMEOUT_MS],
	]);
	const channels = Object.values(harness.ipcChannels);
	assert.ok(channels.length > 50, "the contract should contain the full channel set");
	for (const channel of channels) {
		assert.equal(
			harness.nativeRpcTimeoutMs(channel),
			bounded.get(channel),
			`${channel} must ${bounded.has(channel) ? "be bounded" : "stay unbounded"}`,
		);
	}
	assert.equal(harness.nativeRpcTimeoutMs("unknown:channel"), undefined);
});