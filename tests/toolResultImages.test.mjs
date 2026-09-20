import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { AgentMessageProjector } = loadTsCommonJs("src/main/pi/AgentMessageProjector.ts");
const { groupToolMessages, sameChatMessageForRender } = loadTsCommonJs("src/renderer/src/components/app/AppUtils.ts");

const B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

test("AgentMessageProjector: projects toolResult with images into ChatMessage.images and sanitizes base64 from text", () => {
	const projector = new AgentMessageProjector({
		translate: (key) => key,
		isAskAborted: () => false,
	});

	const entries = [
		{
			id: "entry-tool-call",
			parentId: null,
			type: "message",
			message: {
				id: "call-1",
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "tool-call-1",
						name: "take_screenshot",
						arguments: {},
					},
				],
			},
		},
		{
			id: "entry-tool-result",
			parentId: "entry-tool-call",
			type: "message",
			message: {
				id: "result-1",
				role: "toolResult",
				toolCallId: "tool-call-1",
				toolName: "take_screenshot",
				content: [
					{ type: "text", text: "Screenshot captured successfully" },
					{ type: "image", data: B64, mimeType: "image/png" },
				],
			},
		},
	];

	const messages = projector.convert("test-agent", entries.map((e) => e.message), [
		"entry-tool-call",
		"entry-tool-result",
	]);

	const toolMessage = messages.find((m) => m.role === "tool");
	assert.ok(toolMessage, "Tool message should be projected");
	assert.equal(toolMessage.images?.length, 1);
	assert.equal(toolMessage.images[0].mimeType, "image/png");
	assert.equal(toolMessage.images[0].data, B64);

	// 验证 text 和 meta.detailText 中不包含完整 raw base64 字符串
	assert.ok(!toolMessage.text.includes(B64), "Message text must not contain raw base64");
	if (toolMessage.meta?.detailText) {
		assert.ok(!toolMessage.meta.detailText.includes(B64), "Detail text must sanitize raw base64");
	}
});

test("AgentMessageProjector: projects assistant images and sanitizes nested base64 in safeJson", () => {
	const projector = new AgentMessageProjector({
		translate: (key) => key,
		isAskAborted: () => false,
	});

	// 1. 测试 assistant 图片投影
	const assistantEntry = {
		role: "assistant",
		content: [
			{ type: "text", text: "Here is your generated image" },
			{ type: "image", data: B64, mimeType: "image/png" },
		],
	};
	const msgs = projector.convert("test-agent", [assistantEntry]);
	assert.equal(msgs.length, 1);
	assert.equal(msgs[0].role, "assistant");
	assert.equal(msgs[0].images?.length, 1);
	assert.equal(msgs[0].images[0].data, B64);

	// 2. 测试 safeJson 对 nested image base64 进行脱敏
	const nestedPayload = {
		type: "image",
		source: {
			type: "base64",
			data: "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ejAxMjM0NTY3ODk=",
			media_type: "image/png",
		},
	};
	const json = projector.safeJson(nestedPayload);
	assert.ok(!json.includes("QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ejAxMjM0NTY3ODk="));
	assert.ok(json.includes("[base64 image ("));

	// 3. 历史工具结果带 9 张图片时，遵守 8 张限制并打上 notice
	const toolNineImages = {
		role: "toolResult",
		toolCallId: "call-9",
		content: Array.from({ length: 9 }, () => ({
			type: "image",
			data: B64,
			mimeType: "image/png",
		})),
	};
	const toolMsgs = projector.convert("test-agent", [toolNineImages]);
	assert.equal(toolMsgs.length, 1);
	assert.equal(toolMsgs[0].images?.length, 8);
	assert.equal(toolMsgs[0].imageDisplayNotice?.kind, "too-many");
	assert.equal(toolMsgs[0].imageDisplayNotice?.omitted, 1);
});

