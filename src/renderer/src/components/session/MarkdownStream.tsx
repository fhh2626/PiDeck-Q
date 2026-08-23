import {
	memo,
	useEffect,
	useRef,
	useState,
	type ComponentType,
} from "react";
import { FormulaCopyLayer } from "./FormulaCopyLayer";
import { useSmoothStream } from "../../utils/useSmoothStream";
import { shouldKeepLightOnSettle } from "./markdownStreamPolicy";
import type { MarkdownStreamProps } from "./MarkdownStreamProps";

// 兼容既有阈值导出；流式现在始终走分段纯文本，不再同步加载 Markdown 引擎。
export { STREAM_LIGHT_MAX_CHARS } from "./markdownStreamPolicy";
export type { MarkdownStreamProps } from "./MarkdownStreamProps";

type MarkdownRendererComponent = ComponentType<MarkdownStreamProps>;

let rendererLoadPromise: Promise<MarkdownRendererComponent> | undefined;
/** 已成功解析出的 renderer 组件：全局缓存，后续新实例首帧即可直接富渲染，
 * 避免切换会话时每个新 MarkdownStream 都先走纯文本再切 Streamdown 造成纵向闪动。 */
let loadedMarkdownRenderer: MarkdownRendererComponent | null = null;

/**
 * 全局复用 Markdown renderer 的异步加载，避免同屏多条消息分别创建下载请求。
 * renderer 已加载时同步返回；加载失败时清掉 promise 缓存，让后续重新挂载仍有重试机会。
 * 当前消息保持纯文本可读。
 */
function loadMarkdownRenderer(): Promise<MarkdownRendererComponent> {
	if (loadedMarkdownRenderer) {
		return Promise.resolve(loadedMarkdownRenderer);
	}

	if (!rendererLoadPromise) {
		rendererLoadPromise = import("./MarkdownStreamRenderer")
			.then((module) => {
				loadedMarkdownRenderer = module.MarkdownStreamRenderer;
				return loadedMarkdownRenderer;
			})
			.catch((error: unknown) => {
				rendererLoadPromise = undefined;
				throw error;
			});
	}

	return rendererLoadPromise;
}

/**
 * 纯文本路径按 4K 切成冻结段与活动段，限制流式更新时 Chromium 的重排范围。
 * 同一 fallback 也用于首帧和异步模块加载期，保证内容立即可读且不出现空白占位。
 */
const PLAIN_SPLIT_STEP = 4_096;

const PlainStreamSplit = memo(function PlainStreamSplit(props: { text: string }) {
	const text = props.text;
	const frozenCacheRef = useRef<{ split: number; text: string }>({ split: 0, text: "" });
	const split = Math.floor(text.length / PLAIN_SPLIT_STEP) * PLAIN_SPLIT_STEP;
	let frozenText = frozenCacheRef.current.text;
	if (frozenCacheRef.current.split !== split || !text.startsWith(frozenText)) {
		frozenText = text.slice(0, split);
		frozenCacheRef.current = { split, text: frozenText };
	}
	return (
		<div className="whitespace-pre-wrap break-words">
			{split > 0 && <span data-md-plain-frozen="1">{frozenText}</span>}
			<span data-md-plain-live="1">{text.slice(split)}</span>
		</div>
	);
});

/**
 * Markdown 首屏壳层。
 *
 * 流式期间只更新轻量纯文本；静态内容在 renderer 尚未加载过时先提交同一 fallback，
 * 再于浏览器空闲时动态加载完整 Streamdown 管线，重库既不进入入口同步图也不与首帧争抢主线程。
 * renderer 一旦加载成功（模块级 loadedMarkdownRenderer 缓存），新实例首帧即直接富渲染，
 * 切换会话不再出现“纯文本 → Streamdown”的段距/行高闪动。
 */
export const MarkdownStream = memo(function MarkdownStream(props: MarkdownStreamProps) {
	const isStreamingNow = Boolean(props.isStreaming);
	const { displayedContent } = useSmoothStream({
		content: props.text,
		isStreaming: isStreamingNow,
	});
	const displayText = isStreamingNow ? displayedContent : props.text;
	// 初始值直接取模块级已缓存 renderer：已加载时不等待空闲回调即可富渲染。
	const [Renderer, setRenderer] =
		useState<MarkdownRendererComponent | null>(
			() => loadedMarkdownRenderer,
		);

	useEffect(() => {
		if (isStreamingNow || Renderer) return;

		// 首次遇到静态 Markdown 时延迟到浏览器空闲再异步加载完整 Streamdown 管线，
		// 避免重 chunk 与首帧争抢主线程；renderer 一旦加载成功（模块级缓存），
		// 后续新实例因 useState 初始值直接命中缓存，根本不会进入本 effect 的加载路径。
		let active = true;
		const load = () => {
			void loadMarkdownRenderer()
				.then((component) => {
					if (active) setRenderer(() => component);
				})
				.catch(() => {
					// 异步 chunk 失败时保留纯文本；缓存已清空，后续挂载可重新尝试。
				});
		};
		const id = typeof window.requestIdleCallback === "function"
			? window.requestIdleCallback(load, { timeout: 1500 })
			: window.setTimeout(load, 50);
		return () => {
			active = false;
			if (typeof window.cancelIdleCallback === "function") window.cancelIdleCallback(id);
			else window.clearTimeout(id);
		};
	}, [isStreamingNow, Renderer]);

	const renderRichMarkdown =
		!isStreamingNow && Renderer != null;
	return (
		<>
			{renderRichMarkdown ? (
				<Renderer
					{...props}
					text={props.text}
					isStreaming={false}
					light={Boolean(props.light) || shouldKeepLightOnSettle(props.text.length)}
				/>
			) : (
				<PlainStreamSplit text={displayText} />
			)}
			<FormulaCopyLayer />
		</>
	);
});
