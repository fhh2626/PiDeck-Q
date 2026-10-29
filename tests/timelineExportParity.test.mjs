import test from "node:test";
import assert from "node:assert/strict";
import { withHookHost } from "./helpers/l5_hookHost.mjs";

test("步骤9与10测试: buildExportDocumentModel 支持内联 thinking 与完整工具载荷，ReadOnlyExportDocument 渲染真实 Markdown", async () => {
	await withHookHost(async ({ React, load, mount, act, window }) => {
		const modelMod = load("src/renderer/src/components/session/timeline/imageExportModel.ts");
		const { buildExportDocumentModel } = modelMod;

		// 1. 构造测试数据：包含普通 assistant 消息的内联 thinking，以及工具调用
		const testRuns = [
			{
				kind: "agent-run",
				id: "run-1",
				items: [
					{
						kind: "message",
						message: {
							id: "asst-1",
							role: "assistant",
							thinking: "This is assistant inline thinking process",
							text: "# Heading 1\n\nThis is **bold text** and `inline code`.",
							timestamp: 1000,
						},
					},
					{
						kind: "tool-group",
						id: "tool-grp-1",
						messages: [
							{
								id: "tool-msg-1",
								role: "toolResult",
								toolName: "bash",
								text: "truncated output...",
								timestamp: 1001,
							},
						],
					},
				],
			},
		];

		const toolPayloadMap = new Map([
			[
				"tool-msg-1",
				{
					argsText: '{\n  "command": "npm run test:raw"\n}',
					resultText: "PASSED: all 120 tests green",
					detailsText: '{\n  "exitCode": 0,\n  "duration": 1200\n}',
				},
			],
		]);

		const docModel = buildExportDocumentModel(
			testRuns,
			new Map(),
			true,
			toolPayloadMap,
		);

		assert.equal(docModel.items.length, 1);
		const runItem = docModel.items[0];
		assert.equal(runItem.kind, "agent-run");

		// 验证思考项与消息项都存在
		const thinkingSub = runItem.items.find((i) => i.kind === "thinking");
		assert.ok(thinkingSub, "必须提取普通助手消息的内联 thinking！");
		assert.equal(thinkingSub.thinking.thinkingText, "This is assistant inline thinking process");

		const toolSub = runItem.items.find((i) => i.kind === "tool");
		assert.ok(toolSub, "必须包含工具项");
		assert.equal(toolSub.tool.argsText, '{\n  "command": "npm run test:raw"\n}');
		assert.equal(toolSub.tool.detailText, "PASSED: all 120 tests green");
		assert.equal(toolSub.tool.detailsText, '{\n  "exitCode": 0,\n  "duration": 1200\n}');

		// 2. 测试 ReadOnlyExportDocument 渲染真实 Markdown
		const streamdownStub = {
			Streamdown: ({ children }) =>
				React.createElement("div", { className: "markdown-body" }, children),
			defaultRemarkPlugins: { gfm: () => {}, codeMeta: () => {} },
			defaultRehypePlugins: { raw: () => {} },
		};
		const docMod = load("src/renderer/src/components/session/timeline/ReadOnlyExportMarkdown.tsx", {
			stubs: {
				streamdown: streamdownStub,
				"@streamdown/code": { code: {} },
				"@streamdown/math": { createMathPlugin: () => ({}) },
				"./imageExportModel": modelMod,
			},
		});
		const { ReadOnlyExportDocument } = docMod;

		let commitFired = false;
		await mount(
			() => {},
			{},
			() =>
				React.createElement(ReadOnlyExportDocument, {
					model: docModel,
					onRenderCommit: () => {
						commitFired = true;
					},
				}),
		);

		assert.equal(commitFired, true, "useLayoutEffect 必须触发 onRenderCommit");

		const rootEl = window.document.querySelector("[data-markdown-readonly='true']");
		assert.ok(rootEl, "必须带有 data-markdown-readonly='true' 属性阻断公式复制层");

		// 验证工具详情完整展示
		const toolCard = window.document.querySelector(".export-tool-card");
		assert.ok(toolCard, "工具卡片必须被渲染");
		assert.ok(toolCard.textContent.includes("PASSED: all 120 tests green"), "必须展示完整工具结果");
		assert.ok(toolCard.textContent.includes("npm run test:raw"), "必须展示完整工具参数");
	});
});