test("AgentMessageProjector: large >4 MiB image parses without stack overflow and is omitted with too-large notice while text is kept", () => {
	const projector = new AgentMessageProjector({
		translate: (key) => key,
		isAskAborted: () => false,
	});

	// 5 MiB base64 image (> 4 MiB limit)
	const fiveMbB64 = "A".repeat(5 * 1024 * 1024);
	const toolEntry = {
		role: "toolResult",
		toolCallId: "call-large",
		toolName: "large_tool",
		content: [
			{ type: "text", text: "Tool executed with large image" },
			{ type: "image", data: fiveMbB64, mimeType: "image/png" },
		],
	};

	const messages = projector.convert("test-agent", [toolEntry]);
	assert.equal(messages.length, 1);
	const msg = messages[0];
	assert.equal(msg.role, "tool");
	assert.ok(msg.text.includes("large_tool"), "Tool message text preserved");
	assert.ok(msg.meta?.result?.includes("Tool executed with large image"), "Tool result text preserved");
	assert.equal(msg.images, undefined, "Oversized image should be omitted");
	assert.ok(msg.imageDisplayNotice, "Image display notice should be present");
	assert.equal(msg.imageDisplayNotice?.kind, "too-large");
	assert.equal(msg.imageDisplayNotice?.count, 1);
	assert.equal(msg.imageDisplayNotice?.omitted, 1);
});

test("AgentMessageProjector: preserves image-only and notice-only assistant messages", () => {
	const projector = new AgentMessageProjector({
		translate: (key) => key,
		isAskAborted: () => false,
	});

	// 1. image-only assistant (no text, no thinking)
	const imageOnlyEntry = {
		role: "assistant",
		content: [{ type: "image", data: B64, mimeType: "image/png" }],
	};
	const msgs1 = projector.convert("test-agent", [imageOnlyEntry]);
	assert.equal(msgs1.length, 1);
	assert.equal(msgs1[0].role, "assistant");
	assert.equal(msgs1[0].images?.length, 1);
	assert.equal(msgs1[0].text, "");

	// 2. tool uses up 8 MiB turn budget, then image-only assistant becomes notice-only and is still preserved
	const fourMbB64 = "A".repeat(4 * 1024 * 1024);
	const toolEntry = {
		role: "toolResult",
		toolCallId: "call-8m",
		toolName: "draw",
		content: [
			{ type: "image", data: fourMbB64, mimeType: "image/png" },
			{ type: "image", data: fourMbB64, mimeType: "image/png" },
		],
	};
	const nextImageEntry = {
		role: "assistant",
		content: [{ type: "image", data: B64, mimeType: "image/png" }],
	};
	const msgs2 = projector.convert("test-agent", [toolEntry, nextImageEntry]);
	assert.equal(msgs2.length, 2);
	assert.equal(msgs2[0].role, "tool");
	assert.equal(msgs2[0].images?.length, 2);
	assert.equal(msgs2[1].role, "assistant");
	assert.equal(msgs2[1].images, undefined, "Images omitted due to turn budget");
	assert.ok(msgs2[1].imageDisplayNotice, "Notice preserved");
	assert.equal(msgs2[1].imageDisplayNotice?.kind, "too-many");
});

test("AppUtils: groupToolMessages and sameChatMessageForRender handle image-bearing assistant messages", () => {
	// thinking + image 不会变成纯 thinking-only 分组（保持为 message）
	const messageWithThinkingAndImage = {
		id: "m-1",
		agentId: "agent-1",
		role: "assistant",
		text: "",
		thinking: "pondering...",
		images: [{ type: "image", data: B64, mimeType: "image/png" }],
		timestamp: 100,
	};
	const rendered = groupToolMessages([messageWithThinkingAndImage]);
	assert.equal(rendered.length, 1);
	assert.equal(rendered[0].kind, "agent-run");
	const runItems = rendered[0].items;
	const msgItem = runItems.find((it) => it.kind === "message");
	assert.ok(msgItem, "Must be retained as a message item, not collapsed into thinking-only group");

	// sameChatMessageForRender: notice 变化时返回 false（需要重新渲染）
	const msgA = {
		id: "m-2",
		agentId: "agent-1",
		role: "assistant",
		text: "hi",
		timestamp: 100,
		imageDisplayNotice: { kind: "too-many", count: 10, omitted: 2 },
	};
	const msgB = {
		...msgA,
		imageDisplayNotice: { kind: "too-many", count: 10, omitted: 3 },
	};
	assert.equal(sameChatMessageForRender(msgA, msgB), false);
});
