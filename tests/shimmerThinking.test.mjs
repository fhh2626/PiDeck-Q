import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 低成本体验包（借鉴 Vercel AI Elements）：
 * 1. Shimmer 是可选视觉组件，等待中的 RespondingIndicator 不使用持续动画；
 * 2. 思考耗时人性化——ThinkingBlock 展示「思考了 Xs / Thought for Xs」，不再裸显工程化数字。
 */

const shimmerSource = readFileSync(
	"src/renderer/src/components/session/ShimmerText.tsx",
	"utf8",
);
const cardsSource = readFileSync(
	"src/renderer/src/components/session/TimelineEventCards.tsx",
	"utf8",
);
const timelineCss = readFileSync("src/renderer/src/styles/timeline.css", "utf8");
const zhCN = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
const enUS = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");

test("ShimmerText 零依赖 CSS 实现：bg-clip-text + Tailwind 动画，不新增手写 CSS class", () => {
	assert.match(shimmerSource, /export function ShimmerText/);
	assert.match(shimmerSource, /bg-clip-text text-transparent/);
	// 动画走 Tailwind 工具类 + motion-safe（reduced-motion 退化为静态文本）
	assert.match(shimmerSource, /motion-safe:animate-\[shimmer-sweep/);
	// 明暗取语义 token，暗色模式自适应
	assert.match(shimmerSource, /--color-text-tertiary/);
	assert.match(shimmerSource, /--color-text-primary/);
	assert.match(shimmerSource, /--color-warning/);
	// 不引第三方动画库（零依赖约束）
	assert.doesNotMatch(shimmerSource, /from "(framer-motion|motion|gsap)/);
});

test("shimmer-sweep keyframes 定义在 timeline.css（规则允许 keyframes）", () => {
	assert.match(timelineCss, /@keyframes shimmer-sweep/);
});

test("RespondingIndicator keeps translated status labels without rotation", () => {
	const fnStart = cardsSource.indexOf("export function RespondingIndicator");
	const fn = cardsSource.slice(
		fnStart,
		cardsSource.indexOf("\nexport ", fnStart + 10) || undefined,
	);
	assert.ok(fn, "RespondingIndicator must exist");
	// 四种状态在渲染期翻译，不能在模块初始化时把系统语言固化成字符串。
	assert.doesNotMatch(cardsSource, /const RESPONDING_PHRASES/);
	assert.match(fn, /agent\.loading\.starting1/);
	assert.match(fn, /agent\.loading\.executing1/);
	assert.match(fn, /"agent\.loading\.responding"/);
	assert.match(fn, /agent\.loading\.waiting/);
	assert.match(fn, /data-kind=\{kind\} role="status"/);
	assert.doesNotMatch(fn, /ReasoningText|<Loader|interval=|animate-/);
	// 状态判定保留
	assert.match(fn, /kind = "starting"/);
	assert.match(fn, /kind = "waiting"/);
});

test("RespondingIndicator 静态状态文案中英同步", () => {
	for (const suffix of ["starting1", "executing1", "responding", "waiting"]) {
		const key = `agent.loading.${suffix}`;
		assert.match(zhCN, new RegExp(`"${key}":`));
		assert.match(enUS, new RegExp(`"${key}":`));
	}
});

test("ThinkingBlock 耗时改人性化 i18n 文案，不再裸显数字", () => {
	const block = cardsSource.match(
		/function ThinkingBlock[\s\S]*?\n\t\},\n/,
	)?.[0] ?? "";
	assert.ok(block, "ThinkingBlock must exist");
	assert.match(block, /thinking\.duration/);
	// 耗时仍由 startedAt/endedAt 计算（c73f05c7 重构后变量名 durationMs → durationText）
	assert.match(block, /formatDuration\(props\.endedAt - props\.startedAt\)/);
});

test("thinking.duration 文案中英同步", () => {
	assert.match(zhCN, /"thinking\.duration": "思考了 \{duration\}"/);
	assert.match(enUS, /"thinking\.duration": "Thought for \{duration\}"/);
});
