import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// UI 2.0（#115 U2）：Streamdown 为唯一 markdown 引擎，内置能力交给官方插件。
// 2026-08 曾因内存移除 @streamdown/code（shiki 双主题 + 全语言 grammar 常驻），
// 2026-08 恢复：@streamdown/code 1.x 为 JS 引擎 + 按语言懒加载（不复现全语言常驻），
// 代码块不再包 details 折叠（Chrome 中文会露出默认「详情」disclosure）。
// 锚点：mermaid/math 由 @streamdown/* 插件接管；a 仍走 MarkdownLink
// （file:// 打开 + 系统浏览器）；Tailwind 已扫描 streamdown 类名保证控件样式完整。
const stream = readFileSync("src/renderer/src/components/session/MarkdownStream.tsx", "utf8");
const renderer = readFileSync("src/renderer/src/components/session/MarkdownStreamRenderer.tsx", "utf8");
const surface = readFileSync("src/renderer/src/components/session/SurfaceComponents.tsx", "utf8");
const link = readFileSync("src/renderer/src/components/session/MarkdownLink.tsx", "utf8");
const linkCore = readFileSync("src/renderer/src/components/session/MarkdownLinkCore.ts", "utf8");
const tailwind = readFileSync("src/renderer/src/styles/tailwind.css", "utf8");
const main = readFileSync("src/renderer/src/main.tsx", "utf8");
const packageJson = readFileSync("package.json", "utf8");
const surfacesCss = readFileSync("src/renderer/src/styles/surfaces.css", "utf8");

test("Markdown heavy runtime stays behind the async renderer boundary", () => {
  // 首屏壳层只能动态加载完整 renderer；type-only import 不会进入运行时依赖图。
  assert.match(stream, /import\("\.\/MarkdownStreamRenderer"\)/);
  assert.doesNotMatch(stream, /from "streamdown"/);
  assert.doesNotMatch(stream, /from "@streamdown\/(?:code|mermaid|math)"/);

  // 完整能力仍由异步模块统一拥有，不能为了减包退化 Markdown 功能。
  assert.match(renderer, /from "streamdown"/);
  assert.match(renderer, /import \{ code \} from "@streamdown\/code"/);
  assert.match(renderer, /import \{ mermaid \} from "@streamdown\/mermaid"/);
  assert.match(renderer, /import \{ createMathPlugin \} from "@streamdown\/math"/);
});

test("streamdown pipeline delegates to official plugins (code/mermaid/math) and keeps link override", () => {
  // 官方插件接管：代码高亮、mermaid、数学
  assert.match(renderer, /import \{ code \} from "@streamdown\/code"/);
  assert.match(renderer, /import \{ mermaid \} from "@streamdown\/mermaid"/);
  assert.match(renderer, /import \{ createMathPlugin \} from "@streamdown\/math"/);
  // 数学插件开启单美元行内公式（singleDollarTextMath: true）：
  // AI 输出 $...$ 是常态，默认关闭会整句原样输出（2026-08 修复，防回归锚点）
  assert.match(renderer, /createMathPlugin\(\{ singleDollarTextMath: true \}\)/);
  assert.match(renderer, /effectiveLight/);
  assert.match(renderer, /math: mathPlugin/);
  // 公式复制走事件委托浮层（FormulaCopyLayer）：rehype-katex 产物不进组件 map，
  // 旧 p 层拦截只能覆盖“单一行内公式独占一段”，已删除（2026-08 通用化）
  assert.match(stream, /<FormulaCopyLayer \/>/);
  assert.doesNotMatch(stream, /MathBlockParagraph/);
  // 非 light 分支注册 code 插件；light（更新日志等轻场景）保持无高亮
  assert.match(renderer, /\bcode,\n/);
  // 不再用 details 折叠代码块（会露出浏览器默认「详情」）；行号沿用 streamdown 默认开启
  assert.doesNotMatch(renderer, /collapseCodeBlocks/);
  assert.doesNotMatch(renderer, /lineNumbers=\{false\}/);
  // 链接覆盖保留（file:// 打开 + 外链拦截是项目核心能力）
  assert.match(renderer, /a: \(linkProps\) =>/);
  assert.match(renderer, /MarkdownLink/);
  assert.match(renderer, /remarkLinkifyPaths/);
  // 自定义 pre/span 覆盖移除：mermaid 由插件渲染、公式由 math 插件
  assert.doesNotMatch(renderer, /pre: \(preProps\) => <CodeBlock/);
  assert.doesNotMatch(renderer, /span: \(spanProps\) => <MathSpan/);
  // 富渲染只发生在 settle 后，固定使用 static 模式。
  assert.match(renderer, /mode="static"/);
  assert.doesNotMatch(renderer, /mode=\{props\.isStreaming \? "streaming" : "static"\}/);
  // mermaid 主题跟随明暗
  assert.match(renderer, /theme: isDark \? "dark" : "default"/);
});

