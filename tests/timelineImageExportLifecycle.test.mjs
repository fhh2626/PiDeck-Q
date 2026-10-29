import test from "node:test";
import assert from "node:assert/strict";
import { withHookHost } from "./helpers/l5_hookHost.mjs";

test("步骤10导出管线测试: 带有 data-markdown-readonly 标识，宿主阻断全局公式复制层污染", async () => {
	await withHookHost(async ({ window, load }) => {
		const container = window.document.createElement("div");
		container.setAttribute("data-markdown-readonly", "true");

		const mathBlock = window.document.createElement("div");
		mathBlock.className = "math-display";
		container.appendChild(mathBlock);

		const inlineMath = window.document.createElement("span");
		inlineMath.className = "katex";
		container.appendChild(inlineMath);

		window.document.body.appendChild(container);

		// 使用 hookHost 的 loadTsCommonJs 加载并触发模块初始化
		load("src/renderer/src/components/session/FormulaCopyLayer.tsx");

		// 检查 mathBlock 是否被插入了复制按钮
		const copyBtn = mathBlock.querySelector("[data-math-copy-btn]");
		assert.equal(copyBtn, null, "只读导出容器内的公式绝不得被插入复制按钮！");

		// 检查 inlineMath 是否被打上了点击复制类
		assert.equal(inlineMath.dataset.mathCopyAttached, undefined, "只读导出容器内的行内公式绝不得挂载交互事件！");

		container.remove();
	});
});
