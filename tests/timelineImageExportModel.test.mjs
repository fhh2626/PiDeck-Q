import test from "node:test";
import assert from "node:assert/strict";
import { buildExportDocumentModel } from "../src/renderer/src/components/session/timeline/imageExportModel.ts";

test("步骤9导出数据模型测试: thinking 优先读取 message.thinking，tool 完整枚举全部且不截断", () => {
	const selectedRuns = [
		{
			kind: "agent-run",
			id: "run-1",
			items: [
				{
					kind: "thinking-group",
					id: "tg-1",
					messages: [
						{
							id: "think-msg-1",
							role: "thinking",
							text: "", // text 为空
							thinking: "Deep thought details", // thinking 字段非空
							timestamp: 1,
						},
					],
				},
				{
					kind: "tool-group",
					id: "tools-1",
					messages: Array.from({ length: 50 }, (_, i) => ({
						id: `tool-${i}`,
						role: "tool",
						text: `Summary ${i}`,
						meta: { toolName: "bash", detailText: `Full detail text ${i}` },
						timestamp: i,
					})),
				},
			],
		},
	];

	const fullTextMap = new Map();
	const model = buildExportDocumentModel(selectedRuns, fullTextMap, true);

	assert.equal(model.items.length, 1);
	const runItem = model.items[0];
	assert.equal(runItem.kind, "agent-run");

	// 1. 验证 thinking 内容正确读取 message.thinking
	const thinkItem = runItem.items.find((i) => i.kind === "thinking");
	assert.ok(thinkItem);
	assert.equal(thinkItem.thinking.thinkingText, "Deep thought details");

	// 2. 验证 50 个工具全部被完整收集，未被 40 页码分页截断
	const toolItems = runItem.items.filter((i) => i.kind === "tool");
	assert.equal(toolItems.length, 50, "导出模型必须收集全部 50 个工具项！");
	assert.equal(toolItems[0].tool.detailText, "Full detail text 0");
});