test("streamdown code/table chrome uses faded action controls", () => {
  const streamdownChrome = readFileSync("src/renderer/src/styles/streamdownChrome.css", "utf8");
  assert.match(streamdownChrome, /\[data-streamdown="code-block-actions"\]/);
  assert.match(streamdownChrome, /opacity:\s*0\.5/);
  assert.match(streamdownChrome, /\[data-streamdown="code-block"\]:hover \[data-streamdown="code-block-actions"\]/);
  assert.match(streamdownChrome, /\[data-streamdown="code-block-copy-button"\][\s\S]*?order:\s*1/);
  assert.match(streamdownChrome, /\[data-streamdown="code-block-download-button"\][\s\S]*?order:\s*2/);
  // 表格与代码块同皮（utilities 层）
  assert.match(streamdownChrome, /\[data-streamdown="table-wrapper"\]:hover > div:first-child/);
  assert.doesNotMatch(surfacesCss, /\.sd-code-collapse\b/);
  assert.doesNotMatch(streamdownChrome, /\.sd-code-collapse\b/);
});

test("Tailwind scans streamdown + plugin classes; styles.css imports vendor streamdown layer", () => {
  assert.match(tailwind, /@source "\.\.\/\.\.\/\.\.\/\.\.\/node_modules\/streamdown\/dist\/\*\.js"/);
  // @streamdown/code 已恢复（JS 引擎懒加载高亮），继续扫描其类名
  assert.match(tailwind, /@source "\.\.\/\.\.\/\.\.\/\.\.\/node_modules\/@streamdown\/code\/dist\/\*\.js"/);
  assert.match(tailwind, /@source "\.\.\/\.\.\/\.\.\/\.\.\/node_modules\/@streamdown\/mermaid/);
  assert.match(tailwind, /@source "\.\.\/\.\.\/\.\.\/\.\.\/node_modules\/@streamdown\/math/);
  // streamdown 经 styles.css layer(vendor) 引入，避免 unlayered 压过 surfaces 覆盖
  const stylesEntry = readFileSync("src/renderer/src/styles.css", "utf8");
  assert.match(stylesEntry, /@import\s+"streamdown\/styles\.css"\s+layer\(vendor\)/);
  assert.doesNotMatch(main, /import "streamdown\/styles\.css"/);
  // 高亮插件进 devDependencies（渲染层依赖随 vite 打包，与分支重构模式一致）
  assert.match(packageJson, /"@streamdown\/code"/);
  assert.match(packageJson, /"@streamdown\/mermaid"/);
  assert.match(packageJson, /"@streamdown\/math"/);
  // shiki 声明为直接依赖（beUI agents/file-diff 的 agent-code 高亮需要直接 import，
  // 此前由 @streamdown/code 传递引入，声明后不增加实际安装体积）；react-markdown 不可回归
  assert.match(packageJson, /"shiki"/);
  assert.doesNotMatch(packageJson, /"react-markdown"/);
});

test("link handling is the single shared implementation (no react-markdown import)", () => {
  // 单份实现：所有管线从共享模块 import，不允许本地重复定义
  assert.match(surface, /from "\.\/MarkdownStream"/);
  assert.doesNotMatch(surface, /function MarkdownLink\(/);
  assert.doesNotMatch(surface, /const remarkLinkifyPaths = /);
  assert.match(link, /export function MarkdownLink/);
  // 纯逻辑（remarkLinkifyPaths/FILE_PATH_RE/isLocalPathRef）在 MarkdownLinkCore.ts
  assert.match(linkCore, /export const remarkLinkifyPaths/);
  assert.match(linkCore, /export function isLocalPathRef/);
  assert.match(link, /from "\.\/MarkdownLinkCore"/);
  assert.match(linkCore, /export function markdownUrlTransform/);
  // 链接安全过滤已本地复刻，不再依赖 react-markdown 包
  assert.match(linkCore, /export function defaultUrlTransform/);
  assert.doesNotMatch(linkCore, /from "react-markdown"/);
});

test("Streamdown is the only markdown engine (switch, settings field, dependency removed)", () => {
  // AssistantText 无开关分流，直接渲染 MarkdownStream
  assert.doesNotMatch(surface, /useStreamdownRendererAtom/);
  assert.doesNotMatch(surface, /ReactMarkdown/);
  assert.doesNotMatch(surface, /from "react-markdown"/);
  assert.match(surface, /<MarkdownStream/);
});

test("static markdown scenes share the Streamdown engine", () => {
  const diffViewer = readFileSync("src/renderer/src/components/app/FileDiffViewer.tsx", "utf8");
  const updateOverlay = readFileSync("src/renderer/src/components/overlays/AppUpdateOverlay.tsx", "utf8");
  const scratchPad = readFileSync("src/renderer/src/components/scratchPad/ScratchPadPanel.tsx", "utf8");
  assert.doesNotMatch(diffViewer, /ReactMarkdown/);
  assert.doesNotMatch(updateOverlay, /ReactMarkdown/);
  assert.doesNotMatch(scratchPad, /ReactMarkdown/);
  assert.match(diffViewer, /MarkdownStream/);
  assert.match(updateOverlay, /MarkdownStream/);
  assert.match(scratchPad, /MarkdownStream/);
  // 静态场景保留各自插件（草稿本的高亮 mark 与 GFM task list 覆盖）
  assert.match(scratchPad, /rehypeHighlightMark/);
  assert.match(scratchPad, /remarkBreaks/);
});

test("streaming and first paint stay on the split plain-text fallback", () => {
  const stream = readFileSync("src/renderer/src/components/session/MarkdownStream.tsx", "utf8");
  const policy = readFileSync("src/renderer/src/components/session/markdownStreamPolicy.ts", "utf8");
  // 阈值兼容导出与超大 settle 轻插件策略仍保留。
  assert.match(policy, /export const STREAM_LIGHT_MAX_CHARS = 40_000/);
  assert.match(policy, /export const SETTLE_FULL_MAX_CHARS = 150_000/);
  assert.match(stream, /export \{ STREAM_LIGHT_MAX_CHARS \} from "\.\/markdownStreamPolicy"/);
  // 流式内容及 renderer 未加载的异步期都复用同一个可读 fallback，不创建 Markdown 解析树。
  // 富 Markdown 只在静态（settle）且 renderer 已解析后启用；流式永远走 PlainStreamSplit 轻量路径。
  assert.match(stream, /const displayText = isStreamingNow \? displayedContent : props\.text/);
  assert.match(stream, /const renderRichMarkdown =\s*!isStreamingNow && Renderer != null/);
  assert.doesNotMatch(stream, /rendererRequested/);
  assert.match(stream, /<PlainStreamSplit text=\{displayText\} \/>/);
  assert.doesNotMatch(stream, /IncrementalMarkdownFrontier|FrozenMarkdownChunk|<Streamdown/);
  // settle 全量渲染上限：超大内容保持轻量插件。
  assert.match(stream, /shouldKeepLightOnSettle\(props\.text\.length\)/);
  assert.match(stream, /whitespace-pre-wrap break-words/);
  // 思考同样复用 MarkdownStream，无需另一条首屏渲染链。
  const thinking = readFileSync("src/renderer/src/components/session/TimelineEventCards.tsx", "utf8");
  assert.match(thinking, /<MarkdownStream/);
});

test("loaded renderer is cached per-process: new static instances skip the plain-text fallback", () => {
	const stream = readFileSync("src/renderer/src/components/session/MarkdownStream.tsx", "utf8");
	// 已解析出的 renderer 组件在模块级缓存（loadedMarkdownRenderer），
	// 新实例的初始 state 直接取该缓存：renderer 已加载时首帧即富渲染，
	// 不再先走 PlainStreamSplit 再等空闲切 Streamdown（修正切换会话时的“先松后紧”闪动）。
	assert.match(stream, /let loadedMarkdownRenderer: MarkdownRendererComponent \| null = null/);
	assert.match(stream, /\(\s*\) => loadedMarkdownRenderer,/);
	assert.match(stream, /if \(loadedMarkdownRenderer\) \{\s*return Promise\.resolve\(loadedMarkdownRenderer\);/);
	// 首次加载仍保持懒加载 + 单并发去重；失败保持纯文本，promise 缓存复位供后续挂载重试。
	assert.match(stream, /import\("\.\/MarkdownStreamRenderer"\)/);
	assert.match(stream, /loadedMarkdownRenderer = module\.MarkdownStreamRenderer/);
	assert.match(stream, /rendererLoadPromise = undefined/);
	assert.match(stream, /\.catch\(\(\) => \{/);
	// 首次静态 Markdown 延迟到浏览器空闲再加载（timeout 兜底），不与首帧争抢主线程；
	// 卸载后取消调度不得 setState：cancelIdleCallback + active 双保险。
	assert.match(stream, /requestIdleCallback\(load, \{ timeout: 1500 \}\)/);
	assert.match(stream, /window\.setTimeout\(load, 50\)/);
	assert.match(stream, /window\.cancelIdleCallback\(id\)/);
	assert.match(stream, /active = false;/);
	assert.match(stream, /if \(active\) setRenderer\(\(\) => component\)/);
});

test("AnswerOutput live path renders through MarkdownStream (no dual typewriter)", () => {
  const answer = readFileSync("src/renderer/src/components/session/AnswerOutput.tsx", "utf8");
  // live 分支把打字机/超长兜底委托给 MarkdownStream，不自持 useSmoothStream
  assert.match(answer, /<MarkdownStream/);
  assert.doesNotMatch(answer, /from "\.\.\/\.\.\/utils\/useSmoothStream"/);
  // live 容器保留 e2e typewriter 选择器锚点
  assert.match(answer, /execution-interim markdown-body/);
  assert.match(answer, /data-is-streaming=\{props\.isStreaming \? "1" : "0"\}/);
});
