/**
 * 桌面端 ToolGroupCard 源码静态结构契约：
 * 1. 默认折叠（expanded=false）；
 * 2. 包含单个工具的消息组直接渲染单个 ToolCard，不挂载折叠切换按钮；
 * 3. 详细 ToolCard 仅在 expanded 为 true 时才进入 JSX 挂载树；
 * 4. 外部图片画廊受 !expanded 条件护航，与内部卡片互斥。
 *
 * 注：真实的 DOM 节点挂载/卸载、图片点击预览与展开收起由 Playwright
 * tests/browser/sessionAndToolInteraction.spec.ts 进行端到端行为验证。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const src = readFileSync("src/renderer/src/components/session/ToolCallComponents.tsx", "utf8");

test("ToolGroupCard single message group renders single ToolCard directly without multi-tool toggle", () => {
	assert.match(
		src,
		/if\s*\(props\.group\.messages\.length\s*<\s*2\)\s*\{[\s\S]*?<ToolCard[\s\S]*?key=\{singleMessage\.id\}/,
		"single tool must render single ToolCard branch directly",
	);
});

test("ToolGroupCard defaults to collapsed and omits unmounted ToolCards", () => {
	assert.match(
		src,
		/const \[expanded, setExpanded\] = useState\(false\);/,
		"group card must default to collapsed state",
	);
	// 验证 ToolCard 仅在 expanded 为 true 时才挂载
	assert.match(
		src,
		/\{expanded\s*&&\s*\([\s\S]*?props\.group\.messages\.map\(\(message\)\s*=>\s*\([\s\S]*?<ToolCard/,
		"detail ToolCards must not mount when collapsed",
	);
});

test("ToolGroupCard displays images under summary only when collapsed", () => {
	// 折叠态下若有图片，在头部下方渲染画廊
	assert.match(
		src,
		/\{!expanded\s*&&\s*groupImages\.length\s*>\s*0\s*&&\s*\([\s\S]*?<MessageImageGallery/,
		"gallery should render under summary only when collapsed",
	);
	// 展开后由内部 ToolCard 自行渲染，两处互斥，不发生图片重复渲染
});
