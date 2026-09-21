import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { stripToolResultForDelivery, enforceDeliveryEnvelopeBudget } = loadTsCommonJs("src/main/pi/agentUtils.ts");
const {
	applyImageDisplayBudget,
	MAX_MESSAGE_DELIVERY_TOTAL_IMAGE_BASE64_BYTES,
	MAX_TOOL_IMAGE_SINGLE_BASE64_BYTES,
	MAX_TOOL_IMAGES_PER_MESSAGE,
	MAX_TOOL_IMAGE_MESSAGE_BASE64_BYTES,
} = loadTsCommonJs("src/shared/imageLimits.ts");

test("stripToolResultForDelivery: unloads images from older messages when delivery budget is exceeded", () => {
	const bigChunk = "A".repeat(18 * 1024 * 1024);
	const messages = [
		{
			id: "msg-old",
			agentId: "agent",
			role: "tool",
			text: "old tool",
			timestamp: 1,
			images: [{ type: "image", data: bigChunk, mimeType: "image/png" }],
		},
		{
			id: "msg-new",
			agentId: "agent",
			role: "tool",
			text: "new tool",
			timestamp: 2,
			images: [{ type: "image", data: bigChunk, mimeType: "image/png" }],
		},
	];

	const delivered = stripToolResultForDelivery(messages);
	assert.equal(delivered.length, 2);

	// 较旧的消息图片被卸载，并标记 delivery-budget-exceeded
	assert.equal(delivered[0].images, undefined);
	assert.deepEqual(JSON.parse(JSON.stringify(delivered[0].imageDisplayNotice)), {
		kind: "delivery-budget-exceeded",
		count: 1,
	});

	// 较新的消息图片被保留
	assert.ok(delivered[1].images);
	assert.equal(delivered[1].images.length, 1);
});

test("enforceDeliveryEnvelopeBudget: guarantees final envelope JSON UTF-8 size <= 30 MiB", () => {
	// 构造 10 条各带 3 MiB 图片及 250 KiB 文本的消息（加上 envelope 超过 32 MiB）
	const textChunk = "x".repeat(250 * 1024);
	const imageChunk = "A".repeat(3 * 1024 * 1024);
	const messages = Array.from({ length: 10 }, (_, i) => ({
		id: `msg-${i}`,
		agentId: "agent-1",
		role: "tool",
		timestamp: i,
		text: textChunk,
		images: [{ type: "image", data: imageChunk, mimeType: "image/png" }],
	}));

	const payload = {
		agentId: "agent-1",
		messages,
		slideOut: [
			{
				id: "slide-1",
				agentId: "agent-1",
				role: "tool",
				timestamp: -1,
				text: "slide out",
				images: [{ type: "image", data: imageChunk, mimeType: "image/png" }],
			},
		],
	};

	const bounded = enforceDeliveryEnvelopeBudget(payload);
	const serializedBytes = Buffer.byteLength(
		JSON.stringify({ channel: "agents:message", args: [bounded] }),
		"utf8",
	);

	assert.ok(
		serializedBytes <= MAX_MESSAGE_DELIVERY_TOTAL_IMAGE_BASE64_BYTES,
		`Envelope size ${serializedBytes} must be <= ${MAX_MESSAGE_DELIVERY_TOTAL_IMAGE_BASE64_BYTES}`,
	);
	// 验证较旧的消息图片被成功卸载
	assert.equal(bounded.slideOut[0].images, undefined);
	assert.equal(bounded.slideOut[0].imageDisplayNotice?.kind, "delivery-budget-exceeded");
});

test("applyImageDisplayBudget: enforces single image size, count, and per-turn budget", () => {
	// 1. 单图超 4 MiB 过滤
	const oversized = [{ type: "image", data: "A".repeat(5 * 1024 * 1024), mimeType: "image/png" }];
	const res1 = applyImageDisplayBudget(oversized);
	assert.equal(res1.images.length, 0);
	assert.equal(res1.notice?.kind, "too-large");

	// 2. 单消息超过 8 张截断
	const nineImages = Array.from({ length: 9 }, () => ({
		type: "image",
		data: "AAAA",
		mimeType: "image/png",
	}));
	const res2 = applyImageDisplayBudget(nineImages);
	assert.equal(res2.images.length, 8);
	assert.equal(res2.notice?.kind, "too-many");
	assert.equal(res2.notice?.omitted, 1);

	// 3. 单轮累计超过 8 MiB 截断
	const twoLargeImages = [
		{ type: "image", data: "A".repeat(3 * 1024 * 1024), mimeType: "image/png" },
	];
	// 假设本轮已经用了 6 MiB，再来 3 MiB 会超出 8 MiB
	const res3 = applyImageDisplayBudget(twoLargeImages, {
		currentTurnUsedBytes: 6 * 1024 * 1024,
	});
	assert.equal(res3.images.length, 0);
	assert.equal(res3.notice?.kind, "too-many");
});
