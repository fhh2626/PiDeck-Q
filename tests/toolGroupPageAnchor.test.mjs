import test from "node:test";
import assert from "node:assert/strict";
import {
	resolveToolGroupPage,
	resolveToolGroupPageWithAnchor,
	TOOL_GROUP_PAGE_SIZE,
} from "../src/renderer/src/components/session/timeline/toolGroupPage.ts";

test("步骤6工具分页回归测试: 锚点恢复与翻页计算", () => {
	const messages = Array.from({ length: 100 }, (_, i) => ({
		id: `msg-tool-${i}`,
		role: "tool",
		timestamp: i,
	}));

	// 1. 无 anchor 时，pageIndex=1 对应 40~80 条
	const res1 = resolveToolGroupPageWithAnchor(messages, 1);
	assert.equal(res1.pageIndex, 1);
	assert.equal(res1.startIndex, 40);
	assert.equal(res1.endIndex, 80);
	assert.equal(res1.effectiveAnchorId, "msg-tool-40");

	// 2. 有 anchor 且位于第 85 条（对应第 2 页，80~100）
	const res2 = resolveToolGroupPageWithAnchor(messages, 0, "msg-tool-85");
	assert.equal(res2.pageIndex, 2, "存在 anchor 时应定位到 anchor 所在页（第2页）！");
	assert.equal(res2.startIndex, 80);
	assert.equal(res2.endIndex, 100);

	// 3. anchor 已被删除时，安全 fallback 到 requestedPageIndex
	const res3 = resolveToolGroupPageWithAnchor(messages, 1, "non-existent-msg");
	assert.equal(res3.pageIndex, 1);
});
