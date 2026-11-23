import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
const { groupToolMessages, sameChatMessageForRender } = loadTsCommonJs("src/renderer/src/components/app/AppUtils.ts");

const B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

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
