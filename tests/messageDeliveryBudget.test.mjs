import test from "node:test";
import assert from "node:assert/strict";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const {
	measureUtf8JsonBytes,
	enforceDeliveryBudgetOnPayload,
	enforceDeliveryBudgetOnPage,
	MAX_MESSAGE_DELIVERY_ENVELOPE_BYTES,
} = loadTsCommonJs("src/main/pi/messageDeliveryBudget.ts");

test("measureUtf8JsonBytes: returns byte length on valid object and null on circular/error", () => {
	const obj = { hello: "world", count: 123 };
	const bytes = measureUtf8JsonBytes(obj);
	assert.equal(bytes, Buffer.byteLength(JSON.stringify(obj), "utf8"));

	const circular = {};
	circular.self = circular;
	assert.equal(measureUtf8JsonBytes(circular), null, "Circular structure must return null, not 0");
});

test("enforceDeliveryBudgetOnPayload: 30 MiB boundary precision and copy-on-write", () => {
	const dummyWrapper = (payload) => ({
		channel: "test-channel",
		args: [payload],
	});

	// 1. 29.9 MiB payload 保留完整图片
	const imageUnder = "A".repeat(29 * 1024 * 1024);
	const payloadUnder = {
		messages: [
			{
				id: "m-1",
				agentId: "agent-1",
				role: "assistant",
				text: "done",
				images: [{ type: "image", data: imageUnder, mimeType: "image/png" }],
				timestamp: 1,
			},
		],
	};
	const resUnder = enforceDeliveryBudgetOnPayload(payloadUnder, dummyWrapper);
	assert.equal(resUnder.ok, true);
	assert.equal(resUnder.value.messages[0].images?.length, 1);

	// 2. 30.1 MiB payload 触发图片卸载并附加 notice
	const imageOver = "A".repeat(31 * 1024 * 1024);
	const payloadOver = {
		messages: [
			{
				id: "m-2",
				agentId: "agent-1",
				role: "assistant",
				text: "done",
				images: [{ type: "image", data: imageOver, mimeType: "image/png" }],
				timestamp: 2,
			},
		],
	};
	const resOver = enforceDeliveryBudgetOnPayload(payloadOver, dummyWrapper);
	assert.equal(resOver.ok, true);
	assert.equal(resOver.value.messages[0].images, undefined);
	assert.equal(resOver.value.messages[0].imageDisplayNotice?.kind, "delivery-budget-exceeded");

	// 3. Copy-on-write: 原始 payload 未被破坏
	assert.equal(payloadOver.messages[0].images?.length, 1, "Original payload should remain unchanged");

	// 4. 优先卸载 slideOut（旧），若仍超限再卸载 messages（新）
	const image4M = "A".repeat(4 * 1024 * 1024);
	const payloadSlideOut = {
		slideOut: [
			{
				id: "s-1",
				agentId: "agent-1",
				role: "tool",
				text: "old slide out",
				images: [{ type: "image", data: image4M, mimeType: "image/png" }],
				timestamp: 1,
			},
		],
		messages: [
			{
				id: "m-3",
				agentId: "agent-1",
				role: "assistant",
				text: "current message",
				images: [{ type: "image", data: image4M, mimeType: "image/png" }],
				timestamp: 2,
			},
		],
	};
	// 设定一个稍微超过 4M 包装限制的上限，使得只需要卸载 1 条图片即可满足
	const wrapperOverOne = dummyWrapper(payloadSlideOut);
	const totalBytes = measureUtf8JsonBytes(wrapperOverOne);
	const resSlideFirst = enforceDeliveryBudgetOnPayload(payloadSlideOut, dummyWrapper, totalBytes - 1000);
	assert.equal(resSlideFirst.ok, true);
	// slideOut 图片应被卸载，而 messages 仍保留！
	assert.equal(resSlideFirst.value.slideOut[0].images, undefined);
	assert.equal(resSlideFirst.value.messages[0].images?.length, 1);

	// 5. 删完图片仍超限（纯文本超限）返回 MESSAGE_DELIVERY_TOO_LARGE
	const hugeText = "X".repeat(31 * 1024 * 1024);
	const payloadHugeText = {
		messages: [
			{
				id: "m-4",
				agentId: "agent-1",
				role: "assistant",
				text: hugeText,
				images: [{ type: "image", data: image4M, mimeType: "image/png" }],
				timestamp: 3,
			},
		],
	};
	const resHugeText = enforceDeliveryBudgetOnPayload(payloadHugeText, dummyWrapper);
	assert.equal(resHugeText.ok, false);
	assert.equal(resHugeText.code, "MESSAGE_DELIVERY_TOO_LARGE");
});

test("enforceDeliveryBudgetOnPage: envelopes SessionMessagePage and drops images on overflow", () => {
	const imageOver = "A".repeat(31 * 1024 * 1024);
	const page = {
		messages: [
			{
				id: "p-1",
				agentId: "agent-1",
				role: "assistant",
				text: "page msg",
				images: [{ type: "image", data: imageOver, mimeType: "image/png" }],
				timestamp: 1,
			},
		],
		total: 1,
		nextBefore: null,
	};

	const res = enforceDeliveryBudgetOnPage(page);
	assert.equal(res.ok, true);
	assert.equal(res.value.messages[0].images, undefined);
	assert.equal(res.value.messages[0].imageDisplayNotice?.kind, "delivery-budget-exceeded");

	// 纯文本超限返回 MESSAGE_DELIVERY_TOO_LARGE
	const hugePage = {
		messages: [
			{
				id: "p-2",
				agentId: "agent-1",
				role: "assistant",
				text: "Y".repeat(31 * 1024 * 1024),
				timestamp: 2,
			},
		],
		total: 1,
		nextBefore: null,
	};
	const resHuge = enforceDeliveryBudgetOnPage(hugePage);
	assert.equal(resHuge.ok, false);
	assert.equal(resHuge.code, "MESSAGE_DELIVERY_TOO_LARGE");
	// 失败结果必须带回已剥图后的 candidate（供调用方 emit + listener 拒绝路径）
	assert.ok(resHuge.value, "失败 Result 必须携带最后 candidate");
	assert.equal(resHuge.value.messages[0].images, undefined);
});

// 序列化失败不得被当作 0 字节放行（旧行为 getEnvelopeBytes catch 返回 0 的 fail-open）
test("enforceDeliveryBudgetOnPayload: circular structure fails closed with candidate", () => {
	const circular = { id: "c-1", agentId: "agent-1", role: "assistant", text: "loop", timestamp: 1 };
	const payload = {
		messages: [circular],
	};
	// 通过 meta 挂循环引用（JSON.stringify 会抛 TypeError）
	circular.meta = { self: circular };

	const res = enforceDeliveryBudgetOnPayload(payload, (candidate) => ({
		channel: "test-channel",
		args: [candidate],
	}));
	assert.equal(res.ok, false, "循环引用必须 fail-closed，不得原样放行");
	assert.equal(res.code, "SERIALIZATION_FAILED");
	assert.ok(res.value, "失败 Result 必须携带已 strip 的 candidate");
});
