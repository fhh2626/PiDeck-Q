import type { AgentCodeTokenLines } from "./agentCodeTokenCache";
import {
	type AgentCodeLanguage,
	type HighlightRequest,
	type HighlightResponse,
} from "./agentHighlightTypes";

/**
 * 代码高亮 Worker：把 shiki 的同步高亮计算搬离主线程。
 *
 * Worker 全局量（self/onmessage/postMessage）不在 tsconfig 的 DOM lib 里
 * （DOM lib 只有 Window 视角），因此按 Worker 实际形状声明一个最小作用域接口。
 * 不用类型断言：声明的是接口而非具体类型，运行时由 Worker 环境提供。
 */
interface WorkerScope {
	onmessage: ((event: MessageEvent<HighlightRequest>) => void) | null;
	postMessage(message: HighlightResponse): void;
}

declare const self: WorkerScope;

const LIGHT_THEME = "github-light-high-contrast";
const DARK_THEME = "github-dark-high-contrast";
const LANGS = ["bash", "diff", "json", "tsx", "typescript"];

// 高亮器在 Worker 内按需加载一次：Worker 空闲会被主线程终止，重建时会重新加载。
let highlighterPromise: Promise<import("shiki").Highlighter> | null = null;

function getHighlighter() {
	if (!highlighterPromise) {
		highlighterPromise = import("shiki").then(({ createHighlighter }) =>
			createHighlighter({
				themes: [LIGHT_THEME, DARK_THEME],
				langs: LANGS,
			}),
		);
	}
	return highlighterPromise;
}

/** 高亮并拍平成可结构化克隆的纯数据（Worker 之间不能传类实例）。 */
function highlight(
	highlighter: import("shiki").Highlighter,
	code: string,
	language: AgentCodeLanguage,
): AgentCodeTokenLines {
	return highlighter
		.codeToTokensWithThemes(code, {
			lang: language,
			themes: { light: LIGHT_THEME, dark: DARK_THEME },
		})
		.map((line) =>
			line.map((token) => ({
				content: token.content,
				offset: token.offset,
				light: token.variants.light?.color,
				dark: token.variants.dark?.color,
			})),
		);
}

self.onmessage = (event) => {
	const request = event.data;
	if (request?.type !== "highlight") return;
	const { requestId, code, language } = request;
	void getHighlighter()
		.then((highlighter) => {
			self.postMessage({
				type: "highlight-result",
				requestId,
				lines: highlight(highlighter, code, language),
			});
		})
		.catch((error: unknown) => {
			// 统计/语言缺失等失败必须回传，不能静默丢弃——否则主线程永远等不到结果。
			self.postMessage({
				type: "highlight-error",
				requestId,
				message: error instanceof Error ? error.message : "highlight failed",
			});
		});
};
